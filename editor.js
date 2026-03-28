/**
 * MashRoom Test – Editor v2
 * Clip-based multi-layer audio mashup editor.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */

const LAYER_COLORS = [
  '#C02020', '#2080C0', '#20A050', '#C07820',
  '#8020C0', '#20A0A0', '#C04080', '#70A020',
];
const PX_PER_SEC_BASE = 100;
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const SNAP_SEC = 0.1;          // snap grid in seconds
const LAYER_H = 76;            // must match CSS --layer-h
const LAYER_HDR_W = 178;       // must match CSS --layer-hdr-w
const RULER_H = 28;
const MIN_CLIP_PX = 8;         // minimum clip width in pixels
const WAVEFORM_BUCKETS = 800;  // peak resolution per file

/* ═══════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════ */

let _nextId = 1;
function uid() { return _nextId++; }

let pxPerSec = PX_PER_SEC_BASE;
let zoomIdx = ZOOM_LEVELS.indexOf(1);   // default = 1×
let snapEnabled = true;

const state = {
  files: new Map(),     // id → { id, name, buffer, duration, color, peaks }
  layers: [],           // [{ id, name, color, muted, solo, volume, pan }]
  clips: [],            // [{ id, fileId, layerId, startTime, duration, trimStart }]
  selection: new Set(),  // clip ids
  clipboard: [],         // [{ fileId, relTime, duration, trimStart, layerOffset }]
  dirty: false,
};

/* Helper: snap a time value to the grid */
function snap(t) {
  if (!snapEnabled) return Math.max(0, t);
  const grid = SNAP_SEC * (60 / (getBpm() || 120));   // beat-relative grid
  return Math.max(0, Math.round(t / SNAP_SEC) * SNAP_SEC);
}

function getBpm() {
  const el = document.getElementById('bpmInput');
  return el ? +el.value || 120 : 120;
}

function layerIndex(layerId) {
  return state.layers.findIndex(l => l.id === layerId);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════
   AUDIO ENGINE  (clip-based)
   ═══════════════════════════════════════════════════════════ */

const engine = {
  ctx: null,
  masterGain: null,
  layerNodes: new Map(),   // layerId → { gain, pan }
  sources: [],             // active BufferSource refs for stop()
  playing: false,
  playhead: 0,             // current logical position (seconds)
  _startCtx: 0,            // ctx.currentTime when play() was called
  _startOff: 0,            // playhead value at play()
  _raf: null,
  onTick: null,            // callback(sec)
  onEnd: null,

  /* ── context ── */

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.8;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  /* ── file loading ── */

  async decodeFile(file) {
    this.ensure();
    const ab = await file.arrayBuffer();
    return this.ctx.decodeAudioData(ab);
  },

  /* ── layer audio nodes ── */

  createLayerNodes(layer) {
    this.ensure();
    const gain = this.ctx.createGain();
    gain.gain.value = layer.volume;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = layer.pan;
    gain.connect(pan);
    pan.connect(this.masterGain);
    this.layerNodes.set(layer.id, { gain, pan });
  },

  removeLayerNodes(layerId) {
    const n = this.layerNodes.get(layerId);
    if (n) { try { n.gain.disconnect(); n.pan.disconnect(); } catch (_) {} }
    this.layerNodes.delete(layerId);
  },

  setLayerVolume(layerId, v) {
    const n = this.layerNodes.get(layerId);
    if (n) n.gain.gain.value = v;
  },

  setLayerMute(layerId, muted) {
    const n = this.layerNodes.get(layerId);
    const layer = state.layers.find(l => l.id === layerId);
    if (n && layer) n.gain.gain.value = muted ? 0 : layer.volume;
  },

  setLayerPan(layerId, v) {
    const n = this.layerNodes.get(layerId);
    if (n) n.pan.pan.value = v;
  },

  setMasterVolume(v) {
    if (this.masterGain) this.masterGain.gain.value = v / 100;
  },

  /* ── transport ── */

  play() {
    if (this.playing) return;
    this.ensure();
    this._startOff = this.playhead;
    this._startCtx = this.ctx.currentTime;
    this.playing = true;
    this._scheduleAll(this._startOff);
    this._tick();
  },

  pause() {
    if (!this.playing) return;
    this.playhead = this._now();
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this._stopSources();
  },

  stop() {
    this.pause();
    this.playhead = 0;
    if (this.onTick) this.onTick(0);
  },

  seek(sec) {
    const was = this.playing;
    if (was) this.pause();
    this.playhead = Math.max(0, sec);
    if (was) this.play();
    if (this.onTick) this.onTick(this.playhead);
  },

  _now() {
    if (!this.playing) return this.playhead;
    return this._startOff + (this.ctx.currentTime - this._startCtx);
  },

  _tick() {
    if (!this.playing) return;
    const sec = this._now();
    this.playhead = sec;
    if (this.onTick) this.onTick(sec);
    const dur = this.totalDuration();
    if (dur > 0 && sec >= dur) {
      this.stop();
      if (this.onEnd) this.onEnd();
      return;
    }
    this._raf = requestAnimationFrame(() => this._tick());
  },

  /* ── schedule clips ── */

  _scheduleAll(offset) {
    this._stopSources();
    const hasSolo = state.layers.some(l => l.solo);

    for (const clip of state.clips) {
      const layer = state.layers.find(l => l.id === clip.layerId);
      if (!layer) continue;
      if (layer.muted) continue;
      if (hasSolo && !layer.solo) continue;

      const file = state.files.get(clip.fileId);
      if (!file) continue;

      const nodes = this.layerNodes.get(layer.id);
      if (!nodes) continue;

      const clipEnd = clip.startTime + clip.duration;
      if (clipEnd <= offset) continue;   // already past

      const clipOff = offset - clip.startTime;
      const bufStart = clip.trimStart + Math.max(0, clipOff);
      const remaining = clip.duration - Math.max(0, clipOff);
      if (remaining <= 0) continue;

      const when = clipOff < 0
        ? this.ctx.currentTime + (-clipOff)
        : this.ctx.currentTime;

      const src = this.ctx.createBufferSource();
      src.buffer = file.buffer;
      src.connect(nodes.gain);
      src.start(when, bufStart, remaining);
      this.sources.push(src);
    }
  },

  _stopSources() {
    for (const s of this.sources) {
      try { s.stop(0); } catch (_) {}
      try { s.disconnect(); } catch (_) {}
    }
    this.sources = [];
  },

  /* ── duration ── */

  totalDuration() {
    if (!state.clips.length) return 0;
    return Math.max(...state.clips.map(c => c.startTime + c.duration));
  },

  /* ── export ── */

  async exportWav(onProgress) {
    this.ensure();
    const dur = this.totalDuration();
    if (dur <= 0) throw new Error('No audio to export');

    const sr = this.ctx.sampleRate;
    const len = Math.ceil(dur * sr);
    const offline = new OfflineAudioContext(2, len, sr);

    const offMaster = offline.createGain();
    offMaster.gain.value = this.masterGain.gain.value;
    offMaster.connect(offline.destination);

    const hasSolo = state.layers.some(l => l.solo);

    // Build per-layer gain chains in offline context
    const offLayerGains = new Map();
    for (const layer of state.layers) {
      if (layer.muted) continue;
      if (hasSolo && !layer.solo) continue;
      const g = offline.createGain();
      g.gain.value = layer.volume;
      const p = offline.createStereoPanner();
      p.pan.value = layer.pan;
      g.connect(p);
      p.connect(offMaster);
      offLayerGains.set(layer.id, g);
    }

    for (const clip of state.clips) {
      const dest = offLayerGains.get(clip.layerId);
      if (!dest) continue;
      const file = state.files.get(clip.fileId);
      if (!file) continue;

      const src = offline.createBufferSource();
      src.buffer = file.buffer;
      src.connect(dest);
      src.start(clip.startTime, clip.trimStart, clip.duration);
    }

    onProgress && onProgress(10);
    const rendered = await offline.startRendering();
    onProgress && onProgress(80);
    const blob = encodeWav(rendered);
    onProgress && onProgress(100);
    return blob;
  },
};

/* ═══════════════════════════════════════════════════════════
   WAV ENCODER
   ═══════════════════════════════════════════════════════════ */

function encodeWav(audioBuffer) {
  const nCh = Math.min(audioBuffer.numberOfChannels, 2);
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const bps = 2;  // 16-bit PCM
  const dataSize = len * nCh * bps;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  function str(off, s) { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }

  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * nCh * bps, true);
  v.setUint16(32, nCh * bps, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < nCh; ch++) {
      const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ═══════════════════════════════════════════════════════════
   WAVEFORM PEAKS + RENDERING
   ═══════════════════════════════════════════════════════════ */

/** Pre-compute peak data for fast drawing (once per file) */
function computePeaks(audioBuffer, buckets) {
  buckets = buckets || WAVEFORM_BUCKETS;
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.ceil(data.length / buckets));
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let mx = 0;
    const base = i * step;
    for (let j = 0; j < step; j++) {
      const val = Math.abs(data[base + j] || 0);
      if (val > mx) mx = val;
    }
    peaks[i] = mx;
  }
  return peaks;
}

/** Draw a waveform into a canvas using pre-computed peaks.
 *  @param {HTMLCanvasElement} canvas
 *  @param {Float32Array} peaks  – full file peaks
 *  @param {string} color        – CSS hex colour
 *  @param {object} opts         – { trimStart, duration, fileDuration, bg }
 */
function drawPeaks(canvas, peaks, color, opts) {
  const { trimStart = 0, duration, fileDuration, bg = 'transparent' } = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Optional background
  if (bg && bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.clearRect(0, 0, w, h);
  }

  // Which slice of peaks to draw
  const fd = fileDuration || 1;
  const startFrac = trimStart / fd;
  const durFrac = (duration || fd) / fd;
  const peakStart = Math.floor(startFrac * peaks.length);
  const peakCount = Math.max(1, Math.floor(durFrac * peaks.length));

  const mid = h / 2;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const pi = peakStart + Math.floor((x / w) * peakCount);
    const pk = (pi >= 0 && pi < peaks.length) ? peaks[pi] : 0;
    const barH = pk * mid * 0.88;
    ctx.moveTo(x, mid - barH);
    ctx.lineTo(x, mid + barH);
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Filled mirror
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const pi = peakStart + Math.floor((x / w) * peakCount);
    const pk = (pi >= 0 && pi < peaks.length) ? peaks[pi] : 0;
    const barH = pk * mid * 0.88;
    ctx.rect(x, mid - barH, 1, barH * 2);
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.fill();

  ctx.globalAlpha = 1;
}

/** Convenience: draw full-file mini waveform (for file panel items). */
function drawMiniWaveform(canvas, peaks, color) {
  drawPeaks(canvas, peaks, color, { bg: '#111' });
}

/* ═══════════════════════════════════════════════════════════
   PROJECT FILE PANEL  (left sidebar)
   ═══════════════════════════════════════════════════════════ */

let colorIdx = 0;
function nextColor() { return LAYER_COLORS[colorIdx++ % LAYER_COLORS.length]; }

function initFilePanel() {
  const btnImport = document.getElementById('btnImport');
  const fileInput = document.getElementById('fileInput');

  btnImport.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) importFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  // Drop files onto the panel itself
  const panel = document.getElementById('fpFiles');
  panel.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  panel.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) importFiles(files);
  });
}

async function importFiles(fileList) {
  const audio = fileList.filter(f =>
    f.type.startsWith('audio/') ||
    /\.(mp3|wav|ogg|flac|aac|m4a|opus|webm)$/i.test(f.name)
  );
  if (!audio.length) { setStatus('No audio files found.'); return; }
  setStatus(`Importing ${audio.length} file(s)…`);

  for (const f of audio) {
    try {
      const buffer = await engine.decodeFile(f);
      const name = f.name.replace(/\.[^.]+$/, '');
      const color = nextColor();
      const peaks = computePeaks(buffer);
      const id = uid();
      const entry = { id, name, buffer, duration: buffer.duration, color, peaks };
      state.files.set(id, entry);
      addFilePanelItem(entry);
      state.dirty = true;
    } catch (err) {
      setStatus(`Failed: "${f.name}" – ${err.message}`);
    }
  }
  document.getElementById('fpEmpty').style.display = state.files.size ? 'none' : '';
  setStatus(`${state.files.size} file(s) in project. Drag to timeline →`);
  updateStatusBar();
}

function addFilePanelItem(file) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.dataset.fileId = file.id;
  el.draggable = true;

  const durM = Math.floor(file.duration / 60);
  const durS = Math.floor(file.duration % 60).toString().padStart(2, '0');

  el.innerHTML = `
    <div class="file-item-top">
      <div class="file-item-color" style="background:${file.color}"></div>
      <div class="file-item-info">
        <div class="file-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="file-item-dur">${durM}:${durS}</div>
      </div>
      <button class="file-item-del" title="Remove from project">
        <svg viewBox="0 0 12 12" fill="currentColor" width="10" height="10">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="file-item-wave"><canvas></canvas></div>
    <div class="file-item-drag-hint">
      <svg viewBox="0 0 10 10" fill="currentColor" width="8" height="8"><path d="M2 3h6M2 5h6M2 7h6" stroke="currentColor" stroke-width="0.8"/></svg>
      Drag to timeline
    </div>
  `;

  // Mini waveform
  const canvas = el.querySelector('canvas');
  requestAnimationFrame(() => drawMiniWaveform(canvas, file.peaks, file.color));

  // Drag start → sets file id for timeline drop
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/x-mashroom-file', String(file.id));
    e.dataTransfer.effectAllowed = 'copy';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

  // Delete file from project
  el.querySelector('.file-item-del').addEventListener('click', e => {
    e.stopPropagation();
    // Check if any clips use this file
    const used = state.clips.filter(c => c.fileId === file.id);
    if (used.length && !confirm(`"${file.name}" is used in ${used.length} clip(s). Remove anyway?`)) return;
    // Remove clips that reference it
    for (const c of used) removeClip(c.id);
    state.files.delete(file.id);
    el.remove();
    document.getElementById('fpEmpty').style.display = state.files.size ? 'none' : '';
    state.dirty = true;
    updateStatusBar();
  });

  // Click → play preview
  el.addEventListener('dblclick', () => {
    engine.ensure();
    const src = engine.ctx.createBufferSource();
    src.buffer = file.buffer;
    src.connect(engine.masterGain);
    src.start();
    setStatus(`Previewing "${file.name}"…`);
  });

  document.getElementById('fpFiles').appendChild(el);
}

/* ═══════════════════════════════════════════════════════════
   TIMELINE INIT  (ruler, scroll sync, resize)
   ═══════════════════════════════════════════════════════════ */

let tlScrollArea, tlContent, tlLayerHeaders, tlRulerWrap, tlRulerCanvas, tlPlayhead;

function initTimeline() {
  tlScrollArea  = document.getElementById('tlScrollArea');
  tlContent     = document.getElementById('tlContent');
  tlLayerHeaders = document.getElementById('tlLayerHeaders');
  tlRulerWrap   = document.getElementById('tlRulerWrap');
  tlRulerCanvas = document.getElementById('tlRuler');
  tlPlayhead    = document.getElementById('tlPlayhead');

  // Scroll sync: ruler + layer headers track the scroll area
  tlScrollArea.addEventListener('scroll', syncScroll);

  // Click ruler to seek
  tlRulerCanvas.addEventListener('click', e => {
    const rect = tlRulerWrap.getBoundingClientRect();
    const x = e.clientX - rect.left + tlScrollArea.scrollLeft;
    engine.seek(Math.max(0, x / pxPerSec));
  });

  // Click empty timeline area to deselect / seek
  tlScrollArea.addEventListener('mousedown', onTimelineMouseDown);

  // Drop files from project panel onto timeline
  tlScrollArea.addEventListener('dragover', onTimelineDragOver);
  tlScrollArea.addEventListener('dragleave', onTimelineDragLeave);
  tlScrollArea.addEventListener('drop', onTimelineDrop);

  // Zoom buttons
  document.getElementById('btnZoomIn').addEventListener('click', () => setZoom(zoomIdx + 1));
  document.getElementById('btnZoomOut').addEventListener('click', () => setZoom(zoomIdx - 1));

  // Snap toggle
  const snapBtn = document.getElementById('btnSnap');
  snapBtn.addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    snapBtn.dataset.active = snapEnabled;
  });

  // Resize observer to re-draw ruler on window resize
  new ResizeObserver(() => { drawRuler(); resizePlayhead(); }).observe(tlScrollArea);

  drawRuler();
  resizePlayhead();
}

function syncScroll() {
  // Horizontal: translate ruler canvas to match content scroll
  tlRulerCanvas.style.transform = `translateX(${-tlScrollArea.scrollLeft}px)`;
  // Vertical: sync layer headers
  tlLayerHeaders.scrollTop = tlScrollArea.scrollTop;
}

function contentWidth() {
  const minW = tlScrollArea.clientWidth || 800;
  return Math.max(engine.totalDuration() * pxPerSec + 400, minW);
}

function contentHeight() {
  return Math.max(state.layers.length * LAYER_H, tlScrollArea.clientHeight || 200);
}

function updateContentSize() {
  const w = contentWidth();
  const h = contentHeight();
  tlContent.style.width = w + 'px';
  tlContent.style.height = h + 'px';
  drawRuler();
  resizePlayhead();
}

/* ── Ruler drawing ── */

function drawRuler() {
  const w = contentWidth();
  const dpr = window.devicePixelRatio || 1;
  tlRulerCanvas.width = w * dpr;
  tlRulerCanvas.height = RULER_H * dpr;
  tlRulerCanvas.style.width = w + 'px';
  tlRulerCanvas.style.height = RULER_H + 'px';

  const ctx = tlRulerCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, RULER_H);
  ctx.fillStyle = '#1E1E1E';
  ctx.fillRect(0, 0, w, RULER_H);

  const totalSec = w / pxPerSec;
  const secInterval = pxPerSec >= 80 ? 5 : pxPerSec >= 40 ? 10 : 30;

  // Time labels + major ticks
  ctx.font = '9px -apple-system, monospace';
  ctx.fillStyle = '#666';
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;

  for (let s = 0; s <= totalSec; s += secInterval) {
    const x = s * pxPerSec;
    ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, RULER_H); ctx.stroke();
    const m = Math.floor(s / 60);
    const sec = (s % 60).toString().padStart(2, '0');
    ctx.fillText(`${m}:${sec}`, x + 3, 12);
  }

  // Beat ticks (lighter)
  const bpm = getBpm();
  const beatSec = 60 / bpm;
  ctx.strokeStyle = '#272727';
  for (let s = 0; s <= totalSec; s += beatSec) {
    const x = s * pxPerSec;
    ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x, RULER_H); ctx.stroke();
  }

  // Apply scroll offset
  tlRulerCanvas.style.transform = `translateX(${-tlScrollArea.scrollLeft}px)`;
}

/* ── Playhead canvas ── */

function resizePlayhead() {
  const dpr = window.devicePixelRatio || 1;
  const w = contentWidth();
  const h = contentHeight();
  tlPlayhead.width = w * dpr;
  tlPlayhead.height = h * dpr;
  tlPlayhead.style.width = w + 'px';
  tlPlayhead.style.height = h + 'px';
  drawPlayhead(engine.playhead);
}

function drawPlayhead(sec) {
  const dpr = window.devicePixelRatio || 1;
  const w = parseFloat(tlPlayhead.style.width) || 0;
  const h = parseFloat(tlPlayhead.style.height) || 0;
  const ctx = tlPlayhead.getContext('2d');
  ctx.clearRect(0, 0, tlPlayhead.width, tlPlayhead.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const x = sec * pxPerSec;
  if (x < 0 || x > w) { ctx.restore(); return; }

  // Vertical line
  ctx.strokeStyle = '#FF4444';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(255,68,68,0.5)';
  ctx.shadowBlur = 4;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();

  // Triangle at top
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#FF4444';
  ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();

  ctx.restore();

  // Auto-scroll to keep playhead visible during playback
  if (engine.playing) {
    const vis = tlScrollArea.clientWidth;
    const sl = tlScrollArea.scrollLeft;
    if (x < sl || x > sl + vis - 60) {
      tlScrollArea.scrollLeft = x - vis * 0.2;
    }
  }
}

/* ── Zoom ── */

function setZoom(idx) {
  idx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx));
  zoomIdx = idx;
  pxPerSec = PX_PER_SEC_BASE * ZOOM_LEVELS[idx];
  document.getElementById('zoomLabel').textContent = ZOOM_LEVELS[idx] + '×';
  updateContentSize();
  refreshAllClips();
  updateStatusBar();
}

/* ── Timeline drag-over (from file panel) ── */

let _dropLayerIdx = -1;

function onTimelineDragOver(e) {
  // Only accept our custom file data
  if (!e.dataTransfer.types.includes('text/x-mashroom-file')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';

  // Highlight target layer
  const rect = tlScrollArea.getBoundingClientRect();
  const y = e.clientY - rect.top + tlScrollArea.scrollTop;
  const idx = Math.min(state.layers.length - 1, Math.max(0, Math.floor(y / LAYER_H)));
  if (idx !== _dropLayerIdx) {
    clearDropHighlight();
    _dropLayerIdx = idx;
    const bg = tlContent.querySelector(`.layer-bg-row[data-layer-idx="${idx}"]`);
    if (bg) bg.classList.add('drop-target');
  }

  // Hide empty message during drag
  const em = document.getElementById('tlEmptyMsg');
  if (em) em.style.display = 'none';
}

function onTimelineDragLeave(e) {
  // Only clear if leaving the scroll area entirely
  if (e.relatedTarget && tlScrollArea.contains(e.relatedTarget)) return;
  clearDropHighlight();
}

function onTimelineDrop(e) {
  e.preventDefault();
  clearDropHighlight();

  const fileId = Number(e.dataTransfer.getData('text/x-mashroom-file'));
  if (!fileId || !state.files.has(fileId)) {
    // Maybe external file drop → import
    const files = Array.from(e.dataTransfer.files);
    if (files.length) importFiles(files);
    return;
  }

  const file = state.files.get(fileId);
  const rect = tlScrollArea.getBoundingClientRect();
  const x = e.clientX - rect.left + tlScrollArea.scrollLeft;
  const y = e.clientY - rect.top + tlScrollArea.scrollTop;

  let startTime = Math.max(0, x / pxPerSec);
  if (snapEnabled) startTime = snap(startTime);

  let layerIdx = Math.floor(y / LAYER_H);
  layerIdx = Math.max(0, Math.min(state.layers.length - 1, layerIdx));
  const layer = state.layers[layerIdx];
  if (!layer) return;

  addClip(fileId, layer.id, startTime, file.duration);
  setStatus(`Added "${file.name}" to ${layer.name}`);
}

function clearDropHighlight() {
  _dropLayerIdx = -1;
  tlContent.querySelectorAll('.layer-bg-row.drop-target').forEach(el => el.classList.remove('drop-target'));
  // Re-show empty message if no clips
  const em = document.getElementById('tlEmptyMsg');
  if (em) em.style.display = state.clips.length ? 'none' : '';
}

/* ═══════════════════════════════════════════════════════════
   LAYER MANAGEMENT
   ═══════════════════════════════════════════════════════════ */

function initLayers() {
  document.getElementById('btnAddLayer').addEventListener('click', () => {
    const n = state.layers.length + 1;
    addLayer('Layer ' + n);
  });
}

function addLayer(name) {
  const id = uid();
  const color = LAYER_COLORS[(state.layers.length) % LAYER_COLORS.length];
  const layer = { id, name, color, muted: false, solo: false, volume: 0.8, pan: 0 };
  state.layers.push(layer);
  engine.createLayerNodes(layer);
  renderLayerHeader(layer);
  renderLayerBg(layer);
  updateContentSize();
  updateStatusBar();
  state.dirty = true;
  return layer;
}

function removeLayer(layerId) {
  const idx = layerIndex(layerId);
  if (idx === -1) return;
  // Remove all clips on this layer
  const layerClips = state.clips.filter(c => c.layerId === layerId);
  for (const c of layerClips) removeClip(c.id);
  // Remove audio nodes
  engine.removeLayerNodes(layerId);
  // Remove from state
  state.layers.splice(idx, 1);
  // Rebuild all layer headers + backgrounds (indices shifted)
  rebuildLayerUI();
  updateContentSize();
  updateStatusBar();
  state.dirty = true;
}

function renderLayerHeader(layer) {
  const idx = layerIndex(layer.id);
  const el = document.createElement('div');
  el.className = 'layer-header';
  el.dataset.layerId = layer.id;

  el.innerHTML = `
    <div class="layer-header-color-bar" style="background:${layer.color}"></div>
    <div class="layer-header-body">
      <div class="layer-header-top">
        <input class="layer-name-input" type="text" value="${escapeHtml(layer.name)}" spellcheck="false">
        <div class="layer-btns">
          <button class="layer-btn layer-btn-mute" title="Mute">M</button>
          <button class="layer-btn layer-btn-solo" title="Solo">S</button>
          <button class="layer-btn layer-btn-del" title="Remove layer">
            <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="layer-header-bottom">
        <div class="layer-vol-group">
          <span class="layer-vol-label">VOL</span>
          <input type="range" class="layer-vol-slider" min="0" max="100" value="${Math.round(layer.volume * 100)}">
          <span class="layer-vol-val">${Math.round(layer.volume * 100)}</span>
        </div>
      </div>
    </div>
  `;

  // Events
  el.querySelector('.layer-name-input').addEventListener('input', e => {
    layer.name = e.target.value;
    state.dirty = true;
  });

  const btnMute = el.querySelector('.layer-btn-mute');
  btnMute.addEventListener('click', () => {
    layer.muted = !layer.muted;
    btnMute.classList.toggle('active', layer.muted);
    engine.setLayerMute(layer.id, layer.muted);
    state.dirty = true;
  });

  const btnSolo = el.querySelector('.layer-btn-solo');
  btnSolo.addEventListener('click', () => {
    layer.solo = !layer.solo;
    btnSolo.classList.toggle('active', layer.solo);
    state.dirty = true;
  });

  el.querySelector('.layer-btn-del').addEventListener('click', () => {
    if (state.layers.length <= 1) { setStatus('Need at least one layer.'); return; }
    if (!confirm(`Delete "${layer.name}" and its clips?`)) return;
    removeLayer(layer.id);
  });

  const volSlider = el.querySelector('.layer-vol-slider');
  const volVal = el.querySelector('.layer-vol-val');
  volSlider.addEventListener('input', () => {
    const v = +volSlider.value / 100;
    layer.volume = v;
    volVal.textContent = volSlider.value;
    engine.setLayerVolume(layer.id, layer.muted ? 0 : v);
    state.dirty = true;
  });

  // Insert before the add-layer row
  const addRow = document.getElementById('tlAddLayerRow');
  tlLayerHeaders.insertBefore(el, addRow);
}

function renderLayerBg(layer) {
  const idx = layerIndex(layer.id);
  const bg = document.createElement('div');
  bg.className = 'layer-bg-row';
  bg.dataset.layerId = layer.id;
  bg.dataset.layerIdx = idx;
  bg.style.top = (idx * LAYER_H) + 'px';
  bg.style.height = LAYER_H + 'px';
  tlContent.insertBefore(bg, tlPlayhead);
}

function rebuildLayerUI() {
  // Remove all existing headers (except add-layer row) and bg rows
  tlLayerHeaders.querySelectorAll('.layer-header').forEach(el => el.remove());
  tlContent.querySelectorAll('.layer-bg-row').forEach(el => el.remove());

  for (const layer of state.layers) {
    renderLayerHeader(layer);
    renderLayerBg(layer);
  }

  // Re-position all clip elements (layer indices may have shifted)
  refreshAllClips();
}

/* ═══════════════════════════════════════════════════════════
   CLIP MANAGEMENT
   ═══════════════════════════════════════════════════════════ */

function addClip(fileId, layerId, startTime, duration) {
  const file = state.files.get(fileId);
  if (!file) return null;
  const id = uid();
  const clip = { id, fileId, layerId, startTime, duration: duration || file.duration, trimStart: 0 };
  state.clips.push(clip);
  renderClip(clip);
  updateContentSize();
  document.getElementById('tlEmptyMsg').style.display = 'none';
  updateStatusBar();
  state.dirty = true;
  return clip;
}

function removeClip(clipId) {
  const idx = state.clips.findIndex(c => c.id === clipId);
  if (idx === -1) return;
  state.clips.splice(idx, 1);
  state.selection.delete(clipId);
  const el = getClipEl(clipId);
  if (el) el.remove();
  updateContentSize();
  if (!state.clips.length) document.getElementById('tlEmptyMsg').style.display = '';
  updateStatusBar();
  state.dirty = true;
}

function getClipEl(clipId) {
  return tlContent.querySelector(`.clip[data-clip-id="${clipId}"]`);
}

function clipLeft(clip)  { return clip.startTime * pxPerSec; }
function clipTop(clip)   { return layerIndex(clip.layerId) * LAYER_H + 1; }
function clipWidth(clip) { return Math.max(MIN_CLIP_PX, clip.duration * pxPerSec); }

function renderClip(clip) {
  const file  = state.files.get(clip.fileId);
  const layer = state.layers.find(l => l.id === clip.layerId);
  if (!file || !layer) return;

  const el = document.createElement('div');
  el.className = 'clip';
  el.dataset.clipId = clip.id;
  el.style.setProperty('--clip-color', layer.color);
  el.style.left   = clipLeft(clip) + 'px';
  el.style.top    = clipTop(clip)  + 'px';
  el.style.width  = clipWidth(clip) + 'px';
  el.style.height = (LAYER_H - 2) + 'px';

  el.innerHTML = `
    <div class="clip-bg"></div>
    <canvas class="clip-wave-canvas"></canvas>
    <div class="clip-label">
      <span class="clip-label-text">${escapeHtml(file.name)}</span>
    </div>
    <div class="clip-resize-handle"></div>
  `;

  // Draw waveform
  requestAnimationFrame(() => {
    const canvas = el.querySelector('.clip-wave-canvas');
    drawPeaks(canvas, file.peaks, layer.color, {
      trimStart: clip.trimStart,
      duration: clip.duration,
      fileDuration: file.duration,
    });
  });

  attachClipInteractions(el, clip);
  tlContent.insertBefore(el, tlPlayhead);
}

function refreshClipEl(clip) {
  const el = getClipEl(clip.id);
  if (!el) return;
  el.style.left  = clipLeft(clip)  + 'px';
  el.style.top   = clipTop(clip)   + 'px';
  el.style.width = clipWidth(clip) + 'px';
  // Redraw waveform if size changed
  const file = state.files.get(clip.fileId);
  const layer = state.layers.find(l => l.id === clip.layerId);
  if (file && layer) {
    const canvas = el.querySelector('.clip-wave-canvas');
    requestAnimationFrame(() => drawPeaks(canvas, file.peaks, layer.color, {
      trimStart: clip.trimStart, duration: clip.duration, fileDuration: file.duration,
    }));
  }
}

function refreshAllClips() {
  for (const clip of state.clips) refreshClipEl(clip);
}

/* ═══════════════════════════════════════════════════════════
   CLIP INTERACTIONS  (drag move, drag resize, selection)
   ═══════════════════════════════════════════════════════════ */

function attachClipInteractions(el, clip) {
  const resizeHandle = el.querySelector('.clip-resize-handle');

  // ── Move drag ──
  el.addEventListener('mousedown', e => {
    if (e.target === resizeHandle) return; // handled below
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    // Selection
    if (!e.shiftKey && !state.selection.has(clip.id)) deselectAll();
    if (e.shiftKey) toggleSelect(clip.id);
    else selectClip(clip.id);

    // Collect all selected clips' original state for multi-drag
    const selected = state.clips.filter(c => state.selection.has(c.id));
    const primary  = clip;
    const snapshots = selected.map(c => ({
      clip: c, origStart: c.startTime, origLayerIdx: layerIndex(c.layerId),
    }));

    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    el.classList.add('dragging');

    const onMove = e => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;

      const dTime  = dx / pxPerSec;
      const dLayer = Math.round(dy / LAYER_H);

      for (const s of snapshots) {
        let newStart = Math.max(0, s.origStart + dTime);
        if (snapEnabled) newStart = snap(newStart);
        const newLIdx = Math.max(0, Math.min(state.layers.length - 1, s.origLayerIdx + dLayer));

        s.clip.startTime = newStart;
        s.clip.layerId   = state.layers[newLIdx].id;

        const cEl = getClipEl(s.clip.id);
        if (cEl) {
          cEl.style.left = clipLeft(s.clip) + 'px';
          cEl.style.top  = clipTop(s.clip)  + 'px';
          // Update clip color if layer changed
          const layer = state.layers[newLIdx];
          cEl.style.setProperty('--clip-color', layer.color);
        }
      }
      updateContentSize();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('dragging');
      if (moved) {
        for (const s of snapshots) refreshClipEl(s.clip);
        updateContentSize();
        state.dirty = true;
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Resize drag (right handle) ──
  resizeHandle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const origDur = clip.duration;
    const startX  = e.clientX;
    const file    = state.files.get(clip.fileId);
    const maxDur  = file ? file.duration - clip.trimStart : Infinity;

    el.classList.add('resizing');

    const onMove = e => {
      const dx = e.clientX - startX;
      let newDur = Math.max(0.1, origDur + dx / pxPerSec);
      newDur = Math.min(newDur, maxDur);
      clip.duration = newDur;
      el.style.width = clipWidth(clip) + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('resizing');
      refreshClipEl(clip);
      updateContentSize();
      state.dirty = true;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Context menu ──
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.selection.has(clip.id)) { deselectAll(); selectClip(clip.id); }
    showCtxMenu(e.clientX, e.clientY, 'clip');
  });
}

/* Click on empty timeline background — deselect / marquee */
function onTimelineMouseDown(e) {
  if (e.target !== tlScrollArea && e.target !== tlContent &&
      !e.target.classList.contains('layer-bg-row')) return;
  if (e.button !== 0) return;

  deselectAll();

  // Marquee selection
  const rect  = tlScrollArea.getBoundingClientRect();
  const startX = e.clientX - rect.left + tlScrollArea.scrollLeft;
  const startY = e.clientY - rect.top  + tlScrollArea.scrollTop;
  const marquee = document.getElementById('selMarquee');
  marquee.removeAttribute('hidden');
  marquee.style.left = startX + 'px'; marquee.style.top  = startY + 'px';
  marquee.style.width = '0'; marquee.style.height = '0';

  const onMove = e => {
    const cx = e.clientX - rect.left + tlScrollArea.scrollLeft;
    const cy = e.clientY - rect.top  + tlScrollArea.scrollTop;
    const x1 = Math.min(startX, cx), y1 = Math.min(startY, cy);
    const x2 = Math.max(startX, cx), y2 = Math.max(startY, cy);
    marquee.style.left   = x1 + 'px'; marquee.style.top    = y1 + 'px';
    marquee.style.width  = (x2 - x1) + 'px'; marquee.style.height = (y2 - y1) + 'px';

    // Hit-test clips
    deselectAll(true);
    for (const clip of state.clips) {
      const cl = clipLeft(clip), ct = clipTop(clip);
      const cr = cl + clipWidth(clip), cb = ct + LAYER_H - 2;
      if (cl < x2 && cr > x1 && ct < y2 && cb > y1) selectClip(clip.id, true);
    }
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    marquee.setAttribute('hidden', '');
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

/* ═══════════════════════════════════════════════════════════
   SELECTION
   ═══════════════════════════════════════════════════════════ */

function selectClip(clipId, silent) {
  state.selection.add(clipId);
  const el = getClipEl(clipId);
  if (el) el.classList.add('selected');
  if (!silent) updateSelectionStatus();
}

function toggleSelect(clipId) {
  if (state.selection.has(clipId)) {
    state.selection.delete(clipId);
    const el = getClipEl(clipId);
    if (el) el.classList.remove('selected');
  } else {
    selectClip(clipId);
  }
  updateSelectionStatus();
}

function deselectAll(silent) {
  for (const id of state.selection) {
    const el = getClipEl(id);
    if (el) el.classList.remove('selected');
  }
  state.selection.clear();
  if (!silent) updateSelectionStatus();
}

function selectAll() {
  for (const clip of state.clips) selectClip(clip.id, true);
  updateSelectionStatus();
}

function updateSelectionStatus() {
  const n = state.selection.size;
  const el = document.getElementById('statSelection');
  if (el) el.textContent = n ? `${n} selected` : '';
}

/* ═══════════════════════════════════════════════════════════
   CLIPBOARD  (cut / copy / paste / delete)
   ═══════════════════════════════════════════════════════════ */

function copySelected() {
  const selected = state.clips.filter(c => state.selection.has(c.id));
  if (!selected.length) return;
  const earliest = Math.min(...selected.map(c => c.startTime));
  state.clipboard = selected.map(c => ({
    fileId:      c.fileId,
    layerId:     c.layerId,
    relTime:     c.startTime - earliest,
    duration:    c.duration,
    trimStart:   c.trimStart,
    layerOffset: layerIndex(c.layerId),
  }));
  setStatus(`Copied ${selected.length} clip(s)`);
}

function cutSelected() {
  copySelected();
  const ids = [...state.selection];
  deselectAll();
  for (const id of ids) removeClip(id);
  setStatus(`Cut ${ids.length} clip(s)`);
}

function pasteClips() {
  if (!state.clipboard.length) return;
  const pasteAt = engine.playhead;
  deselectAll();
  for (const snap of state.clipboard) {
    const layer = state.layers.find(l => l.id === snap.layerId)
      || state.layers[Math.min(snap.layerOffset, state.layers.length - 1)]
      || state.layers[0];
    if (!layer || !state.files.has(snap.fileId)) continue;
    const clip = addClip(snap.fileId, layer.id, pasteAt + snap.relTime, snap.duration);
    if (clip) { clip.trimStart = snap.trimStart; selectClip(clip.id, true); }
  }
  updateSelectionStatus();
  setStatus(`Pasted ${state.clipboard.length} clip(s)`);
}

function deleteSelected() {
  const ids = [...state.selection];
  if (!ids.length) return;
  deselectAll();
  for (const id of ids) removeClip(id);
  setStatus(`Deleted ${ids.length} clip(s)`);
}

/* ═══════════════════════════════════════════════════════════
   TRANSPORT
   ═══════════════════════════════════════════════════════════ */

function initTransport() {
  document.getElementById('btnPlay').addEventListener('click', () => {
    if (engine.playing) { engine.pause(); setPlayState(false); }
    else {
      if (!state.clips.length) { setStatus('Add some clips first!'); return; }
      engine.play(); setPlayState(true);
    }
  });
  document.getElementById('btnStop').addEventListener('click', () => {
    engine.stop(); setPlayState(false);
  });
  document.getElementById('btnRestart').addEventListener('click', () => {
    const was = engine.playing;
    engine.stop(); setPlayState(false);
    if (was) { engine.play(); setPlayState(true); }
  });

  document.getElementById('masterVol').addEventListener('input', e => {
    engine.setMasterVolume(+e.target.value);
    document.getElementById('masterVolVal').textContent = e.target.value + '%';
  });

  engine.onTick = sec => { updateTimeDisplay(sec); drawPlayhead(sec); };
  engine.onEnd  = ()  => setPlayState(false);
}

function setPlayState(playing) {
  const btn  = document.getElementById('btnPlay');
  btn.querySelector('.icon-play').style.display  = playing ? 'none' : '';
  btn.querySelector('.icon-pause').style.display = playing ? '' : 'none';
  btn.classList.toggle('playing', playing);
}

function updateTimeDisplay(sec) {
  const m  = Math.floor(sec / 60).toString().padStart(2, '0');
  const s  = Math.floor(sec % 60).toString().padStart(2, '0');
  const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
  document.getElementById('timeMin').textContent = m;
  document.getElementById('timeSec').textContent = s;
  document.getElementById('timeMs').textContent  = ms;
}

/* ═══════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════ */

function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const ctrl = e.ctrlKey || e.metaKey;

    switch (true) {
      case e.code === 'Space':
        e.preventDefault();
        document.getElementById('btnPlay').click();
        break;
      case e.code === 'Escape':
        engine.stop(); setPlayState(false);
        break;
      case e.code === 'Home':
        e.preventDefault();
        document.getElementById('btnRestart').click();
        break;
      case ctrl && e.key === 's':
        e.preventDefault(); saveProject();
        break;
      case ctrl && e.key === 'a':
        e.preventDefault(); selectAll();
        break;
      case ctrl && e.key === 'c':
        e.preventDefault(); copySelected();
        break;
      case ctrl && e.key === 'x':
        e.preventDefault(); cutSelected();
        break;
      case ctrl && e.key === 'v':
        e.preventDefault(); pasteClips();
        break;
      case ctrl && e.key === 'z':
        e.preventDefault(); setStatus('Undo not yet implemented');
        break;
      case e.key === 'Delete' || e.key === 'Backspace':
        e.preventDefault(); deleteSelected();
        break;
      case e.key === '+' || e.key === '=':
        if (ctrl) { e.preventDefault(); setZoom(zoomIdx + 1); }
        break;
      case e.key === '-':
        if (ctrl) { e.preventDefault(); setZoom(zoomIdx - 1); }
        break;
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   CONTEXT MENU
   ═══════════════════════════════════════════════════════════ */

function showCtxMenu(x, y, context) {
  const menu = document.getElementById('ctxMenu');
  const paste = document.getElementById('ctxPaste');
  paste.disabled = !state.clipboard.length;

  menu.removeAttribute('hidden');
  // Keep within viewport
  const mw = 170, mh = 140;
  menu.style.left = Math.min(x, window.innerWidth  - mw) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - mh) + 'px';

  // Bind action once
  const handler = e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    hideCtxMenu();
    if (action === 'cut')    cutSelected();
    else if (action === 'copy')   copySelected();
    else if (action === 'paste')  pasteClips();
    else if (action === 'delete') deleteSelected();
  };
  menu.addEventListener('click', handler, { once: true });
}

function hideCtxMenu() {
  document.getElementById('ctxMenu').setAttribute('hidden', '');
}

document.addEventListener('click',       hideCtxMenu);
document.addEventListener('contextmenu', e => { if (!e.target.closest('.clip')) hideCtxMenu(); });

/* ═══════════════════════════════════════════════════════════
   SAVE & EXPORT
   ═══════════════════════════════════════════════════════════ */

function initSaveExport() {
  document.getElementById('btnSave').addEventListener('click', saveProject);
  document.getElementById('btnExport').addEventListener('click', exportWav);
}

function saveProject() {
  if (!state.clips.length) { setStatus('Nothing to save.'); return; }
  const name = document.getElementById('projectName').value || 'Untitled';
  const key  = 'project_' + Date.now();
  const data = {
    name, savedAt: Date.now(),
    tracks: state.clips.length,
    layers: state.layers.map(l => ({ id: l.id, name: l.name, color: l.color })),
  };
  const save = fn => { try { fn(); setStatus('Project saved.'); state.dirty = false; } catch (_) {} };
  if (typeof chrome !== 'undefined' && chrome.storage)
    chrome.storage.local.set({ [key]: data }, () => { setStatus('Project saved.'); state.dirty = false; });
  else save(() => localStorage.setItem(key, JSON.stringify(data)));
}

async function exportWav() {
  if (!state.clips.length) { setStatus('No clips to export.'); return; }
  const modal    = document.getElementById('exportModal');
  const progress = document.getElementById('exportProgressBar');
  const statusTx = document.getElementById('exportStatusText');
  modal.removeAttribute('hidden');

  const wasPlaying = engine.playing;
  if (wasPlaying) { engine.pause(); setPlayState(false); }

  try {
    progress.style.width = '0%';
    statusTx.textContent = 'Rendering audio…';
    const blob = await engine.exportWav(pct => {
      progress.style.width = pct + '%';
      if (pct >= 80) statusTx.textContent = 'Encoding WAV…';
    });
    const name = (document.getElementById('projectName').value || 'mashroom-mix')
      .replace(/[^a-z0-9_\-\s]/gi, '_');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name + '.wav'; a.click();
    URL.revokeObjectURL(url);
    setStatus('Export complete!');
  } catch (err) {
    statusTx.textContent = 'Export failed: ' + err.message;
    console.error(err);
  } finally {
    setTimeout(() => modal.setAttribute('hidden', ''), 1400);
  }
}

/* ═══════════════════════════════════════════════════════════
   STATUS BAR
   ═══════════════════════════════════════════════════════════ */

function setStatus(msg) {
  const el = document.getElementById('statusMsg');
  if (el) el.textContent = msg;
}

function updateStatusBar() {
  const nL = state.layers.length;
  const nC = state.clips.length;
  const dur = engine.totalDuration();
  const m = Math.floor(dur / 60);
  const s = Math.floor(dur % 60).toString().padStart(2, '0');
  document.getElementById('statLayers').textContent   = `${nL} layer${nL !== 1 ? 's' : ''}`;
  document.getElementById('statClips').textContent    = `${nC} clip${nC !== 1 ? 's' : ''}`;
  document.getElementById('statDuration').textContent = `${m}:${s}`;
}

/* ═══════════════════════════════════════════════════════════
   GLOBAL DRAG-DROP  (external files dropped anywhere)
   ═══════════════════════════════════════════════════════════ */

function initGlobalDrop() {
  const overlay = document.getElementById('dropOverlay');
  let depth = 0;

  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    depth++;
    overlay.classList.add('active');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; overlay.classList.remove('active'); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0; overlay.classList.remove('active');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) importFiles(files);
  });
}

/* ═══════════════════════════════════════════════════════════
   PROJECT NAME  (dirty flag)
   ═══════════════════════════════════════════════════════════ */

function initProjectName() {
  document.getElementById('projectName').addEventListener('input', () => { state.dirty = true; });
  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ═══════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initTimeline();
  initFilePanel();
  initLayers();
  initTransport();
  initKeyboard();
  initSaveExport();
  initGlobalDrop();
  initProjectName();

  // Start with 2 default layers
  addLayer('Layer 1');
  addLayer('Layer 2');

  setStatus('Ready — import audio files and drag them onto the timeline layers');
});
