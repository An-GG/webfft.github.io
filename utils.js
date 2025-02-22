import { FFT } from 'https://soundshader.github.io/webfft.js';

export const $ = (selector) => document.querySelector(selector);
export const log = (...args) => console.log(args.join(' '));
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export const mix = (a, b, x) => a * (1 - x) + b * x;
export const clamp = (x, min = 0, max = 1) => Math.max(Math.min(x, max), min);
export const hann = (x) => x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 2 : 0;
export const reim2 = (re, im) => re * re + im * im;
export const dcheck = (x) => { if (x) return; debugger; throw new Error('dcheck failed'); }

const is_spectrogram = (s) => s.rank == 3 && s.dimensions[2] == 2;

export class Float32Tensor {
  constructor(dims, array) {
    let size = dims.reduce((p, d) => p * d, 1);
    dcheck(!array || array.length == size);

    // ds[i] = dims[i + 1] * dims[i + 2] * ...
    let dim = dims, ds = dim.slice(), n = ds.length;

    ds[n - 1] = 1;
    for (let i = n - 2; i >= 0; i--)
      ds[i] = ds[i + 1] * dim[i + 1];

    this.array = array || new Float32Array(size);
    this.rank = dims.length;
    this.dimensions = dims;
    this.dimension_size = ds;
  }

  slice(begin, end) {
    dcheck(begin >= 0 && begin < end && end <= this.dimensions[0]);
    let size = this.dimension_size[0];
    let dims = this.dimensions.slice(1);
    let data = this.array.subarray(begin * size, end * size);
    return new Float32Tensor([end - begin, ...dims], data);
  }

  subtensor(index) {
    let t = this.slice(index, index + 1);
    let d = t.dimensions;
    dcheck(d[0] == 1);
    return new Float32Tensor(d.slice(1), t.array);
  }
}

export function forwardFFT(signal) {
  let n = signal.length;
  let res2 = forwardReFFT(signal);
  return new Float32Tensor([n, 2], res2);
}

export function inverseFFT(frame) {
  dcheck(frame.rank == 2 && frame.dimensions[1] == 2);
  let n = frame.dimensions[0];
  let sig2 = new Float32Array(n * 2);
  FFT.inverse(frame.array, sig2);
  return FFT.re(sig2);
}

// http://www.robinscheibler.org/2013/02/13/real-fft.html
// x -> Z -> (Xe, Xo) -> X
export function forwardReFFT(x, X, [Xe, Xo] = []) {
  let n = x.length;

  X = X || new Float32Array(2 * n);
  Xe = Xe || new Float32Array(n);
  Xo = Xo || new Float32Array(n);

  let Z = X.subarray(0, n);

  dcheck(X.length == 2 * n);
  dcheck(Z.length == n);
  dcheck(Xe.length == n);
  dcheck(Xo.length == n);

  FFT.forward(x, Z);
  splitDFTs(Xe, Xo, Z);
  mergeDFTs(Xe, Xo, X);

  return X;
}

// Z -> X + iY
function splitDFTs(X, Y, Z) {
  let n = X.length / 2;

  dcheck(Y.length == 2 * n);
  dcheck(Z.length == 2 * n);

  for (let k = 0; k < n; k++) {
    let k1 = k, k2 = (-k + n) % n;
    let re1 = Z[2 * k1 + 0];
    let im1 = Z[2 * k1 + 1];
    let re2 = Z[2 * k2 + 0];
    let im2 = Z[2 * k2 + 1];
    X[2 * k + 0] = (re1 + re2) / 2;
    X[2 * k + 1] = (im1 - im2) / 2;
    Y[2 * k + 0] = (im1 + im2) / 2;
    Y[2 * k + 1] = (re2 - re1) / 2;
  }
}

// (Xe, Xo) -> X
function mergeDFTs(Xe, Xo, X) {
  let n = Xe.length;
  let uroots = FFT.get(n).uroots;

  dcheck(Xo.length == n);
  dcheck(X.length == 2 * n);

  for (let k = 0; k < n; k++) {
    let k1 = k % (n / 2);
    let k2 = (n - k) % n;
    let re1 = Xe[2 * k1 + 0];
    let im1 = Xe[2 * k1 + 1];
    let re2 = Xo[2 * k1 + 0];
    let im2 = Xo[2 * k1 + 1];
    let cos = uroots[k2 * 2 + 0];
    let sin = uroots[k2 * 2 + 1];
    // (re1, im1) + (re2, im2) * (cos, sin)
    X[2 * k + 0] = re1 + re2 * cos - im2 * sin;
    X[2 * k + 1] = im1 + re2 * sin + im2 * cos;
  }
}

export function applyBandpassFilter(signal, f_min, f_max) {
  let n = signal.length;
  dcheck(f_min >= 0 && f_max >= f_min && f_max <= n / 2);
  let fft = forwardFFT(signal);
  for (let i = 0; i < n; i++) {
    let f = Math.min(i, n - i);
    let s = f >= f_min && f <= f_max ? 1 : 0;
    fft.array[2 * i + 0] *= s;
    fft.array[2 * i + 1] *= s;
  }
  return inverseFFT(fft);
}

export function drawSpectrogram(canvas, spectrogram, {
  db_log = s => s, rgb_fn = s => [s * 9, s * 3, s] }) {
  let h = canvas.height;
  let w = canvas.width;
  let ctx = canvas.getContext('2d');
  let img = ctx.getImageData(0, 0, w, h);
  let sqrabs_max = getFrameMax(spectrogram.array);
  let rgb_reim = (re, im) => rgb_fn(db_log(reim2(re, im) / sqrabs_max));
  let num_frames = spectrogram.dimensions[0];

  for (let x = 0; x < w; x++) {
    let frame = spectrogram.subtensor(x / w * num_frames | 0);
    drawSpectrogramFrame(img, frame, x, rgb_reim);
  }

  ctx.putImageData(img, 0, 0);
}

export function getMaskedSpectrogram(spectrogram1, mask_fn) {
  dcheck(is_spectrogram(spectrogram1));
  let dims = spectrogram1.dimensions.slice(0);
  let [t_size, f_size] = dims;
  let data = new Float32Array(t_size * f_size * 2);
  let spectrogram2 = new Float32Tensor(dims, data);

  for (let t = 0; t < t_size; t++) {
    let frame1 = spectrogram1.subtensor(t).array;
    let frame2 = spectrogram2.subtensor(t).array;

    for (let f = 0; f < f_size; f++) {
      let m = mask_fn(t, f);
      frame2[2 * f + 0] = m * frame1[2 * f + 0];
      frame2[2 * f + 1] = m * frame1[2 * f + 1];
    }
  }

  return spectrogram2;
}

export function getFrameMax(data) {
  return aggFrameData(data, reim2, Math.max, 0);
}

export function getFrameSum(data) {
  return aggFrameData(data, reim2, (sum, sqr) => sum + sqr, 0);
}

function aggFrameData(data, fn, reduce, initial = 0) {
  let max = initial;
  for (let i = 0; i < data.length / 2; i++) {
    let re = data[i * 2];
    let im = data[i * 2 + 1];
    max = reduce(max, fn(re, im));
  }
  return max;
}

function drawSpectrogramFrame(img, frame, x, rgb_fn) {
  let frame_size = frame.dimensions[0];
  let w = img.width;
  let h = img.height;

  for (let y = 0; y < h; y++) {
    let f = (h - 1 - y) / h * frame_size / 2 | 0;
    let re = frame.array[f * 2];
    let im = frame.array[f * 2 + 1];

    let rgb = rgb_fn(re, im);
    let i = (x + y * w) * 4;

    img.data[i + 0] = 255 * rgb[0];
    img.data[i + 1] = 255 * rgb[1];
    img.data[i + 2] = 255 * rgb[2];
    img.data[i + 3] = 255;
  }
}

export function computeSpectrogram(signal, { num_frames, frame_size, min_frame, max_frame }) {
  let sig1 = new Float32Array(frame_size);
  let tmp1 = new Float32Array(frame_size);
  let tmp2 = new Float32Array(frame_size);

  min_frame = min_frame || 0;
  max_frame = max_frame || num_frames - 1;

  let frames = new Float32Tensor([max_frame - min_frame + 1, frame_size, 2]); // (re, im)

  for (let t = min_frame; t <= max_frame; t++) {
    let res1 = frames.subtensor(t - min_frame).array;
    readAudioFrame(signal, sig1, num_frames, t + 0);
    forwardReFFT(sig1, res1, [tmp1, tmp2]);
  }

  return frames;
}

export async function computePaddedSpectrogram(signal, { num_frames, frame_size }) {
  dcheck(frame_size % 2 == 0);
  let padded = new Float32Array(signal.length + frame_size);
  padded.set(signal, frame_size / 2);
  let frame_step = signal.length / num_frames;
  let padded_frames = padded.length / frame_step | 0;
  let spectrogram = computeSpectrogram(padded, { num_frames: padded_frames, frame_size });
  let null_frames = (padded_frames - num_frames) / 2 | 0;
  return spectrogram.slice(null_frames, null_frames + num_frames);
}

export function getAvgSpectrum(spectrogram) {
  dcheck(is_spectrogram(spectrogram));
  let [num_frames, frame_size] = spectrogram.dimensions;
  let spectrum = new Float32Array(frame_size);

  for (let t = 0; t < num_frames; t++) {
    let frame = spectrogram.subtensor(t).array;
    for (let f = 0; f < frame_size; f++)
      spectrum[f] += reim2(frame[2 * f], frame[2 * f + 1]) / num_frames;
  }


  return spectrum;
}

export function getVolumeTimeline(spectrogram) {
  dcheck(is_spectrogram(spectrogram));
  let [num_frames, frame_size] = spectrogram.dimensions;
  let timeline = new Float32Array(num_frames);

  for (let t = 0; t < num_frames; t++) {
    let frame = spectrogram.subtensor(t).array;
    timeline[t] = getFrameSum(frame) / frame_size;
  }

  return timeline;
}

export function getAmpDensity(spectrogram, num_bins = 1024, amp2_map = Math.sqrt) {
  dcheck(is_spectrogram(spectrogram));
  let density = new Float32Array(num_bins);
  let abs2_max = getFrameMax(spectrogram.array);

  aggFrameData(spectrogram.array, reim2, (_, abs2) => {
    let i = amp2_map(abs2 / abs2_max) * num_bins | 0;
    density[i] += 2 / spectrogram.array.length;
  });

  return density;
}

// frame_size = fft_bins * 2
export function readAudioFrame(signal, frame, num_frames, frame_id) {
  let len = frame.length;
  let n = signal.length;
  let step = signal.length / num_frames;
  let t = frame_id * step | 0;

  frame.set(
    signal.subarray(
      clamp(t, 0, n - 1),
      clamp(t + len, 0, n - 1)));

  for (let i = 0; i < len; i++)
    frame[i] *= hann(i / len);

  return frame;
}

export async function selectAudioFile() {
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.multiple = false;
  input.click();

  let file = await new Promise((resolve, reject) => {
    input.onchange = () => resolve(input.files[0]);
  });

  return file;
}

export async function decodeAudioFile(file, sample_rate) {
  let encoded_data = await file.arrayBuffer();
  let audio_ctx = new AudioContext({ sampleRate: sample_rate });
  try {
    let audio_buffer = await audio_ctx.decodeAudioData(encoded_data);
    let channel_data = audio_buffer.getChannelData(0);
    return channel_data;
  } finally {
    audio_ctx.close();
  }
}

// https://docs.fileformat.com/audio/wav
export function generateWavFile(wave, sample_rate) {
  let len = wave.length;
  let i16 = new Int16Array(22 + len + len % 2);
  let i32 = new Int32Array(i16.buffer);

  i16.set([
    0x4952, 0x4646, 0x0000, 0x0000, 0x4157, 0x4556, 0x6d66, 0x2074,
    0x0010, 0x0000, 0x0001, 0x0001, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0002, 0x0010, 0x6164, 0x6174, 0x0000, 0x0000]);

  i32[1] = i32.length * 4; // file size
  i32[6] = sample_rate;
  i32[7] = sample_rate * 2; // bytes per second
  i32[10] = len * 2; // data size

  for (let i = 0; i < len; i++)
    i16[22 + i] = wave[i] * 0x7FFF;

  return i16.buffer;
}

class FFTWorker {
  static workers = [];
  static requests = {};
  static handlers = {};

  static get(worker_id) {
    let worker = FFTWorker.workers[worker_id] || new FFTWorker(worker_id);
    return FFTWorker.workers[worker_id] = worker;
  }

  constructor(id) {
    this.id = id;
    this.worker = new Worker('/utils.js', { type: 'module' });
    this.worker.onmessage = (e) => {
      let { txid, res, err } = e.data;
      // this.dlog('received a message:', txid, { res, err });
      let promise = FFTWorker.requests[txid];
      dcheck(promise);
      delete FFTWorker.requests[txid];
      err ? promise.reject(err) : promise.resolve(res);
    };
    this.dlog('started');
  }

  terminate() {
    this.worker.terminate();
    delete FFTWorker.workers[this.id];
    this.dlog('terminated');
  }

  sendRequest(req, transfer = []) {
    dcheck(req && req.call && req.args);
    dcheck(Array.isArray(transfer));
    let txid = Date.now() + '.' + (Math.random() * 1e6).toFixed(0);
    let message = { req, txid };
    this.worker.postMessage(message, transfer);
    // this.dlog('was sent a message:', txid, req);
    return new Promise((resolve, reject) => {
      FFTWorker.requests[txid] = { resolve, reject };
    });
  }

  dlog(...args) {
    console.info('fftw.' + this.id, ...args);
  }
}

if (typeof window === 'undefined') {
  // This is a Worker.
  onmessage = (e) => {
    let { txid, req } = e.data;
    // console.debug('Routing a worker request:', txid, req);
    dcheck(txid && req && req.call && req.args);
    let handler = FFTWorker.handlers[req.call];
    dcheck(handler);
    try {
      let { res, transfer } = handler(...req.args);
      dcheck(Array.isArray(transfer));
      let message = { txid, res };
      // console.debug('Posting a worker message:', message);
      postMessage(message, transfer);
    } catch (err) {
      let message = { txid, err };
      postMessage(message);
    }
  };
}

FFTWorker.handlers['spectrogram'] = (signal, config) => {
  console.debug('"spectrogram" handler invoked:', config);
  let frames = computeSpectrogram(signal, config);
  let dims = frames.dimensions;
  let data = frames.array;
  return { res: { dims, data }, transfer: [data.buffer] };
};

async function computeSpectrogramAsync(worker_id, signal, config) {
  let worker = FFTWorker.get(worker_id);
  let req = { call: 'spectrogram', args: [signal, config] };
  let { dims, data } = await worker.sendRequest(req, [signal.buffer]);
  return new Float32Tensor(dims, data);
}
