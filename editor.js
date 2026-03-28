/**
 * MashRoom Test – Editor
 * Full-featured multi-track audio mashup editor using the Web Audio API.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════

const PIXELS_PER_SEC = 80;        // timeline zoom (px per second)
const TRACK_COLORS = [
  '#C02020', '#2080C0', '#20A050', '#C07820',
  '#8020C0', '#20A0A0', '#C04080', '#70A020',
];

let colorIdx = 0;
function nextColor() { return TRACK_COLORS[colorIdx++ % TRACK_COLORS.length]; }

// ═══════════════════════════════════════════════════════════════
//  AudioEngine
// ═══════════════════════════════════════════════════════════════

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.tracks = [];
    this.isPlaying = false;
    this.playheadSec = 0;       // logical position in seconds
    this.startContextTime = 0;  // ctx.currentTime when play started
    this.startOffset = 0;       // playhead position when play was pressed
    this._rafId = null;
    this.onTimeUpdate = null;   // callback(sec)
    this.onPlayEnd = null;
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.8;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async loadFile(file) {
    this._ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  addTrack(audioBuffer, name, color) {
    const track = new Track(this._ensureContext(), audioBuffer, name, color || nextColor());
    track.connect(this.masterGain);
    this.tracks.push(track);
    return track;
  }

  removeTrack(id) {
    const idx = this.tracks.findIndex(t => t.id === id);
    if (idx === -1) return;
    this.tracks[idx].stop();
    this.tracks[idx].disconnect();
    this.tracks.splice(idx, 1);
  }

  play() {
    if (this.isPlaying) return;
    this._ensureContext();
    this.startOffset = this.playheadSec;
    this.startContextTime = this.ctx.currentTime;
    this.isPlaying = true;

    const activeTracks = this.tracks.filter(t => !t.muted || this._hasSolo());
    activeTracks.forEach(t => {
      if (this._hasSolo() && !t.solo) return;
      t.play(this.ctx.currentTime, this.startOffset);
    });

    this._tick();
  }

  _hasSolo() { return this.tracks.some(t => t.solo); }

  pause() {
    if (!this.isPlaying) return;
    this.playheadSec = this._currentSec();
    this.isPlaying = false;
    cancelAnimationFrame(this._rafId);
    this.tracks.forEach(t => t.stop());
  }

  stop() {
    this.pause();
    this.playheadSec = 0;
    this.onTimeUpdate && this.onTimeUpdate(0);
  }

  seek(sec) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.playheadSec = Math.max(0, sec);
    if (wasPlaying) this.play();
    this.onTimeUpdate && this.onTimeUpdate(this.playheadSec);
  }

  setMasterVolume(val) {
    if (this.masterGain) this.masterGain.gain.value = val / 100;
  }

  _currentSec() {
    if (!this.isPlaying) return this.playheadSec;
    return this.startOffset + (this.ctx.currentTime - this.startContextTime);
  }

  _tick() {
    if (!this.isPlaying) return;
    const sec = this._currentSec();
    this.playheadSec = sec;
    this.onTimeUpdate && this.onTimeUpdate(sec);

    // Auto-stop when all tracks have finished
    const duration = this._totalDuration();
    if (duration > 0 && sec >= duration) {
      this.stop();
      this.onPlayEnd && this.onPlayEnd();
      return;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _totalDuration() {
    if (!this.tracks.length) return 0;
    return Math.max(...this.tracks.map(t => t.startOffset + t.buffer.duration));
  }

  totalDuration() { return this._totalDuration(); }

  /** Render mix to WAV blob using OfflineAudioContext */
  async exportWav(onProgress) {
    this._ensureContext();
    const duration = this._totalDuration();
    if (duration <= 0) throw new Error('No audio to export');

    const sampleRate = this.ctx.sampleRate;
    const length = Math.ceil(duration * sampleRate);
    const offline = new OfflineAudioContext(2, length, sampleRate);

    const masterGain = offline.createGain();
    masterGain.gain.value = this.masterGain.gain.value;
    masterGain.connect(offline.destination);

    const hasSolo = this._hasSolo();

    this.tracks.forEach(t => {
      if (t.muted) return;
      if (hasSolo && !t.solo) return;
      if (t.startOffset >= duration) return;

      const src = offline.createBufferSource();
      src.buffer = t.buffer;
      src.loop = t.loop;

      const gain = offline.createGain();
      gain.gain.value = t.volume;

      const panner = offline.createStereoPanner();
      panner.pan.value = t.pan;

      src.connect(gain);
      gain.connect(panner);
      panner.connect(masterGain);

      src.start(t.startOffset, 0);
    });

    onProgress && onProgress(10);

    offline.oncomplete = null; // cleared below
    const rendered = await offline.startRendering();
    onProgress && onProgress(80);

    const wav = encodeWav(rendered);
    onProgress && onProgress(100);
    return wav;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Track
// ═══════════════════════════════════════════════════════════════

let trackIdCounter = 0;

class Track {
  constructor(ctx, buffer, name, color) {
    this.id = ++trackIdCounter;
    this.ctx = ctx;
    this.buffer = buffer;
    this.name = name;
    this.color = color;
    this.volume = 0.8;
    this.pan = 0;
    this.muted = false;
    this.solo = false;
    this.loop = false;
    this.startOffset = 0;  // seconds into timeline where clip starts
    this._source = null;
    this._gainNode = ctx.createGain();
    this._panNode = ctx.createStereoPanner();
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._gainNode.gain.value = this.volume;
    this._gainNode.connect(this._panNode);
    this._panNode.connect(this._analyser);
  }

  connect(dest) { this._analyser.connect(dest); }
  disconnect() { try { this._analyser.disconnect(); } catch (_) {} }

  play(when, globalOffset) {
    this.stop();
    // Calculate where in the buffer to start based on global playhead
    const clipOffset = globalOffset - this.startOffset;
    if (clipOffset >= this.buffer.duration && !this.loop) return; // past end
    const bufferStart = Math.max(0, clipOffset);
    const startAt = (clipOffset < 0)
      ? when + (-clipOffset)  // track hasn't started yet
      : when;

    this._source = this.ctx.createBufferSource();
    this._source.buffer = this.buffer;
    this._source.loop = this.loop;
    this._source.connect(this._gainNode);
    this._source.start(startAt, this.loop ? (bufferStart % this.buffer.duration) : bufferStart);
  }

  stop() {
    if (this._source) {
      try { this._source.stop(0); } catch (_) {}
      this._source.disconnect();
      this._source = null;
    }
  }

  setVolume(val) {
    this.volume = val / 100;
    this._gainNode.gain.value = this.muted ? 0 : this.volume;
  }

  setPan(val) {
    this.pan = val / 100;
    this._panNode.pan.value = this.pan;
  }

  setMute(muted) {
    this.muted = muted;
    this._gainNode.gain.value = muted ? 0 : this.volume;
  }

  getAnalyserData() {
    const data = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteTimeDomainData(data);
    return data;
  }

  durationStr() {
    const d = this.buffer.duration;
    const m = Math.floor(d / 60);
    const s = Math.floor(d % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
}

// ═══════════════════════════════════════════════════════════════
//  WAV Encoder
// ═══════════════════════════════════════════════════════════════

function encodeWav(audioBuffer) {
  const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit PCM

  const dataSize = length * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  function writeU32(offset, val) { view.setUint32(offset, val, true); }
  function writeU16(offset, val) { view.setUint16(offset, val, true); }

  // RIFF header
  writeStr(0, 'RIFF');
  writeU32(4, 36 + dataSize);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  writeU32(16, 16);          // chunk size
  writeU16(20, 1);           // PCM
  writeU16(22, numChannels);
  writeU32(24, sampleRate);
  writeU32(28, sampleRate * numChannels * bytesPerSample);
  writeU16(32, numChannels * bytesPerSample);
  writeU16(34, 16);
  writeStr(36, 'data');
  writeU32(40, dataSize);

  // Interleave channels
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = audioBuffer.getChannelData(ch)[i];
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// ═══════════════════════════════════════════════════════════════
//  Waveform Renderer
// ═══════════════════════════════════════════════════════════════

function renderWaveform(canvas, audioBuffer, color, options = {}) {
  const { bg = '#111', alpha = 0.85 } = options;
  const ctx2d = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx2d.clearRect(0, 0, w, h);
  if (bg) {
    ctx2d.fillStyle = bg;
    ctx2d.fillRect(0, 0, w, h);
  }

  const channelData = audioBuffer.getChannelData(0);
  const step = Math.ceil(channelData.length / w);
  const amp = h / 2;

  ctx2d.beginPath();
  ctx2d.strokeStyle = color;
  ctx2d.globalAlpha = alpha;
  ctx2d.lineWidth = 1;

  // Top waveform
  ctx2d.moveTo(0, amp);
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const val = channelData[x * step + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    ctx2d.lineTo(x, amp + min * amp * 0.9);
  }
  // Bottom (mirror)
  for (let x = w - 1; x >= 0; x--) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const val = channelData[x * step + j] || 0;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    ctx2d.lineTo(x, amp + max * amp * 0.9);
  }
  ctx2d.closePath();

  ctx2d.fillStyle = color;
  ctx2d.globalAlpha = 0.25;
  ctx2d.fill();

  ctx2d.globalAlpha = alpha;
  ctx2d.stroke();
  ctx2d.globalAlpha = 1;
}

function renderWaveformFull(canvas, audioBuffer, color, startX, totalWidth, trackH) {
  /** Render waveform on timeline canvas at startX offset */
  const ctx2d = canvas.getContext('2d');
  const clipW = Math.round(audioBuffer.duration * PIXELS_PER_SEC);
  const h = trackH;

  // Clip region background
  ctx2d.fillStyle = hexToRgba(color, 0.12);
  ctx2d.fillRect(startX, 0, clipW, h);
  // Clip border
  ctx2d.strokeStyle = hexToRgba(color, 0.5);
  ctx2d.lineWidth = 1;
  ctx2d.strokeRect(startX + 0.5, 0.5, clipW - 1, h - 1);

  const channelData = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.ceil(channelData.length / clipW));
  const amp = h / 2;

  ctx2d.beginPath();
  for (let x = 0; x < clipW; x++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const val = Math.abs(channelData[Math.floor(x * step + j)] || 0);
      if (val > max) max = val;
    }
    const barH = max * amp * 0.85;
    ctx2d.rect(startX + x, amp - barH, 1, barH * 2);
  }

  ctx2d.fillStyle = hexToRgba(color, 0.75);
  ctx2d.fill();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ═══════════════════════════════════════════════════════════════
//  UI Controller
// ═══════════════════════════════════════════════════════════════

class UIController {
  constructor() {
    this.engine = new AudioEngine();
    this.trackRowMap = new Map(); // track.id → { sidebarRow, timelineRow, timelineCanvas }
    this._projectKey = null;
    this._dirty = false;
    this._timelineWidth = 0;
  }

  init() {
    this._bindTransport();
    this._bindMasterVolume();
    this._bindAddTrack();
    this._bindDragDrop();
    this._bindSaveExport();
    this._bindScrollSync();
    this._bindKeyboard();
    this._bindProjectName();
    this._initTimeline();
    this._checkUrlProject();

    this.engine.onTimeUpdate = (sec) => {
      this._updateTimeDisplay(sec);
      this._updatePlayhead(sec);
    };
    this.engine.onPlayEnd = () => {
      this._setPlaying(false);
    };
  }

  // ── Transport ──

  _bindTransport() {
    document.getElementById('btnPlay').addEventListener('click', () => {
      if (this.engine.isPlaying) {
        this.engine.pause();
        this._setPlaying(false);
      } else {
        if (this.engine.tracks.length === 0) {
          this._status('Add some tracks first!');
          return;
        }
        this.engine.play();
        this._setPlaying(true);
      }
    });

    document.getElementById('btnStop').addEventListener('click', () => {
      this.engine.stop();
      this._setPlaying(false);
    });

    document.getElementById('btnRestart').addEventListener('click', () => {
      const wasPlaying = this.engine.isPlaying;
      this.engine.stop();
      this._setPlaying(false);
      if (wasPlaying) {
        this.engine.play();
        this._setPlaying(true);
      }
    });
  }

  _setPlaying(playing) {
    const btn = document.getElementById('btnPlay');
    btn.querySelector('.icon-play').style.display = playing ? 'none' : '';
    btn.querySelector('.icon-pause').style.display = playing ? '' : 'none';
    btn.classList.toggle('playing', playing);
  }

  // ── Master Volume ──

  _bindMasterVolume() {
    const slider = document.getElementById('masterVol');
    const label  = document.getElementById('masterVolVal');
    slider.addEventListener('input', () => {
      label.textContent = slider.value + '%';
      this.engine.setMasterVolume(+slider.value);
    });
  }

  // ── Add Track / File Loading ──

  _bindAddTrack() {
    const btn = document.getElementById('btnAddTrack');
    const input = document.getElementById('fileInput');
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      if (files.length) this._loadFiles(files);
      input.value = '';
    });
  }

  async _loadFiles(files) {
    const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|opus|webm)$/i.test(f.name));
    if (!audioFiles.length) { this._status('No audio files found.'); return; }

    this._status(`Loading ${audioFiles.length} file(s)…`);
    for (const file of audioFiles) {
      try {
        const buf = await this.engine.loadFile(file);
        const name = file.name.replace(/\.[^.]+$/, '');
        const track = this.engine.addTrack(buf, name);
        this._addTrackRow(track);
        this._dirty = true;
      } catch (err) {
        this._status(`Failed to load "${file.name}": ${err.message}`);
      }
    }
    this._updateStatus();
    this._redrawTimeline();
    this._status('Tracks loaded. Press Play to start!');
  }

  // ── Drag & Drop ──

  _bindDragDrop() {
    const overlay = document.getElementById('dropOverlay');
    let dragCount = 0;

    document.addEventListener('dragenter', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        dragCount++;
        overlay.classList.add('active');
      }
    });
    document.addEventListener('dragleave', () => {
      dragCount--;
      if (dragCount <= 0) { dragCount = 0; overlay.classList.remove('active'); }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCount = 0;
      overlay.classList.remove('active');
      const files = Array.from(e.dataTransfer.files);
      if (files.length) this._loadFiles(files);
    });
  }

  // ── Track Row ──

  _addTrackRow(track) {
    // Remove empty state
    document.getElementById('emptyState').style.display = 'none';

    // Clone sidebar template
    const tmpl = document.getElementById('trackTemplate').content.cloneNode(true);
    const row = tmpl.querySelector('.track-row');
    row.dataset.trackId = track.id;
    row.querySelector('.track-color-bar').style.background = track.color;
    row.querySelector('.track-name-input').value = track.name;
    row.querySelector('.track-duration').textContent = track.durationStr();

    const volSlider = row.querySelector('.track-volume');
    const volVal    = row.querySelector('.vol-val');
    volSlider.value = track.volume * 100;
    volVal.textContent = Math.round(track.volume * 100);

    const panSlider = row.querySelector('.track-pan');
    const panVal    = row.querySelector('.pan-val');
    panSlider.value = track.pan * 100;
    panVal.textContent = 'C';

    // Mini waveform
    const miniCanvas = row.querySelector('.waveform-mini-canvas');
    // Defer until layout is known
    requestAnimationFrame(() => {
      const parent = miniCanvas.parentElement;
      const w = parent.offsetWidth || 200;
      miniCanvas.width = w * (window.devicePixelRatio || 1);
      miniCanvas.height = 28 * (window.devicePixelRatio || 1);
      miniCanvas.style.width = w + 'px';
      miniCanvas.style.height = '28px';
      renderWaveform(miniCanvas, track.buffer, track.color, { bg: '#111', alpha: 0.9 });
    });

    // Events
    row.querySelector('.track-name-input').addEventListener('input', (e) => {
      track.name = e.target.value;
      this._dirty = true;
    });
    volSlider.addEventListener('input', () => {
      track.setVolume(+volSlider.value);
      volVal.textContent = volSlider.value;
      this._dirty = true;
    });
    panSlider.addEventListener('input', () => {
      track.setPan(+panSlider.value);
      const v = +panSlider.value;
      panVal.textContent = v === 0 ? 'C' : (v > 0 ? `R${v}` : `L${-v}`);
      this._dirty = true;
    });

    const btnMute = row.querySelector('.btn-mute');
    btnMute.addEventListener('click', () => {
      track.muted = !track.muted;
      track.setMute(track.muted);
      btnMute.classList.toggle('active', track.muted);
      row.classList.toggle('muted', track.muted);
      this._dirty = true;
    });

    const btnSolo = row.querySelector('.btn-solo');
    btnSolo.addEventListener('click', () => {
      track.solo = !track.solo;
      btnSolo.classList.toggle('active', track.solo);
      this._dirty = true;
    });

    const btnDel = row.querySelector('.btn-delete');
    btnDel.addEventListener('click', () => {
      if (!confirm(`Delete "${track.name}"?`)) return;
      this.engine.removeTrack(track.id);
      this._removeTrackRow(track.id);
      this._dirty = true;
      this._updateStatus();
      this._redrawTimeline();
    });

    document.getElementById('trackList').appendChild(row);

    // Timeline row
    const tlRow = document.createElement('div');
    tlRow.className = 'timeline-track-row';
    tlRow.dataset.trackId = track.id;
    tlRow.style.height = getComputedStyle(document.documentElement).getPropertyValue('--track-h').trim();

    const tlCanvas = document.createElement('canvas');
    tlCanvas.className = 'timeline-track-canvas';
    tlCanvas.style.cursor = 'pointer';
    tlRow.appendChild(tlCanvas);

    // Insert before the playhead overlay
    const playheadOverlay = document.getElementById('playheadOverlay');
    document.getElementById('timelineBody').insertBefore(tlRow, playheadOverlay);

    this.trackRowMap.set(track.id, { sidebarRow: row, timelineRow: tlRow, timelineCanvas: tlCanvas });

    // Render waveform on timeline
    requestAnimationFrame(() => this._renderTrackTimeline(track));

    // Click to seek
    tlCanvas.addEventListener('click', (e) => {
      const rect = tlCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const sec = x / PIXELS_PER_SEC;
      this.engine.seek(sec);
    });
  }

  _removeTrackRow(trackId) {
    const rows = this.trackRowMap.get(trackId);
    if (!rows) return;
    rows.sidebarRow.remove();
    rows.timelineRow.remove();
    this.trackRowMap.delete(trackId);
    if (this.engine.tracks.length === 0) {
      document.getElementById('emptyState').style.display = '';
    }
  }

  // ── Timeline Rendering ──

  _initTimeline() {
    this._resizeTimeline();
    window.addEventListener('resize', () => this._resizeTimeline());
  }

  _resizeTimeline() {
    const timelineArea = document.querySelector('.timeline-area');
    this._timelineWidth = timelineArea.offsetWidth;
    this._drawRuler();
    this._redrawTimeline();
    this._resizePlayhead();
  }

  _calcTimelineWidth() {
    const minWidth = this._timelineWidth || 800;
    const contentWidth = Math.max(
      this.engine.totalDuration() * PIXELS_PER_SEC + 200,
      minWidth
    );
    return contentWidth;
  }

  _drawRuler() {
    const canvas = document.getElementById('timelineRuler');
    const dpr = window.devicePixelRatio || 1;
    const w = this._calcTimelineWidth();
    canvas.width = w * dpr;
    canvas.height = 28 * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = '28px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 28);
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, w, 28);

    // Tick interval
    const secInterval = PIXELS_PER_SEC >= 60 ? 5 : 10;
    const totalSec = w / PIXELS_PER_SEC;

    ctx.font = '9px -apple-system, monospace';
    ctx.fillStyle = '#666';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;

    for (let s = 0; s <= totalSec; s += secInterval) {
      const x = s * PIXELS_PER_SEC;
      ctx.beginPath();
      ctx.moveTo(x, 16);
      ctx.lineTo(x, 28);
      ctx.stroke();

      const m = Math.floor(s / 60);
      const sec = (s % 60).toString().padStart(2, '0');
      ctx.fillText(`${m}:${sec}`, x + 3, 12);
    }

    // Beat ticks (lighter)
    const beatInterval = 60 / (this._bpm || 120);
    ctx.strokeStyle = '#2A2A2A';
    for (let s = 0; s <= totalSec; s += beatInterval) {
      const x = s * PIXELS_PER_SEC;
      ctx.beginPath();
      ctx.moveTo(x, 22);
      ctx.lineTo(x, 28);
      ctx.stroke();
    }
  }

  _renderTrackTimeline(track) {
    const rows = this.trackRowMap.get(track.id);
    if (!rows) return;

    const tlRow = rows.timelineRow;
    const tlCanvas = rows.timelineCanvas;
    const dpr = window.devicePixelRatio || 1;
    const totalW = this._calcTimelineWidth();
    const trackH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--track-h')) || 110;

    tlCanvas.width = totalW * dpr;
    tlCanvas.height = trackH * dpr;
    tlCanvas.style.width = totalW + 'px';
    tlCanvas.style.height = trackH + 'px';

    const ctx = tlCanvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, totalW, trackH);

    const startX = track.startOffset * PIXELS_PER_SEC;
    renderWaveformFull(tlCanvas.getContext('2d'), track.buffer, track.color, startX, totalW, trackH);

    // Track label on clip
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(startX, 0, Math.min(120, track.buffer.duration * PIXELS_PER_SEC), 18);
    ctx.fillStyle = track.color;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText(track.name, startX + 5, 12);
  }

  _redrawTimeline() {
    const totalW = this._calcTimelineWidth();
    this._drawRuler();

    // Expand timeline rows
    document.querySelectorAll('.timeline-track-row').forEach(row => {
      row.style.minWidth = totalW + 'px';
    });

    this.engine.tracks.forEach(t => this._renderTrackTimeline(t));
    this._resizePlayhead();
  }

  _resizePlayhead() {
    const overlay = document.getElementById('playheadOverlay');
    const body = document.getElementById('timelineBody');
    const dpr = window.devicePixelRatio || 1;
    const totalW = this._calcTimelineWidth();
    const totalH = body.scrollHeight || 400;
    overlay.width = totalW * dpr;
    overlay.height = totalH * dpr;
    overlay.style.width = totalW + 'px';
    overlay.style.height = totalH + 'px';
    this._updatePlayhead(this.engine.playheadSec);
  }

  _updatePlayhead(sec) {
    const overlay = document.getElementById('playheadOverlay');
    const dpr = window.devicePixelRatio || 1;
    const totalW = overlay.width / dpr;
    const totalH = overlay.height / dpr;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, totalW * dpr, totalH * dpr);
    ctx.save();
    ctx.scale(dpr, dpr);

    const x = sec * PIXELS_PER_SEC;
    if (x < 0 || x > totalW) { ctx.restore(); return; }

    ctx.strokeStyle = '#FF4444';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255, 68, 68, 0.5)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, totalH);
    ctx.stroke();

    // Playhead triangle
    ctx.fillStyle = '#FF4444';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Auto-scroll to keep playhead visible
    const body = document.getElementById('timelineBody');
    const scrollLeft = body.scrollLeft;
    const visibleW = body.clientWidth;
    if (x < scrollLeft || x > scrollLeft + visibleW - 40) {
      if (this.engine.isPlaying) body.scrollLeft = x - visibleW * 0.2;
    }
  }

  // ── Time display ──

  _updateTimeDisplay(sec) {
    const m  = Math.floor(sec / 60).toString().padStart(2, '0');
    const s  = Math.floor(sec % 60).toString().padStart(2, '0');
    const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
    document.getElementById('timeMin').textContent = m;
    document.getElementById('timeSec').textContent = s;
    document.getElementById('timeMs').textContent  = ms;
  }

  // ── Save / Export ──

  _bindSaveExport() {
    document.getElementById('btnSave').addEventListener('click', () => this._saveProject());
    document.getElementById('btnExport').addEventListener('click', () => this._exportWav());
  }

  _saveProject() {
    if (!this.engine.tracks.length) { this._status('Nothing to save.'); return; }
    const key = this._projectKey || ('project_' + Date.now());
    this._projectKey = key;

    // We can't serialise AudioBuffers to localStorage, so we save metadata only
    const data = {
      name: document.getElementById('projectName').value || 'Untitled',
      savedAt: Date.now(),
      tracks: this.engine.tracks.map(t => ({
        id: t.id,
        name: t.name,
        color: t.color,
        volume: t.volume,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
        loop: t.loop,
        startOffset: t.startOffset,
        duration: t.buffer.duration,
      })),
    };

    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ [key]: data }, () => {
        this._status('Project saved.');
        this._dirty = false;
      });
    } else {
      try {
        localStorage.setItem(key, JSON.stringify(data));
        this._status('Project saved (local).');
        this._dirty = false;
      } catch (_) { this._status('Save failed.'); }
    }
  }

  async _exportWav() {
    if (!this.engine.tracks.length) { this._status('No tracks to export.'); return; }

    const modal = document.getElementById('exportModal');
    const progressBar = document.getElementById('exportProgressBar');
    const statusText = document.getElementById('exportStatusText');
    modal.style.display = 'flex';

    try {
      const wasPlaying = this.engine.isPlaying;
      if (wasPlaying) { this.engine.pause(); this._setPlaying(false); }

      progressBar.style.width = '0%';
      statusText.textContent = 'Rendering audio…';

      const blob = await this.engine.exportWav((pct) => {
        progressBar.style.width = pct + '%';
        if (pct >= 80) statusText.textContent = 'Encoding WAV…';
      });

      statusText.textContent = 'Preparing download…';
      progressBar.style.width = '100%';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = (document.getElementById('projectName').value || 'mashroom-mix')
        .replace(/[^a-z0-9_\-\s]/gi, '_');
      a.href = url;
      a.download = `${name}.wav`;
      a.click();
      URL.revokeObjectURL(url);

      this._status('Export complete!');
    } catch (err) {
      statusText.textContent = 'Export failed: ' + err.message;
      console.error(err);
    } finally {
      setTimeout(() => { modal.style.display = 'none'; }, 1200);
    }
  }

  // ── Keyboard shortcuts ──

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Don't intercept when typing in inputs
      if (e.target.tagName === 'INPUT') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          document.getElementById('btnPlay').click();
          break;
        case 'Home':
          e.preventDefault();
          document.getElementById('btnRestart').click();
          break;
        case 'Escape':
          document.getElementById('btnStop').click();
          break;
        case 'KeyS':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this._saveProject();
          }
          break;
      }
    });
  }

  // ── Scroll sync ──

  _bindScrollSync() {
    const sidebar = document.getElementById('trackList');
    const timeline = document.getElementById('timelineBody');
    let syncing = false;

    sidebar.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      timeline.scrollTop = sidebar.scrollTop;
      syncing = false;
    });

    timeline.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      sidebar.scrollTop = timeline.scrollTop;
      syncing = false;
    });
  }

  // ── Project name ──

  _bindProjectName() {
    const input = document.getElementById('projectName');
    input.addEventListener('input', () => { this._dirty = true; });
    // Warn on unload if dirty
    window.addEventListener('beforeunload', (e) => {
      if (this._dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ── BPM ──

  get _bpm() { return +document.getElementById('bpmInput').value || 120; }

  // ── Status ──

  _status(msg) {
    document.getElementById('statusMsg').textContent = msg;
  }

  _updateStatus() {
    const n = this.engine.tracks.length;
    document.getElementById('statusTracks').textContent = `${n} track${n !== 1 ? 's' : ''}`;
    const dur = this.engine.totalDuration();
    const m = Math.floor(dur / 60);
    const s = Math.floor(dur % 60).toString().padStart(2, '0');
    document.getElementById('statusDuration').textContent = `${m}:${s}`;
  }

  // ── URL project loading ──

  _checkUrlProject() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get('project');
    if (!key) return;
    this._projectKey = key;

    const load = (data) => {
      if (!data || !data[key]) return;
      const proj = data[key];
      document.getElementById('projectName').value = proj.name || 'Untitled';
      this._status(`Loaded project "${proj.name}" — re-add audio files to restore tracks.`);
    };

    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(key, load);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════════

const app = new UIController();
document.addEventListener('DOMContentLoaded', () => app.init());
