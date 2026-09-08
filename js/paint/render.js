/* ============================================================================
   Compositing — flatten a layered pixel document into RGBA bytes.

   Everything here works on plain Uint8ClampedArray buffers rather than canvas
   operations, because the editor needs exact, unsmoothed results and canvas
   compositing quietly changes alpha in ways pixel art notices.
   ========================================================================= */

import { clamp } from '../core/util.js';

export const BLEND_MODES = [
  { id: 'normal',   name: 'Normal' },
  { id: 'multiply', name: 'Multiply' },
  { id: 'screen',   name: 'Screen' },
  { id: 'overlay',  name: 'Overlay' },
  { id: 'add',      name: 'Add' },
  { id: 'darken',   name: 'Darken' },
  { id: 'lighten',  name: 'Lighten' },
];

function blendChannel(mode, b, s) {
  switch (mode) {
    case 'multiply': return (b * s) / 255;
    case 'screen':   return 255 - ((255 - b) * (255 - s)) / 255;
    case 'overlay':  return b < 128 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255;
    case 'add':      return b + s;
    case 'darken':   return Math.min(b, s);
    case 'lighten':  return Math.max(b, s);
    default:         return s;
  }
}

/**
 * Composite every visible layer bottom-to-top into a fresh RGBA buffer.
 * @param {object} doc  pixel document
 * @param {object} opts { skipLayer, onlyLayer, until }
 */
export function flatten(doc, opts = {}) {
  const n = doc.w * doc.h;
  const out = new Uint8ClampedArray(n * 4);
  const layers = doc.layers;
  const end = opts.until != null ? opts.until : layers.length;

  for (let li = 0; li < end; li++) {
    const layer = layers[li];
    if (!layer.visible) continue;
    if (opts.skipLayer === layer.id) continue;
    if (opts.onlyLayer && opts.onlyLayer !== layer.id) continue;
    const src = layer.data;
    const alpha = layer.opacity ?? 1;
    if (alpha <= 0) continue;
    const mode = layer.blend || 'normal';

    if (mode === 'normal' && alpha === 1) {
      // Fast path — the overwhelmingly common case.
      for (let i = 0; i < src.length; i += 4) {
        const sa = src[i + 3];
        if (sa === 0) continue;
        if (sa === 255) { out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = 255; continue; }
        const a = sa / 255, da = out[i + 3] / 255;
        const oa = a + da * (1 - a);
        if (oa <= 0) { out[i + 3] = 0; continue; }
        out[i]     = (src[i]     * a + out[i]     * da * (1 - a)) / oa;
        out[i + 1] = (src[i + 1] * a + out[i + 1] * da * (1 - a)) / oa;
        out[i + 2] = (src[i + 2] * a + out[i + 2] * da * (1 - a)) / oa;
        out[i + 3] = oa * 255;
      }
    } else {
      for (let i = 0; i < src.length; i += 4) {
        const sa = (src[i + 3] / 255) * alpha;
        if (sa <= 0) continue;
        const da = out[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) { out[i + 3] = 0; continue; }
        for (let c = 0; c < 3; c++) {
          const b = out[i + c], s = clamp(blendChannel(mode, b, src[i + c]), 0, 255);
          out[i + c] = (s * sa + b * da * (1 - sa)) / oa;
        }
        out[i + 3] = oa * 255;
      }
    }
  }
  return out;
}

/** Composite into an ImageData ready for putImageData. */
export function flattenImageData(doc, opts) {
  const bytes = flatten(doc, opts);
  return new ImageData(bytes, doc.w, doc.h);
}

/** Render a document to a fresh canvas at 1:1 pixel scale. */
export function docToCanvas(doc, opts = {}) {
  const c = document.createElement('canvas');
  c.width = doc.w; c.height = doc.h;
  const g = c.getContext('2d');
  g.putImageData(flattenImageData(doc, opts), 0, 0);
  return c;
}

/** Render RGBA bytes to a canvas. */
export function bytesToCanvas(bytes, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes), w, h), 0, 0);
  return c;
}

/** Upscale RGBA bytes by an integer factor with hard pixel edges. */
export function upscale(bytes, w, h, scale) {
  const nw = w * scale, nh = h * scale;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y / scale) | 0;
    for (let x = 0; x < nw; x++) {
      const sx = (x / scale) | 0;
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = bytes[si]; out[di + 1] = bytes[si + 1];
      out[di + 2] = bytes[si + 2]; out[di + 3] = bytes[si + 3];
    }
  }
  return { data: out, w: nw, h: nh };
}

/* ---- Pixel accessors ---------------------------------------------------- */
export function getPixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}
export function setPixel(data, w, x, y, r, g, b, a) {
  const i = (y * w + x) * 4;
  data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
}
/** Source-over a single pixel (used by soft brushes and dithering). */
export function blendPixel(data, w, x, y, r, g, b, a) {
  if (a >= 255) return setPixel(data, w, x, y, r, g, b, 255);
  if (a <= 0) return;
  const i = (y * w + x) * 4;
  const sa = a / 255, da = data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) { data[i + 3] = 0; return; }
  data[i]     = (r * sa + data[i]     * da * (1 - sa)) / oa;
  data[i + 1] = (g * sa + data[i + 1] * da * (1 - sa)) / oa;
  data[i + 2] = (b * sa + data[i + 2] * da * (1 - sa)) / oa;
  data[i + 3] = oa * 255;
}

/** Bounding box of non-transparent pixels, or null. */
export function contentBounds(data, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ---- Transforms --------------------------------------------------------- */
export function flipHorizontal(data, w, h) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = (y * w + (w - 1 - x)) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  return out;
}
export function flipVertical(data, w, h) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const src = y * w * 4, dst = (h - 1 - y) * w * 4;
    out.set(data.subarray(src, src + w * 4), dst);
  }
  return out;
}
export function rotate90(data, w, h) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const nx = h - 1 - y, ny = x;
      const di = (ny * h + nx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  return { data: out, w: h, h: w };
}
export function shift(data, w, h, dx, dy, wrap = true) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    let sy = y - dy;
    if (wrap) sy = ((sy % h) + h) % h; else if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      let sx = x - dx;
      if (wrap) sx = ((sx % w) + w) % w; else if (sx < 0 || sx >= w) continue;
      const si = (sy * w + sx) * 4, di = (y * w + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return out;
}

/* ---- Adjustments -------------------------------------------------------- */
export function adjust(data, { brightness = 0, contrast = 0, saturation = 1, hueShift = 0 } = {}) {
  const out = new Uint8ClampedArray(data);
  const c = (contrast + 1);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    let r = out[i], g = out[i + 1], b = out[i + 2];
    r = (r - 128) * c + 128 + brightness * 255;
    g = (g - 128) * c + 128 + brightness * 255;
    b = (b - 128) * c + 128 + brightness * 255;
    if (saturation !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * saturation; g = l + (g - l) * saturation; b = l + (b - l) * saturation;
    }
    out[i] = clamp(r, 0, 255); out[i + 1] = clamp(g, 0, 255); out[i + 2] = clamp(b, 0, 255);
  }
  if (hueShift) return hueRotate(out, hueShift);
  return out;
}

function hueRotate(data, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i]     = clamp(m[0] * r + m[1] * g + m[2] * b, 0, 255);
    data[i + 1] = clamp(m[3] * r + m[4] * g + m[5] * b, 0, 255);
    data[i + 2] = clamp(m[6] * r + m[7] * g + m[8] * b, 0, 255);
  }
  return data;
}

/** Count distinct opaque colours — shown in the editor status line. */
export function countColors(data, cap = 4096) {
  const set = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    set.add((data[i] << 24 | data[i + 1] << 16 | data[i + 2] << 8 | data[i + 3]) >>> 0);
    if (set.size > cap) break;
  }
  return set.size;
}
