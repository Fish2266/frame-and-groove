/* ============================================================================
   Frames — procedural borders that adapt to any painting size.

   A frame is drawn straight into the flattened RGBA buffer at native
   resolution (16 px per block), so a 1×1 painting gets a 1 px frame and a 4×4
   gets a 3 px one without any stretching. Every style is defined as a small
   palette plus a per-pixel shader, which keeps them consistent and lets the
   thumbnail chooser render each one live at whatever size it needs.
   ========================================================================= */

import { hexToRgba, mixRgb, clamp } from '../core/util.js';
import { setPixel, blendPixel } from './render.js';

/* Deterministic value noise — same input, same grain, every render. */
function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040888963407) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* ---- Palettes ----------------------------------------------------------- */
/* base / light / dark / accent — accent is used for seams, rivets and gloss. */
export const FRAME_PALETTES = {
  oak:       { base: '#9C7F4E', light: '#BFA269', dark: '#6B5533', accent: '#8A6E42', grain: 0.16 },
  dark_oak:  { base: '#4A3220', light: '#61432C', dark: '#2E1E12', accent: '#3D2A1A', grain: 0.18 },
  birch:     { base: '#D7CB8D', light: '#EFE5B2', dark: '#A89C63', accent: '#C4B77B', grain: 0.13 },
  spruce:    { base: '#6E4E2E', light: '#8A6440', dark: '#4A331D', accent: '#5C4126', grain: 0.17 },
  stone:     { base: '#7C7C7C', light: '#9E9E9E', dark: '#585858', accent: '#8A8A8A', grain: 0.22 },
  deepslate: { base: '#4C4C52', light: '#63636B', dark: '#333338', accent: '#565660', grain: 0.24 },
  copper:    { base: '#C1683F', light: '#E28A5C', dark: '#8C482A', accent: '#4FA487', grain: 0.20 },
  gold:      { base: '#E4BC44', light: '#FBE192', dark: '#A9821F', accent: '#FFF3B8', grain: 0.10 },
  iron:      { base: '#C4C4C4', light: '#E8E8E8', dark: '#8F8F8F', accent: '#D8D8D8', grain: 0.12 },
  rope:      { base: '#93714A', light: '#B58F60', dark: '#654B2E', accent: '#7E6040', grain: 0.20 },
  hairline:  { base: '#1A1A1C', light: '#3A3A40', dark: '#000000', accent: '#2A2A30', grain: 0.0  },
};

/* ---- Thickness ---------------------------------------------------------- */
/** Auto thickness scales with the smaller dimension so frames read the same
 *  visual weight on a 1×1 as on a 4×4. */
export function autoThickness(blocksW, blocksH) {
  const m = Math.min(blocksW, blocksH);
  if (m <= 1) return 1;
  if (m <= 2) return 2;
  if (m <= 3) return 2;
  return 3;
}
export function resolveThickness(frame, blocksW, blocksH) {
  const t = frame?.thickness;
  if (t == null || t === 'auto' || t === 0) return autoThickness(blocksW, blocksH);
  return clamp(t | 0, 1, 6);
}

/* ---- Style shaders ------------------------------------------------------ */
/**
 * Each shader answers: given a pixel in the border ring, what colour is it?
 *   ctx = { x, y, w, h, t, depth, along, edge, pal, rgb }
 *   depth — 0 at the outermost pixel, t-1 at the innermost
 *   along — distance travelled along that edge, for seams and twists
 *   edge  — 'top' | 'bottom' | 'left' | 'right' | 'corner'
 */
const SHADERS = {
  plank(c) {
    const { depth, along, t, pal } = c;
    let col = pal.baseRGB;
    if (depth === 0) col = pal.darkRGB;
    else if (depth === t - 1 && t > 1) col = pal.darkRGB;
    else if (c.edge === 'top' || c.edge === 'left') col = pal.lightRGB;
    // Plank seams every 5–6 px along the run.
    const period = t >= 3 ? 6 : 5;
    if (along % period === 0 && depth > 0 && depth < t) col = pal.darkRGB;
    const g = (hash2(c.x, c.y, 11) - 0.5) * 2 * pal.grain * 255;
    return [col[0] + g, col[1] + g, col[2] + g];
  },

  stone(c) {
    const { depth, t, pal } = c;
    let col = pal.baseRGB;
    if (depth === 0) col = pal.darkRGB;
    else if (depth === t - 1 && t > 1) col = pal.darkRGB;
    else if (c.edge === 'top' || c.edge === 'left') col = pal.lightRGB;
    const n = hash2(c.x, c.y, 7);
    const speck = n > 0.86 ? 26 : n < 0.12 ? -26 : (n - 0.5) * 2 * pal.grain * 200;
    return [col[0] + speck, col[1] + speck, col[2] + speck];
  },

  metal(c) {
    const { depth, along, t, pal } = c;
    let col = pal.baseRGB;
    if (depth === 0) col = pal.darkRGB;
    else if (c.edge === 'top' || c.edge === 'left') col = pal.lightRGB;
    else if (depth === t - 1 && t > 1) col = pal.darkRGB;
    // Rivets at regular intervals, and a bright specular on the top edge.
    const rivetPeriod = t >= 3 ? 8 : 7;
    if (t >= 2 && depth === Math.floor(t / 2) && along % rivetPeriod === 3) col = pal.accentRGB;
    if (c.edge === 'top' && depth === 1 && t >= 3) col = mixRgb(col, pal.lightRGB, 0.55);
    const g = (hash2(c.x, c.y, 3) - 0.5) * 2 * pal.grain * 160;
    return [col[0] + g, col[1] + g, col[2] + g];
  },

  copper(c) {
    const out = SHADERS.metal(c);
    // Scattered oxidation, denser toward the corners.
    const n = hash2(c.x, c.y, 91);
    const cornerBias = c.edge === 'corner' ? 0.22 : 0;
    if (n > 0.88 - cornerBias) return mixRgb(out, c.pal.accentRGB, 0.75);
    if (n > 0.80 - cornerBias) return mixRgb(out, c.pal.accentRGB, 0.34);
    return out;
  },

  rope(c) {
    const { depth, along, t, pal } = c;
    // A twisted cord: the highlight travels diagonally along the run.
    const phase = (along + depth * 2) % 4;
    let col = phase === 0 ? pal.lightRGB : phase === 1 ? pal.baseRGB : phase === 2 ? pal.accentRGB : pal.darkRGB;
    if (depth === 0 || (depth === t - 1 && t > 1)) col = mixRgb(col, pal.darkRGB, 0.45);
    const g = (hash2(c.x, c.y, 23) - 0.5) * 2 * pal.grain * 120;
    return [col[0] + g, col[1] + g, col[2] + g];
  },

  hairline(c) {
    const { depth, t, pal } = c;
    if (depth === 0) return pal.darkRGB;
    if (depth === t - 1 && t > 1) return pal.lightRGB;
    return pal.baseRGB;
  },
};

const STYLE_SHADER = {
  oak: 'plank', dark_oak: 'plank', birch: 'plank', spruce: 'plank',
  stone: 'stone', deepslate: 'stone',
  copper: 'copper', gold: 'metal', iron: 'metal',
  rope: 'rope', hairline: 'hairline',
};

/* ---- Main entry --------------------------------------------------------- */
/**
 * Draw a frame ring into an RGBA buffer, in place.
 * @param {Uint8ClampedArray} data
 * @param {number} w pixel width  @param {number} h pixel height
 * @param {object} frame { style, thickness, tint, inner }
 * @param {number} blocksW @param {number} blocksH
 */
export function drawFrame(data, w, h, frame, blocksW, blocksH) {
  const style = frame?.style || 'none';
  if (style === 'none') return data;
  const raw = FRAME_PALETTES[style];
  if (!raw) return data;

  const t = Math.min(resolveThickness(frame, blocksW, blocksH), Math.floor(Math.min(w, h) / 2));
  if (t < 1) return data;

  const tint = frame?.tint ? hexToRgba(frame.tint) : null;
  const pal = buildPalette(raw, tint);
  const shade = SHADERS[STYLE_SHADER[style] || 'plank'];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dTop = y, dBottom = h - 1 - y, dLeft = x, dRight = w - 1 - x;
      const depth = Math.min(dTop, dBottom, dLeft, dRight);
      if (depth >= t) continue;

      let edge, along;
      const vert = Math.min(dTop, dBottom), horiz = Math.min(dLeft, dRight);
      if (vert < t && horiz < t) { edge = 'corner'; along = Math.max(x, y); }
      else if (vert <= horiz)    { edge = dTop < dBottom ? 'top' : 'bottom'; along = x; }
      else                       { edge = dLeft < dRight ? 'left' : 'right'; along = y; }

      let col = shade({ x, y, w, h, t, depth, along, edge, pal });

      // Corners darken slightly so the mitre reads.
      if (edge === 'corner') col = mixRgb(col, pal.darkRGB, 0.28);

      setPixel(data, w, x, y,
        clamp(col[0], 0, 255), clamp(col[1], 0, 255), clamp(col[2], 0, 255), 255);
    }
  }

  // A single-pixel inner shadow so the artwork sits *inside* the frame.
  if (frame?.inner !== false && t >= 1 && w > t * 2 + 1 && h > t * 2 + 1) {
    const x0 = t, y0 = t, x1 = w - t - 1, y1 = h - t - 1;
    for (let x = x0; x <= x1; x++) {
      blendPixel(data, w, x, y0, 0, 0, 0, 70);
      blendPixel(data, w, x, y1, 255, 255, 255, 24);
    }
    for (let y = y0; y <= y1; y++) {
      blendPixel(data, w, x0, y, 0, 0, 0, 70);
      blendPixel(data, w, x1, y, 255, 255, 255, 24);
    }
  }
  return data;
}

function buildPalette(raw, tint) {
  const toRGB = hex => hexToRgba(hex).slice(0, 3);
  let base = toRGB(raw.base), light = toRGB(raw.light), dark = toRGB(raw.dark), accent = toRGB(raw.accent);
  if (tint) {
    const t = [tint[0], tint[1], tint[2]];
    const amt = (tint[3] ?? 255) / 255 * 0.7;
    base = mixRgb(base, t, amt); light = mixRgb(light, t, amt * 0.8);
    dark = mixRgb(dark, t, amt * 0.9); accent = mixRgb(accent, t, amt * 0.5);
  }
  return { baseRGB: base, lightRGB: light, darkRGB: dark, accentRGB: accent, grain: raw.grain };
}

/** How many pixels of artwork the frame eats on each side. */
export function frameInset(frame, blocksW, blocksH) {
  if (!frame || frame.style === 'none') return 0;
  return resolveThickness(frame, blocksW, blocksH);
}

/** Render a standalone frame swatch for the chooser. */
export function frameSwatch(style, size = 22, blocks = 2) {
  const data = new Uint8ClampedArray(size * size * 4);
  // Mid-grey artwork stand-in so the frame reads against something.
  for (let i = 0; i < data.length; i += 4) {
    const v = 92 + ((i / 4) % size % 2 === 0 ? 6 : 0);
    data[i] = v; data[i + 1] = v + 4; data[i + 2] = v + 8; data[i + 3] = 255;
  }
  drawFrame(data, size, size, { style, thickness: style === 'hairline' ? 1 : 2, inner: true }, blocks, blocks);
  return { data, w: size, h: size };
}

export const FRAME_IDS = Object.keys(FRAME_PALETTES);
