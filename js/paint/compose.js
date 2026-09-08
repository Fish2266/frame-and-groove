/* ============================================================================
   Compose — turn a painting into the exact bytes that ship in the pack.
   ========================================================================= */

import { flatten } from './render.js';
import { drawFrame } from './frames.js';
import { canvasToBlob } from '../core/util.js';
import { PIXELS_PER_BLOCK } from '../core/versions.js';

/** Flattened artwork + frame, at native resolution. */
export function composePainting(painting, { withFrame = true } = {}) {
  const doc = painting.doc;
  const data = flatten(doc);
  if (withFrame && painting.frame && painting.frame.style !== 'none') {
    drawFrame(data, doc.w, doc.h, painting.frame, painting.w, painting.h);
  }
  return { data, w: doc.w, h: doc.h };
}

export function paintingCanvas(painting, opts) {
  const { data, w, h } = composePainting(painting, opts);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}

export async function paintingPNG(painting) {
  const blob = await canvasToBlob(paintingCanvas(painting));
  return new Uint8Array(await blob.arrayBuffer());
}

/** RGBA bytes → PNG bytes, via the platform encoder. */
export async function bytesToPNG(data, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  const blob = await canvasToBlob(c);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Scale an RGBA buffer to a square pack icon (64×64 by default). */
export function toPackIcon(data, w, h, size = 64) {
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  // Contain, centred, so non-square paintings are not distorted.
  const s = Math.min(size / w, size / h);
  const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
  g.drawImage(src, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
  return out;
}

export { PIXELS_PER_BLOCK };
