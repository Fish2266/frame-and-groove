/* ============================================================================
   Vanilla disc templates — the real item textures, optionally recoloured.

   The parametric templates in sprite.js are for making something new. This is
   the other half of the job: starting from a disc that already looks exactly
   like the game, because it *is* a real texture from the bundled pack. Nothing
   here is drawn from memory or approximated.

   Recolouring works on the label only. Every vanilla disc is a near-black
   vinyl body with one saturated label, so shifting hue on the saturated pixels
   and leaving the grey ones alone gives a disc that still reads as vanilla —
   just in your colour.
   ========================================================================= */

import { textureCanvasSync, decodeTexture, vanillaDiscIds } from '../core/texturepack.js';
import { rgbToHsv, hsvToRgb, clamp } from '../core/util.js';

/** Ordered so the familiar ones come first when a jar has extras. */
const PREFERRED = [
  'music_disc_13', 'music_disc_cat', 'music_disc_blocks', 'music_disc_chirp',
  'music_disc_far', 'music_disc_mall', 'music_disc_mellohi', 'music_disc_stal',
  'music_disc_strad', 'music_disc_ward', 'music_disc_11', 'music_disc_wait',
  'music_disc_otherside', 'music_disc_5', 'music_disc_pigstep', 'music_disc_relic',
  'music_disc_creator', 'music_disc_creator_music_box', 'music_disc_precipice',
  'music_disc_tears', 'music_disc_lava_chicken', 'music_disc_bounce',
];

/** Which vanilla discs are actually available right now. */
export function availableVanillaDiscs() {
  const found = vanillaDiscIds();
  const set = new Set(found);
  const ordered = PREFERRED.filter(id => set.has(id));
  for (const id of found) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

export const hasVanillaDiscs = () => availableVanillaDiscs().length > 0;

export const prettyDiscName = id =>
  id.replace(/^music_disc_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Make sure a disc texture is decoded before a synchronous render needs it. */
export async function preloadVanillaDiscs(ids = availableVanillaDiscs()) {
  await Promise.all(ids.map(id => decodeTexture(`item/${id}`)));
}

/**
 * Render a vanilla disc, optionally recoloured.
 * @param {object} v { base, recolor, hue, sat, val }
 * @param {number} size output size (16 is what ships)
 * @returns {Uint8ClampedArray|null} null when the texture is not loaded
 */
export function vanillaDiscData(v, size = 16) {
  const base = v?.base || 'music_disc_13';
  const src = textureCanvasSync(`item/${base}`);
  if (!src) return null;

  const g = src.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, src.width, src.height);
  let data = img.data;

  if (v?.recolor) {
    data = new Uint8ClampedArray(data);
    const targetHue = ((v.hue ?? 145) % 360 + 360) % 360;
    const satMul = v.sat ?? 1;
    const valMul = v.val ?? 1;

    /* The label is whatever carries real colour; the vinyl is near-grey and is
       left alone so the disc keeps its vanilla weight and shading. */
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const [hh, ss, vv] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (ss < 0.18) continue;
      const [r, gg, b] = hsvToRgb(targetHue, clamp(ss * satMul, 0, 1), clamp(vv * valMul, 0, 1));
      data[i] = r; data[i + 1] = gg; data[i + 2] = b;
    }
  }

  if (src.width === size) return data;

  /* Nearest-neighbour to the requested size — a vanilla texture is already
     16×16, so this only ever runs for a zoomed preview. */
  const out = new Uint8ClampedArray(size * size * 4);
  const sx = src.width / size, sy = src.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = ((Math.min(src.height - 1, (y * sy) | 0)) * src.width + Math.min(src.width - 1, (x * sx) | 0)) * 4;
      const di = (y * size + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return out;
}

/** A canvas of a vanilla disc at an integer scale, for pickers and previews. */
export function vanillaDiscCanvas(v, scale = 1) {
  const data = vanillaDiscData(v, 16);
  const c = document.createElement('canvas');
  c.width = 16 * scale; c.height = 16 * scale;
  if (!data) return c;
  const src = document.createElement('canvas');
  src.width = 16; src.height = 16;
  src.getContext('2d').putImageData(new ImageData(data, 16, 16), 0, 0);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** The dominant label hue of a vanilla disc, so recolouring can start from it. */
export function baseHue(base) {
  const src = textureCanvasSync(`item/${base}`);
  if (!src) return 145;
  const img = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
  const buckets = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 40) continue;
    const [hh, ss] = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
    if (ss < 0.2) continue;
    const key = Math.round(hh / 10) * 10;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  if (!buckets.size) return 145;
  return [...buckets.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function createVanillaSprite(base = 'music_disc_13') {
  return { base, recolor: false, hue: baseHue(base), sat: 1, val: 1 };
}
