'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------
//   Settings
// ---------------------------------------------------------------

const STORAGE_KEY = 'spectrogram.settings';

const DEFAULTS = {
  fftSize: 4096,
  scale: 'log',
  maxFreq: 12000,
  colormap: 'magma',
  speed: 2,
  minDb: -100,
  maxDb: -30,
  imageSeconds: 0, // 0 = fit the visible spectrogram width
};

const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
} catch { /* ignore broken storage */ }

const saveSettings = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));

// ---------------------------------------------------------------
//   Colormaps
// ---------------------------------------------------------------

const COLORMAPS = {
  magma:   ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8761', '#fec287', '#fcfdbf'],
  inferno: ['#000004', '#1f0c48', '#550f6d', '#88226a', '#ba3655', '#e35933', '#f98c0a', '#f9c932', '#fcffa4'],
  viridis: ['#440154', '#472c7a', '#3b518b', '#2c718e', '#21908d', '#27ad81', '#5cc863', '#aadc32', '#fde725'],
  jet:     ['#000080', '#0000ff', '#0080ff', '#00ffff', '#80ff80', '#ffff00', '#ff8000', '#ff0000', '#800000'],
  gray:    ['#000000', '#ffffff'],
};

// Packed as 0xAABBGGRR so it can be written straight into a Uint32 view of ImageData (little-endian).
function buildLut(stops) {
  const rgb = stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const k = Math.min(Math.floor(t), rgb.length - 2);
    const f = t - k;
    const [r, g, b] = [0, 1, 2].map((j) => Math.round(rgb[k][j] + (rgb[k + 1][j] - rgb[k][j]) * f));
    lut[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return lut;
}

let lut = buildLut(COLORMAPS[settings.colormap] || COLORMAPS.magma);

// ---------------------------------------------------------------
//   Elements
// ---------------------------------------------------------------

const wave = $('wave');
const spec = $('spec');
const axis = $('axis');
const waveCtx = wave.getContext('2d');
const specCtx = spec.getContext('2d', { willReadFrequently: false });
const axisCtx = axis.getContext('2d');
const player = $('player');
const cursor = $('cursor');

let dpr = window.devicePixelRatio || 1;

// ---------------------------------------------------------------
//   Audio
// ---------------------------------------------------------------

let audioCtx = null;
let analyser = null;
let bus = null; // every source feeds this; it goes to the analyser and the recorder
let micStream = null;
let micNode = null;
let fileNode = null;
let fileUrl = null;
let source = null; // 'mic' | 'file' | null
let paused = false;

let freqData = new Float32Array(0);
let timeData = new Float32Array(0);

const sampleRate = () => (audioCtx ? audioCtx.sampleRate : 48000);

function ensureContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.smoothingTimeConstant = 0;
    bus = audioCtx.createGain();
    bus.connect(analyser);
    applyFftSize();
    $('sr').textContent = `${audioCtx.sampleRate} Hz`;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function applyFftSize() {
  if (!analyser) return;
  analyser.fftSize = settings.fftSize;
  freqData = new Float32Array(analyser.frequencyBinCount);
  timeData = new Float32Array(analyser.fftSize);
  rebuildRowMap();
  drawAxis();
}

function stopSources() {
  if (micNode) {
    micNode.disconnect();
    micNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (fileNode) {
    player.pause();
    fileNode.disconnect();
  }
  source = null;
  $('btnSaveAudio').hidden = true;
  $('btnMic').classList.remove('active');
  $('btnMic').textContent = 'Микрофон';
}

async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Микрофонът изисква HTTPS или localhost');
    return;
  }
  ensureContext();
  stopSources();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    setStatus(`Няма достъп до микрофона: ${e.message || e.name}`);
    return;
  }
  micNode = audioCtx.createMediaStreamSource(micStream);
  micNode.connect(bus);
  source = 'mic';
  player.hidden = true;
  $('btnMic').classList.add('active');
  $('btnMic').textContent = 'Спри';
  setStatus('Микрофон');
  start();
}

function startFile(file) {
  ensureContext();
  stopSources();
  if (!fileNode) fileNode = audioCtx.createMediaElementSource(player);
  fileNode.connect(bus);
  fileNode.connect(audioCtx.destination);
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(file);
  player.src = fileUrl;
  player.hidden = false;
  player.play().catch((e) => {
    if (e.name !== 'AbortError') setStatus(`Грешка при пускане: ${e.message}`);
  });
  source = 'file';
  setStatus(file.name);
  start();
}

function start() {
  paused = false;
  $('btnPause').disabled = false;
  $('btnPause').textContent = 'Пауза';
  keepAwake(true);
}

function togglePause() {
  if (!source) return;
  paused = !paused;
  $('btnPause').textContent = paused ? 'Продължи' : 'Пауза';
  keepAwake(!paused);
}

const setStatus = (text) => { $('status').textContent = text; };

// Keep the screen on while recording (mostly useful on Android).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or denied */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && source && !paused) keepAwake(true);
});

function stopAll() {
  stopRecording();
  stopSources();
  $('btnPause').disabled = true;
  keepAwake(false);
  setStatus('Спряно');
}

// ---------------------------------------------------------------
//   Saving files
// ---------------------------------------------------------------

const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform());

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

const SAVE_FOLDER = 'Spectrogram';

// Desktop: normal download. Android app: WebView can't download blob: links,
// so the file is written straight into the public Documents/Spectrogram folder.
async function saveBlob(blob, name) {
  if (isNative()) {
    const { Filesystem } = window.Capacitor.Plugins;
    try {
      const perm = await Filesystem.requestPermissions();
      if (perm.publicStorage !== 'granted') {
        setStatus('Няма разрешение за запис в паметта');
        return;
      }
      await Filesystem.writeFile({
        path: `${SAVE_FOLDER}/${name}`,
        data: await blobToBase64(blob),
        directory: 'DOCUMENTS',
        recursive: true,
      });
      setStatus(`Запазено: Documents/${SAVE_FOLDER}/${name}`);
    } catch (e) {
      setStatus(`Грешка при запазване: ${e.message}`);
    }
    return;
  }
  // The Windows launcher stores pictures, recordings and generated sounds in project folders.
  const savable = /\.(png|wav)$/i.test(name);
  if (savable && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      const res = await fetch('/save', {
        method: 'POST',
        headers: { 'X-Filename': name },
        body: blob,
      });
      if (res.ok) {
        setStatus(`Запазено: ${await res.text()}`);
        return;
      }
    } catch { /* opened without server.py: fall back to a browser download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function encodeWav(chunks, rate) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------------------------------------------------------------
//   Recording
// ---------------------------------------------------------------

let recNode = null;
let recSink = null;
let recChunks = [];
let recTimer = null;
let recWorkletLoaded = false;

async function startRecording() {
  if (!source) {
    await startMic();
    if (!source) return;
  }
  if (!recWorkletLoaded) {
    await audioCtx.audioWorklet.addModule('recorder-worklet.js');
    recWorkletLoaded = true;
  }
  recChunks = [];
  recNode = new AudioWorkletNode(audioCtx, 'recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  recNode.port.onmessage = (e) => recChunks.push(e.data);
  // The worklet only runs while connected to the destination, so route it through a muted gain.
  recSink = audioCtx.createGain();
  recSink.gain.value = 0;
  bus.connect(recNode);
  recNode.connect(recSink);
  recSink.connect(audioCtx.destination);

  const started = Date.now();
  const btn = $('btnRec');
  btn.classList.add('active');
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    btn.textContent = `Стоп ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  recTimer = setInterval(tick, 500);
}

function stopRecording() {
  if (!recNode) return;
  clearInterval(recTimer);
  bus.disconnect(recNode);
  recNode.port.postMessage('flush');
  const node = recNode;
  const sink = recSink;
  recNode = null;
  recSink = null;
  $('btnRec').classList.remove('active');
  $('btnRec').textContent = 'Запис';

  // Give the worklet a moment to send its last buffered samples.
  setTimeout(() => {
    node.disconnect();
    sink.disconnect();
    if (!recChunks.length) return;
    saveBlob(encodeWav(recChunks, audioCtx.sampleRate), `zapis-${timestamp()}.wav`);
    recChunks = [];
  }, 150);
}

// ---------------------------------------------------------------
//   Image -> sound
// ---------------------------------------------------------------

const IMAGE_ROWS = 360;
const IMAGE_MAX_COLS = 600;

let generatedAudio = null;

function finishGenerated(out, rate, file) {
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (!peak) {
    setStatus('Картинката е празна (няма светли части)');
    return;
  }
  const gain = 0.9 / peak;
  const fade = Math.round(rate * 0.01);
  for (let i = 0; i < out.length; i++) {
    let g = gain;
    if (i < fade) g *= i / fade;
    else if (i > out.length - fade) g *= (out.length - i) / fade;
    out[i] *= g;
  }
  generatedAudio = encodeWav([out], rate);
  const name = `${file.name.replace(/\.[^.]+$/, '')}-zvuk.wav`;
  startFile(new File([generatedAudio], name, { type: 'audio/wav' }));
  $('btnSaveAudio').hidden = false;
  $('btnSaveAudio').dataset.name = name;
}

// The spectrogram scrolls `speed` CSS pixels per 1/60 s, independent of the display's refresh rate.
const scrollPxPerSecond = () => settings.speed * dpr * 60;

const visibleSeconds = () => spec.width / scrollPxPerSecond();

async function imageToSound(file) {
  setStatus('Превръщам картинката в звук…');
  await new Promise((r) => setTimeout(r, 30));

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    setStatus('Не мога да отворя тази картинка');
    return;
  }

  const rows = IMAGE_ROWS;
  const cols = Math.min(IMAGE_MAX_COLS, bitmap.width);
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const cx = c.getContext('2d');
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, cols, rows);
  cx.drawImage(bitmap, 0, 0, cols, rows);
  const px = cx.getImageData(0, 0, cols, rows).data;

  const bright = new Float32Array(rows * cols);
  let mean = 0;
  for (let i = 0; i < bright.length; i++) {
    const b = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
    bright[i] = b;
    mean += b;
  }
  // Mostly-light pictures (e.g. black text on white) are inverted so the drawing, not the background, sounds.
  if (mean / bright.length > 0.5) for (let i = 0; i < bright.length; i++) bright[i] = 1 - bright[i];

  ensureContext();
  const rate = audioCtx.sampleRate;
  const seconds = settings.imageSeconds || Math.min(30, Math.max(2, visibleSeconds() * 0.85));
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const spc = n / cols;
  const rangeDb = settings.maxDb - settings.minDb;
  const amps = new Float32Array(cols);

  for (let r = 0; r < rows; r++) {
    // Brightness is mapped to dB so grey levels land on matching colours in the spectrogram.
    let any = false;
    for (let col = 0; col < cols; col++) {
      const b = bright[r * cols + col];
      amps[col] = b > 0.04 ? Math.pow(10, ((b - 1) * rangeDb) / 20) : 0;
      if (amps[col]) any = true;
    }
    if (!any) continue;

    const f = Math.max(20, yToFreq(r + 0.5, rows));
    const w = (2 * Math.PI * f) / rate;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const phase = Math.random() * 2 * Math.PI;
    let x = Math.cos(phase);
    let y = Math.sin(phase);

    for (let col = 0; col < cols; col++) {
      const a0 = amps[col];
      const a1 = amps[Math.min(col + 1, cols - 1)];
      if (!a0 && !a1) continue;
      const s0 = Math.round(col * spc);
      const s1 = Math.round((col + 1) * spc);
      const da = (a1 - a0) / (s1 - s0);
      let a = a0;
      for (let i = s0; i < s1; i++) {
        const nx = x * cw - y * sw;
        y = x * sw + y * cw;
        x = nx;
        out[i] += a * y;
        a += da;
      }
      const k = 1 / Math.hypot(x, y);
      x *= k;
      y *= k;
    }
  }

  finishGenerated(out, rate, file);
}

// ---------------------------------------------------------------
//   Frequency <-> pixel mapping
// ---------------------------------------------------------------

function freqRange() {
  const nyquist = sampleRate() / 2;
  const fMax = Math.min(settings.maxFreq || nyquist, nyquist);
  const fMin = settings.scale === 'log' ? 20 : 0;
  return { fMin, fMax };
}

function yToFreq(y, h) {
  const { fMin, fMax } = freqRange();
  const frac = 1 - y / h;
  return settings.scale === 'log'
    ? fMin * Math.pow(fMax / fMin, frac)
    : fMin + (fMax - fMin) * frac;
}

function freqToY(f, h) {
  const { fMin, fMax } = freqRange();
  const frac = settings.scale === 'log'
    ? Math.log(f / fMin) / Math.log(fMax / fMin)
    : (f - fMin) / (fMax - fMin);
  return (1 - frac) * h;
}

// For every pixel row: either a range of FFT bins to take the max of,
// or (when the row is narrower than one bin) a fractional bin to interpolate.
let rowA = new Int32Array(0);
let rowB = new Int32Array(0);
let rowF = new Float32Array(0);

function rebuildRowMap() {
  const h = spec.height;
  const n = freqData.length;
  if (!n) return;
  const binHz = sampleRate() / settings.fftSize;
  rowA = new Int32Array(h);
  rowB = new Int32Array(h);
  rowF = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const fTop = yToFreq(y, h);
    const fBot = yToFreq(y + 1, h);
    rowA[y] = Math.ceil(fBot / binHz);
    rowB[y] = Math.min(Math.floor(fTop / binHz), n - 1);
    rowF[y] = Math.min(yToFreq(y + 0.5, h) / binHz, n - 1.001);
  }
}

// ---------------------------------------------------------------
//   Drawing
// ---------------------------------------------------------------

let colImage = null;

function drawSpecColumn(colW) {
  const w = spec.width;
  const h = spec.height;

  specCtx.drawImage(spec, colW, 0, w - colW, h, 0, 0, w - colW, h);

  if (!colImage || colImage.width !== colW || colImage.height !== h) {
    colImage = specCtx.createImageData(colW, h);
  }
  const px = new Uint32Array(colImage.data.buffer);
  const lo = settings.minDb;
  const k = 255 / Math.max(1, settings.maxDb - settings.minDb);
  const d = freqData;

  for (let y = 0; y < h; y++) {
    let v;
    const a = rowA[y];
    const b = rowB[y];
    if (b >= a) {
      v = d[a];
      for (let i = a + 1; i <= b; i++) if (d[i] > v) v = d[i];
    } else {
      const f = rowF[y];
      const i = f | 0;
      const t = f - i;
      v = d[i] * (1 - t) + d[i + 1] * t;
    }
    let c = ((v - lo) * k) | 0; // -Infinity / NaN become 0
    if (c < 0) c = 0;
    else if (c > 255) c = 255;
    const color = lut[c];
    const o = y * colW;
    for (let x = 0; x < colW; x++) px[o + x] = color;
  }
  specCtx.putImageData(colImage, w - colW, 0);
}

function drawWave() {
  const w = wave.width;
  const h = wave.height;
  const d = timeData;
  const n = d.length;
  const mid = h / 2;

  waveCtx.fillStyle = '#0b0b0e';
  waveCtx.fillRect(0, 0, w, h);
  waveCtx.fillStyle = 'rgba(255,255,255,0.08)';
  waveCtx.fillRect(0, Math.round(mid), w, 1);

  if (!n) return;
  waveCtx.fillStyle = '#4fd1c5';
  const spp = n / w;
  for (let x = 0; x < w; x++) {
    const s = Math.floor(x * spp);
    const e = Math.max(s + 1, Math.floor((x + 1) * spp));
    let mn = 1;
    let mx = -1;
    for (let i = Math.max(0, s - 1); i < e && i < n; i++) {
      const v = d[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const y1 = mid - mx * mid;
    const y2 = mid - mn * mid;
    waveCtx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

const formatFreq = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);

function drawAxis() {
  const w = axis.width;
  const h = axis.height;
  axisCtx.clearRect(0, 0, w, h);

  const { fMin, fMax } = freqRange();
  let ticks;
  if (settings.scale === 'log') {
    ticks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f > fMin && f < fMax);
  } else {
    const step = niceStep(fMax / 8);
    ticks = [];
    for (let f = step; f < fMax; f += step) ticks.push(f);
  }

  axisCtx.font = `${11 * dpr}px system-ui, sans-serif`;
  axisCtx.textBaseline = 'bottom';
  for (const f of ticks) {
    const y = Math.round(freqToY(f, h)) + 0.5;
    if (y < 16 * dpr) continue;
    axisCtx.fillStyle = 'rgba(255,255,255,0.12)';
    axisCtx.fillRect(0, y, w, 1);
    axisCtx.fillStyle = 'rgba(255,255,255,0.85)';
    axisCtx.fillRect(0, y, 8 * dpr, 1);
    axisCtx.fillStyle = 'rgba(0,0,0,0.6)';
    const label = formatFreq(f);
    const tw = axisCtx.measureText(label).width;
    axisCtx.fillRect(10 * dpr, y - 14 * dpr, tw + 6 * dpr, 13 * dpr);
    axisCtx.fillStyle = '#fff';
    axisCtx.fillText(label, 13 * dpr, y - 2 * dpr);
  }
}

// ---------------------------------------------------------------
//   Peak frequency / note
// ---------------------------------------------------------------

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(f) {
  const m = 12 * Math.log2(f / 440) + 69;
  const r = Math.round(m);
  const cents = Math.round((m - r) * 100);
  return `${NOTES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}¢`;
}

function updatePeak() {
  const d = freqData;
  const binHz = sampleRate() / settings.fftSize;
  const { fMax } = freqRange();
  const last = Math.min(d.length - 2, Math.floor(fMax / binHz));
  let best = 2;
  for (let i = 3; i <= last; i++) if (d[i] > d[best]) best = i;

  if (!(d[best] > settings.minDb + 15)) {
    $('peak').textContent = '—';
    return;
  }
  const a = d[best - 1];
  const b = d[best];
  const c = d[best + 1];
  const denom = a - 2 * b + c;
  const offset = denom ? (0.5 * (a - c)) / denom : 0;
  const f = (best + offset) * binHz;
  $('peak').textContent = `${formatFreq(f)}  ${noteName(f)}`;
}

// ---------------------------------------------------------------
//   Main loop
// ---------------------------------------------------------------

let frameCount = 0;
let lastFrameTime = 0;
let scrollRemainder = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  if (!source || paused || !analyser) return;
  analyser.getFloatFrequencyData(freqData);
  analyser.getFloatTimeDomainData(timeData);
  drawWave();
  scrollRemainder += scrollPxPerSecond() * dt;
  const colW = Math.floor(scrollRemainder);
  if (colW > 0) {
    scrollRemainder -= colW;
    drawSpecColumn(colW);
  }
  if (++frameCount % 6 === 0) updatePeak();
}

// ---------------------------------------------------------------
//   Resize
// ---------------------------------------------------------------

function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (c.width === w && c.height === h) return false;
  c.width = w;
  c.height = h;
  return true;
}

function resize() {
  dpr = window.devicePixelRatio || 1;

  // Keep the already drawn spectrogram, stretched to the new size.
  const old = document.createElement('canvas');
  old.width = spec.width;
  old.height = spec.height;
  old.getContext('2d').drawImage(spec, 0, 0);

  fitCanvas(wave);
  if (fitCanvas(spec)) {
    specCtx.fillStyle = '#000';
    specCtx.fillRect(0, 0, spec.width, spec.height);
    specCtx.imageSmoothingEnabled = false;
    specCtx.drawImage(old, 0, 0, spec.width, spec.height);
  }
  fitCanvas(axis);

  rebuildRowMap();
  drawAxis();
  drawWave();
}

new ResizeObserver(resize).observe($('specPane'));

// ---------------------------------------------------------------
//   Frequency cursor (mouse / touch)
// ---------------------------------------------------------------

function showCursor(e) {
  const r = $('specPane').getBoundingClientRect();
  const y = e.clientY - r.top;
  if (y < 0 || y > r.height) return;
  const f = yToFreq(y, r.height);
  cursor.hidden = false;
  cursor.style.top = `${y}px`;
  cursor.firstElementChild.textContent = `${formatFreq(f)}  ${noteName(f)}`;
}

$('specPane').addEventListener('pointermove', showCursor);
$('specPane').addEventListener('pointerdown', showCursor);
for (const ev of ['pointerleave', 'pointercancel']) {
  $('specPane').addEventListener(ev, () => { cursor.hidden = true; });
}

// ---------------------------------------------------------------
//   UI wiring
// ---------------------------------------------------------------

$('btnMic').addEventListener('click', () => {
  if (source === 'mic') stopAll();
  else startMic();
});

const isImage = (file) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    if (isImage(file)) imageToSound(file);
    else startFile(file);
  }
  e.target.value = '';
});

$('btnRec').addEventListener('click', () => {
  if (recNode) stopRecording();
  else startRecording().catch((e) => setStatus(`Грешка при запис: ${e.message}`));
});

$('btnSaveAudio').addEventListener('click', () => {
  if (generatedAudio) saveBlob(generatedAudio, $('btnSaveAudio').dataset.name || `kartinka-${timestamp()}.wav`);
});

$('btnPause').addEventListener('click', togglePause);
$('btnSettings').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
});

$('credit').addEventListener('click', () => $('about').showModal());
$('aboutOk').addEventListener('click', () => $('about').close());
$('about').addEventListener('click', (e) => {
  if (e.target === $('about')) $('about').close();
});
for (const btn of document.querySelectorAll('#about .copy')) {
  btn.addEventListener('click', async () => {
    const value = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const t = document.createElement('textarea');
      t.value = value;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    setStatus('Copied');
  });
}

$('btnSave').addEventListener('click', () => {
  // Only the spectrogram itself. The waveform and the Hz labels would become extra sound.
  spec.toBlob((blob) => saveBlob(blob, `spectrogram-${timestamp()}.png`));
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePause();
  } else if (e.code === 'Escape') {
    stopAll();
  }
});

const CONTROLS = {
  fftSize: 'setFft',
  scale: 'setScale',
  maxFreq: 'setMaxFreq',
  colormap: 'setColormap',
  speed: 'setSpeed',
  minDb: 'setMinDb',
  maxDb: 'setMaxDb',
  imageSeconds: 'setImageSeconds',
};

function updateOutputs() {
  $('outSpeed').textContent = settings.speed;
  $('outMinDb').textContent = settings.minDb;
  $('outMaxDb').textContent = settings.maxDb;
}

function onSettingChanged(key) {
  if (key === 'minDb' && settings.minDb > settings.maxDb - 10) {
    settings.maxDb = Math.min(0, settings.minDb + 10);
    $('setMaxDb').value = settings.maxDb;
  }
  if (key === 'maxDb' && settings.maxDb < settings.minDb + 10) {
    settings.minDb = settings.maxDb - 10;
    $('setMinDb').value = settings.minDb;
  }
  if (key === 'fftSize') applyFftSize();
  if (key === 'scale' || key === 'maxFreq') {
    rebuildRowMap();
    drawAxis();
  }
  if (key === 'colormap') lut = buildLut(COLORMAPS[settings.colormap]);
  updateOutputs();
  saveSettings();
}

for (const [key, id] of Object.entries(CONTROLS)) {
  const el = $(id);
  el.value = settings[key];
  el.addEventListener('input', () => {
    settings[key] = typeof DEFAULTS[key] === 'number' ? Number(el.value) : el.value;
    onSettingChanged(key);
  });
}
updateOutputs();

// ---------------------------------------------------------------
//   Start
// ---------------------------------------------------------------

resize();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
