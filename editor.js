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
  files: new Map(),       // id → { id, name, buffer, duration, color, peaks }
  layers: [],             // [{ id, name, color, muted, solo, volume, pan }]
  clips: [],              // [{ id, fileId, layerId, startTime, duration, trimStart }]
  selection: new Set(),   // clip ids
  clipboard: [],          // [{ fileId, relTime, duration, trimStart, layerOffset }]
  activeLayerId: null,    // currently selected layer (for H-key range marking)
  dirty: false,
};

/* ── Undo / redo stacks ── */
const undoStack = [];
const redoStack = [];
const MAX_UNDO  = 50;

function _snapshot() {
  return {
    clips:         state.clips.map(c => ({ ...c })),
    layers:        state.layers.map(l => ({ ...l })),
    activeLayerId: state.activeLayerId,
  };
}

function pushUndo() {
  undoStack.push(_snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  _updateUndoButtons();
}

function _commitUndo(snap) {
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  _updateUndoButtons();
}

function applySnapshot(snapshot) {
  if (engine.playing) { engine.stop(); setPlayState(false); }

  state.clips         = snapshot.clips.map(c => ({ ...c }));
  state.layers        = snapshot.layers.map(l => ({ ...l }));
  state.activeLayerId = snapshot.activeLayerId;

  // Re-sync audio engine layer nodes
  engine.layerNodes.forEach((_, id) => engine.removeLayerNodes(id));
  if (engine.ctx) {
    for (const layer of state.layers) engine.createLayerNodes(layer);
  }

  // Clear range if its layer no longer exists
  if (range.layerId && !state.layers.find(l => l.id === range.layerId)) clearRange();

  deselectAll(true);
  rebuildLayerUI();
  updateContentSize();
  updateStatusBar();
  if (state.activeLayerId) setActiveLayer(state.activeLayerId);
  state.dirty = true;
}

function undo() {
  if (!undoStack.length) { setStatus('Nothing to undo'); return; }
  redoStack.push(_snapshot());
  applySnapshot(undoStack.pop());
  _updateUndoButtons();
  setStatus(`Undo  (${undoStack.length} step${undoStack.length !== 1 ? 's' : ''} remaining)`);
}

function redo() {
  if (!redoStack.length) { setStatus('Nothing to redo'); return; }
  undoStack.push(_snapshot());
  applySnapshot(redoStack.pop());
  _updateUndoButtons();
  setStatus(`Redo  (${redoStack.length} step${redoStack.length !== 1 ? 's' : ''} remaining)`);
}

function _updateUndoButtons() {
  const u = document.getElementById('btnUndo');
  const r = document.getElementById('btnRedo');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

/* Range selection state — one contiguous highlighted region on one layer */
const range = {
  layerId:  null,    // which layer the range is on
  pending:  null,    // time of first Ctrl+Click (waiting for 2nd)
  start:    null,    // confirmed range start (seconds)
  end:      null,    // confirmed range end   (seconds)
  inverted: false,   // true after Ctrl+I
  get active() { return this.start !== null && this.end !== null; },
};

/* ── Active layer ── */
function setActiveLayer(layerId) {
  state.activeLayerId = layerId;
  document.querySelectorAll('.layer-header').forEach(el => {
    el.classList.toggle('active', String(el.dataset.layerId) === String(layerId));
  });
  tlContent && tlContent.querySelectorAll('.layer-bg-row').forEach(el => {
    el.classList.toggle('active', String(el.dataset.layerId) === String(layerId));
  });
}

/* Helper: snap a time value to the grid */
function snap(t) {
  if (!snapEnabled) return Math.max(0, t);
  return Math.max(0, Math.round(t / SNAP_SEC) * SNAP_SEC);
}

function layerIndex(layerId) {
  return state.layers.findIndex(l => l.id === layerId);
}

function _panLabel(v) {
  const pct = Math.round(Math.abs(v) * 100);
  if (pct === 0) return 'C';
  return (v < 0 ? 'L' : 'R') + pct;
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

  /* Ensure every current layer has audio nodes (called before play, safe after undo) */
  ensureLayerNodes() {
    for (const layer of state.layers) {
      if (!this.layerNodes.has(layer.id)) this.createLayerNodes(layer);
    }
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
    this.ensureLayerNodes();
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

      const rate     = clip.playbackRate || 1;
      const clipOff  = offset - clip.startTime;
      const bufStart = clip.trimStart + Math.max(0, clipOff) * rate;
      const remaining = clip.duration - Math.max(0, clipOff);
      if (remaining <= 0) continue;

      const when = clipOff < 0
        ? this.ctx.currentTime + (-clipOff)
        : this.ctx.currentTime;

      const src = this.ctx.createBufferSource();
      src.buffer = file.buffer;
      src.playbackRate.value = rate;
      src.connect(nodes.gain);
      src.start(when, bufStart, remaining * rate);  // duration in buffer-time = wall-clock * rate
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
      src.playbackRate.value = clip.playbackRate || 1;
      src.connect(dest);
      src.start(clip.startTime, clip.trimStart, clip.duration * (clip.playbackRate || 1));
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

/** Pre-compute peak data for fast drawing (once per file).
 *  Runs in async chunks to avoid blocking the UI thread on long files. */
async function computePeaks(audioBuffer, buckets) {
  buckets = buckets || WAVEFORM_BUCKETS;
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.ceil(data.length / buckets));
  const peaks = new Float32Array(buckets);
  const CHUNK = 80;  // buckets per slice before yielding
  for (let i = 0; i < buckets; i += CHUNK) {
    const end = Math.min(buckets, i + CHUNK);
    for (let b = i; b < end; b++) {
      let mx = 0;
      const base = b * step;
      for (let j = 0; j < step; j++) {
        const val = Math.abs(data[base + j] || 0);
        if (val > mx) mx = val;
      }
      peaks[b] = mx;
    }
    // Yield to the browser between chunks so the UI stays responsive
    await new Promise(r => setTimeout(r, 0));
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
  const { trimStart = 0, duration, fileDuration, bg = 'transparent', w: wHint, h: hHint } = opts || {};
  const dpr = window.devicePixelRatio || 1;
  // Use caller-supplied dimensions when available to avoid forced synchronous layout.
  const w = wHint !== undefined ? wHint : canvas.clientWidth;
  const h = hHint !== undefined ? hHint : canvas.clientHeight;
  if (w === 0 || h === 0) return;

  // Only reallocate the canvas bitmap when the size actually changes —
  // resetting canvas.width/height destroys the GPU texture and is expensive.
  const needW = Math.round(w * dpr);
  const needH = Math.round(h * dpr);
  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width  = needW;
    canvas.height = needH;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // safe whether or not bitmap was reset

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
      const peaks = await computePeaks(buffer);
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

  // Ctrl+Wheel → zoom in/out
  document.querySelector('.timeline-panel').addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoomIdx + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

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

/* ── Ruler tick presets ──
   Each preset defines major (labelled), minor and micro tick intervals
   in seconds. The first preset where  major * pxPerSec >= MIN_LABEL_PX
   is chosen, giving finer detail as the user zooms in.            */

const TICK_PRESETS = [
  { major: 0.1,  minor: null,  micro: null  },
  { major: 0.25, minor: 0.05,  micro: null  },
  { major: 0.5,  minor: 0.1,   micro: null  },
  { major: 1,    minor: 0.25,  micro: 0.1   },
  { major: 2,    minor: 0.5,   micro: 0.1   },
  { major: 5,    minor: 1,     micro: 0.25  },
  { major: 10,   minor: 2,     micro: 0.5   },
  { major: 30,   minor: 5,     micro: 1     },
  { major: 60,   minor: 15,    micro: 5     },
  { major: 120,  minor: 30,    micro: 10    },
  { major: 300,  minor: 60,    micro: 15    },
  { major: 600,  minor: 120,   micro: 30    },
];
const MIN_LABEL_PX = 65;

function getTickPreset() {
  return TICK_PRESETS.find(p => p.major * pxPerSec >= MIN_LABEL_PX)
    || TICK_PRESETS[TICK_PRESETS.length - 1];
}

/** Format a ruler timestamp. Shows sub-second precision when interval < 1s. */
function formatRulerTime(sec, majorInterval) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (majorInterval < 1) {
    const ms = Math.round((sec % 1) * 1000);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Iterate tick positions without floating-point drift by working in
 *  integer milliseconds internally.                                  */
function* tickPositions(intervalSec, totalSec) {
  const stepMs = Math.round(intervalSec * 1000);
  if (stepMs <= 0) return;
  for (let ms = 0; ms / 1000 <= totalSec + 0.0001; ms += stepMs) {
    yield ms / 1000;
  }
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
  ctx.fillStyle = '#1E1E1E';
  ctx.fillRect(0, 0, w, RULER_H);

  const totalSec = w / pxPerSec;
  const preset   = getTickPreset();
  ctx.lineWidth  = 1;

  // ── Micro ticks  (very faint, shortest) ──
  if (preset.micro && preset.micro * pxPerSec >= 3) {
    ctx.strokeStyle = '#262626';
    ctx.beginPath();
    for (const s of tickPositions(preset.micro, totalSec)) {
      const x = s * pxPerSec;
      ctx.moveTo(x, 23); ctx.lineTo(x, RULER_H);
    }
    ctx.stroke();
  }

  // ── Minor ticks  (medium grey) ──
  if (preset.minor && preset.minor * pxPerSec >= 4) {
    ctx.strokeStyle = '#383838';
    ctx.beginPath();
    for (const s of tickPositions(preset.minor, totalSec)) {
      const x = s * pxPerSec;
      ctx.moveTo(x, 18); ctx.lineTo(x, RULER_H);
    }
    ctx.stroke();
  }

  // ── Major ticks + labels  (bright, tallest) ──
  ctx.font        = '9px -apple-system, ui-monospace, monospace';
  ctx.strokeStyle = '#555';
  ctx.fillStyle   = '#888';
  ctx.beginPath();
  for (const s of tickPositions(preset.major, totalSec)) {
    const x = s * pxPerSec;
    ctx.moveTo(x, 13); ctx.lineTo(x, RULER_H);
  }
  ctx.stroke();

  for (const s of tickPositions(preset.major, totalSec)) {
    const x = s * pxPerSec;
    ctx.fillText(formatRulerTime(s, preset.major), x + 3, 10);
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
  _updateRangeVisual();
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

  pushUndo();
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
  pushUndo();
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
  pushUndo();
  // Clear range and active layer if they were on this layer
  if (range.layerId === layerId) clearRange();
  if (state.activeLayerId === layerId) state.activeLayerId = null;
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
        <div class="layer-pan-group">
          <span class="layer-pan-label">PAN</span>
          <input type="range" class="layer-pan-slider" min="-100" max="100" value="${Math.round((layer.pan || 0) * 100)}" title="Double-click to reset to center">
          <span class="layer-pan-val">${_panLabel(layer.pan || 0)}</span>
        </div>
      </div>
    </div>
  `;

  // Clicking the header activates this layer
  el.addEventListener('mousedown', e => {
    if (e.target.closest('.layer-btn, .layer-vol-slider, .layer-pan-slider, .layer-name-input')) return;
    setActiveLayer(layer.id);
  });

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

  const panSlider = el.querySelector('.layer-pan-slider');
  const panVal    = el.querySelector('.layer-pan-val');
  panSlider.addEventListener('input', () => {
    const v = +panSlider.value / 100;
    layer.pan = v;
    panVal.textContent = _panLabel(v);
    engine.setLayerPan(layer.id, v);
    state.dirty = true;
  });
  panSlider.addEventListener('dblclick', () => {
    layer.pan = 0;
    panSlider.value = 0;
    panVal.textContent = _panLabel(0);
    engine.setLayerPan(layer.id, 0);
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
  // Clicking the bg row (empty space) activates the layer
  bg.addEventListener('mousedown', () => setActiveLayer(layer.id));
  // Keep active class in sync after rebuild
  if (state.activeLayerId === layer.id) bg.classList.add('active');
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
  _updateRangeVisual();
}

/* ═══════════════════════════════════════════════════════════
   CLIP MANAGEMENT
   ═══════════════════════════════════════════════════════════ */

function addClip(fileId, layerId, startTime, duration) {
  const file = state.files.get(fileId);
  if (!file) return null;
  const id = uid();
  const clip = { id, fileId, layerId, startTime, duration: duration || file.duration, trimStart: 0, playbackRate: 1 };
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
    <span class="clip-speed-badge" hidden></span>
    <div class="clip-trim-left" title="Drag to trim start"></div>
    <div class="clip-resize-handle" title="Drag to trim end">
      <div class="clip-speed-knob" title="Drag to stretch / compress playback speed"></div>
    </div>
  `;

  // Draw waveform — retry until the canvas has been laid out (clientWidth > 0)
  const _drawWhenReady = (attempts) => {
    const canvas = el.querySelector('.clip-wave-canvas');
    if (!canvas) return;
    if (canvas.clientWidth === 0 && attempts > 0) {
      requestAnimationFrame(() => _drawWhenReady(attempts - 1));
      return;
    }
    drawPeaks(canvas, file.peaks, layer.color, {
      trimStart: clip.trimStart,
      duration: clip.duration * (clip.playbackRate || 1),
      fileDuration: file.duration,
    });
  };
  requestAnimationFrame(() => _drawWhenReady(5));
  _refreshClipBadge(el, clip);

  attachClipInteractions(el, clip);
  tlContent.insertBefore(el, tlPlayhead);
}

function _refreshClipBadge(el, clip) {
  const badge = el.querySelector('.clip-speed-badge');
  if (!badge) return;
  const rate = clip.playbackRate || 1;
  if (Math.abs(rate - 1) < 0.005) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    badge.textContent = '×' + rate.toFixed(2);
  }
}

function refreshClipEl(clip) {
  const el = getClipEl(clip.id);
  if (!el) return;
  el.style.left  = clipLeft(clip)  + 'px';
  el.style.top   = clipTop(clip)   + 'px';
  el.style.width = clipWidth(clip) + 'px';
  const file = state.files.get(clip.fileId);
  const layer = state.layers.find(l => l.id === clip.layerId);
  if (file && layer) {
    const canvas = el.querySelector('.clip-wave-canvas');
    requestAnimationFrame(() => drawPeaks(canvas, file.peaks, layer.color, {
      trimStart: clip.trimStart,
      duration: clip.duration * (clip.playbackRate || 1),
      fileDuration: file.duration,
    }));
  }
  _refreshClipBadge(el, clip);
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
    // Let resize/trim/speed handles handle their own mousedown
    if (e.target.closest('.clip-resize-handle, .clip-trim-left, .clip-speed-knob')) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    // Activate this clip's layer
    setActiveLayer(clip.layerId);

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
    const preMovSnap = _snapshot();

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
      // Do NOT call updateContentSize() here — drawRuler() inside it
      // is too expensive to run on every mousemove (causes freeze).
      // Content size is updated correctly in onUp.
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('dragging');
      if (moved) {
        _commitUndo(preMovSnap);
        for (const s of snapshots) refreshClipEl(s.clip);
        updateContentSize();
        state.dirty = true;
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Left-edge trim ──
  const trimLeft = el.querySelector('.clip-trim-left');
  trimLeft.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const preSnap        = _snapshot();
    const origStart      = clip.startTime;
    const origTrimStart  = clip.trimStart;
    const rightEdge      = clip.startTime + clip.duration;
    const startX         = e.clientX;
    const file           = state.files.get(clip.fileId);

    el.classList.add('resizing');

    const file2   = state.files.get(clip.fileId);
    const layer2  = state.layers.find(l => l.id === clip.layerId);
    const canvas2 = el.querySelector('.clip-wave-canvas');
    let _raf2 = null;
    const redrawLeft = () => {
      _raf2 = null;
      if (file2 && layer2) drawPeaks(canvas2, file2.peaks, layer2.color, {
        trimStart: clip.trimStart, duration: clip.duration * (clip.playbackRate || 1), fileDuration: file2.duration,
        w: clipWidth(clip), h: LAYER_H - 2,
      });
    };

    const onMove = ev => {
      const rate = clip.playbackRate || 1;
      const dTimeline = (ev.clientX - startX) / pxPerSec;

      // How far left can we go? Until trimStart hits 0
      const minDelta = -origTrimStart / rate;
      // How far right can we go? Leave at least 0.1s of clip
      const maxDelta = (rightEdge - origStart) - 0.1;

      const delta = Math.max(minDelta, Math.min(maxDelta, dTimeline));

      let newStart = origStart + delta;
      if (snapEnabled) newStart = snap(newStart);
      newStart = Math.max(0, newStart);

      const actualDelta  = newStart - origStart;
      clip.startTime     = newStart;
      clip.trimStart     = Math.max(0, origTrimStart + actualDelta * rate);
      clip.duration      = rightEdge - newStart;

      el.style.left  = clipLeft(clip) + 'px';
      el.style.width = clipWidth(clip) + 'px';
      if (!_raf2) _raf2 = requestAnimationFrame(redrawLeft);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('resizing');
      if (clip.startTime !== origStart) _commitUndo(preSnap);
      refreshClipEl(clip);
      updateContentSize();
      state.dirty = true;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Right-edge trim ──
  resizeHandle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const preResSnap = _snapshot();
    const origDur    = clip.duration;
    const startX     = e.clientX;
    const file       = state.files.get(clip.fileId);
    const rate       = clip.playbackRate || 1;
    // Maximum duration is the remaining audio content adjusted for speed
    const maxDur     = file ? (file.duration - clip.trimStart) / rate : Infinity;

    el.classList.add('resizing');

    const file3   = state.files.get(clip.fileId);
    const layer3  = state.layers.find(l => l.id === clip.layerId);
    const canvas3 = el.querySelector('.clip-wave-canvas');
    let _raf3 = null;
    const redrawRight = () => {
      _raf3 = null;
      if (file3 && layer3) drawPeaks(canvas3, file3.peaks, layer3.color, {
        trimStart: clip.trimStart, duration: clip.duration * (clip.playbackRate || 1), fileDuration: file3.duration,
        w: clipWidth(clip), h: LAYER_H - 2,
      });
    };

    const onMove = e => {
      const dx = e.clientX - startX;
      let newDur = Math.max(0.1, origDur + dx / pxPerSec);
      newDur = Math.min(newDur, maxDur);
      clip.duration = newDur;
      el.style.width = clipWidth(clip) + 'px';
      if (!_raf3) _raf3 = requestAnimationFrame(redrawRight);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('resizing');
      if (clip.duration !== origDur) _commitUndo(preResSnap);
      refreshClipEl(clip);
      updateContentSize();
      state.dirty = true;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Speed knob (bottom of right handle) — stretch / compress ──
  const speedKnob = el.querySelector('.clip-speed-knob');
  speedKnob.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const preKnobSnap  = _snapshot();
    const origDur      = clip.duration;
    const origRate     = clip.playbackRate || 1;
    // Source audio content consumed at current state — stays constant during stretch
    const sourceDur    = origDur * origRate;
    const startX       = e.clientX;

    el.classList.add('resizing');

    const file4   = state.files.get(clip.fileId);
    const layer4  = state.layers.find(l => l.id === clip.layerId);
    const canvas4 = el.querySelector('.clip-wave-canvas');
    let _raf4 = null;
    const redrawSpeed = () => {
      _raf4 = null;
      if (file4 && layer4) drawPeaks(canvas4, file4.peaks, layer4.color, {
        trimStart: clip.trimStart, duration: clip.duration * (clip.playbackRate || 1), fileDuration: file4.duration,
        w: clipWidth(clip), h: LAYER_H - 2,
      });
    };

    const onMove = e => {
      const dx = e.clientX - startX;
      const newDur  = Math.max(0.05, origDur + dx / pxPerSec);
      const newRate = Math.max(0.1, Math.min(10, sourceDur / newDur));
      clip.playbackRate = newRate;
      clip.duration     = sourceDur / newRate;
      el.style.width = clipWidth(clip) + 'px';
      _refreshClipBadge(el, clip);
      if (!_raf4) _raf4 = requestAnimationFrame(redrawSpeed);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      el.classList.remove('resizing');
      if (clip.playbackRate !== origRate) _commitUndo(preKnobSnap);
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
/* ═══════════════════════════════════════════════════════════
   RANGE SELECTION
   ═══════════════════════════════════════════════════════════ */

/** Handle Ctrl+Click on a layer: first click sets pending marker,
 *  second click on the same layer finalises the range.           */
function onLayerCtrlClick(layerId, time) {
  if (range.pending === null || range.layerId !== layerId) {
    // ── First click (or switching layer) ──
    range.layerId  = layerId;
    range.pending  = snapEnabled ? snap(time) : Math.max(0, time);
    range.start    = null;
    range.end      = null;
    range.inverted = false;
    _updateRangeVisual();
    const name = state.layers.find(l => l.id === layerId)?.name || 'layer';
    setStatus(`Range start: ${_fmtSec(range.pending)} on "${name}" — Ctrl+Click again to close range`);
  } else {
    // ── Second click: finalise ──
    const t = snapEnabled ? snap(time) : Math.max(0, time);
    const a = Math.min(range.pending, t);
    const b = Math.max(range.pending, t);
    if (b - a < 0.02) { clearRange(); setStatus('Range too small — cleared'); return; }
    range.start   = a;
    range.end     = b;
    range.pending = null;
    _updateRangeVisual();
    setStatus(`Range: ${_fmtSec(a)} → ${_fmtSec(b)}  (${_fmtDur(b - a)})  ·  Ctrl+X cut · Ctrl+C copy · Ctrl+J new layer · Ctrl+I invert`);
  }
}

function clearRange() {
  range.layerId  = null;
  range.pending  = null;
  range.start    = null;
  range.end      = null;
  range.inverted = false;
  tlContent.querySelectorAll('.range-highlight, .range-pending-marker').forEach(el => el.remove());
}

function _fmtSec(sec) {
  const m = Math.floor(sec / 60), s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}
function _fmtDur(sec) {
  if (sec < 60) return sec.toFixed(2) + 's';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/** Rebuild the range highlight / pending marker divs. */
function _updateRangeVisual() {
  tlContent.querySelectorAll('.range-highlight, .range-pending-marker').forEach(el => el.remove());
  if (!range.layerId) return;

  const idx = layerIndex(range.layerId);
  if (idx === -1) return;
  const top = idx * LAYER_H;

  // Pending marker (thin vertical line)
  if (range.pending !== null) {
    const el = document.createElement('div');
    el.className = 'range-pending-marker';
    el.style.cssText = `left:${range.pending * pxPerSec}px;top:${top}px;height:${LAYER_H}px;`;
    tlContent.insertBefore(el, tlPlayhead);
  }

  // Confirmed range highlight
  if (range.active) {
    const segments = range.inverted ? _invertedSegments() : [[range.start, range.end]];
    for (const [s, e] of segments) {
      const el = document.createElement('div');
      el.className = 'range-highlight' + (range.inverted ? ' inverted' : '');
      const left = s * pxPerSec, w = (e - s) * pxPerSec;
      el.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${LAYER_H}px;`;

      // Duration label
      const lbl = document.createElement('span');
      lbl.className = 'range-highlight-label';
      lbl.textContent = _fmtDur(e - s);
      el.appendChild(lbl);

      // Alt+drag → duplicate to new layer
      el.addEventListener('mousedown', _onRangeHighlightMouseDown);

      tlContent.insertBefore(el, tlPlayhead);
    }
  }
}

/** Returns [[s1,e1], [s2,e2]] for inverted selection on the layer. */
function _invertedSegments() {
  const layerClips = state.clips.filter(c => c.layerId === range.layerId);
  const lo = layerClips.length
    ? Math.min(...layerClips.map(c => c.startTime))
    : 0;
  const hi = layerClips.length
    ? Math.max(...layerClips.map(c => c.startTime + c.duration))
    : (engine.totalDuration() || 30);
  const segs = [];
  if (range.start > lo + 0.01) segs.push([lo, range.start]);
  if (range.end   < hi - 0.01) segs.push([range.end, hi]);
  return segs.length ? segs : [[lo, hi]];
}

/** Alt+drag on a range highlight → drag to create a new layer clone. */
function _onRangeHighlightMouseDown(e) {
  if (!e.altKey || e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();

  // Show ghost
  const ghost = document.createElement('div');
  ghost.className = 'range-ghost';
  const hlEl = e.currentTarget;
  const rect  = hlEl.getBoundingClientRect();
  ghost.style.cssText = `width:${hlEl.offsetWidth}px;height:${LAYER_H - 2}px;left:${rect.left}px;top:${rect.top}px;`;
  document.body.appendChild(ghost);

  const startY = e.clientY;

  const onMove = e => {
    ghost.style.top = (rect.top + e.clientY - startY) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    ghost.remove();
    // Only trigger if dragged more than a tiny bit
    if (Math.abs(e.clientY - startY) > 6) duplicateRangeToNewLayer();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

/* ── Range operations ── */

/** Return clip "pieces" that overlap with the current range (or inverted segments). */
function _rangeSegments() {
  return range.inverted ? _invertedSegments() : [[range.start, range.end]];
}

function _getPiecesInSegments(segments) {
  const pieces = [];
  for (const [s, e] of segments) {
    for (const clip of state.clips) {
      if (clip.layerId !== range.layerId) continue;
      const cs = clip.startTime, ce = cs + clip.duration;
      if (cs >= e || ce <= s) continue;   // no overlap
      const ps = Math.max(cs, s);
      const pe = Math.min(ce, e);
      pieces.push({
        clip,
        pieceStart:     ps,
        pieceEnd:       pe,
        pieceTrimStart: clip.trimStart + (ps - cs),
        pieceDuration:  pe - ps,
        relTime:        ps - s,           // relative to segment start
      });
    }
  }
  return pieces;
}

function copyRange() {
  if (!range.active) return;
  const segs   = _rangeSegments();
  const pieces = _getPiecesInSegments(segs);
  const refStart = segs[0][0];
  state.clipboard = pieces.map(p => ({
    fileId:      p.clip.fileId,
    layerId:     p.clip.layerId,
    relTime:     p.pieceStart - refStart,
    duration:    p.pieceDuration,
    trimStart:   p.pieceTrimStart,
    layerOffset: layerIndex(p.clip.layerId),
  }));
  setStatus(`Copied range (${pieces.length} piece${pieces.length !== 1 ? 's' : ''})`);
}

function cutRange() {
  if (!range.active) return;
  pushUndo();
  copyRange();
  _sliceOutSegments(_rangeSegments());
  clearRange();
  updateContentSize();
  updateStatusBar();
  state.dirty = true;
  setStatus('Cut range');
}

/** Remove clip content within [segStart, segEnd], splitting clips at boundaries. */
function _sliceOutSegments(segments) {
  for (const [s, e] of segments) {
    // Snapshot affected clips before we start modifying
    const affected = state.clips.filter(c => {
      if (c.layerId !== range.layerId) return false;
      return c.startTime < e && c.startTime + c.duration > s;
    }).map(c => ({ ...c }));   // shallow copy of data

    for (const snap of affected) {
      const cs = snap.startTime, ce = cs + snap.duration;
      removeClip(snap.id);
      // Left remnant (before range start)
      if (cs < s) {
        const c = addClip(snap.fileId, snap.layerId, cs, s - cs);
        if (c) c.trimStart = snap.trimStart;
      }
      // Right remnant (after range end)
      if (ce > e) {
        const c = addClip(snap.fileId, snap.layerId, e, ce - e);
        if (c) c.trimStart = snap.trimStart + (e - cs);
      }
    }
  }
}

function duplicateRangeToNewLayer() {
  if (!range.active) return;
  pushUndo();
  const segs   = _rangeSegments();
  const pieces = _getPiecesInSegments(segs);
  if (!pieces.length) { setStatus('No clips in range to duplicate'); return; }
  const newLayer = addLayer('Layer ' + (state.layers.length + 1));
  for (const p of pieces) {
    const c = addClip(p.clip.fileId, newLayer.id, p.pieceStart, p.pieceDuration);
    if (c) c.trimStart = p.pieceTrimStart;
  }
  setStatus(`Created "${newLayer.name}" from range (${pieces.length} clip${pieces.length !== 1 ? 's' : ''})`);
  state.dirty = true;
}

function invertRange() {
  if (!range.active) return;
  range.inverted = !range.inverted;
  _updateRangeVisual();
  setStatus(range.inverted ? 'Selection inverted' : 'Selection restored');
}

function onTimelineMouseDown(e) {
  if (e.target !== tlScrollArea && e.target !== tlContent &&
      !e.target.classList.contains('layer-bg-row')) return;
  if (e.button !== 0) return;

  // Activate the layer that was clicked
  const rect2 = tlScrollArea.getBoundingClientRect();
  const yInContent = e.clientY - rect2.top + tlScrollArea.scrollTop;
  const layerIdx = Math.floor(yInContent / LAYER_H);
  const clickedLayer = state.layers[layerIdx];
  if (clickedLayer) setActiveLayer(clickedLayer.id);

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
  pushUndo();
  copySelected();
  const ids = [...state.selection];
  deselectAll();
  for (const id of ids) removeClip(id);
  setStatus(`Cut ${ids.length} clip(s)`);
}

function pasteClips() {
  if (!state.clipboard.length) return;
  pushUndo();
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
  pushUndo();
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
        if (range.layerId) { clearRange(); setStatus('Range cleared'); }
        else { engine.stop(); setPlayState(false); }
        break;
      case e.key === 'h' || e.key === 'H':
        e.preventDefault();
        if (!state.activeLayerId) {
          setStatus('Select a layer first — click a layer header or row');
        } else {
          onLayerCtrlClick(state.activeLayerId, engine.playhead);
        }
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
        e.preventDefault();
        if (range.active) copyRange(); else copySelected();
        break;
      case ctrl && e.key === 'x':
        e.preventDefault();
        if (range.active) cutRange(); else cutSelected();
        break;
      case ctrl && e.key === 'j':
        e.preventDefault(); duplicateRangeToNewLayer();
        break;
      case ctrl && e.key === 'i':
        e.preventDefault(); invertRange();
        break;
      case ctrl && e.key === 'v':
        e.preventDefault(); pasteClips();
        break;
      case ctrl && e.key === 'z' && !e.shiftKey:
        e.preventDefault(); undo();
        break;
      case ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey)):
        e.preventDefault(); redo();
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
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  _updateUndoButtons();
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
