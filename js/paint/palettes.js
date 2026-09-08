/* ============================================================================
   Palettes — colour sets that make pixel art look like it belongs in the game.

   These are built from block and dye families rather than generic colour
   wheels, because paintings that share Minecraft's own hues read as part of
   the world instead of pasted on top of it.
   ========================================================================= */

export const PALETTES = {
  wool: {
    name: 'Wool & Dye',
    hint: 'The sixteen dye colours, straight from the game.',
    colors: [
      '#E9ECEC', '#F07613', '#BD44B3', '#3AAFD9', '#F8C627', '#70B919', '#ED8DAC', '#3E4447',
      '#8E8E86', '#158991', '#792AAC', '#35399D', '#724728', '#546D1B', '#A12722', '#141519',
    ],
  },
  overworld: {
    name: 'Overworld',
    hint: 'Grass, stone, wood, water and sky.',
    colors: [
      '#7CB342', '#5D9B33', '#48792A', '#33541D', '#8FBF5B', '#A8CF74',
      '#8B6D45', '#6B5334', '#503C24', '#3A2A18', '#A98A5D', '#C4A97A',
      '#8A8A8A', '#6E6E6E', '#565656', '#3C3C3C', '#A6A6A6', '#C2C2C2',
      '#4A7FD4', '#3765AE', '#274B85', '#6FA3E8', '#9CC6F5', '#CFE6FF',
      '#E4D8A8', '#D2C089', '#B9A76E', '#F2EBCE',
      '#C86A4A', '#9E4E33', '#E8A06B', '#FFD9A0',
    ],
  },
  deepslate: {
    name: 'Deepslate & Ore',
    hint: 'The cold half of the palette — stone, metal, gemstone.',
    colors: [
      '#2A2C31', '#3A3D44', '#4C5058', '#5F646E', '#767C88', '#8F96A3',
      '#17DD62', '#0FA34A', '#0A6E33',
      '#4AA8E0', '#2E7DB0', '#1D5680',
      '#E8443B', '#B22B24', '#7A1B16',
      '#C8CDD4', '#E8ECF2', '#9AA0A8',
      '#D9C27E', '#B79A4E', '#8A7133',
      '#9C6BD6', '#7645AE', '#552C82',
    ],
  },
  nether: {
    name: 'Nether',
    hint: 'Crimson, warped, soul and blaze.',
    colors: [
      '#5A1A1A', '#7A2323', '#9E3030', '#C24040', '#E05858',
      '#B24C2E', '#D96A3E', '#F2905C',
      '#3D2A3F', '#5B3A5E', '#7B5080',
      '#1C6B6B', '#248A8A', '#33ADAD', '#5FD3D3',
      '#3A2B22', '#54413A', '#6E5A4E',
      '#F5C542', '#FFE07A', '#FF8A2B', '#C24E00',
      '#12100F', '#241F1D',
    ],
  },
  end: {
    name: 'The End',
    hint: 'Pale stone, void and chorus.',
    colors: [
      '#DDDDB8', '#C6C69C', '#A9A97F', '#8C8C66',
      '#0B0A10', '#16141F', '#241F33', '#332B4A',
      '#8E63B5', '#A97ED0', '#C79EE8',
      '#5FE0C8', '#3BB8A2', '#288C79',
      '#F2F0E4', '#FFFFFF',
    ],
  },
  copper: {
    name: 'Copper & Oxide',
    hint: 'Every stage of weathering, in order.',
    colors: [
      '#C46A45', '#E08050', '#A75232', '#7E3B22',
      '#A97A55', '#8C7B58', '#6E8A6B',
      '#54A882', '#4FBF95', '#7FD8B4',
      '#2E6B54', '#1E4D3C',
    ],
  },
  canvas: {
    name: 'Canvas',
    hint: 'Muted painterly tones for framed art.',
    colors: [
      '#F5EFE2', '#E4D9C3', '#CDBEA0', '#B09E7D', '#8E7C5D', '#6B5B41',
      '#4A3D2B', '#2E2519', '#1A150E',
      '#A8595A', '#C97B6E', '#E0A184',
      '#4C6B7A', '#6E8FA0', '#9BB7C4',
      '#6B7A4C', '#8FA06E', '#B7C49B',
      '#7A5C8E', '#9B7EAE', '#C0A7CE',
    ],
  },
  gray: {
    name: 'Grayscale',
    hint: 'Sixteen even steps for shading studies.',
    colors: [
      '#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777',
      '#888888', '#999999', '#AAAAAA', '#BBBBBB', '#CCCCCC', '#DDDDDD', '#EEEEEE', '#FFFFFF',
    ],
  },
  sunset: {
    name: 'Sunset',
    hint: 'A ready-made gradient ramp.',
    colors: [
      '#1B1033', '#331A4D', '#552A5E', '#7A3A63', '#A34B60', '#C86155',
      '#E37C4A', '#F49B48', '#FBBB55', '#FDD77A', '#FEEBAB', '#FFF8DC',
    ],
  },
};

export const PALETTE_IDS = Object.keys(PALETTES);
export const DEFAULT_PALETTE = 'overworld';

export function getPalette(id) { return PALETTES[id] || PALETTES[DEFAULT_PALETTE]; }

/** Build a ramp between two colours — used by the gradient tool and shading. */
export function ramp(hexA, hexB, steps = 5) {
  const parse = hex => {
    const h2 = hex.replace('#', '');
    return [parseInt(h2.slice(0, 2), 16), parseInt(h2.slice(2, 4), 16), parseInt(h2.slice(4, 6), 16)];
  };
  const a = parse(hexA), b = parse(hexB);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const c = [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * t));
    out.push('#' + c.map(v => v.toString(16).padStart(2, '0')).join(''));
  }
  return out;
}

/** Median-cut quantisation — used when importing photographs. */
export function medianCut(pixels, count = 16) {
  const boxes = [pixels.slice()];
  const volume = box => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const p of box) {
      if (p[0] < rMin) rMin = p[0]; if (p[0] > rMax) rMax = p[0];
      if (p[1] < gMin) gMin = p[1]; if (p[1] > gMax) gMax = p[1];
      if (p[2] < bMin) bMin = p[2]; if (p[2] > bMax) bMax = p[2];
    }
    return { r: rMax - rMin, g: gMax - gMin, b: bMax - bMin };
  };
  while (boxes.length < count) {
    let bestI = -1, bestSpan = -1, bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const v = volume(boxes[i]);
      const span = Math.max(v.r, v.g, v.b);
      if (span > bestSpan) { bestSpan = span; bestI = i; bestCh = v.r >= v.g && v.r >= v.b ? 0 : v.g >= v.b ? 1 : 2; }
    }
    if (bestI < 0) break;
    const box = boxes[bestI];
    box.sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes.splice(bestI, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.filter(b => b.length).map(b => {
    let r = 0, g = 0, bl = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    return [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)];
  });
}
