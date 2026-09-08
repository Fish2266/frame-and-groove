/* ============================================================================
   Sample pack — a finished, working example built entirely from code.

   Nothing here is a fixture file: the paintings are drawn with the same tools
   the editor exposes and the music comes out of the same generator, so the
   demo is a genuine demonstration of what the app can do rather than a canned
   asset dump. It exports and installs like any other pack.
   ========================================================================= */

import {
  createMobVariant, createNamedSprite,
  createProject, createPainting, createDisc, createAudio, createPixelDoc,
} from '../core/project.js';
import { PIXELS_PER_BLOCK } from '../core/versions.js';
import { hexToRgba, hsvToRgb, clamp } from '../core/util.js';
import { setPixel, blendPixel } from '../paint/render.js';
import { gradientFill, plot, strokeLine, drawEllipse } from '../paint/tools.js';
import { paletteFromHue } from '../disc/sprite.js';
import { MOBS, baseTextureName } from '../mob/registry.js';
import { textureURL, loadTexturePack } from '../core/texturepack.js';
import { loadItems, itemById, itemTextureName } from '../sprite/items.js';
import { generateTrack, nameFor } from '../audio/compose.js';
import { bufferToWav, processBuffer, encodeOgg, computePeaks } from '../audio/engine.js';
import { adoptProject, putAsset, state, bus } from '../core/store.js';

/* Deterministic noise so the sample is identical for everybody. */
function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 3266489917) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const C = hexToRgba;

/* ========================================================================= */
/* PAINTING SCENES                                                           */
/* ========================================================================= */

/** A wide seascape: graded sky, a low sun, water with dithered bands. */
function paintDeepCurrent(doc) {
  const { w, h } = doc;
  const d = doc.layers[0].data;
  const horizon = Math.round(h * 0.58);

  // Sky — a banded vertical gradient, ordered-dithered so it stays pixel art.
  gradientFill(d, w, h, 0, 0, 0, horizon,
    C('#1B2A5E'), C('#E88B4F'), { type: 'linear', dither: 'bayer', steps: 7 });

  // Sun
  const sunX = Math.round(w * 0.68), sunY = Math.round(horizon - h * 0.10);
  const sunR = Math.max(2, Math.round(h * 0.09));
  drawEllipse(d, w, h, sunX - sunR, sunY - sunR, sunX + sunR, sunY + sunR, C('#FFE9A8'), { fill: true, size: 1 });
  drawEllipse(d, w, h, sunX - sunR, sunY - sunR, sunX + sunR, sunY + sunR, C('#FFF6D8'), { size: 1 });

  // Stars in the upper third
  for (let i = 0; i < Math.round(w * h * 0.004); i++) {
    const x = Math.floor(hash(i, 1, 7) * w);
    const y = Math.floor(hash(i, 2, 9) * horizon * 0.45);
    if (hash(x, y, 3) > 0.55) plot(d, w, h, x, y, C('#FFFFFFCC'), { size: 1 });
  }

  // Water
  gradientFill(d, w, h, 0, horizon, 0, h - 1,
    C('#2E6FA8'), C('#0A1B33'), { type: 'linear', dither: 'bayer', steps: 6, mask: rowsMask(w, h, horizon, h - 1) });

  // Sun reflection column, broken into ripples
  for (let y = horizon; y < h; y++) {
    const spread = Math.round((y - horizon) * 0.28) + 1;
    for (let k = -spread; k <= spread; k++) {
      const x = sunX + k;
      if (x < 0 || x >= w) continue;
      const t = 1 - (y - horizon) / (h - horizon);
      if (hash(x, y, 11) < 0.30 + t * 0.4) {
        blendPixel(d, w, x, y, 255, 226, 160, 150 * t + 40);
      }
    }
  }

  // Horizon line
  strokeLine(d, w, h, 0, horizon, w - 1, horizon, C('#0E2038'), { size: 1 });
  strokeLine(d, w, h, 0, horizon - 1, w - 1, horizon - 1, C('#F0A868'), { size: 1 });
  return doc;
}

/** A tall ravine: stone strata with a glowing seam of ore. */
function paintRavine(doc) {
  const { w, h } = doc;
  const d = doc.layers[0].data;

  // Snap every tone to one of a handful of steps — a stone wall in Minecraft
  // is four greys, not four hundred, and the eye reads the difference.
  const STEP = 14;
  for (let y = 0; y < h; y++) {
    const band = Math.floor(y / 3 + Math.sin(y * 0.22) * 1.2);
    const base = 58 + (band % 4) * 9;
    for (let x = 0; x < w; x++) {
      const n = hash(x, y, band);
      const v = Math.round(clamp(base + (n - 0.5) * 26, 20, 200) / STEP) * STEP;
      setPixel(d, w, x, y, v, Math.round(v * 0.97), Math.round(v * 1.06), 255);
    }
  }

  // A crack running down the middle, wandering
  let cx = w / 2;
  for (let y = 0; y < h; y++) {
    cx += (hash(0, y, 5) - 0.5) * 1.6;
    cx = clamp(cx, w * 0.22, w * 0.78);
    const width = 1 + Math.round(Math.sin(y * 0.16) + 1);
    for (let k = -width; k <= width; k++) {
      const x = Math.round(cx + k);
      if (x < 0 || x >= w) continue;
      const edge = Math.abs(k) === width;
      setPixel(d, w, x, y, edge ? 22 : 8, edge ? 24 : 10, edge ? 30 : 14, 255);
    }
    // Ore glow along the seam
    if (hash(1, y, 13) > 0.62) {
      const x = Math.round(cx + (hash(2, y, 17) > 0.5 ? width + 1 : -width - 1));
      if (x > 0 && x < w) {
        const [r, g, b] = hsvToRgb(160 + hash(3, y, 19) * 30, 0.75, 0.9);
        setPixel(d, w, x, y, r, g, b, 255);
        blendPixel(d, w, clamp(x - 1, 0, w - 1), y, r, g, b, 90);
        blendPixel(d, w, clamp(x + 1, 0, w - 1), y, r, g, b, 90);
      }
    }
  }
  return doc;
}

/** A single-block lantern, the smallest useful painting. */
function paintLantern(doc) {
  const { w, h } = doc;
  const d = doc.layers[0].data;

  // Dark backdrop with a warm halo
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dist = Math.hypot(x - w / 2 + 0.5, y - h * 0.5) / (w * 0.75);
    const t = clamp(1 - dist, 0, 1);
    const [r, g, b] = [22 + t * 150, 20 + t * 108, 30 + t * 40];
    setPixel(d, w, x, y, r, g, b, 255);
  }

  const cx = Math.floor(w / 2), top = Math.floor(h * 0.22);
  // Hanger
  strokeLine(d, w, h, cx, 1, cx, top - 1, C('#5A4A32'), { size: 1 });
  // Body
  const bw = Math.max(4, Math.round(w * 0.42)), bh = Math.max(5, Math.round(h * 0.44));
  const x0 = cx - Math.floor(bw / 2), y0 = top;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
    const rim = (x === x0 || x === x0 + bw - 1 || y === y0 || y === y0 + bh - 1);
    setPixel(d, w, x, y, rim ? 92 : 250, rim ? 74 : 214, rim ? 44 : 120, 255);
  }
  // Cap and base
  strokeLine(d, w, h, x0 - 1, y0 - 1, x0 + bw, y0 - 1, C('#8A6A3C'), { size: 1 });
  strokeLine(d, w, h, x0 - 1, y0 + bh, x0 + bw, y0 + bh, C('#8A6A3C'), { size: 1 });
  // Flame core
  const fy = y0 + Math.floor(bh / 2);
  setPixel(d, w, cx, fy, 255, 252, 220, 255);
  blendPixel(d, w, cx, fy - 1, 255, 240, 170, 220);
  return doc;
}

function rowsMask(w, h, y0, y1) {
  const m = new Uint8Array(w * h);
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) m.fill(255, y * w, y * w + w);
  return m;
}

/* ========================================================================= */
/* BUILD                                                                     */
/* ========================================================================= */

const PAINTINGS = [
  { id: 'deep_current', title: 'Deep Current', author: 'Frame & Groove', w: 4, h: 2, frame: 'oak', paint: paintDeepCurrent },
  { id: 'ravine', title: 'Ravine', author: 'Frame & Groove', w: 2, h: 3, frame: 'iron', paint: paintRavine },
  { id: 'lantern', title: 'Lantern', author: 'Frame & Groove', w: 1, h: 1, frame: 'gold', paint: paintLantern },
];

const TRACKS = [
  { id: 'tidewater', style: 'cave', seed: 20481, seconds: 42, template: 'ring', hue: 195, comparator: 6, base: 'music_disc_13' },
  { id: 'copper_hours', style: 'groove', seed: 77123, seconds: 38, template: 'wedge', hue: 24, comparator: 11, base: 'music_disc_cat' },
];

/**
 * Build the sample project and adopt it.
 * @param {(step:string, pct:number) => void} onProgress
 */

/* ---- A worked example of the mob editor --------------------------------- *
   A cow tinted toward the glow-berry greens of a lush cave, spawning only
   there. It starts from the real temperate cow so the shading survives, and
   only the hue is pushed — which is what a good variant usually is.        */
async function addSampleCow(project) {
  await loadTexturePack();
  const mob = MOBS.cow;
  const variant = createMobVariant('cow', mob, 'Verdant Cow');
  variant.id = 'verdant_cow';
  variant.notes = 'Made by hue-shifting the vanilla cow. Open the 3D view and paint on it.';
  variant.spawns = [{ type: 'minecraft:biome', priority: 1, values: ['minecraft:lush_caves'] }];

  const load = url => new Promise(res => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
  /* The calf is a different sheet on a different model, so each age loads its
     own base and gets the same hue push. */
  for (const kind of Object.keys(variant.slots)) {
    const base = mob.bases[0];
    const img = await load(textureURL(baseTextureName(mob, base, kind, null)));
    const doc = variant.slots[kind].default.doc;
    if (!img) continue;
    const c = document.createElement('canvas');
    c.width = doc.w; c.height = doc.h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, doc.w, doc.h);
    const px = g.getImageData(0, 0, doc.w, doc.h).data;
    /* Push browns toward green while keeping the light and dark of the
       original, so the cow still reads as a cow. */
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 8) continue;
      const r = px[i], gr = px[i + 1], b = px[i + 2];
      const lum = (r * 0.3 + gr * 0.59 + b * 0.11) / 255;
      px[i]     = Math.round(lum * 90 + 20);
      px[i + 1] = Math.round(lum * 190 + 30);
      px[i + 2] = Math.round(lum * 95 + 25);
    }
    doc.layers[0].data.set(px);
    variant.slots[kind].default.base = base;
  }
  project.mobs.push(variant);
}

/**
 * One renamed sprite: a stone sword called Ember, drawn by pushing the vanilla
 * blade into fire colours and leaving the handle alone. It shows the whole
 * feature in one object — the name in the anvil is the switch, and every other
 * stone sword in the world is untouched.
 */
async function addSampleSprite(project) {
  await Promise.all([loadTexturePack(), loadItems()]);
  const item = itemById('stone_sword');
  if (!item) return;
  const sprite = createNamedSprite('stone_sword', 'Ember', 2);
  sprite.id = 'ember';
  sprite.notes = 'Name a stone sword “Ember” in an anvil. Nothing else changes.';

  const url = textureURL(itemTextureName(item));
  const img = url && await new Promise(res => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
  if (img) {
    const doc = sprite.doc;
    const c = document.createElement('canvas');
    c.width = doc.w; c.height = doc.h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, doc.w, doc.h);
    const px = g.getImageData(0, 0, doc.w, doc.h).data;
    /* The blade is the grey half of the sprite and the handle is the brown
       half, so hue tells them apart: leave the wood, set the stone alight. */
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 8) continue;
      const r = px[i], gr = px[i + 1], b = px[i + 2];
      const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
      if (max - min > 40) continue;               // coloured already — the grip
      const lum = (r * 0.3 + gr * 0.59 + b * 0.11) / 255;
      px[i]     = Math.round(120 + lum * 135);
      px[i + 1] = Math.round(30 + lum * 150);
      px[i + 2] = Math.round(20 + lum * 60);
    }
    doc.layers[0].data.set(px);
    sprite.base = item.id;
  }
  project.sprites.push(sprite);
}

export async function buildSamplePack(onProgress = () => {}) {
  const p = createProject({
    name: 'Frame & Groove Sampler',
    namespace: 'fg_sampler',
  });
  p.description = 'Three paintings, two tracks, a cow that only lives in lush caves and a sword that catches fire when you name it — all made by the app itself. Take it apart and see how it is put together.';
  p.author = 'Frame & Groove';

  onProgress('Painting…', 0.05);
  for (const spec of PAINTINGS) {
    const pt = createPainting(spec.title, spec.w, spec.h);
    pt.id = spec.id;
    pt.title = spec.title;
    pt.author = spec.author;
    pt.frame = { style: spec.frame, thickness: 0, tint: null, inner: true };
    pt.doc = createPixelDoc(spec.w * PIXELS_PER_BLOCK, spec.h * PIXELS_PER_BLOCK, { layerName: 'Artwork' });
    spec.paint(pt.doc);
    p.paintings.push(pt);
  }

  /* The project has to exist in storage before assets can point at it. */
  onProgress('Saving the pack…', 0.25);
  await adoptProject(p);

  let i = 0;
  for (const spec of TRACKS) {
    i++;
    onProgress(`Composing “${nameFor(spec.style, spec.seed)}”…`, 0.3 + (i - 1) * 0.3);
    const buffer = generateTrack({ style: spec.style, seed: spec.seed, seconds: spec.seconds });
    const wav = bufferToWav(buffer);
    const srcId = await putAsset('audio', wav, { name: `${spec.id}.wav` });

    onProgress(`Encoding “${nameFor(spec.style, spec.seed)}”…`, 0.42 + (i - 1) * 0.3);
    const ogg = await encodeOgg(processBuffer(buffer, { mono: true, normalize: true }), { quality: 4 });
    const encId = await putAsset('audio', ogg, { name: `${spec.id}.ogg` });

    const d = createDisc(nameFor(spec.style, spec.seed));
    d.id = spec.id;
    d.artist = 'Frame & Groove';
    d.descriptionText = d.name;
    d.baseItem = spec.base;
    d.comparatorOutput = spec.comparator;
    d.rarity = 'rare';
    d.sprite.template = spec.template;
    d.sprite.colors = paletteFromHue(spec.hue, { saturation: 0.6 });
    d.audio = createAudio({
      assetId: srcId, sourceName: `${nameFor(spec.style, spec.seed)} (generated)`,
      mime: 'audio/wav', size: wav.size,
      durationSec: buffer.duration, sampleRate: buffer.sampleRate, channels: 1,
      peaks: computePeaks(buffer), mono: true, normalize: true, quality: 4,
      generated: { style: spec.style, seed: spec.seed, seconds: spec.seconds, bpm: null },
      encoded: { assetId: encId, size: ogg.size },
    });
    state.project.discs.push(d);
  }

  onProgress('Colouring a cow…', 0.90);
  await addSampleCow(p);

  onProgress('Setting a sword alight…', 0.93);
  await addSampleSprite(state.project);

  onProgress('Finishing up…', 0.95);
  const { saveProject, refreshLibrary } = await import('../core/store.js');
  await saveProject({ silent: true });
  await refreshLibrary();
  /* The project was adopted before its paintings, tracks and cow were all in
     place, so every view is told to re-read it once the pack is complete. */
  bus.emit('project');
  onProgress('Ready', 1);
  return state.project;
}
