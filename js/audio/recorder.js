/* ============================================================================
   Recorder — microphone capture with a live level meter and spectrum.

   MediaRecorder gives us a compressed blob in whatever the browser prefers
   (usually Opus in WebM). That is only ever an intermediate: the blob is
   decoded straight back to PCM and re-encoded as Ogg Vorbis on the way into a
   pack, so the container the browser chose never reaches Minecraft.
   ========================================================================= */

import { audioCtx } from './engine.js';
import { clamp } from '../core/util.js';

export const RECORD_MIMES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
  '',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of RECORD_MIMES) {
    if (m === '' || MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export const canRecord = () =>
  !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');

export class Recorder {
  constructor() {
    this.stream = null; this.rec = null; this.chunks = [];
    this.state = 'idle';           // idle | ready | recording | paused
    this.startedAt = 0; this.pausedFor = 0; this._pauseMark = 0;
    this.analyser = null; this.source = null;
    this.onLevel = null;           // (rms, peak, bars Float32Array) => void
    this.onState = null;
    this.onTime = null;
    this._raf = null;
    this._peakHold = 0;
    this.deviceId = null;
  }

  async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.filter(d => d.kind === 'audioinput');
    } catch { return []; }
  }

  async arm({ deviceId = null, echoCancellation = false, noiseSuppression = false, autoGainControl = false } = {}) {
    if (this.state !== 'idle') await this.disarm();
    this.deviceId = deviceId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation, noiseSuppression, autoGainControl,
        channelCount: 2,
      },
    });
    const ctx = audioCtx();
    this.source = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.75;
    this.source.connect(this.analyser);
    this._setState('ready');
    this._meter();
    return this;
  }

  start() {
    if (!this.stream) throw new Error('Microphone is not armed yet.');
    const mime = pickMime();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    this.rec.ondataavailable = e => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.startedAt = performance.now();
    this.pausedFor = 0;
    this._setState('recording');
  }

  pause() {
    if (this.state !== 'recording') return;
    this.rec.pause(); this._pauseMark = performance.now();
    this._setState('paused');
  }
  resume() {
    if (this.state !== 'paused') return;
    this.rec.resume(); this.pausedFor += performance.now() - this._pauseMark;
    this._setState('recording');
  }

  /** Stop and hand back the captured blob. */
  stop() {
    return new Promise(resolve => {
      if (!this.rec || this.state === 'idle' || this.state === 'ready') return resolve(null);
      this.rec.onstop = () => {
        const type = this.rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this._setState('ready');
        resolve(blob);
      };
      try { this.rec.stop(); } catch { resolve(null); }
    });
  }

  async disarm() {
    if (this.state === 'recording' || this.state === 'paused') await this.stop();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.rec = null; this.analyser = null; this.source = null;
    this._setState('idle');
  }

  get elapsed() {
    if (this.state === 'idle' || this.state === 'ready') return 0;
    const now = this.state === 'paused' ? this._pauseMark : performance.now();
    return (now - this.startedAt - this.pausedFor) / 1000;
  }

  _setState(s) { this.state = s; this.onState?.(s); }

  _meter() {
    const time = new Float32Array(this.analyser.fftSize);
    const freq = new Uint8Array(this.analyser.frequencyBinCount);
    const BARS = 24;
    const bars = new Float32Array(BARS);
    const loop = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(time);
      let sum = 0, peak = 0;
      for (let i = 0; i < time.length; i++) {
        const v = time[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / time.length);
      this._peakHold = Math.max(peak, this._peakHold * 0.94);

      this.analyser.getByteFrequencyData(freq);
      // Log-spaced buckets read far better than linear on voice and music.
      for (let b = 0; b < BARS; b++) {
        const lo = Math.floor(Math.pow(b / BARS, 2.1) * freq.length);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((b + 1) / BARS, 2.1) * freq.length));
        let m = 0;
        for (let i = lo; i < hi; i++) m = Math.max(m, freq[i]);
        bars[b] = clamp(m / 255, 0, 1);
      }
      this.onLevel?.(rms, this._peakHold, bars);
      if (this.state === 'recording') this.onTime?.(this.elapsed);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
}

/** dBFS from a linear amplitude, floored for display. */
export function toDb(v) {
  if (v <= 0.00001) return -100;
  return clamp(20 * Math.log10(v), -100, 6);
}
