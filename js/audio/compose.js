/* ============================================================================
   Track generator — a small synthesiser so a disc can exist before you own a
   single audio file.

   Everything is rendered sample by sample into a Float32Array rather than
   scheduled through Web Audio nodes, which makes a given seed produce the exact
   same track every time — you can share a seed the way you would share a world
   seed, and get the same music back.
   ========================================================================= */

import { clamp } from '../core/util.js';
import { audioCtx } from './engine.js';

/* ---- Deterministic randomness ------------------------------------------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x9E3779B9) | 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21F0AAAD);
    t = Math.imul(t ^ (t >>> 15), 0x735A2D97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

/* ---- Music theory ------------------------------------------------------- */
const SEMI = f => Math.pow(2, f / 12);
const noteHz = (midi) => 440 * SEMI(midi - 69);

const SCALES = {
  minorPent: [0, 3, 5, 7, 10],
  majorPent: [0, 2, 4, 7, 9],
  aeolian:   [0, 2, 3, 5, 7, 8, 10],
  dorian:    [0, 2, 3, 5, 7, 9, 10],
  lydian:    [0, 2, 4, 6, 7, 9, 11],
  phrygian:  [0, 1, 3, 5, 7, 8, 10],
};

const PROGRESSIONS = [
  [0, 5, 3, 4], [0, 3, 5, 4], [0, 4, 5, 3],
  [0, 6, 3, 4], [0, 5, 1, 4], [0, 0, 3, 4],
];

/* ---- Styles ------------------------------------------------------------- */
export const STYLES = [
  {
    id: 'overworld', name: 'Overworld', icon: 'sun',
    hint: 'Warm piano-ish pentatonic, unhurried. Sounds at home in a village.',
    bpm: [64, 78], scale: 'majorPent', root: [57, 60, 62],
    lead: 'bell', pad: 'soft', bass: 'sine', drums: false, reverb: 0.34, sparse: 0.34,
  },
  {
    id: 'cave', name: 'Cave', icon: 'compass',
    hint: 'Sparse, echoing single notes with a low drone underneath.',
    bpm: [48, 58], scale: 'aeolian', root: [50, 53, 55],
    lead: 'bell', pad: 'drone', bass: 'sub', drums: false, reverb: 0.6, sparse: 0.66,
  },
  {
    id: 'chiptune', name: 'Chiptune', icon: 'bolt',
    hint: 'Square-wave arpeggios and a punchy bass. Eight-bit through and through.',
    bpm: [116, 148], scale: 'minorPent', root: [55, 57, 60],
    lead: 'square', pad: 'none', bass: 'square', drums: true, reverb: 0.1, sparse: 0.05,
  },
  {
    id: 'nether', name: 'Nether', icon: 'bolt',
    hint: 'Dark drone, uneasy intervals, distant percussion.',
    bpm: [70, 88], scale: 'phrygian', root: [45, 47, 50],
    lead: 'saw', pad: 'drone', bass: 'sub', drums: true, reverb: 0.5, sparse: 0.4,
  },
  {
    id: 'musicbox', name: 'Music box', icon: 'star',
    hint: 'Delicate high bells with a slow waltz feel.',
    bpm: [86, 104], scale: 'lydian', root: [64, 67, 69],
    lead: 'bell', pad: 'soft', bass: 'none', drums: false, reverb: 0.46, sparse: 0.2,
  },
  {
    id: 'groove', name: 'Groove', icon: 'waveform',
    hint: 'Drums, bassline and a syncopated lead. The most danceable option.',
    bpm: [96, 118], scale: 'dorian', root: [50, 52, 55],
    lead: 'saw', pad: 'soft', bass: 'saw', drums: true, reverb: 0.2, sparse: 0.12,
  },
];

export const getStyle = id => STYLES.find(s => s.id === id) || STYLES[0];

/* ---- Oscillators -------------------------------------------------------- */
function oscValue(kind, phase, extra = 0) {
  const t = phase % 1;
  switch (kind) {
    case 'square':   return t < 0.5 ? 1 : -1;
    case 'pulse':    return t < 0.25 ? 1 : -1;
    case 'saw':      return 2 * t - 1;
    case 'tri':      return 4 * Math.abs(t - 0.5) - 1;
    case 'bell':
      // A few inharmonic partials read as struck metal rather than a sine.
      return Math.sin(2 * Math.PI * t) * 0.62
           + Math.sin(2 * Math.PI * t * 2.01) * 0.24
           + Math.sin(2 * Math.PI * t * 3.02) * 0.1
           + Math.sin(2 * Math.PI * t * 4.97) * 0.04 * extra;
    default:         return Math.sin(2 * Math.PI * t);
  }
}

/* ---- Voice renderer ----------------------------------------------------- */
function renderNote(out, sr, startSec, durSec, freq, o = {}) {
  const {
    wave = 'sine', gain = 0.2, attack = 0.005, decay = 0.12,
    sustain = 0.55, release = 0.25, vibrato = 0, vibratoHz = 5,
    detune = 0, glide = 0, drift = 0,
  } = o;
  const start = Math.floor(startSec * sr);
  const total = Math.floor((durSec + release) * sr);
  const susStart = attack + decay;
  let phase = 0, phase2 = 0;

  for (let i = 0; i < total; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;

    /* Envelope */
    let env;
    if (t < attack) env = t / attack;
    else if (t < susStart) env = 1 - (1 - sustain) * ((t - susStart + decay) / decay);
    else if (t < durSec) env = sustain;
    else env = sustain * Math.max(0, 1 - (t - durSec) / release);
    if (env <= 0) continue;

    let f = freq;
    if (glide) f *= 1 + glide * Math.exp(-t * 24);
    if (vibrato) f *= 1 + vibrato * Math.sin(2 * Math.PI * vibratoHz * t);
    if (drift) f *= 1 + drift * Math.sin(2 * Math.PI * 0.13 * t + freq);

    phase += f / sr;
    let v = oscValue(wave, phase, 1);
    if (detune) {
      phase2 += (f * (1 + detune)) / sr;
      v = (v + oscValue(wave, phase2, 1)) * 0.5;
    }
    out[idx] += v * env * gain;
  }
}

function renderNoise(out, sr, startSec, durSec, o = {}) {
  const { gain = 0.2, decay = 0.06, lowpass = 0.5, seed = 1 } = o;
  const r = rng(seed);
  const start = Math.floor(startSec * sr);
  const total = Math.floor(durSec * sr);
  let lp = 0;
  for (let i = 0; i < total; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;
    const env = Math.exp(-t / decay);
    const n = r() * 2 - 1;
    lp += (n - lp) * lowpass;
    out[idx] += lp * env * gain;
  }
}

function renderKick(out, sr, startSec, o = {}) {
  const { gain = 0.5, f0 = 128, f1 = 44, dur = 0.34 } = o;
  const start = Math.floor(startSec * sr);
  const total = Math.floor(dur * sr);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t * 26);
    phase += f / sr;
    const env = Math.exp(-t * 7.5);
    out[idx] += Math.sin(2 * Math.PI * phase) * env * gain;
  }
}

/* ---- Effects ------------------------------------------------------------ */
function feedbackDelay(buf, sr, timeSec, feedback, mix) {
  const d = Math.max(1, Math.floor(timeSec * sr));
  for (let i = d; i < buf.length; i++) buf[i] += buf[i - d] * feedback * mix;
}

/** A compact Schroeder reverb: four combs into two allpasses. */
function reverb(buf, sr, amount) {
  if (amount <= 0.001) return buf;
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map(t => ({
    n: Math.floor(t * sr), buf: new Float32Array(Math.floor(t * sr)), i: 0, g: 0.79,
  }));
  const allps = [0.005, 0.0017].map(t => ({
    n: Math.floor(t * sr), buf: new Float32Array(Math.floor(t * sr)), i: 0, g: 0.7,
  }));
  const wet = new Float32Array(buf.length);
  for (let s = 0; s < buf.length; s++) {
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = buf[s] + y * c.g;
      c.i = (c.i + 1) % c.n;
      acc += y;
    }
    acc *= 0.25;
    for (const a of allps) {
      const y = a.buf[a.i];
      const out = -a.g * acc + y;
      a.buf[a.i] = acc + a.g * out;
      a.i = (a.i + 1) % a.n;
      acc = out;
    }
    wet[s] = acc;
  }
  for (let s = 0; s < buf.length; s++) buf[s] = buf[s] * (1 - amount * 0.45) + wet[s] * amount;
  return buf;
}

function softClip(buf, drive = 1) {
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] * drive;
    buf[i] = x / (1 + Math.abs(x)) * 1.32;
  }
}

function normalizeTo(buf, target = 0.88) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
  if (peak < 1e-6) return;
  const k = target / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
}

function fadeEdges(buf, sr, inSec = 0.02, outSec = 0.6) {
  const a = Math.floor(inSec * sr), b = Math.floor(outSec * sr);
  for (let i = 0; i < a && i < buf.length; i++) buf[i] *= i / a;
  for (let i = 0; i < b && i < buf.length; i++) buf[buf.length - 1 - i] *= i / b;
}

/* ========================================================================= */
/* COMPOSER                                                                  */
/* ========================================================================= */

/**
 * @param {object} o
 *   style     style id
 *   seed      integer; the same seed always makes the same track
 *   seconds   target length
 *   bpm       override
 *   sampleRate
 * @returns {AudioBuffer}
 */
export function generateTrack(o = {}) {
  const style = getStyle(o.style);
  const seed = (o.seed ?? Math.floor(Math.random() * 1e9)) >>> 0;
  const r = rng(seed);
  const sr = o.sampleRate || 44100;
  const seconds = clamp(o.seconds ?? 48, 4, 300);

  const bpm = o.bpm || Math.round(style.bpm[0] + r() * (style.bpm[1] - style.bpm[0]));
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = Math.max(2, Math.ceil(seconds / bar));
  const total = Math.ceil(bars * bar * sr) + Math.ceil(1.4 * sr);

  const buf = new Float32Array(total);
  const scale = SCALES[style.scale] || SCALES.minorPent;
  const root = pick(r, style.root);
  const prog = pick(r, PROGRESSIONS);

  /* A short motif, repeated with variation — the thing that makes it feel
     composed rather than randomly sprinkled. */
  const motifLen = pick(r, [4, 6, 8]);
  const motif = Array.from({ length: motifLen }, () => Math.floor(r() * scale.length * 2));
  const rhythm = Array.from({ length: motifLen }, () => pick(r, [1, 1, 1, 2, 0.5]));

  const deg = i => {
    const oct = Math.floor(i / scale.length);
    return scale[((i % scale.length) + scale.length) % scale.length] + oct * 12;
  };

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const chordDeg = prog[b % prog.length];
    const chordRoot = root + deg(chordDeg);
    const variation = Math.floor(b / prog.length);

    /* ---- Bass ---- */
    if (style.bass !== 'none') {
      const bassWave = style.bass === 'sub' ? 'sine' : style.bass;
      const pattern = style.drums ? [0, 1.5, 2, 3.5] : [0, 2];
      for (const p of pattern) {
        if (r() < style.sparse * 0.4) continue;
        renderNote(buf, sr, t0 + p * beat, beat * 0.85, noteHz(chordRoot - 24),
          { wave: bassWave, gain: 0.30, attack: 0.004, decay: 0.1, sustain: 0.7, release: 0.14 });
      }
    }

    /* ---- Pad / drone ---- */
    if (style.pad === 'drone') {
      renderNote(buf, sr, t0, bar, noteHz(chordRoot - 12),
        { wave: 'saw', gain: 0.055, attack: 0.9, decay: 0.4, sustain: 0.85, release: 1.1, detune: 0.004, drift: 0.002 });
      renderNote(buf, sr, t0, bar, noteHz(chordRoot - 12) * SEMI(7),
        { wave: 'saw', gain: 0.035, attack: 1.1, decay: 0.4, sustain: 0.8, release: 1.2, detune: 0.006 });
    } else if (style.pad === 'soft') {
      for (const iv of [0, 4, 7]) {
        renderNote(buf, sr, t0, bar * 0.96, noteHz(chordRoot - 12 + iv),
          { wave: 'tri', gain: 0.045, attack: 0.35, decay: 0.5, sustain: 0.6, release: 0.7, detune: 0.003 });
      }
    }

    /* ---- Lead ---- */
    let cursor = 0;
    for (let i = 0; i < motif.length; i++) {
      const step = rhythm[i];
      if (cursor >= 4) break;
      const rest = r() < style.sparse;
      if (!rest) {
        let d = motif[i];
        if (variation > 0 && r() < 0.35) d += pick(r, [-1, 1, 2]);
        const midi = root + 12 + deg(d + chordDeg);
        const isBell = style.lead === 'bell';
        renderNote(buf, sr, t0 + cursor * beat, beat * step * (isBell ? 1.6 : 0.8), noteHz(midi), {
          wave: style.lead,
          gain: isBell ? 0.20 : 0.14,
          attack: isBell ? 0.002 : 0.012,
          decay: isBell ? 0.9 : 0.14,
          sustain: isBell ? 0.0 : 0.55,
          release: isBell ? 0.6 : 0.2,
          vibrato: style.lead === 'saw' ? 0.004 : 0,
          detune: style.lead === 'saw' ? 0.008 : 0,
        });
        /* An octave sparkle on strong beats keeps long tracks from flattening. */
        if (isBell && cursor % 2 === 0 && r() < 0.3) {
          renderNote(buf, sr, t0 + cursor * beat, beat * step, noteHz(midi + 12),
            { wave: 'bell', gain: 0.07, attack: 0.002, decay: 0.7, sustain: 0, release: 0.4 });
        }
      }
      cursor += step;
    }

    /* ---- Drums ---- */
    if (style.drums) {
      renderKick(buf, sr, t0, { gain: 0.42 });
      renderKick(buf, sr, t0 + 2 * beat, { gain: 0.34 });
      if (r() < 0.5) renderKick(buf, sr, t0 + 3.5 * beat, { gain: 0.2, dur: 0.2 });
      renderNoise(buf, sr, t0 + beat, 0.16, { gain: 0.15, decay: 0.05, lowpass: 0.42, seed: seed + b });
      renderNoise(buf, sr, t0 + 3 * beat, 0.16, { gain: 0.15, decay: 0.05, lowpass: 0.42, seed: seed + b + 7 });
      for (let s = 0; s < 8; s++) {
        if (r() < 0.62) {
          renderNoise(buf, sr, t0 + s * beat * 0.5, 0.05,
            { gain: 0.05 + r() * 0.03, decay: 0.014, lowpass: 0.92, seed: seed + b * 13 + s });
        }
      }
    }
  }

  /* ---- Mix bus ---- */
  if (style.reverb > 0.15) feedbackDelay(buf, sr, beat * 0.75, 0.3, style.reverb * 0.5);
  reverb(buf, sr, style.reverb);
  softClip(buf, 1.05);
  normalizeTo(buf, 0.86);
  fadeEdges(buf, sr, 0.03, Math.min(1.2, bars * bar * 0.08));

  /* Trim to the requested length plus the tail. */
  const keep = Math.min(buf.length, Math.ceil((seconds + 1.0) * sr));
  const ctx = audioCtx();
  const out = ctx.createBuffer(1, keep, sr);
  out.getChannelData(0).set(buf.subarray(0, keep));
  return out;
}

/** A short, friendly name for a generated track. */
export function nameFor(styleId, seed) {
  const style = getStyle(styleId);
  const r = rng(seed);
  const A = {
    overworld: ['Meadow', 'Sunrise', 'Quiet', 'Harvest', 'Longbarrow', 'Wanderer'],
    cave: ['Deepwater', 'Lantern', 'Hollow', 'Drip', 'Fossil', 'Undertow'],
    chiptune: ['Pixel', 'Voltage', 'Arcade', 'Blip', 'Overclock', 'Cartridge'],
    nether: ['Ashfall', 'Ember', 'Basalt', 'Soulfire', 'Cinder', 'Bastion'],
    musicbox: ['Porcelain', 'Lullaby', 'Snowglobe', 'Paper', 'Clockwork', 'Feather'],
    groove: ['Nightshift', 'Copper', 'Static', 'Boiler', 'Neon', 'Ledger'],
  }[style.id] || ['Untitled'];
  const B = ['Drift', 'Cycle', 'Signal', 'Echo', 'Theme', 'Passage', 'Loop', 'Hymn', 'Reprise', 'Field'];
  return `${pick(r, A)} ${pick(r, B)}`;
}

export function randomSeed() { return Math.floor(Math.random() * 1e9); }
