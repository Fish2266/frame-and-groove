/* ============================================================================
   Disc sprites — a parametric 16×16 record, plus a smooth vector twin.

   The 16×16 version is what ships in the resource pack: every pixel is decided
   by a shader over polar coordinates, so the same eight templates work at any
   colour without hand-editing. The vector twin renders the same design with
   real arcs for the big preview, where hard pixels would look like a mistake
   rather than a choice.
   ========================================================================= */

import { hexToRgba, mixRgb, clamp, rgbToHsv, hsvToRgb } from '../core/util.js';
import { setPixel, blendPixel, flatten } from '../paint/render.js';
import { vanillaDiscData } from './vanilla.js';

const TAU = Math.PI * 2;

function hash2(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 977) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* ---- Template label shaders --------------------------------------------- */
/* Each returns which label tone a point inside the label disc should take:
   0 = base, 1 = light, 2 = shade, -1 = punch through to the body. */
const LABEL = {
  classic: (r, a, nx, ny) => (nx + ny < -0.35 ? 1 : nx + ny > 0.45 ? 2 : 0),
  ring:    (r) => (r < 0.52 ? -1 : r > 0.86 ? 2 : 0),
  split:   (r, a, nx, ny) => (ny - nx > 0 ? 2 : 0),
  wedge:   (r, a) => {
    const deg = (a / TAU) * 360;
    return (deg > 300 || deg < 40) ? 1 : (deg > 150 && deg < 230) ? 2 : 0;
  },
  dots: (r, a, nx, ny) => {
    const pts = [[0, -0.55], [0.5, 0.3], [-0.5, 0.3]];
    for (const [px, py] of pts) if (Math.hypot(nx - px, ny - py) < 0.3) return 1;
    return r > 0.9 ? 2 : 0;
  },
  radial: (r, a) => {
    const spokes = 8;
    const seg = Math.floor((a / TAU) * spokes) % 2;
    return r < 0.35 ? 0 : seg ? 1 : 2;
  },
  crescent: (r, a, nx, ny) => (Math.hypot(nx - 0.42, ny - 0.18) < 0.72 ? 2 : 1),
  shard: (r, a, nx, ny) => {
    const k = Math.abs(nx) * 1.4 + ny;
    return k < -0.3 ? 1 : k > 0.35 ? 2 : 0;
  },
};

/* ---- Geometry defaults --------------------------------------------------- */
const GEO = {
  outer: 7.05,      // body radius in px on a 16 grid
  labelR: 3.15,     // label radius
  holeR: 0.85,      // centre hole
  grooveA: 6.10,
  grooveB: 5.05,
};

/**
 * Render a disc sprite to RGBA bytes.
 * @param {object} sprite  { template, colors, grooves, gloss, outline }
 * @param {number} size    output size; 16 is the shipping size
 */
export function discSpriteData(sprite, size = 16) {
  const s = size / 16;
  const data = new Uint8ClampedArray(size * size * 4);
  const C = sprite?.colors || {};
  const rgb = (hex, fb) => hexToRgba(hex || fb).slice(0, 3);

  const body      = rgb(C.body, '#1E1E22');
  const bodyShade = rgb(C.bodyShade, '#131316');
  const bodyLight = rgb(C.bodyLight, '#2E2E35');
  const label     = rgb(C.label, '#4FBF6E');
  const labelShade= rgb(C.labelShade, '#2F8F4B');
  const labelLight= rgb(C.labelLight, '#7FE39B');
  const center    = rgb(C.center, '#1A1A1E');
  const gloss     = rgb(C.ringGloss, '#3A3A44');

  const shader = LABEL[sprite?.template] || LABEL.classic;
  const cx = size / 2, cy = size / 2;
  const R  = GEO.outer * s;
  const LR = GEO.labelR * s;
  const HR = GEO.holeR * s;
  const GA = GEO.grooveA * s, GB = GEO.grooveB * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      const d = Math.hypot(px, py);
      if (d > R) continue;                                   // outside the record

      let col;
      const ang = (Math.atan2(py, px) + TAU) % TAU;

      if (d <= HR) {
        col = center;
      } else if (d <= LR) {
        const nr = d / LR, nx = px / LR, ny = py / LR;
        const tone = shader(nr, ang, nx, ny);
        col = tone === 1 ? labelLight : tone === 2 ? labelShade : tone === -1 ? body : label;
        // Soft inner shading so the label reads as a disc, not a flat circle.
        if (tone === 0 && nr > 0.82) col = mixRgb(col, labelShade, 0.5);
      } else {
        col = body;
        if (sprite?.grooves !== false) {
          if (Math.abs(d - GA) < 0.55 * s || Math.abs(d - GB) < 0.5 * s) col = mixRgb(body, bodyLight, 0.75);
        }
        // Vinyl sheen: brighter toward the upper-left.
        const sheen = clamp((-px - py) / (R * 2) + 0.5, 0, 1);
        col = mixRgb(col, bodyLight, sheen * 0.35);
        // Rim darkening.
        if (d > R - 1.15 * s) col = mixRgb(col, bodyShade, 0.62);
        const n = hash2(x, y, 5);
        if (n > 0.93) col = mixRgb(col, bodyLight, 0.3);
      }

      setPixel(data, size, x, y, col[0], col[1], col[2], 255);
    }
  }

  // Outline: darken the outermost occupied pixel ring.
  if (sprite?.outline !== false) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * 4 + 3] === 0) continue;
        const px = x + 0.5 - cx, py = y + 0.5 - cy;
        if (Math.hypot(px, py) > R - 1.0 * s) {
          blendPixel(data, size, x, y, bodyShade[0] * 0.35, bodyShade[1] * 0.35, bodyShade[2] * 0.35, 190);
        }
      }
    }
  }

  // Specular streak across the upper-left quadrant.
  if (sprite?.gloss !== false) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * 4 + 3] === 0) continue;
        const px = x + 0.5 - cx, py = y + 0.5 - cy;
        const d = Math.hypot(px, py);
        if (d < LR + 0.5 * s) continue;
        const t = (px * 0.7 + py * 0.7);
        const band = Math.exp(-((t + R * 0.42) ** 2) / (2 * (0.9 * s) ** 2));
        if (band > 0.05) blendPixel(data, size, x, y, gloss[0], gloss[1], gloss[2], band * 140);
      }
    }
  }

  return data;
}

/* ========================================================================= */
/* THE SHIPPING SPRITE — one renderer, used by previews and by the export     */
/* ========================================================================= */

/**
 * Flatten an authored sprite document to RGBA bytes at `size`.
 * Sprite docs are authored at 16x16; anything else is point-sampled so a
 * mismatched document still previews rather than throwing.
 */
export function flattenSpriteDoc(doc, size = 16) {
  /* The editor's own compositor, so a layer set to Multiply looks the same in
     the sprite preview, on the record in the jukebox scene and in the PNG the
     pack ships. A private copy here used to drop blend modes silently. */
  const src = flatten(doc);
  if (doc.w === size && doc.h === size) return src;
  const out = new Uint8ClampedArray(size * size * 4);
  const sx = doc.w / size, sy = doc.h / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const si = (Math.min(doc.h - 1, (y * sy) | 0) * doc.w + Math.min(doc.w - 1, (x * sx) | 0)) * 4;
    const di = (y * size + x) * 4;
    out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
  }
  return out;
}

/**
 * The pixels this disc actually ships with, whichever sprite mode it uses:
 * hand-drawn pixel art, a real vanilla texture, or a generated template.
 * Every preview goes through here so what you see is what the pack writes.
 */
export function shippingSpriteData(disc, size = 16) {
  const sp = disc?.sprite || disc || {};
  if (sp.mode === 'pixels' && sp.doc) return flattenSpriteDoc(sp.doc, size);
  if (sp.mode === 'vanilla' && sp.vanilla) {
    const data = vanillaDiscData(sp.vanilla, size);
    if (data) return data;
  }
  return discSpriteData(sp, size);
}

/**
 * The shipping sprite as a canvas, blown up by a whole number so the pixel
 * grid stays square. Fractional scales are what make a 16x16 sprite look
 * mushy, so the scale is floored to at least 1.
 */
export function discFaceCanvas(disc, scale = 4, size = 16) {
  const data = shippingSpriteData(disc, size);
  const src = document.createElement('canvas');
  src.width = size; src.height = size;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  const n = Math.max(1, Math.floor(scale));
  if (n === 1) return src;
  const out = document.createElement('canvas');
  out.width = size * n; out.height = size * n;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/* ========================================================================= */
/* PALETTE HELPERS                                                           */
/* ========================================================================= */

/** Derive a full sprite palette from a single hue — the "one-click" recolour. */
export function paletteFromHue(hue, { saturation = 0.62, dark = false } = {}) {
  const L = hsvToRgb(hue, saturation * 0.8, dark ? 0.72 : 0.86);
  const M = hsvToRgb(hue, saturation, dark ? 0.55 : 0.68);
  const D = hsvToRgb(hue, Math.min(1, saturation * 1.15), dark ? 0.34 : 0.44);
  const hx = ([r, g, b]) => `#${[r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
  return {
    body: '#1E1E22', bodyShade: '#111114', bodyLight: '#31313A',
    label: hx(M), labelShade: hx(D), labelLight: hx(L),
    center: '#17171A', ringGloss: '#3A3A44',
  };
}

/** Pull a palette out of artwork the user already made (or an uploaded image). */
export function paletteFromImageData(data) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 40) continue;
    const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (s < 0.12 || v < 0.12) continue;
    const key = Math.round(h / 12) * 12;
    const b = buckets.get(key) || { n: 0, s: 0, v: 0 };
    b.n++; b.s += s; b.v += v;
    buckets.set(key, b);
  }
  if (!buckets.size) return paletteFromHue(140);
  const [hue, agg] = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  return paletteFromHue(hue, { saturation: clamp(agg.s / agg.n, 0.25, 0.9) });
}

/** Named starting points offered in the forge. */
export const DISC_PRESETS = [
  { name: 'Emerald',   hue: 145 }, { name: 'Lapis',     hue: 222 },
  { name: 'Amethyst',  hue: 275 }, { name: 'Redstone',  hue: 355 },
  { name: 'Gold',      hue: 44  }, { name: 'Copper',    hue: 20  },
  { name: 'Prismarine',hue: 175 }, { name: 'Nether',    hue: 320 },
  { name: 'Bone',      hue: 48, sat: 0.18 }, { name: 'Ink', hue: 210, sat: 0.10, dark: true },
];

export function presetPalette(p) {
  return paletteFromHue(p.hue, { saturation: p.sat ?? 0.62, dark: p.dark });
}
