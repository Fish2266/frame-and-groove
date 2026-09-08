/* ============================================================================
   Drawing operations.

   Every function here mutates a flat RGBA buffer in place and knows nothing
   about the editor, undo or the DOM. That separation is what lets the same
   code back the painting canvas, the 16×16 disc sprite editor and the pack
   icon editor without special cases.
   ========================================================================= */

import { clamp, colorDist2, rgbToHsv, hsvToRgb, luma } from '../core/util.js';
import { setPixel, blendPixel, getPixel } from './render.js';

/* ---- Brush shapes ------------------------------------------------------- */
export const BRUSH_SHAPES = ['circle', 'square', 'diamond'];

const stampCache = new Map();
/** Offsets for a brush of the given size and shape, centred on 0,0. */
export function brushOffsets(size, shape = 'circle') {
  const key = `${size}:${shape}`;
  if (stampCache.has(key)) return stampCache.get(key);
  const out = [];
  const s = Math.max(1, size | 0);
  const r = (s - 1) / 2;
  const lo = -Math.floor(r), hi = Math.ceil(r);
  for (let dy = lo; dy <= hi; dy++) {
    for (let dx = lo; dx <= hi; dx++) {
      let inside;
      if (shape === 'square') inside = true;
      else if (shape === 'diamond') inside = Math.abs(dx) + Math.abs(dy) <= r + 0.25;
      else inside = (dx * dx + dy * dy) <= (r + 0.35) * (r + 0.35);
      if (inside) out.push([dx, dy]);
    }
  }
  stampCache.set(key, out);
  return out;
}

/* ---- Masks -------------------------------------------------------------- */
/** A selection mask is a Uint8Array of w*h, 255 = editable. null = everywhere. */
export const maskAt = (mask, w, x, y) => (mask ? mask[y * w + x] : 255);

/* ---- Primitive plot ----------------------------------------------------- */
export function plot(data, w, h, x, y, rgba, opts = {}) {
  const { size = 1, shape = 'circle', alpha = 255, mask = null, erase = false } = opts;
  const offs = size === 1 ? [[0, 0]] : brushOffsets(size, shape);
  for (const [dx, dy] of offs) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    if (!maskAt(mask, w, px, py)) continue;
    if (erase) {
      if (alpha >= 255) setPixel(data, w, px, py, 0, 0, 0, 0);
      else {
        const i = (py * w + px) * 4;
        data[i + 3] = Math.max(0, data[i + 3] - alpha);
      }
    } else if (alpha >= 255 && rgba[3] >= 255) {
      setPixel(data, w, px, py, rgba[0], rgba[1], rgba[2], 255);
    } else {
      blendPixel(data, w, px, py, rgba[0], rgba[1], rgba[2], (rgba[3] ?? 255) * (alpha / 255));
    }
  }
}

/* ---- Lines -------------------------------------------------------------- */
export function strokeLine(data, w, h, x0, y0, x1, y1, rgba, opts = {}) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(data, w, h, x0, y0, rgba, opts);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Snap a line to 0/45/90 degrees — held with Shift. */
export function snapAngle(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx > ady * 2) return [x1, y0];
  if (ady > adx * 2) return [x0, y1];
  const m = Math.max(adx, ady);
  return [x0 + Math.sign(dx) * m, y0 + Math.sign(dy) * m];
}

/* ---- Rectangles --------------------------------------------------------- */
export function drawRect(data, w, h, x0, y0, x1, y1, rgba, opts = {}) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  if (opts.fill) {
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) plot(data, w, h, x, y, rgba, { ...opts, size: 1 });
  } else {
    strokeLine(data, w, h, xa, ya, xb, ya, rgba, opts);
    strokeLine(data, w, h, xa, yb, xb, yb, rgba, opts);
    strokeLine(data, w, h, xa, ya, xa, yb, rgba, opts);
    strokeLine(data, w, h, xb, ya, xb, yb, rgba, opts);
  }
}

/* ---- Ellipses (midpoint, symmetric on the pixel grid) ------------------- */
export function drawEllipse(data, w, h, x0, y0, x1, y1, rgba, opts = {}) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  const rx = (xb - xa) / 2, ry = (yb - ya) / 2;
  const cx = xa + rx, cy = ya + ry;
  if (rx < 0.5 || ry < 0.5) return strokeLine(data, w, h, xa, ya, xb, yb, rgba, opts);

  const inside = (x, y) => {
    const nx = (x + 0.5 - cx - 0.5) / (rx + 0.5), ny = (y + 0.5 - cy - 0.5) / (ry + 0.5);
    return nx * nx + ny * ny <= 1;
  };
  for (let y = ya; y <= yb; y++) {
    let runStart = -1;
    for (let x = xa; x <= xb; x++) {
      const on = inside(x, y);
      if (on && runStart < 0) runStart = x;
      if ((!on || x === xb) && runStart >= 0) {
        const runEnd = on ? x : x - 1;
        if (opts.fill) {
          for (let px = runStart; px <= runEnd; px++) plot(data, w, h, px, y, rgba, { ...opts, size: 1 });
        } else {
          const above = y > ya, below = y < yb;
          for (let px = runStart; px <= runEnd; px++) {
            const edge = px === runStart || px === runEnd ||
              !(above && inside(px, y - 1)) || !(below && inside(px, y + 1));
            if (edge) plot(data, w, h, px, y, rgba, { ...opts, size: 1 });
          }
        }
        runStart = -1;
      }
    }
  }
}

/* ---- Flood fill --------------------------------------------------------- */
export function floodFill(data, w, h, sx, sy, rgba, opts = {}) {
  const { tolerance = 0, contiguous = true, mask = null } = opts;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;
  const target = getPixel(data, w, sx, sy);
  const tol2 = tolerance * tolerance * 3;

  const match = (i) => {
    const a = data[i + 3], ta = target[3];
    if (ta === 0) return a === 0 || (tolerance > 0 && a <= tolerance);
    if (a === 0) return false;
    if (Math.abs(a - ta) > tolerance * 2.55 + 1) return false;
    return colorDist2(data[i], data[i + 1], data[i + 2], target[0], target[1], target[2]) <= tol2 * 260;
  };
  const same = (target[0] === rgba[0] && target[1] === rgba[1] && target[2] === rgba[2] && target[3] === (rgba[3] ?? 255));
  if (same && tolerance === 0) return 0;

  let filled = 0;
  const write = (x, y) => {
    if (!maskAt(mask, w, x, y)) return;
    if (rgba[3] >= 255) setPixel(data, w, x, y, rgba[0], rgba[1], rgba[2], 255);
    else blendPixel(data, w, x, y, rgba[0], rgba[1], rgba[2], rgba[3]);
    filled++;
  };

  if (!contiguous) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (match((y * w + x) * 4)) write(x, y);
    }
    return filled;
  }

  /* Scanline flood — fast and stack-safe for large canvases. */
  const seen = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (py < 0 || py >= h) continue;
    let x = px;
    while (x >= 0 && !seen[py * w + x] && match((py * w + x) * 4)) x--;
    x++;
    let spanUp = false, spanDown = false;
    while (x < w && !seen[py * w + x] && match((py * w + x) * 4)) {
      seen[py * w + x] = 1;
      write(x, py);
      if (py > 0) {
        const up = !seen[(py - 1) * w + x] && match(((py - 1) * w + x) * 4);
        if (up && !spanUp) { stack.push([x, py - 1]); spanUp = true; }
        else if (!up) spanUp = false;
      }
      if (py < h - 1) {
        const dn = !seen[(py + 1) * w + x] && match(((py + 1) * w + x) * 4);
        if (dn && !spanDown) { stack.push([x, py + 1]); spanDown = true; }
        else if (!dn) spanDown = false;
      }
      x++;
    }
  }
  return filled;
}

/* ---- Magic wand --------------------------------------------------------- */
export function magicWand(data, w, h, sx, sy, tolerance = 16, contiguous = true) {
  const mask = new Uint8Array(w * h);
  const target = getPixel(data, w, sx, sy);
  const tol2 = tolerance * tolerance * 3;
  const match = i => {
    const a = data[i + 3], ta = target[3];
    if (ta === 0) return a === 0;
    if (a === 0) return false;
    return colorDist2(data[i], data[i + 1], data[i + 2], target[0], target[1], target[2]) <= tol2 * 260;
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (match(i * 4)) mask[i] = 255;
    return mask;
  }
  const stack = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop();
    if (mask[p]) continue;
    if (!match(p * 4)) continue;
    mask[p] = 255;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  return mask;
}

export function rectMask(w, h, x0, y0, x1, y1) {
  const mask = new Uint8Array(w * h);
  const xa = clamp(Math.min(x0, x1), 0, w - 1), xb = clamp(Math.max(x0, x1), 0, w - 1);
  const ya = clamp(Math.min(y0, y1), 0, h - 1), yb = clamp(Math.max(y0, y1), 0, h - 1);
  for (let y = ya; y <= yb; y++) mask.fill(255, y * w + xa, y * w + xb + 1);
  return mask;
}
export const invertMask = m => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 255; return o; };
export const maskBounds = (mask, w, h) => {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
};

/* ---- Gradient ----------------------------------------------------------- */
const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
export const bayer = (x, y) => BAYER8[((y & 7) << 3) + (x & 7)] / 64;

export function gradientFill(data, w, h, x0, y0, x1, y1, colorA, colorB, opts = {}) {
  const { type = 'linear', dither = 'none', mask = null, steps = 0 } = opts;
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const rad = Math.sqrt(len2) || 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!maskAt(mask, w, x, y)) continue;
      let t;
      if (type === 'radial') t = clamp(Math.hypot(x - x0, y - y0) / rad, 0, 1);
      else t = clamp(((x - x0) * dx + (y - y0) * dy) / len2, 0, 1);

      if (steps > 1) t = Math.round(t * (steps - 1)) / (steps - 1);
      if (dither === 'bayer') {
        const scale = steps > 1 ? steps - 1 : 8;
        t = clamp(t + (bayer(x, y) - 0.5) / scale, 0, 1);
        if (steps > 1) t = Math.round(t * (steps - 1)) / (steps - 1);
      } else if (dither === 'noise') {
        t = clamp(t + (Math.random() - 0.5) * 0.12, 0, 1);
      }

      const r = colorA[0] + (colorB[0] - colorA[0]) * t;
      const g = colorA[1] + (colorB[1] - colorA[1]) * t;
      const b = colorA[2] + (colorB[2] - colorA[2]) * t;
      const a = (colorA[3] ?? 255) + ((colorB[3] ?? 255) - (colorA[3] ?? 255)) * t;
      if (a >= 255) setPixel(data, w, x, y, r, g, b, 255);
      else blendPixel(data, w, x, y, r, g, b, a);
    }
  }
}

/* ---- Shade (dodge / burn on the HSV value channel) ---------------------- */
export function shadePixels(data, w, h, x, y, amount, opts = {}) {
  const { size = 1, shape = 'circle', mask = null, hueShift = 0 } = opts;
  const offs = brushOffsets(size, shape);
  for (const [dx, dy] of offs) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    if (!maskAt(mask, w, px, py)) continue;
    const i = (py * w + px) * 4;
    if (data[i + 3] === 0) continue;
    const [hh, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    // Shadows drift cool and saturated, highlights warm and desaturated —
    // the thing that separates hand-shaded pixel art from a brightness slider.
    const nv = clamp(v + amount, 0.02, 1);
    const ns = clamp(s + (amount < 0 ? 0.05 : -0.04), 0, 1);
    const nh = hh + hueShift * (amount < 0 ? 1 : -1);
    const [r, g, b] = hsvToRgb(nh, ns, nv);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}

/* ---- Colour replace ----------------------------------------------------- */
export function replaceColor(data, from, to, tolerance = 0) {
  const tol2 = tolerance * tolerance * 3 * 260;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0 && from[3] !== 0) continue;
    if (colorDist2(data[i], data[i + 1], data[i + 2], from[0], from[1], from[2]) <= tol2) {
      data[i] = to[0]; data[i + 1] = to[1]; data[i + 2] = to[2];
      if (to[3] != null) data[i + 3] = to[3];
      n++;
    }
  }
  return n;
}

/* ---- Outline ------------------------------------------------------------ */
export function outlineOpaque(data, w, h, rgba, { outside = true, diagonal = false } = {}) {
  const src = new Uint8ClampedArray(data);
  const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 12;
  const dirs = diagonal
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isOpaque = opaque(x, y);
      if (outside ? isOpaque : !isOpaque) continue;
      let edge = false;
      for (const [dx, dy] of dirs) if (opaque(x + dx, y + dy) !== outside) { edge = true; break; }
      if (edge) setPixel(data, w, x, y, rgba[0], rgba[1], rgba[2], rgba[3] ?? 255);
    }
  }
}

/* ---- Auto-shade: a one-click light pass --------------------------------- */
export function autoShade(data, w, h, { angle = 315, strength = 0.16 } = {}) {
  const rad = angle * Math.PI / 180;
  const lx = Math.cos(rad), ly = -Math.sin(rad);
  const src = new Uint8ClampedArray(data);
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : src[(y * w + x) * 4 + 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      // Sobel over the alpha field approximates the silhouette's surface normal.
      const gx = (alphaAt(x + 1, y - 1) + 2 * alphaAt(x + 1, y) + alphaAt(x + 1, y + 1))
               - (alphaAt(x - 1, y - 1) + 2 * alphaAt(x - 1, y) + alphaAt(x - 1, y + 1));
      const gy = (alphaAt(x - 1, y + 1) + 2 * alphaAt(x, y + 1) + alphaAt(x + 1, y + 1))
               - (alphaAt(x - 1, y - 1) + 2 * alphaAt(x, y - 1) + alphaAt(x + 1, y - 1));
      const mag = Math.hypot(gx, gy);
      if (mag < 40) continue;
      const dot = (gx / mag) * lx + (gy / mag) * ly;
      const amt = -dot * strength;
      const [hh, s, v] = rgbToHsv(src[i], src[i + 1], src[i + 2]);
      const [r, g, b] = hsvToRgb(hh + (amt < 0 ? 8 : -6), clamp(s + (amt < 0 ? 0.06 : -0.03), 0, 1), clamp(v + amt, 0.03, 1));
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
}

/* ---- Pixel-perfect stroke cleanup --------------------------------------- */
/**
 * Remove the L-shaped double pixels a freehand stroke leaves behind, the way
 * dedicated pixel editors do. Operates on the list of points in a stroke.
 */
export function pixelPerfect(points) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const corner = (a.x !== c.x) && (a.y !== c.y) &&
      (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) &&
      (Math.abs(c.x - b.x) + Math.abs(c.y - b.y) === 1);
    if (!corner) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/* ---- Contrast-aware colour pick ---------------------------------------- */
export function readableInk(rgb) { return luma(rgb[0], rgb[1], rgb[2]) > 0.55 ? [16, 16, 20, 255] : [244, 246, 248, 255]; }
