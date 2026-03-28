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
   (UI code continues in subsequent chunks…)
   ═══════════════════════════════════════════════════════════ */
