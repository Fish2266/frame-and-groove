/* ============================================================================
   Thumbnails — the little scene on each library card.

   Rather than showing one painting cropped to a rectangle, the card renders a
   small gallery wall: the pack's own art, hung at the right relative sizes,
   with a record leaning against it. It reads as a pack rather than a file.
   ========================================================================= */

import { composePainting } from '../paint/compose.js';
import { discFaceCanvas } from '../disc/sprite.js';
import { canvasToBlob } from '../core/util.js';
import { blockFace } from './pixelart.js';
import { createViewer } from '../mob/render3d.js';
import { MOBS, mobModelFor } from '../mob/registry.js';
import { flattenDoc, docIsBlank } from '../mob/export.js';

const W = 480, H = 300;

/* ---- The mob on the card ------------------------------------------------ *
   One WebGL context, kept for the life of the tab and re-pointed at whichever
   model a card needs. Contexts are a scarce resource — a browser will start
   dropping the oldest after a dozen or so — so a card must never make its own.

   The camera looks the mob in the face rather than showing its flank: a card
   is a portrait, and a variant is recognised by its head.                    */
let mobGL = null;
let mobCanvas = null;

function renderMob(variant, px) {
  const mob = MOBS[variant?.mob];
  if (!mob) return null;
  const slot = variant.slots?.adult?.[mob.assetSet?.[0] || 'default'];
  if (!slot?.doc) return null;
  const model = mobModelFor(mob, 'adult', variant.model);

  try {
    if (!mobCanvas) mobCanvas = document.createElement('canvas');
    if (!mobGL) {
      mobGL = createViewer(mobCanvas, { model, keepBuffer: true });
      if (!mobGL) return null;
    } else {
      mobGL.setModel(model);
    }
    const doc = slot.doc;
    mobGL.setTexture(new ImageData(new Uint8ClampedArray(flattenDoc(doc)), doc.w, doc.h));
    mobGL.setHidden([]);
    mobGL.setView({ yaw: Math.PI - 0.38, pitch: -0.16, zoom: 0.92 });
    return mobGL.renderAt(px, px);
  } catch {
    /* No WebGL, a lost context, a model we could not build — the card simply
       goes without rather than failing the whole thumbnail. */
    mobGL = null;
    return null;
  }
}

export async function renderProjectThumb(project) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;

  /* Wall and floor, built from the same generated blocks as the app chrome. */
  /* Real block textures where a game jar is linked, generated ones otherwise. */
  const tile = (gen, game, x, y, w, hh, cell) => {
    const t = blockFace(gen, game);
    g.save();
    g.imageSmoothingEnabled = false;
    for (let ty = y; ty < y + hh; ty += cell) {
      for (let tx = x; tx < x + w; tx += cell) {
        g.drawImage(t, tx, ty, cell, cell);
      }
    }
    g.restore();
  };

  const FLOOR = Math.round(H * 0.72);
  tile('stone', 'block/stone', 0, 0, W, FLOOR, 48);
  tile('oak', 'block/oak_planks', 0, FLOOR, W, H - FLOOR, 48);

  /* Sink the wall into shadow so the artwork is what the eye lands on. */
  const wallShade = g.createLinearGradient(0, 0, 0, FLOOR);
  wallShade.addColorStop(0, 'rgba(8,11,13,.70)');
  wallShade.addColorStop(0.55, 'rgba(8,11,13,.48)');
  wallShade.addColorStop(1, 'rgba(8,11,13,.68)');
  g.fillStyle = wallShade;
  g.fillRect(0, 0, W, FLOOR);

  const floorShade = g.createLinearGradient(0, FLOOR, 0, H);
  floorShade.addColorStop(0, 'rgba(8,11,13,.42)');
  floorShade.addColorStop(1, 'rgba(8,11,13,.74)');
  g.fillStyle = floorShade;
  g.fillRect(0, FLOOR, W, H - FLOOR);

  /* Block seams on the wall */
  g.strokeStyle = 'rgba(255,255,255,.05)';
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += 48) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, FLOOR); g.stroke(); }
  for (let y = 0; y <= FLOOR; y += 48) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke(); }

  /* The line where wall meets floor */
  g.fillStyle = 'rgba(0,0,0,.55)';
  g.fillRect(0, FLOOR - 2, W, 3);

  const paintings = project.paintings.slice(0, 3);
  const discs = project.discs.slice(0, 2);
  /* A variant whose sheet is still blank renders as nothing at all, so it
     would silently eat the front slot. */
  const mobs = (project.mobs || [])
    .filter(m => {
      const mob = MOBS[m.mob];
      const slot = m.slots?.adult?.[mob?.assetSet?.[0] || 'default'];
      return slot?.doc && !docIsBlank(slot.doc);
    })
    .slice(0, 2);

  /* Hang the paintings, largest in the middle */
  if (paintings.length) {
    const order = paintings.length === 3 ? [1, 0, 2] : paintings.length === 2 ? [0, 1] : [0];
    const unit = 33;                    // px per Minecraft block
    const items = order.map(i => paintings[i]).filter(Boolean);
    const widths = items.map(p => p.w * unit);
    const gap = 20;
    const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
    // If the wall is crowded, shrink everything to fit rather than clipping.
    const fit = Math.min(1, (W - 40) / Math.max(1, total));
    let x = (W - total * fit) / 2;
    const baseline = FLOOR * 0.55;

    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      const { data, w, h } = composePainting(p);
      const src = document.createElement('canvas');
      src.width = w; src.height = h;
      src.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);

      const dw = p.w * unit * fit, dh = p.h * unit * fit;
      const y = baseline - dh / 2;

      g.save();
      g.shadowColor = 'rgba(0,0,0,.55)';
      g.shadowBlur = 16; g.shadowOffsetY = 6;
      g.fillStyle = '#000';
      g.fillRect(x, y, dw, dh);
      g.restore();

      g.imageSmoothingEnabled = false;
      g.drawImage(src, x, y, dw, dh);
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1;
      g.strokeRect(x + .5, y + .5, dw - 1, dh - 1);
      x += dw + gap * fit;
    }
  }

  /* Records propped against the wall, the second one tucked behind. */
  if (discs.length) {
    const size = 92;
    const baseX = paintings.length ? W - size - 34 : (W - size) / 2;
    const baseY = FLOOR - size * 0.42;

    const record = (disc, x, y, scale, alpha) => {
      const px = Math.round(size * scale);
      const tmp = discThumbCanvas(disc, px);
      g.save();
      g.globalAlpha = alpha;
      g.shadowColor = 'rgba(0,0,0,.62)';
      g.shadowBlur = 18; g.shadowOffsetY = 7;
      g.drawImage(tmp, Math.round(x), Math.round(y));
      g.restore();
    };

    if (discs[1]) record(discs[1], baseX - size * 0.46, baseY + size * 0.12, 0.82, 0.72);
    record(discs[0], baseX, baseY, 1, 1);
  }

  /* The mob stands on the floor, front-on, at the left — where the eye lands
     after the wall. It is drawn last so it sits in front of everything. */
  if (mobs.length) {
    const px = 168;
    const solo = !paintings.length && !discs.length;
    const baseY = FLOOR - px * 0.74;
    const spot = (x, y, w) => {
      const sh = g.createRadialGradient(x, y, 0, x, y, w);
      sh.addColorStop(0, 'rgba(0,0,0,.55)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh;
      g.save(); g.translate(x, y); g.scale(1, 0.3); g.beginPath();
      g.arc(0, 0, w, 0, Math.PI * 2); g.fill(); g.restore();
    };
    const place = (variant, x, scale, alpha) => {
      const size = Math.round(px * scale);
      const art = renderMob(variant, size);
      if (!art) return;
      const y = baseY + (px - size);
      spot(x + size / 2, y + size * 0.86, size * 0.30);
      g.save();
      g.globalAlpha = alpha;
      g.imageSmoothingEnabled = true;      // the model is already anti-aliased
      g.drawImage(art, Math.round(x), Math.round(y), size, size);
      g.restore();
    };
    const x0 = solo ? (W - px) / 2 : 18;
    if (mobs[1]) place(mobs[1], x0 + px * 0.62, 0.78, 0.7);
    place(mobs[0], x0, 1, 1);
  }

  /* Renamed sprites lie on the floor at the front right, the way an item on
     the ground reads: small, close, and in front of everything on the wall. */
  const sprites = (project.sprites || []).filter(sp => sp.doc && !docIsBlank(sp.doc)).slice(0, 3);
  if (sprites.length) {
    const px = 58;
    const solo = !paintings.length && !discs.length && !mobs.length;
    const spread = px * 0.72;
    const total = spread * (sprites.length - 1) + px;
    const x0 = solo ? (W - total) / 2 : W - total - 26;
    const y = FLOOR + (H - FLOOR) * 0.16;
    sprites.forEach((sp, i) => {
      const art = spriteThumbCanvas(sp, px);
      const x = x0 + i * spread;
      g.save();
      g.shadowColor = 'rgba(0,0,0,.6)';
      g.shadowBlur = 14; g.shadowOffsetY = 5;
      g.imageSmoothingEnabled = false;
      g.drawImage(art, Math.round(x), Math.round(y));
      g.restore();
    });
  }

  if (!paintings.length && !discs.length && !mobs.length && !sprites.length) {
    g.fillStyle = 'rgba(255,255,255,.10)';
    g.font = '600 15px -apple-system, sans-serif';
    g.textAlign = 'center';
    g.fillText('Empty pack', W / 2, H / 2);
  }

  /* Vignette */
  const vig = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.34)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);

  const blob = await canvasToBlob(c, 'image/webp', 0.82) || await canvasToBlob(c);
  return await blobToDataURL(blob);
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** A renamed sprite's artwork, scaled by a whole number where it can be. */
export function spriteThumbCanvas(sprite, px = 34) {
  const doc = sprite.doc;
  const src = document.createElement('canvas');
  src.width = doc.w; src.height = doc.h;
  src.getContext('2d').putImageData(new ImageData(flattenDoc(doc), doc.w, doc.h), 0, 0);
  const out = document.createElement('canvas');
  out.width = px; out.height = px;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  const fit = px / Math.max(doc.w, doc.h);
  const k = fit >= 1 ? Math.floor(fit) : fit;
  const d = Math.max(1, Math.round(doc.w * k));
  g.drawImage(src, Math.round((px - d) / 2), Math.round((px - d) / 2), d, d);
  return out;
}

/** Small square art for list rows. */
export function paintingThumbCanvas(painting, px = 34) {
  const { data, w, h } = composePainting(painting);
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const out = document.createElement('canvas');
  out.width = px; out.height = px;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  const s = Math.min(px / w, px / h);
  const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
  g.drawImage(src, Math.round((px - dw) / 2), Math.round((px - dh) / 2), dw, dh);
  return out;
}

/**
 * A disc thumbnail is the real sprite, scaled by a whole number and centred.
 * All three sprite modes share one renderer, so a list row, the hero record
 * and the exported PNG can never disagree about what a disc looks like.
 */
export function discThumbCanvas(disc, px = 34) {
  const out = document.createElement('canvas');
  out.width = px; out.height = px;
  const c = discFaceCanvas(disc, Math.max(1, Math.floor(px / 16)));
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(c, Math.round((px - c.width) / 2), Math.round((px - c.height) / 2));
  return out;
}

/** 16×16 shipping sprite, drawn at an integer scale — exactly what exports. */
export function discPixelCanvas(disc, scale = 4) {
  return discFaceCanvas(disc, scale);
}

