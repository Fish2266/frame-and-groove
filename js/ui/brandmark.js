/* ============================================================================
   The mark.

   Drawn on a 16×16 grid, the same resolution as a Minecraft item, because an
   app that makes 16-pixel art should not wear a vector logo. It is the two
   things this tool makes, in one shape: a framed painting with a record
   leaning across its corner.

   Everything is computed rather than hand-plotted so it stays exact at any
   size, and every size is an integer multiple of 16 so the pixels never blur.
   ========================================================================= */

const G = 16;   // logical grid

const PAL = {
  frameDark:  '#5E4A2C',
  frameBase:  '#9C7F4E',
  frameLight: '#C4A76D',
  skyTop:     '#2B3F7A',
  skyMid:     '#7B5E96',
  skyLow:     '#E0894F',
  sun:        '#FFE2A0',
  horizon:    '#173049',
  water:      '#2C6BA6',
  waterLight: '#3F86C4',
  discEdge:   '#0C0C10',
  discBody:   '#1E1E26',
  discSheen:  '#3A3A47',
  label:      '#3FD98B',
  labelLight: '#7FE9B4',
  labelDark:  '#1E9B5E',
  centre:     '#0C0C10',
};

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} size   px; rounded down to a multiple of 16
 * @param {object} o      { bg: draw a rounded plate behind the mark }
 */
export function drawMark(canvas, size = 64, o = {}) {
  const scale = Math.max(1, Math.floor(size / G));
  const px = G * scale;
  canvas.width = px; canvas.height = px;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, px, px);

  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= G || y >= G) return;
    g.fillStyle = color;
    g.fillRect(x * scale, y * scale, scale, scale);
  };
  const rect = (x0, y0, x1, y1, color) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, color);
  };

  /* ---- One object, not two ---------------------------------------------
     Two shapes cannot both read at sixteen pixels, so the mark is a single
     idea instead: a record hung in a picture frame. It says both halves of
     what this tool makes, and it survives being shrunk to a favicon. ------ */

  const F1 = G - 1;

  // Oak frame, two pixels thick, with the game's three-tone block bevel.
  rect(0, 0, F1, F1, PAL.frameBase);
  // Lit edges first, shaded edges second — interleaving them lets the last
  // iteration repaint a corner it should not own.
  for (let i = 0; i <= F1; i++) { set(i, 0, PAL.frameLight); set(0, i, PAL.frameLight); }
  for (let i = 0; i <= F1; i++) { set(i, F1, PAL.frameDark); set(F1, i, PAL.frameDark); }
  // Plank seam across the frame, so it reads as wood rather than a border.
  for (let i = 2; i <= F1 - 2; i++) { set(i, 1, PAL.frameDark); set(1, i, PAL.frameBase); }
  set(0, 0, PAL.frameLight); set(F1, F1, PAL.frameDark);

  // Recessed opening
  const A0 = 2, A1 = F1 - 2;
  rect(A0, A0, A1, A1, '#14161C');
  for (let i = A0; i <= A1; i++) { set(i, A0, '#0A0B0F'); set(A0, i, '#0A0B0F'); }

  /* ---- The record, filling the opening --------------------------------- */
  const cx = (A0 + A1 + 1) / 2, cy = (A0 + A1 + 1) / 2;
  const R = (A1 - A0 + 1) / 2 - 0.05;
  const LR = R * 0.42;

  for (let y = A0; y <= A1; y++) {
    for (let x = A0; x <= A1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      let color;
      if (d <= 0.62) color = PAL.centre;
      else if (d <= LR) {
        color = (dx + dy < -LR * 0.55) ? PAL.labelLight
              : (dx + dy > LR * 0.75) ? PAL.labelDark
              : PAL.label;
      } else if (d > R - 0.9) color = PAL.discEdge;
      else {
        // A groove ring plus a sheen from the upper left, the way the game
        // lights a round item.
        const groove = Math.abs(d - R * 0.72) < 0.42;
        const sheen = (-dx - dy) / (R * 2) + 0.5;
        color = groove ? PAL.discSheen : (sheen > 0.70 ? PAL.discSheen : PAL.discBody);
      }
      set(x, y, color);
    }
  }

  return canvas;
}

/** A standalone canvas element at the given size. */
export function markCanvas(size = 64, o = {}) {
  const c = document.createElement('canvas');
  c.style.width = size + 'px';
  c.style.height = size + 'px';
  drawMark(c, size * Math.min(2, window.devicePixelRatio || 1), o);
  return c;
}

/** A data URI, for the favicon and anywhere CSS needs an image. */
export function markDataURL(size = 64) {
  const c = document.createElement('canvas');
  drawMark(c, size);
  return c.toDataURL('image/png');
}

/** Swap the page favicon to the real mark, at a couple of useful sizes. */
export function installFavicon() {
  for (const link of document.querySelectorAll('link[rel~="icon"]')) link.remove();
  for (const size of [32, 64, 128]) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.sizes = `${size}x${size}`;
    link.href = markDataURL(size);
    document.head.appendChild(link);
  }
  const apple = document.createElement('link');
  apple.rel = 'apple-touch-icon';
  apple.href = markDataURL(160);
  document.head.appendChild(apple);
}

/* ---- Wordmark ------------------------------------------------------------
   "F&G" as three 5×5 pixel glyphs, for the tightest places the mark has to
   appear. Kept here so the whole identity lives in one file. */
const GLYPHS = {
  F: ['11111', '10000', '11110', '10000', '10000'],
  G: ['01110', '10000', '10011', '10001', '01110'],
  '&': ['01100', '10010', '01100', '10011', '01101'],
};

export function drawGlyphs(canvas, text, scale = 2, color = '#EDF1F3') {
  const chars = [...text].filter(c => GLYPHS[c]);
  const w = chars.length * 6 - 1, h = 5;
  canvas.width = w * scale; canvas.height = h * scale;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = color;
  chars.forEach((ch, i) => {
    GLYPHS[ch].forEach((row, y) => {
      [...row].forEach((bit, x) => {
        if (bit === '1') g.fillRect((i * 6 + x) * scale, y * scale, scale, scale);
      });
    });
  });
  return canvas;
}
