/* ============================================================================
   Pixel-art illustrations for empty states.

   Drawn on a coarse logical grid from blocky primitives rather than plotted by
   hand, so each scene stays crisp at any size and can borrow the same
   generated block textures the rest of the theme uses. An empty screen is the
   one everybody sees first — it should look made, not defaulted.
   ========================================================================= */

import { drawBevel, blockCanvasSync } from './textures.js';

/* Which real block each illustration stand-in maps to. */
const GAME_BLOCK = {
  stone: 'block/stone',
  cobble: 'block/cobblestone',
  deepslate: 'block/deepslate',
  dirt: 'block/dirt',
  oak: 'block/oak_planks',
  darkOak: 'block/dark_oak_planks',
  grass: 'block/grass_block_top',
  stoneBricks: 'block/stone_bricks',
};
import { discFaceCanvas } from '../disc/sprite.js';
import { hasTexture, listTextures, textureCanvasSync } from '../core/texturepack.js';

const GRID = 48;   // logical pixels per side

function setup(canvas, size) {
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, size, size);
  const s = size / GRID;
  return { g, s, px: (n) => Math.round(n * s) };
}

/** Fill a logical-grid rect with a flat colour. */
function box(g, s, x, y, w, h, fill) {
  g.fillStyle = fill;
  g.fillRect(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
}

/** Fill a logical-grid rect with a block texture — the real one when a game
 *  jar is linked, the generated stand-in otherwise. */
function texBox(g, s, x, y, w, h, name, opts = {}) {
  const tile = blockCanvasSync(name, GAME_BLOCK[name] || null, opts);
  const pat = g.createPattern(tile, 'repeat');
  g.save();
  g.translate(Math.round(x * s), Math.round(y * s));
  g.scale(s * (opts.zoom || 0.5), s * (opts.zoom || 0.5));
  g.fillStyle = pat;
  g.fillRect(0, 0, (w / (opts.zoom || 0.5)), (h / (opts.zoom || 0.5)));
  g.restore();

  /* Some of the game's textures ship greyscale and are coloured at runtime —
     grass is the obvious one, which is why an untinted grass block looks like
     stone. Multiply is what the game does, so it is what happens here. */
  if (opts.tint) {
    g.save();
    g.beginPath();
    g.rect(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
    g.clip();
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = opts.tintAmount ?? 1;
    g.fillStyle = opts.tint;
    g.fillRect(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
    g.restore();
  }
}

/**
 * Draw a real texture into the logical grid, nearest-neighbour.
 *
 * This is the one that matters for the empty states: an item sprite the game
 * ships is instantly recognisable in a way a hand-drawn approximation of it
 * never is, and it is already sitting in the bundled set.
 */
function sprite(g, s, name, x, y, w, h, { alpha = 1, flip = false } = {}) {
  const tex = textureCanvasSync(name);
  if (!tex) return false;
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalAlpha = alpha;
  const dx = Math.round(x * s), dy = Math.round(y * s);
  const dw = Math.round(w * s), dh = Math.round(h * s);
  if (flip) { g.translate(dx + dw, dy); g.scale(-1, 1); g.drawImage(tex, 0, 0, dw, dh); }
  else g.drawImage(tex, dx, dy, dw, dh);
  g.restore();
  return true;
}

/** A soft ellipse of shadow, so an object sits on the ground instead of over it. */
function contactShadow(g, s, cx, cy, rx, ry = rx * 0.36, strength = 0.5) {
  const grad = g.createRadialGradient(cx * s, cy * s, 0, cx * s, cy * s, rx * s);
  grad.addColorStop(0, `rgba(0,0,0,${strength})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.save();
  g.translate(cx * s, cy * s);
  g.scale(1, ry / rx);
  g.translate(-cx * s, -cy * s);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx * s, cy * s, rx * s, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** The three-tone edge that makes a Minecraft block read as solid. */
function bevel(g, s, x, y, w, h, raised = true, thickness = 1) {
  drawBevel(g, Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s),
    { raised, px: Math.max(1, Math.round(thickness * s)) });
}

/* ========================================================================= */

/* ---- The four content sections ----------------------------------------- *
   Each of these is built from textures the game ships rather than from boxes
   painted to look like them. A hand-drawn approximation of a jukebox reads as
   "some brown box"; the real jukebox reads as a jukebox to anybody who has
   played the game for five minutes, which is everybody who will see it.       */

/** A wall with the painting item hung on it, waiting to become artwork. */
export function drawEmptyFrame(canvas, size = 96, accent = '#F2B33D') {
  const { g, s } = setup(canvas, size);

  // Stone-brick wall, dimmed so the item is what the eye lands on.
  texBox(g, s, 0, 0, GRID, GRID, 'stoneBricks', { zoom: 0.5 });
  g.fillStyle = 'rgba(8,10,13,.46)';
  g.fillRect(0, 0, size, size);

  // The nail it hangs from, and the shadow it casts on the bricks.
  box(g, s, 23, 7, 2, 2, '#2A2A2E');
  box(g, s, 23, 7, 1, 1, '#7A7A84');

  g.save();
  g.shadowColor = 'rgba(0,0,0,.55)';
  g.shadowBlur = 5 * s;
  g.shadowOffsetY = 2.5 * s;
  const ok = sprite(g, s, 'item/painting', 12, 12, 24, 24);
  g.restore();

  if (!ok) {
    // The set has not decoded yet — an empty frame still says "painting".
    box(g, s, 12, 12, 24, 24, '#8A6E42');
    bevel(g, s, 12, 12, 24, 24, true, 1);
    box(g, s, 15, 15, 18, 18, '#1A1E22');
  }

  // A single stroke of colour, the one thing here that is yours.
  g.globalAlpha = 0.9;
  for (let i = 0; i < 7; i++) box(g, s, 17 + i, 30 - i, 1, 1, accent);
  g.globalAlpha = 1;

  return canvas;
}

/** A jukebox with a disc hovering over it, ready to drop in. */
export function drawEmptyJukebox(canvas, size = 96, accent = '#B084F5') {
  const { g, s } = setup(canvas, size);

  const top = textureCanvasSync('block/jukebox_top');
  const side = textureCanvasSync('block/jukebox_side');

  contactShadow(g, s, 24, 36, 15, 5, 0.5);

  if (top && side) {
    isoBlock(g, 24 * s, 18 * s, 12 * s, { top, left: side, right: side });
  } else {
    box(g, s, 12, 16, 24, 20, '#59391F');
    texBox(g, s, 12, 16, 24, 20, 'oak', { zoom: 0.5 });
    bevel(g, s, 12, 16, 24, 20, true, 1);
  }

  // The disc, floating just above the slot with its own small shadow.
  g.save();
  g.shadowColor = 'rgba(0,0,0,.45)';
  g.shadowBlur = 4 * s;
  g.shadowOffsetY = 2 * s;
  const ok = sprite(g, s, 'item/music_disc_13', 16, 2, 16, 16);
  g.restore();

  if (!ok) {
    g.beginPath(); g.arc(24 * s, 10 * s, 6 * s, 0, Math.PI * 2);
    g.fillStyle = '#1B1B20'; g.fill();
    g.beginPath(); g.arc(24 * s, 10 * s, 2.4 * s, 0, Math.PI * 2);
    g.fillStyle = accent; g.fill();
  }

  // Two notes drifting off, in the section's colour.
  g.globalAlpha = 0.85;
  box(g, s, 38, 12, 2, 2, accent); box(g, s, 39, 8, 1, 5, accent); box(g, s, 39, 8, 3, 1, accent);
  g.globalAlpha = 0.5;
  box(g, s, 7, 16, 2, 2, accent); box(g, s, 8, 13, 1, 4, accent);
  g.globalAlpha = 1;

  return canvas;
}

/* ---- The cow -------------------------------------------------------------
   The head is one 8×8×6 box at UV (0, 0) on the cow's own entity sheet, so its
   three visible faces come straight off the texture the game draws with. A
   whole cow is unreadable at this size; a head is how the game solves the same
   problem on its spawn eggs.                                                  */
const COW_HEAD = { u: 0, v: 0, w: 8, h: 8, d: 6 };

let _cowFaces = null;
function cowHeadFaces() {
  if (_cowFaces) return _cowFaces;
  const tex = textureCanvasSync('entity/cow/cow_temperate');
  if (!tex) return null;
  const { u, v, w, h, d } = COW_HEAD;
  const cut = (x, y, cw, ch) => {
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const cg = c.getContext('2d');
    cg.imageSmoothingEnabled = false;
    cg.drawImage(tex, x, y, cw, ch, 0, 0, cw, ch);
    return c;
  };
  /* The standard Minecraft box unwrap: up sits at (u+d, v), the front face at
     (u+d, v+d), and the side before it at (u, v+d). */
  _cowFaces = {
    top:   cut(u + d, v, w, d),
    front: cut(u + d, v + d, w, h),
    side:  cut(u, v + d, d, h),
  };
  return _cowFaces;
}

/** A cow's head on a patch of grass — the mobs section, at a glance. */
export function drawEmptyMob(canvas, size = 96, accent = '#5FC9E8') {
  const { g, s } = setup(canvas, size);

  // A strip of ground, so the head is standing somewhere rather than floating.
  texBox(g, s, 0, 32, GRID, 16, 'grass', { zoom: 0.5, tint: '#79C05A' });
  g.fillStyle = 'rgba(8,10,13,.34)';
  g.fillRect(0, Math.round(32 * s), size, Math.round(16 * s));

  contactShadow(g, s, 24, 35, 14, 4.5, 0.5);

  const faces = cowHeadFaces();
  if (faces) {
    isoBlock(g, 24 * s, 10 * s, 12 * s, { top: faces.top, left: faces.side, right: faces.front });
  } else {
    // No entity sheet yet — the spawn egg says the same thing.
    if (!sprite(g, s, 'item/cow_spawn_egg', 16, 14, 16, 16)) {
      box(g, s, 15, 14, 18, 18, '#6B4B2E');
      bevel(g, s, 15, 14, 18, 18, true, 1);
    }
  }

  // A glimmer, the same note the other scenes end on.
  g.globalAlpha = 0.85;
  box(g, s, 9, 10, 1, 1, accent);
  box(g, s, 39, 14, 1, 1, accent);
  g.globalAlpha = 0.5;
  box(g, s, 33, 6, 1, 1, accent);
  g.globalAlpha = 1;

  return canvas;
}

/** A name tag beside a sword — rename the one, retexture the other. */
export function drawEmptyNameTag(canvas, size = 96, accent = '#E8896B') {
  const { g, s } = setup(canvas, size);

  // A worktop, with the wall above it left dark so the items carry the frame.
  texBox(g, s, 0, 31, GRID, 17, 'stoneBricks', { zoom: 0.5 });
  g.fillStyle = 'rgba(8,10,13,.46)';
  g.fillRect(0, Math.round(31 * s), size, Math.round(17 * s));
  box(g, s, 0, 31, GRID, 1, 'rgba(255,255,255,.07)');

  /* The sword sits behind and dimmed: it is the thing being retextured, not
     the subject. The tag in front is the mechanism, so it gets full strength. */
  contactShadow(g, s, 32, 30, 9, 3.2, 0.42);
  sprite(g, s, 'item/stone_sword', 24, 10, 19, 19, { alpha: 0.5 });

  contactShadow(g, s, 18, 33, 12, 4, 0.55);
  g.save();
  g.shadowColor = 'rgba(0,0,0,.5)';
  g.shadowBlur = 4 * s;
  g.shadowOffsetY = 2 * s;
  const ok = sprite(g, s, 'item/name_tag', 7, 14, 22, 22);
  g.restore();

  if (!ok) {
    box(g, s, 9, 20, 18, 11, '#C9B78E');
    bevel(g, s, 9, 20, 18, 11, true, 1);
    box(g, s, 13, 24, 10, 1, accent);
  }

  // The name itself, suggested rather than spelled out.
  g.globalAlpha = 0.85;
  box(g, s, 30, 36, 9, 1, accent);
  g.globalAlpha = 0.45;
  box(g, s, 30, 39, 6, 1, accent);
  g.globalAlpha = 1;

  return canvas;
}

/* ---- The chest --------------------------------------------------------- *
   Chests are entities, not blocks: the game draws one from a single 64×64
   sheet whose faces are laid out as two box crosses (a 14×10×14 base and a
   14×5×14 lid) plus a 2×4×1 lock. Those rectangles are lifted straight out of
   the sheet here, so the illustration is the same chest the game draws rather
   than oak planks with a latch painted on.                                   */
const CHEST_UV = {
  top:        [14, 0, 14, 14],   // lid, up face
  lidFront:   [42, 14, 14, 5],   // lid, +Z
  baseFront:  [42, 33, 14, 10],  // base, +Z
  lidSide:    [0, 14, 14, 5],    // lid, +X
  baseSide:   [0, 33, 14, 10],   // base, +X
  lock:       [4, 1, 2, 4],      // lock, +Z
};

let _chestFaces = null;
/** The three faces an isometric chest needs, cut from the entity sheet. */
export function chestFaces() {
  if (_chestFaces) return _chestFaces;
  const tex = textureCanvasSync('entity/chest/normal');
  if (!tex) return null;
  const cut = (x, y, w, hh) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(tex, x, y, w, hh, 0, 0, w, hh);
    return c;
  };
  /* Lid over base makes one 14×15 elevation — the chest as you see it head on,
     one pixel short of a full block, exactly as in game. */
  const elevation = (lid, base, lock) => {
    const c = document.createElement('canvas');
    c.width = 14; c.height = 15;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(cut(...lid), 0, 0);
    g.drawImage(cut(...base), 0, 5);
    if (lock) g.drawImage(cut(...lock), 6, 4);
    return c;
  };
  _chestFaces = {
    top: cut(...CHEST_UV.top),
    front: elevation(CHEST_UV.lidFront, CHEST_UV.baseFront, CHEST_UV.lock),
    side: elevation(CHEST_UV.lidSide, CHEST_UV.baseSide, null),
  };
  return _chestFaces;
}

/** A chest — the "nothing here yet" of the whole library. */
export function drawEmptyChest(canvas, size = 96, accent = '#3FD98B') {
  const { g, s } = setup(canvas, size);

  texBox(g, s, 0, 32, GRID, 16, 'stone', { zoom: 0.5 });
  g.fillStyle = 'rgba(0,0,0,.34)';
  g.fillRect(0, Math.round(32 * s), size, Math.round(16 * s));

  const faces = chestFaces();
  const cx = 24 * s, cy = 12 * s, a = 13 * s;

  g.save();
  g.shadowColor = 'rgba(0,0,0,.5)';
  g.shadowBlur = 7 * s; g.shadowOffsetY = 3 * s;
  if (faces) {
    isoBlock(g, cx, cy, a, { top: faces.top, right: faces.front, left: faces.side });
  } else {
    // No sheet decoded yet — a plain oak box still reads as a chest.
    const bx = 10, by = 14, bw = 28, bh = 20;
    box(g, s, bx, by, bw, bh, '#8A6033');
    texBox(g, s, bx, by, bw, bh, 'oak', { zoom: 0.5 });
    bevel(g, s, bx, by, bw, bh, true, 1);
    box(g, s, bx, by + 7, bw, 1, '#4A3018');
  }
  g.restore();

  // A glimmer rising off the lid
  g.globalAlpha = 0.9;
  box(g, s, 17, 8, 1, 1, accent);
  box(g, s, 31, 9, 1, 1, accent);
  g.globalAlpha = 0.5;
  box(g, s, 24, 5, 1, 1, accent);
  g.globalAlpha = 1;

  return canvas;
}

/** A magnifier for "nothing matched". */
export function drawEmptyGlass(canvas, size = 96, accent = '#4FD8DE') {
  const { g, s } = setup(canvas, size);
  g.lineCap = 'square';

  // Handle
  g.strokeStyle = '#7A5133';
  g.lineWidth = 4 * s;
  g.beginPath();
  g.moveTo(29 * s, 29 * s); g.lineTo(39 * s, 39 * s);
  g.stroke();

  // Rim
  g.strokeStyle = '#C9C9CF';
  g.lineWidth = 3.5 * s;
  g.beginPath();
  g.arc(21 * s, 21 * s, 12 * s, 0, Math.PI * 2);
  g.stroke();

  // Lens
  g.beginPath();
  g.arc(21 * s, 21 * s, 10 * s, 0, Math.PI * 2);
  g.fillStyle = 'rgba(120,200,220,.16)';
  g.fill();

  // Highlight
  g.globalAlpha = 0.7;
  g.strokeStyle = accent;
  g.lineWidth = 2 * s;
  g.beginPath();
  g.arc(21 * s, 21 * s, 7 * s, Math.PI * 1.15, Math.PI * 1.62);
  g.stroke();
  g.globalAlpha = 1;

  return canvas;
}

/* ---- Registry ----------------------------------------------------------- */
export const SCENES = {
  frame: drawEmptyFrame,
  jukebox: drawEmptyJukebox,
  mob: drawEmptyMob,
  nametag: drawEmptyNameTag,
  chest: drawEmptyChest,
  glass: drawEmptyGlass,
};

/**
 * The colour each scene glimmers in — the same one its section wears in the
 * rail. Reading --accent instead would tint Mobs and Items green, because only
 * Art and Music currently scope an accent of their own, and a cyan section
 * with a green spark on its empty screen looks like a mistake.
 */
const SCENE_ACCENT = {
  frame:   '#F2B33D',
  jukebox: '#B084F5',
  mob:     '#5FC9E8',
  nametag: '#E8896B',
  chest:   '#3FD98B',
  glass:   '#4FD8DE',
};

/**
 * Build a scene element sized for an empty state.
 * Falls back silently to nothing if an unknown scene is asked for.
 */
export function scene(name, size = 96, accent) {
  const fn = SCENES[name];
  if (!fn) return null;
  const c = document.createElement('canvas');
  c.style.width = size + 'px';
  c.style.height = size + 'px';
  fn(c, size * Math.min(2, window.devicePixelRatio || 1), accent || SCENE_ACCENT[name]);
  return c;
}

/* ============================================================================
   Isometric block rendering — the projection Minecraft itself uses for the
   block icons in your inventory. Three faces, each a texture mapped onto a
   parallelogram, each shaded by which way it points.
   ========================================================================= */

/** Face brightness, matching the game's own top / side / side falloff. */
const FACE_LIGHT = { top: 1, right: 0.82, left: 0.62 };

/* Minecraft ships grass, leaves and vines as greyscale and multiplies a biome
   colour over them at render time. A texture pack does the same, so drawing
   them raw gives grey grass — the tint has to be applied here too. */
const BIOME_TINT = {
  'block/grass_block_top': '#79C05A',
  'block/grass_block_side_overlay': '#79C05A',
  'block/short_grass': '#79C05A',
  'block/oak_leaves': '#59AE30',
  'block/birch_leaves': '#80A755',
  'block/spruce_leaves': '#619961',
  'block/vine': '#59AE30',
  'block/lily_pad': '#71C35C',
};

const tintCache = new Map();
/** Multiply a biome colour through a greyscale texture, as the game does. */
export function biomeTinted(canvas, name) {
  const tint = BIOME_TINT[name];
  if (!tint || !canvas) return canvas;
  const key = `${name}|${canvas.width}`;
  if (tintCache.has(key)) return tintCache.get(key);
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = tint;
  g.fillRect(0, 0, c.width, c.height);
  // multiply also hits the transparent pixels; restore the original alpha.
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(canvas, 0, 0);
  tintCache.set(key, c);
  return c;
}

let _grassSide = null;
/**
 * The grass block's side, built the way the game's own model builds it: the
 * side texture underneath, with the greyscale overlay tinted by the biome
 * colour laid over the top. Drawing `dirt` here instead is what made the
 * platform read as a stack of dirt blocks.
 */
export function grassSideFace() {
  if (_grassSide) return _grassSide;
  const base = blockCanvasSync('dirt', 'block/grass_block_side');
  if (!base) return base;
  const overlay = blockFace('grass', 'block/grass_block_side_overlay');
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(base, 0, 0);
  if (overlay) g.drawImage(overlay, 0, 0, c.width, c.height);
  _grassSide = c;
  return c;
}

/** A block canvas with its biome tint already applied where one applies. */
export function blockFace(gen, game) {
  return biomeTinted(blockCanvasSync(gen, game), game);
}

function shaded(src, amount) {
  if (amount >= 1) return src;
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = `rgba(0,0,0,${(1 - amount).toFixed(3)})`;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * Draw one cube. `a` is the half-width; the block ends up 2a wide and
 * 2a tall including the vertical edge.
 */
export function isoBlock(g, x, y, a, faces) {
  const { top, left, right } = faces;
  const h = a;                      // vertical edge length on screen

  const face = (tex, ux, uy, vx, vy, ox, oy, light) => {
    if (!tex) return;
    g.save();
    g.imageSmoothingEnabled = false;
    g.setTransform(ux, uy, vx, vy, ox, oy);
    g.drawImage(shaded(tex, light), 0, 0, 1, 1);
    g.restore();
  };

  // Top: origin at the left corner, u toward the back corner, v toward front.
  face(top,   a, -a / 2, a,  a / 2, x - a, y + a / 2, FACE_LIGHT.top);
  // Left wall: origin at the left corner, u toward the front corner, v down.
  face(left,  a,  a / 2, 0,  h,     x - a, y + a / 2, FACE_LIGHT.left);
  // Right wall: origin at the front corner, u toward the right corner, v down.
  face(right, a, -a / 2, 0,  h,     x,     y + a,     FACE_LIGHT.right);

  // Crisp silhouette so the cube reads against any background.
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = 'rgba(0,0,0,.45)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y);                     g.lineTo(x + a, y + a / 2);
  g.lineTo(x + a, y + a / 2 + h);     g.lineTo(x, y + a + h);
  g.lineTo(x - a, y + a / 2 + h);     g.lineTo(x - a, y + a / 2);
  g.closePath(); g.stroke();
  g.restore();
}

/**
 * The disc preview scene: a jukebox on grass with the record above it.
 * Uses real block textures when a game jar is linked and generated ones
 * otherwise, so it always looks like something rather than a placeholder.
 */
export function drawJukeboxScene(canvas, w, h, opts = {}) {
  const g = canvas.getContext('2d');
  canvas.width = w; canvas.height = h;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, w, h);

  /* Sky */
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#78A7DC');
  sky.addColorStop(0.62, '#A9CBE9');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  const a = Math.round(Math.min(w, h) * 0.20);      // block half-width
  const cx = Math.round(w / 2);
  const groundY = Math.round(h * 0.56);

  /* A small grass platform, back row first so it overlaps correctly. */
  const grassTop = blockFace('grass', 'block/grass_block_top');
  const grassSide = grassSideFace();
  const tiles = [[-2, 1], [-1, 1], [0, 1], [1, 1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, -1], [0, -1], [1, -1]];
  tiles.sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
  for (const [ix, iy] of tiles) {
    const px = cx + (ix - iy) * a;
    const py = groundY + (ix + iy) * (a / 2);
    isoBlock(g, px, py, a, { top: grassTop, left: grassSide, right: grassSide });
  }

  /* The jukebox, sitting on the middle tile. */
  const jbTop = blockFace('oak', 'block/jukebox_top');
  const jbSide = blockFace('darkOak', 'block/jukebox_side');
  isoBlock(g, cx, groundY - a, a, { top: jbTop, left: jbSide, right: jbSide });

  /* The record, hovering the way a played disc's art does in promo shots. */
  if (opts.disc) {
    /* The real sprite, at a whole-number scale — the record above the jukebox
       is the same art the pack ships, not a smooth stand-in. */
    const size = Math.round(a * 1.15);
    const rec = discFaceCanvas(opts.disc, Math.max(1, Math.round(size / 16)));
    g.save();
    g.shadowColor = 'rgba(0,0,0,.35)';
    g.shadowBlur = 10; g.shadowOffsetY = 5;
    g.drawImage(rec, Math.round(cx - rec.width / 2), Math.round(groundY - a * 2.5));
    g.restore();
  }

  /* Note particles */
  g.font = `${Math.round(a * 0.6)}px ui-monospace, monospace`;
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.textAlign = 'center';
  for (const [dx, dy, ch, alpha] of [[-1.5, -1.2, '♪', 0.9], [1.6, -1.6, '♫', 0.7], [0.6, -2.2, '♪', 0.5]]) {
    g.globalAlpha = alpha;
    g.fillText(ch, cx + dx * a, groundY - a * 1.4 + dy * a * 0.5);
  }
  g.globalAlpha = 1;

  return canvas;
}

/* ============================================================================
   Painting scene — the artwork hung on a real wall, at true block scale.

   The point of this preview is proportion: a 4×2 painting against 16-pixel
   blocks tells you instantly whether it will read across a room, in a way a
   zoomed canvas never can. So the wall tiles at exactly one block per 16
   pixels and the painting is drawn at the same scale, never fitted to the box.
   ========================================================================= */

/* Which generated stand-in each real block falls back to, for the handful the
   bundled pack might not have. Everything else falls back to plain stone. */
const FALLBACK = {
  'block/oak_planks': 'oak', 'block/dark_oak_planks': 'darkOak',
  'block/spruce_planks': 'spruce', 'block/stone': 'stone',
  'block/cobblestone': 'cobble', 'block/deepslate': 'deepslate',
  'block/dirt': 'dirt', 'block/grass_block_top': 'grass',
};

export const DEFAULT_WALL = 'block/oak_planks';

/* The inline shortlist: the walls people actually hang paintings on. Every
   other block is one click away in the browser, so this stays short enough to
   leave room for the preview it sits under. */
const SHORTLIST = [
  'block/oak_planks', 'block/spruce_planks', 'block/dark_oak_planks',
  'block/stone_bricks', 'block/deepslate_bricks', 'block/cobblestone',
  'block/quartz_block_side',
];

/** The blocks offered inline. */
export function wallBlocks() {
  const have = SHORTLIST.filter(n => hasTexture(n));
  const list = have.length ? have : [DEFAULT_WALL];
  return list.map(game => ({
    id: game,
    game,
    gen: FALLBACK[game] || 'stone',
    name: game.replace('block/', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  }));
}

/** Any block at all, for the full picker. */
export function allWallBlocks() {
  return listTextures('block/').map(game => ({
    id: game, game,
    gen: FALLBACK[game] || 'stone',
    name: game.replace('block/', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  }));
}

export function getWallBlock(id) {
  const game = id && id.startsWith('block/') ? id : DEFAULT_WALL;
  return {
    id: game, game,
    gen: FALLBACK[game] || 'stone',
    name: game.replace('block/', '').replace(/_/g, ' '),
  };
}

/**
 * @param {object} o
 *   art        canvas or {data,w,h} of the composed painting
 *   blocksW/H  painting size in blocks
 *   wall       wall block id
 *   margin     wall blocks of space around the painting
 */
export function drawPaintingScene(canvas, boxW, boxH, o) {
  const g = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(boxW * dpr);
  canvas.height = Math.round(boxH * dpr);
  canvas.style.width = boxW + 'px';
  canvas.style.height = boxH + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, boxW, boxH);

  const wall = getWallBlock(o.wall);
  const tile = blockFace(wall.gen, wall.game);

  const margin = o.margin ?? 1.4;
  const cols = o.blocksW + margin * 2;
  const rows = o.blocksH + margin * 2;
  // One block is `px` screen pixels; keep it an integer so the wall grid and
  // the artwork stay pixel-aligned with each other.
  const px = Math.max(8, Math.floor(Math.min(boxW / cols, boxH / rows)));

  /* Wall, tiled from the true block origin so seams land on block edges. */
  const originX = Math.round((boxW - o.blocksW * px) / 2);
  const originY = Math.round((boxH - o.blocksH * px) / 2);
  const startX = originX - Math.ceil(originX / px) * px;
  const startY = originY - Math.ceil(originY / px) * px;
  for (let y = startY; y < boxH; y += px) {
    for (let x = startX; x < boxW; x += px) {
      g.drawImage(tile, x, y, px, px);
    }
  }

  /* Block seams, the way the game's own lighting separates them. */
  g.strokeStyle = 'rgba(0,0,0,.16)';
  g.lineWidth = 1;
  for (let x = startX; x <= boxW; x += px) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, boxH); g.stroke(); }
  for (let y = startY; y <= boxH; y += px) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(boxW, y + .5); g.stroke(); }

  /* Ambient shading toward the edges */
  const vig = g.createRadialGradient(boxW / 2, boxH / 2, Math.min(boxW, boxH) * 0.25,
                                     boxW / 2, boxH / 2, Math.max(boxW, boxH) * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = vig;
  g.fillRect(0, 0, boxW, boxH);

  /* The painting, at exactly the same scale as the wall. */
  const artW = o.blocksW * px, artH = o.blocksH * px;
  g.save();
  g.shadowColor = 'rgba(0,0,0,.5)';
  g.shadowBlur = Math.round(px * 0.28);
  g.shadowOffsetY = Math.round(px * 0.10);
  g.drawImage(o.art, originX, originY, artW, artH);
  g.restore();

  return { px, originX, originY, artW, artH };
}
