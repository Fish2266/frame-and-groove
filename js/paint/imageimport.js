/* ============================================================================
   Image import — photographs and artwork into honest pixel art.

   Downscaling a photo to 32×32 is the whole problem: naive nearest-neighbour
   throws away most of the image, and a smooth downscale produces a muddy blur
   with hundreds of near-identical colours. The pipeline here box-filters down
   (so every source pixel contributes), then quantises to a real palette with a
   choice of dithering, which is what makes the result read as pixel art rather
   than a shrunken photo.
   ========================================================================= */

import { clamp, colorDist2, hexToRgba } from '../core/util.js';
import { medianCut } from './palettes.js';
import { bayer } from './tools.js';

export const FIT_MODES = [
  { id: 'contain', label: 'Fit',     hint: 'Whole image, letterboxed' },
  { id: 'cover',   label: 'Fill',    hint: 'Fills the canvas, crops the overflow' },
  { id: 'stretch', label: 'Stretch', hint: 'Distorts to the exact size' },
];

export const DITHER_MODES = [
  { id: 'none',     label: 'None',     hint: 'Hard colour steps' },
  { id: 'floyd',    label: 'Diffuse',  hint: 'Floyd–Steinberg — smooth and organic' },
  { id: 'atkinson', label: 'Atkinson', hint: 'Lighter, keeps more contrast' },
  { id: 'bayer',    label: 'Ordered',  hint: 'Regular crosshatch, very retro' },
];

/* ---- Source preparation -------------------------------------------------- */
/** Box-filter downscale in halving steps, which keeps detail a single
 *  drawImage call throws away. */
function boxDownscale(src, sw, sh, dw, dh) {
  let cw = sw, ch = sh;
  let canvas = src;
  while (cw > dw * 2 || ch > dh * 2) {
    const nw = Math.max(dw, Math.floor(cw / 2));
    const nh = Math.max(dh, Math.floor(ch / 2));
    const step = document.createElement('canvas');
    step.width = nw; step.height = nh;
    const g = step.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, cw, ch, 0, 0, nw, nh);
    canvas = step; cw = nw; ch = nh;
  }
  return { canvas, w: cw, h: ch };
}

/**
 * Rasterise a source image into RGBA at exactly targetW × targetH.
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} img
 */
export function rasterize(img, targetW, targetH, opts = {}) {
  const {
    fit = 'contain', smooth = true,
    offsetX = 0, offsetY = 0, zoom = 1, rotate = 0,
  } = opts;
  const sw = img.width || img.naturalWidth;
  const sh = img.height || img.naturalHeight;

  /* Geometry */
  let scale;
  if (fit === 'cover') scale = Math.max(targetW / sw, targetH / sh);
  else if (fit === 'stretch') scale = 1;
  else scale = Math.min(targetW / sw, targetH / sh);
  scale *= zoom;

  const dw = fit === 'stretch' ? targetW : Math.max(1, Math.round(sw * scale));
  const dh = fit === 'stretch' ? targetH : Math.max(1, Math.round(sh * scale));

  let source = img;
  if (smooth && (dw < sw || dh < sh)) {
    const pre = document.createElement('canvas');
    pre.width = sw; pre.height = sh;
    pre.getContext('2d').drawImage(img, 0, 0);
    source = boxDownscale(pre, sw, sh, dw, dh).canvas;
  }

  const out = document.createElement('canvas');
  out.width = targetW; out.height = targetH;
  const g = out.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.save();
  if (rotate) {
    g.translate(targetW / 2, targetH / 2);
    g.rotate(rotate * Math.PI / 180);
    g.translate(-targetW / 2, -targetH / 2);
  }
  g.drawImage(source,
    Math.round((targetW - dw) / 2 + offsetX),
    Math.round((targetH - dh) / 2 + offsetY),
    dw, dh);
  g.restore();
  return g.getImageData(0, 0, targetW, targetH);
}

/* ---- Adjustments -------------------------------------------------------- */
export function applyAdjust(img, { brightness = 0, contrast = 0, saturation = 1, gamma = 1 } = {}) {
  const d = img.data;
  const c = contrast + 1;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    if (gamma !== 1) v = Math.pow(v, 1 / gamma);
    v = (v - 0.5) * c + 0.5 + brightness;
    lut[i] = clamp(v * 255, 0, 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    if (saturation !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * saturation; g = l + (g - l) * saturation; b = l + (b - l) * saturation;
    }
    d[i] = clamp(r, 0, 255); d[i + 1] = clamp(g, 0, 255); d[i + 2] = clamp(b, 0, 255);
  }
  return img;
}

/** Knock out a flat background by flooding inward from the edges. */
export function removeBackground(img, tolerance = 24) {
  const { width: w, height: h, data: d } = img;
  const seedIdx = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  const seeds = seedIdx.map(i => [d[i], d[i + 1], d[i + 2]]);
  const tol2 = tolerance * tolerance * 3 * 260;
  const seen = new Uint8Array(w * h);
  const stack = [0, w - 1, (h - 1) * w, (h - 1) * w + w - 1];
  const matches = i => seeds.some(s => colorDist2(d[i], d[i + 1], d[i + 2], s[0], s[1], s[2]) <= tol2);

  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    const i = p * 4;
    if (d[i + 3] === 0) { seen[p] = 1; continue; }
    if (!matches(i)) continue;
    seen[p] = 1;
    d[i + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  return img;
}

/* ---- Quantisation ------------------------------------------------------- */
function nearestIndex(palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dd = colorDist2(r, g, b, p[0], p[1], p[2]);
    if (dd < bestD) { bestD = dd; best = i; if (dd === 0) break; }
  }
  return best;
}

/** Sample the image and derive an N-colour palette from it. */
export function derivePalette(img, count = 16) {
  const d = img.data;
  const pts = [];
  const stride = Math.max(4, Math.floor(d.length / 4 / 6000) * 4);
  for (let i = 0; i < d.length; i += stride) {
    if (d[i + 3] < 128) continue;
    pts.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!pts.length) return [[0, 0, 0]];
  return medianCut(pts, count);
}

/**
 * Quantise in place.
 * @param {ImageData} img
 * @param {Array<[r,g,b]>} palette
 * @param {string} dither  none | floyd | atkinson | bayer
 * @param {number} strength 0..1
 */
export function quantize(img, palette, dither = 'none', strength = 1) {
  const { width: w, height: h, data: d } = img;
  if (!palette?.length) return img;

  if (dither === 'bayer') {
    const spread = 34 * strength;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 128) { d[i + 3] = 0; continue; }
      const t = (bayer(x, y) - 0.5) * spread;
      const p = palette[nearestIndex(palette, d[i] + t, d[i + 1] + t, d[i + 2] + t)];
      d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = 255;
    }
    return img;
  }

  if (dither === 'none') {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) { d[i + 3] = 0; continue; }
      const p = palette[nearestIndex(palette, d[i], d[i + 1], d[i + 2])];
      d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = 255;
    }
    return img;
  }

  /* Error diffusion — work in a float buffer so errors do not clip early. */
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    buf[j] = d[i]; buf[j + 1] = d[i + 1]; buf[j + 2] = d[i + 2];
  }
  const kernels = {
    floyd:    [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
    atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  };
  const K = kernels[dither] || kernels.floyd;

  for (let y = 0; y < h; y++) {
    const leftToRight = (y & 1) === 0 || dither === 'atkinson';
    for (let k = 0; k < w; k++) {
      const x = leftToRight ? k : w - 1 - k;
      const p3 = (y * w + x) * 3, p4 = (y * w + x) * 4;
      if (d[p4 + 3] < 128) { d[p4 + 3] = 0; continue; }
      const r = buf[p3], g = buf[p3 + 1], b = buf[p3 + 2];
      const pal = palette[nearestIndex(palette, r, g, b)];
      d[p4] = pal[0]; d[p4 + 1] = pal[1]; d[p4 + 2] = pal[2]; d[p4 + 3] = 255;
      const er = (r - pal[0]) * strength, eg = (g - pal[1]) * strength, eb = (b - pal[2]) * strength;
      for (const [kx, ky, f] of K) {
        const nx = x + (leftToRight ? kx : -kx), ny = y + ky;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = (ny * w + nx) * 3;
        buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f;
      }
    }
  }
  return img;
}

/** Snap soft edges to hard alpha, which is what pixel art wants. */
export function hardenAlpha(img, threshold = 128) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= threshold ? 255 : 0;
  return img;
}

/* ---- Whole pipeline ----------------------------------------------------- */
/**
 * @param {ImageBitmap|HTMLImageElement} img
 * @param {number} w @param {number} h
 * @param {object} o full settings from the import dialog
 * @returns {{ imageData, palette }}
 */
export function convert(img, w, h, o = {}) {
  const data = rasterize(img, w, h, o);
  applyAdjust(data, o);
  if (o.removeBg) removeBackground(data, o.bgTolerance ?? 24);
  if (o.hardAlpha !== false) hardenAlpha(data, o.alphaThreshold ?? 128);

  let palette = null;
  if (o.paletteMode === 'fixed' && o.paletteColors?.length) {
    palette = o.paletteColors.map(c => (typeof c === 'string' ? hexToRgba(c).slice(0, 3) : c));
  } else if (o.paletteMode === 'auto') {
    palette = derivePalette(data, clamp(o.colorCount ?? 16, 2, 128));
  }
  if (palette) quantize(data, palette, o.dither || 'none', o.ditherStrength ?? 1);

  return { imageData: data, palette };
}

/** Load a File into something rasterize() accepts. */
export async function fileToImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('That image could not be read.')); img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
