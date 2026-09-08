/* ============================================================================
   Mobs — build a variant of a mob, skin it, and say where it spawns.

   The two views are deliberately the same document seen twice: the 3D model
   and the flat sheet share one pixel doc and one undo history, so painting in
   either shows up in the other on the next frame. Clicking the model resolves
   to an exact texel through the renderer's picking pass, which is what makes
   painting in 3D land where you expect instead of one pixel off.
   ========================================================================= */

import { h, clear, raw, observeResize, add } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import {
  state, bindLive, markDirty, scheduleSave,
} from '../../core/store.js';
import {
  createMobVariant, suggestMobName, nextUniqueId, mobSlots, docRescale,
} from '../../core/project.js';
import { slugifyId } from '../../core/util.js';
import { getVersion, FEATURES, versionAtLeast } from '../../core/versions.js';
import {
  MOBS, MOB_LIST, CONDITION_TYPES, variantJSON, missingSoundFields,
  mobModelFor, mobTextureSize, baseTextureName, hasOwnMesh,
} from '../../mob/registry.js';
import { createViewer } from '../../mob/render3d.js';
import { modelUVRegions, regionAt, FACE_LIGHT } from '../../mob/uv.js';
import { mobAssetId, summonCommand, docIsBlank, flattenDoc, mobSoundEvent } from '../../mob/export.js';
import { textureURL, loadTexturePack } from '../../core/texturepack.js';
import { PixelEditor } from '../editor.js';
import {
  panel, section, field, textInput, textArea, selectInput, segmented, switchRow,
  iconButton, note, badge, emptyState, toast, toastOk, toastWarn, toastInfo, codeBlock,
  contextMenu, confirmDialog, idInput, stepper, modal,
} from '../kit.js';
import { sfx } from '../sfx.js';
import { putAsset, getAsset } from '../../core/store.js';
import { analyseAudio, loadEncoder, encodeOgg, decodeToBuffer, Player } from '../../audio/engine.js';
import { canRecord } from '../../audio/recorder.js';
import { formatBytes, formatTime } from '../../core/util.js';

const F = FEATURES;

/* How many texels of artwork per model pixel. The game does not care — entity
   textures are sampled by normalised coordinate, so any whole multiple of the
   model's own sheet works — but powers of two keep mipmapping happy and keep
   the numbers easy to reason about. */
const SCALES = [1, 2, 4, 8];

let world = null;   // biome / structure vocabulary, loaded once

async function loadWorld() {
  if (world) return world;
  const empty = { biomes: [], biomeTags: [], structures: [], structureTags: [] };
  try {
    const res = await fetch('assets/mobdata/world.json', { cache: 'force-cache' });
    world = await res.json();
    for (const k of Object.keys(empty)) if (!Array.isArray(world[k])) world[k] = [];
  } catch {
    world = empty;
  }
  return world;
}

/** Names the target version actually knows about, newest additions flagged. */
function vocabularyFor(list, versionId) {
  return list.map(row => ({
    id: row.id,
    since: row.since || null,
    available: !row.since || versionAtLeast(versionId, row.since),
  }));
}

/** Every spawn value in a variant that the target version does not have. */
export function unknownSpawnValues(variant, versionId, w) {
  if (!w) return [];
  const index = new Map();
  for (const key of ['biomes', 'biomeTags', 'structures', 'structureTags']) {
    for (const row of w[key] || []) {
      index.set(row.id.startsWith('#') ? row.id : `minecraft:${row.id}`, row.since || null);
    }
  }
  const out = [];
  for (const sp of variant.spawns || []) {
    for (const v of sp.values || []) {
      const since = index.has(v) ? index.get(v) : undefined;
      if (since === undefined) continue;                 // not ours to judge
      if (since && !versionAtLeast(versionId, since)) out.push({ value: v, since });
    }
  }
  return out;
}

export function buildMobsView() {
  const list = h('.wk-sidebar-list');
  const host = h('.grow', { style: 'display:flex;min-width:0' });
  let panelInstance = null;

  const view = h('.view', { dataset: { view: 'mobs' } },
    h('.workspace',
      h('.wk-sidebar',
        h('.wk-sidebar-head',
          h('.row.between.g-2',
            h('span.eyebrow', { text: 'Mob variants' }),
            iconButton('plus', { tip: 'New variant', pos: 'left', cls: 'btn-sm', onClick: e => newMenu(e.currentTarget) }),
          ),
        ),
        list,
        h('.wk-sidebar-foot',
          h('button.btn.btn-block.btn-sm', { onclick: e => newMenu(e.currentTarget) },
            raw(icon('plus', 13)), h('span', { text: 'New variant' }), raw(icon('chevDown', 11))),
        ),
      ),
      host,
    ),
  );

  const variants = () => state.project?.mobs || [];
  const current = () => variants().find(v => v.key === state.selMob) || null;

  function select(key) {
    state.selMob = key;
    renderList();
    renderDetail();
  }

  function newMenu(anchor) {
    const p = state.project;
    if (!p) return;
    const v = getVersion(p.mcVersion);
    contextMenu(MOB_LIST.map(mob => {
      const ok = mobUsable(p, mob, v);
      return {
        label: mob.label,
        hint: ok ? `${mob.texture.join('×')} · ${mob.registry}` : `Needs ${mob.since}`,
        disabled: !ok,
        run: () => addVariant(mob),
      };
    }), anchor);
  }

  async function addVariant(mob) {
    const p = state.project;
    const name = suggestMobName(p, mob.id);
    const variant = createMobVariant(mob.id, mob, name);
    variant.id = nextUniqueId(slugifyId(name), p.mobs.map(m => m.id));
    p.mobs.push(variant);
    markDirty('mob added');
    sfx('place');
    select(variant.key);
    /* Start from the real texture rather than a blank sheet: an empty
       document renders as an invisible model, which looks broken. */
    await seedFromBase(variant, mob);
    scheduleSave();
    select(variant.key);
  }

  function renderList() {
    clear(list);
    const p = state.project;
    if (!p) return;
    if (!p.mobs.length) {
      list.appendChild(h('.col.g-2.p-3.center', { style: 'text-align:center;color:var(--text-4)' },
        raw(icon('sparkle', 24)),
        h('.caption', { text: 'No variants yet.' })));
      return;
    }
    for (const variant of p.mobs) {
      const mob = MOBS[variant.mob];
      const row = h('.list-row', {
        'aria-selected': String(variant.key === state.selMob),
        dataset: { index: p.mobs.indexOf(variant) },
        onclick: () => select(variant.key),
        oncontextmenu: e => { e.preventDefault(); rowMenu(variant, { x: e.clientX, y: e.clientY }); },
      },
        h('.lr-thumb.checker.checker-sm', mobThumb(variant, mob, 34)),
        h('.lr-main',
          h('.lr-title.truncate', { text: variant.name || variant.id }),
          h('.lr-sub.truncate', { text: `${mob?.label || variant.mob} · ${spawnSummary(variant)}` }),
        ),
        h('.lr-actions',
          iconButton('more', { cls: 'btn-sm btn-ghost', onClick: e => { e.stopPropagation(); rowMenu(variant, e.currentTarget); } })),
      );
      list.appendChild(row);
    }
  }

  function rowMenu(variant, anchor) {
    const p = state.project;
    contextMenu([
      { label: 'Duplicate', icon: 'copy', run: () => {
        const copy = structuredClone(variant);
        copy.key = createMobVariant(variant.mob, MOBS[variant.mob]).key;
        copy.name = `${variant.name} copy`;
        copy.id = nextUniqueId(`${variant.id}_copy`, p.mobs.map(m => m.id));
        p.mobs.splice(p.mobs.indexOf(variant) + 1, 0, copy);
        markDirty('variant duplicated'); scheduleSave(); select(copy.key);
      } },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, run: async () => {
        const ok = await confirmDialog({
          title: `Delete “${variant.name}”?`,
          message: 'The variant and its textures go with it.',
          confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        p.mobs.splice(p.mobs.indexOf(variant), 1);
        if (state.selMob === variant.key) state.selMob = p.mobs[0]?.key || null;
        markDirty('variant deleted'); scheduleSave(); sfx('remove');
        renderList(); renderDetail();
      } },
    ], anchor);
  }

  function renderDetail() {
    panelInstance?.destroy?.();
    panelInstance = null;
    const p = state.project;
    if (!p) return;
    const v = getVersion(p.mcVersion);
    if (!p.mobs.length) {
      clear(host).appendChild(h('.grow.center',
        emptyState({
          scene: 'chest', iconName: 'sparkle',
          title: 'Make a mob your own',
          message: v.features.includes(F.MOB_VARIANTS)
            ? 'Pick a mob, paint it, and choose the biomes it turns up in. Nothing vanilla is replaced.'
            : `Mob variants need ${'1.21.5'} or newer. Change the target in Pack settings.`,
          action: v.features.includes(F.MOB_VARIANTS)
            ? h('button.btn.btn-primary', { onclick: e => newMenu(e.currentTarget) },
                raw(icon('plus', 13)), h('span', { text: 'New variant' }))
            : null,
        })));
      return;
    }
    const variant = current() || p.mobs[0];
    state.selMob = variant.key;
    panelInstance = new MobEditor(variant, { onNameChange: renderList, onThumb: renderList });
    panelInstance.mount(host);
  }

  view.refresh = () => { renderList(); renderDetail(); };
  /* The command palette has no element to anchor a menu to, so it opens the
     picker against the sidebar's own button. */
  view.openNewMenu = () => newMenu(view.querySelector('.wk-sidebar-foot .btn'));
  bindLive(view, 'project', () => view.refresh());
  bindLive(view, 'select:mob', () => { renderList(); renderDetail(); });
  return view;
}

/**
 * Fill every texture slot of a new variant with the matching bundled texture,
 * so it opens looking like the mob rather than like nothing.
 */
async function seedFromBase(variant, mob) {
  await loadTexturePack();
  const load = url => new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
  for (const kind of Object.keys(variant.slots)) {
    for (const slot of Object.keys(variant.slots[kind])) {
      /* Wolves keep a texture per state and every mob with a calf keeps one
         per age; the bundled set names all of them by suffix. */
      const base = mob.bases[0];
      const url = textureURL(baseTextureName(mob, base, kind, slot)) ||
                  textureURL(baseTextureName(mob, base, kind, null)) ||
                  textureURL(baseTextureName(mob, base, 'adult', slot));
      if (!url) continue;
      const img = await load(url);
      if (!img) continue;
      const doc = variant.slots[kind][slot].doc;
      const c = document.createElement('canvas');
      c.width = doc.w; c.height = doc.h;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, doc.w, doc.h);
      doc.layers[0].data.set(g.getImageData(0, 0, doc.w, doc.h).data);
      variant.slots[kind][slot].base = base;
    }
  }
}

/** Every mob the target version can actually carry. */
export function mobUsable(project, mob, v = getVersion(project.mcVersion)) {
  if (mob.since === '1.20.5') return true;          // wolves predate the table
  return v.features.includes(F.MOB_VARIANTS) && versionAtLeast(project.mcVersion, mob.since);
}

function spawnSummary(variant) {
  const s = variant.spawns || [];
  if (!s.length) return 'never spawns';
  const first = s[0];
  if (first.type === 'none') return s.length > 1 ? `default +${s.length - 1}` : 'default spawn';
  const n = first.values?.length || 0;
  const kind = first.type === 'minecraft:biome' ? 'biome' : first.type === 'minecraft:structure' ? 'structure' : 'moon';
  return n > 1 ? `${n} ${kind}s` : (first.values?.[0] || kind).replace(/^#?minecraft:/, '');
}

/* ---- A small canvas of the variant's main texture, for the sidebar ------- */
function mobThumb(variant, mob, px) {
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const slot = variant.slots?.adult?.[mob?.assetSet?.[0] || 'default'];
  if (!slot?.doc) return c;
  const doc = slot.doc;
  const src = document.createElement('canvas');
  src.width = doc.w; src.height = doc.h;
  src.getContext('2d').putImageData(new ImageData(flattenDoc(doc), doc.w, doc.h), 0, 0);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  // Show the head region rather than the whole sheet — it reads better small.
  const head = (mob?.model && Object.values(mob.model.parts)[0]?.cubes?.[0]) || null;
  if (head) {
    // The crop is in model pixels; the sheet may carry several texels per one.
    const k = mob.texture ? doc.w / mob.texture[0] : 1;
    const [u, v] = head.uv;
    const [w, hgt, d] = head.size;
    g.drawImage(src, (u + d) * k, (v + d) * k, w * k, hgt * k, 0, 0, px, px);
  } else {
    g.drawImage(src, 0, 0, px, px);
  }
  return c;
}

/**
 * Draw an image into a rectangle. `fill` covers and crops, `fit` letterboxes,
 * `stretch` ignores the aspect ratio entirely. Smoothing stays on: this is the
 * one place in the app where the source really is a photograph, and nearest
 * sampling a photo down to a face is what makes it look like mud.
 */
function drawFitted(g, img, rect, mode) {
  g.save();
  g.beginPath();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (mode === 'stretch') {
    g.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  } else {
    const s = mode === 'fill'
      ? Math.max(rect.w / img.width, rect.h / img.height)
      : Math.min(rect.w / img.width, rect.h / img.height);
    const dw = img.width * s, dh = img.height * s;
    g.drawImage(img, rect.x + (rect.w - dw) / 2, rect.y + (rect.h - dh) / 2, dw, dh);
  }
  g.restore();
}

/* ========================================================================= */
/* The editor                                                                */
/* ========================================================================= */

class MobEditor {
  constructor(variant, { onNameChange, onThumb } = {}) {
    this.v = variant;
    this.mob = MOBS[variant.mob];
    this.onNameChange = onNameChange;
    this.onThumb = onThumb;
    this.kind = 'adult';
    this.slot = this.mob?.assetSet?.[0] || 'default';
    this.showGuides = true;
    this.mode = 'split';           // split | model | sheet
    this._disposers = [];
    /* Part names the user has switched off, so they can reach a face that is
       normally buried. Purely a view state — the export always writes the
       whole sheet, and hidden parts are reinstated whenever the age changes,
       because a calf's parts are not the adult's. */
    this.hidden = new Set();
    this.regions = this.mob ? modelUVRegions(this.model) : [];
  }

  /* A calf is its own mesh on its own sheet, and a cold cow is a different
     shape again, so the mesh follows both the age and the variant's model. */
  get model() { return mobModelFor(this.mob, this.kind, this.v.model); }
  /** The model's own sheet size, in the units its UVs are measured in. */
  get sheet() { return mobTextureSize(this.mob, this.kind); }
  /** How many texels of artwork sit on one model pixel. */
  get scale() { return Math.max(1, this.v.texScale || 1); }
  /** The size of the document the user actually paints on. */
  get canvasSize() { const [w, h] = this.sheet; return [w * this.scale, h * this.scale]; }
  get doc() { return this.v.slots?.[this.kind]?.[this.slot]?.doc || null; }

  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    this.hidden.clear();
    this.renderStage();
    this.renderSide();
  }

  mount(container) {
    this.root = h('.mob-layout');
    this.stage = h('.mob-stage');
    this.side = h('.mob-side');
    this.root.append(this.stage, this.side);
    clear(container).appendChild(this.root);
    this.renderStage();
    return this;
  }

  destroy() {
    this.teardownStage();
    this.editor?.destroy();
    this.editor = null;
    this.clipPlayer?.stop?.();
    this.root?.remove();
  }

  /** Drop the previous stage's GL context and listeners before building another. */
  teardownStage() {
    this._disposers.forEach(d => d());
    this._disposers = [];
    this.viewer?.dispose();
    this.viewer = null;
  }

  /* --------------------------------------------------------------- stage */
  renderStage() {
    this.teardownStage();
    this.regions = this.mob ? modelUVRegions(this.model) : [];
    clear(this.stage);
    const head = h('.mob-stage-head',
      h('.row.g-2.center-y',
        h('strong', { text: this.v.name || this.v.id }),
        badge(this.mob?.label || this.v.mob),
      ),
      h('.spacer'),
      segmented({
        options: [
          { value: 'split', label: 'Both', tip: 'Model and sheet, side by side' },
          { value: 'model', label: '3D', tip: 'The model on its own' },
          { value: 'sheet', label: 'Texture', tip: 'The flat sheet on its own' },
        ],
        value: this.mode,
        onChange: m => { this.mode = m; this.renderStage(); this.renderSide(); },
      }),
    );

    this.canvas3d = h('canvas.mob-3d');
    this.showAllBtn = iconButton('eye', {
      tip: 'Show every part again', pos: 'left', cls: 'btn-sm btn-ghost',
      onClick: () => this.setHidden([]),
    });
    this.showAllBtn.hidden = !this.hidden.size;
    const modelPane = h('.mob-pane',
      this.canvas3d,
      h('.mob-3d-tools',
        this.showAllBtn,
        iconButton('refresh', { tip: 'Reset the camera', pos: 'left', cls: 'btn-sm btn-ghost', onClick: () => { this.viewer?.reset(); this.draw3d(); } }),
      ),
      h('.mob-hint', { text: 'Drag to turn · scroll to zoom · paint straight onto the model' }),
    );

    const sheetPane = h('.mob-pane.mob-sheet');
    this.sheetHost = sheetPane;

    const body = h('.mob-panes', { dataset: { mode: this.mode } });
    if (this.mode !== 'sheet') body.appendChild(modelPane);
    if (this.mode !== 'model') body.appendChild(sheetPane);
    this.stage.append(head, body);

    if (this.mode !== 'sheet') this.setupViewer();
    if (this.mode !== 'model') this.setupEditor();
    /* The editor ships its own inspector column. Rather than stand a second
       one beside it, its panels are moved into this view's single column and
       the variant's own sections sit above them. */
    this.renderSide();
  }

  setupEditor() {
    const doc = this.doc;
    if (!doc) return;
    this.editor?.destroy();
    this.editor = new PixelEditor({
      doc,
      compact: true,
      guides: () => (this.showGuides ? this.guideRects() : null),
      /* A picture dropped on the sheet gets the same face list the Place
         button offers, so it can be snapped after it lands. */
      placeOptions: () => ({ snaps: this.placeSnaps() }),
      onEdit: () => {
        this.syncTexture();
        markDirty('mob texture');
        scheduleSave();
        this.onThumb?.();
      },
    });
    this.editor.mount(this.sheetHost);
  }

  guideRects() {
    // Faces that belong to the hovered part glow; everything else is a hairline.
    // Regions are in model pixels; the document may hold several texels per one.
    const k = this.scale;
    return this.regions.map(r => ({
      x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k,
      color: r.part === this.hoverPart
        ? [126, 104, 255, 210]
        : [255, 255, 255, Math.round(40 + 60 * (FACE_LIGHT[r.face] || 0.6))],
    }));
  }

  setupViewer() {
    if (!this.mob) return;
    try {
      this.viewer = createViewer(this.canvas3d, { model: this.model });
    } catch (e) {
      this.canvas3d.replaceWith(h('.mob-pane-fallback',
        note('This browser could not start WebGL, so the 3D view is unavailable. The texture view works as normal.', 'warn')));
      return;
    }
    if (!this.viewer) return;
    this.viewer.setHidden(this.hidden);
    this.syncTexture();
    this._disposers.push(observeResize(this.canvas3d, () => this.draw3d()));
    this.installOrbit();
    requestAnimationFrame(() => this.draw3d());
  }

  draw3d() { this.viewer?.draw(); }

  syncTexture() {
    const doc = this.doc;
    if (!doc || !this.viewer) return;
    this.viewer.setTexture(new ImageData(new Uint8ClampedArray(flattenDoc(doc)), doc.w, doc.h));
    this.draw3d();
  }

  installOrbit() {
    const cv = this.canvas3d;
    let mode = null, last = null;

    const down = e => {
      cv.setPointerCapture?.(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      // Alt turns the model even while a paint tool is active.
      mode = (e.button === 0 && !e.altKey && this.paintIn3d()) ? 'paint' : 'orbit';
      if (mode === 'paint') this.paintAt(e, true);
      e.preventDefault();
    };
    const move = e => {
      if (!last) {
        this.hoverModel(e);
        return;
      }
      if (mode === 'paint') { this.paintAt(e, false); return; }
      const dx = (e.clientX - last.x) * 0.01, dy = (e.clientY - last.y) * 0.01;
      last = { x: e.clientX, y: e.clientY };
      this.viewer.orbit(dx, dy);
      this.draw3d();
    };
    const up = () => {
      if (mode === 'paint') this.endPaint();
      mode = null; last = null;
    };
    const wheel = e => {
      e.preventDefault();
      this.viewer.zoom(e.deltaY > 0 ? 1.1 : 0.9);
      this.draw3d();
    };
    const leave = () => {
      if (this.viewer?.hoverTexel(null)) this.draw3d();
      if (this.hoverPart) {
        this.hoverPart = null;
        this.viewer?.highlight(null);
        this.draw3d();
        this.editor?.redraw?.();
        if (this.partChip) this.partChip.textContent = '';
      }
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', leave);
    cv.addEventListener('wheel', wheel, { passive: false });
    this._disposers.push(() => {
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('pointerleave', leave);
      cv.removeEventListener('wheel', wheel);
    });
  }

  paintIn3d() {
    return ['pencil', 'eraser', 'fill', 'eyedropper'].includes(this.editor?.tool || 'pencil');
  }

  /**
   * Follow the cursor across the model. Two things move: the ring around the
   * exact texel a click would land on, and the highlight on the part it
   * belongs to. The ring is the one that matters — a boxy model at a shallow
   * angle makes it genuinely hard to tell which pixel you are over.
   */
  hoverModel(e) {
    if (!this.viewer) return;
    const hit = this.viewer.pickTexel(e.clientX, e.clientY);
    let dirty = this.viewer.hoverTexel(hit);
    const part = hit ? this.regionFor(hit)?.part : null;
    if (part !== this.hoverPart) {
      this.hoverPart = part;
      this.viewer.highlight(part);
      this.editor?.redraw?.();
      dirty = true;
    }
    if (this.partChip) {
      this.partChip.textContent = hit
        ? `${part ? part.replace(/_/g, ' ') : 'unmapped'} · ${hit.x}, ${hit.y}`
        : '';
    }
    if (dirty) this.draw3d();
  }

  /** Which face a document texel belongs to, at whatever resolution it is. */
  regionFor(hit) {
    if (!hit) return null;
    const k = this.scale;
    return regionAt(this.regions, Math.floor(hit.x / k), Math.floor(hit.y / k));
  }

  /** Turn parts on and off without touching the document. */
  setHidden(names) {
    this.hidden = new Set(names);
    this.viewer?.setHidden(this.hidden);
    if (this.showAllBtn) this.showAllBtn.hidden = !this.hidden.size;
    this.draw3d();
    this.partsHost?.rebuild?.();
  }

  /**
   * Paint one texel through the model. The editor owns the document and the
   * undo history, so the stroke is handed to it rather than written here —
   * that keeps a 3D stroke and a flat stroke a single undo step apart.
   */
  paintAt(e, begin) {
    if (!this.viewer || !this.editor) return;
    const hit = this.viewer.pickTexel(e.clientX, e.clientY);
    if (!hit) return;
    this.editor.paintExternal?.(hit.x, hit.y, { begin, alt: e.altKey, button: e.button });
    this.syncTexture();
  }

  endPaint() {
    this.editor?.endExternal?.();
    markDirty('mob texture');
    scheduleSave();
    this.onThumb?.();
  }

  /* ---------------------------------------------------------------- side */
  renderSide() {
    if (!this.side) return;
    clear(this.side);
    const v = this.v, mob = this.mob;
    if (!mob) { this.side.appendChild(note('This mob is not in the registry.', 'error')); return; }
    const project = state.project;
    const version = getVersion(project.mcVersion);

    add(this.side,
      this.identitySection(),
      this.textureSection(),
      this.mode !== 'sheet' ? this.partsSection() : null,
      this.spawnSection(),
      mob.sounds ? this.soundSection(version) : null,
      this.aboutSection(),
      this.outputSection(),
    );
    if (this.editor?.panels) this.side.appendChild(this.editor.panels);
  }

  identitySection() {
    const v = this.v, project = state.project;
    return section('Variant', [
      field('Name', textInput({
        value: v.name,
        onInput: val => {
          v.name = val;
          this.onNameChange?.();
          markDirty('variant renamed'); scheduleSave();
        },
      })),
      field('Id', idInput({
        prefix: `${project.namespace}:`,
        value: v.id,
        onChange: val => {
          v.id = nextUniqueId(slugifyId(val) || 'variant',
            project.mobs.filter(m => m !== v).map(m => m.id));
          this.onNameChange?.();
          this.renderSide();
          markDirty('variant id'); scheduleSave();
        },
      }), 'The registry entry name, and the texture file name.'),
      this.mob.models ? field('Model', segmented({
        options: this.mob.models.map(m => ({
          value: m, label: m,
          tip: hasOwnMesh(this.mob, m) ? `A different shape, not just a different skin` : 'The base shape',
        })),
        value: v.model || 'normal',
        block: true,
        onChange: m => {
          v.model = m;
          markDirty('variant model'); scheduleSave();
          this.renderStage(); this.renderSide();
        },
      }), this.mob.id === 'cow'
        ? 'A cold cow wears a fur layer and swept-back horns; a warm one has ears and no horns. The preview draws whichever you pick.'
        : 'The cold model is different geometry, not just a different skin — the preview follows it.') : null,
      field('Notes', textArea({
        value: v.notes || '', rows: 2, placeholder: 'Anything you want to remember…',
        onInput: val => { v.notes = val; scheduleSave(); },
      })),
    ], { key: 'mob-identity' });
  }

  textureSection() {
    const v = this.v, mob = this.mob;
    const kinds = Object.keys(v.slots || {});
    const slots = Object.keys(v.slots?.[this.kind] || {});
    this.partChip = h('span.caption.muted', { text: '' });

    return section('Texture', [
      kinds.length > 1 ? field('Age', segmented({
        options: kinds.map(k => ({
          value: k, label: k,
          tip: k === 'baby'
            ? `The calf's own model and its own ${(mob.babyTexture || mob.texture).join(' × ')} sheet`
            : `The grown ${mob.label.toLowerCase()}, ${mob.texture.join(' × ')}`,
        })),
        value: this.kind, block: true,
        onChange: k => this.setKind(k),
      }), mob.babyTexture && mob.babyTexture.join() !== mob.texture.join()
        ? 'The baby is a different model on a different sheet, not a shrunken adult.'
        : null) : null,
      slots.length > 1 ? field('State', segmented({
        options: slots.map(s => ({ value: s, label: s })),
        value: this.slot, block: true,
        onChange: s => { this.slot = s; this.renderStage(); this.renderSide(); },
      }), 'Wolves show a different texture wild, tamed and angry.') : null,
      field('Resolution', segmented({
        options: SCALES.map(n => ({
          value: n, label: n === 1 ? '1×' : `${n}×`,
          tip: `${this.sheet[0] * n} × ${this.sheet[1] * n} for this sheet`,
        })),
        value: this.scale, block: true,
        onChange: n => this.setScale(n),
      }), this.scale === 1
        ? 'The size the game draws at. Raise it to paint finer detail than a model pixel.'
        : `${this.scale}× the model's own grid — ${this.canvasSize.join(' × ')} pixels, and every face has ${this.scale}× the room.`),
      h('.row.g-2',
        h('button.btn.btn-sm.grow', { onclick: () => this.openBasePicker() },
          raw(icon('image', 13)), h('span', { text: 'Start from…' })),
        h('button.btn.btn-sm.grow', {
          'data-tip': this.mode === 'model'
            ? 'Pick a face and drop a picture on it'
            : 'Drag and resize a picture onto the sheet — or drop a file straight on it',
          onclick: () => this.importImage(),
        }, raw(icon('upload', 13)), h('span', { text: 'Place image' })),
      ),
      switchRow({
        title: 'Show face guides',
        desc: 'Outline which patch of the sheet belongs to which face.',
        checked: this.showGuides,
        onChange: on => { this.showGuides = on; this.editor?.redraw?.(); },
      }),
      h('.row.between.center-y', h('span.caption.muted', { text: 'Under the cursor' }), this.partChip),
      note(`This sheet is ${this.sheet.join(' × ')} pixels — the size the ${this.kind === 'baby' ? 'baby ' : ''}${mob.label.toLowerCase()} model expects.`, 'info'),
    ], { key: 'mob-texture' });
  }

  /* ---------------------------------------------------------------- parts */
  /**
   * Show and hide parts of the model. This changes nothing about the texture —
   * it is a way to get at a face that is normally buried, like the inside of a
   * leg or the underside of a body. Hidden parts also drop out of the picker,
   * so a click goes to whatever is behind them.
   */
  partsSection() {
    const host = h('.mob-parts');
    const names = this.viewer?.partNames?.() ||
      Object.keys(this.model?.parts || {}).filter(n => (this.model.parts[n].cubes || []).length);
    const rebuild = () => {
      clear(host);
      for (const name of names) {
        const off = this.hidden.has(name);
        host.appendChild(h('.mob-part-row', { 'data-off': String(off) },
          h('button.mob-part-eye', {
            'data-tip': off ? `Show ${name.replace(/_/g, ' ')}` : `Hide ${name.replace(/_/g, ' ')}`,
            'data-tip-pos': 'left',
            onclick: () => {
              const next = new Set(this.hidden);
              next.has(name) ? next.delete(name) : next.add(name);
              this.setHidden(next);
            },
          }, raw(icon(off ? 'eyeOff' : 'eye', 13))),
          h('button.mob-part-name.truncate', {
            text: name.replace(/_/g, ' '),
            'data-tip': 'Show only this part', 'data-tip-pos': 'left',
            onmouseenter: () => { this.hoverPart = name; this.viewer?.highlight(name); this.draw3d(); this.editor?.redraw?.(); },
            onmouseleave: () => { this.hoverPart = null; this.viewer?.highlight(null); this.draw3d(); this.editor?.redraw?.(); },
            onclick: () => {
              const solo = names.filter(n => n !== name);
              this.setHidden(this.hidden.size === solo.length && solo.every(n => this.hidden.has(n)) ? [] : solo);
            },
          }),
        ));
      }
    };
    host.rebuild = rebuild;
    this.partsHost = host;
    rebuild();
    return section('Parts', [
      host,
      h('.row.g-2',
        h('button.btn.btn-sm.grow', { onclick: () => this.setHidden([]) },
          raw(icon('eye', 12)), h('span', { text: 'Show all' })),
        h('button.btn.btn-sm.grow', { onclick: () => this.setHidden(names) },
          raw(icon('eyeOff', 12)), h('span', { text: 'Hide all' })),
      ),
      note('Only the preview changes. The exported texture always covers the whole model.', 'info'),
    ], { key: 'mob-parts', open: false, count: this.hidden.size || undefined });
  }

  /* ----------------------------------------------------------- resolution */
  /**
   * Change how many texels the artwork carries per model pixel.
   *
   * The game reads an entity texture by normalised coordinates, so a 4× sheet
   * needs nothing declared anywhere — it simply has four times the pixels under
   * the same faces. Every slot moves together: adult and baby are separate
   * files at separate base sizes, but a variant painted at 4× should be 4×
   * throughout or the two ages stop matching.
   */
  async setScale(n) {
    const from = this.scale;
    if (n === from) return;
    if (n < from) {
      const ok = await confirmDialog({
        title: `Drop to ${n}×?`,
        message: `Detail finer than ${n === 1 ? 'a model pixel' : `1/${n} of a model pixel`} cannot survive the trip down. ` +
                 'Going back up afterwards will not bring it back.',
        confirmLabel: 'Reduce', danger: true,
      });
      if (!ok) return;
    }
    this.v.texScale = n;
    for (const { doc } of mobSlots(this.v, this.mob)) {
      docRescale(doc, Math.round(doc.w * n / from), Math.round(doc.h * n / from), { average: true });
    }
    markDirty('texture resolution'); scheduleSave();
    this.renderStage(); this.renderSide(); this.onThumb?.();
    toastOk(`Now painting at ${n}×`, `${this.canvasSize.join(' × ')} pixels on the ${this.kind} sheet.`);
  }

  async openBasePicker() {
    await loadTexturePack();
    const mob = this.mob;
    const grid = h('.mob-base-grid');
    const m = modal({
      title: `Start from a ${this.kind === 'baby' ? 'baby ' : ''}${mob.label.toLowerCase()} texture`,
      body: h('.col.g-3',
        h('.caption.muted', { text: 'The bundled textures for this exact age and state. Each one is a starting point — load it, then make it yours.' }),
        grid,
      ),
      width: 560,
    });
    for (const base of mob.bases) {
      const name = baseTextureName(mob, base, this.kind, this.slot);
      const url = textureURL(name);
      if (!url) continue;
      const cell = h('button.mob-base', { onclick: () => { this.applyBase(url, base); m.close(); } },
        h('img', { src: url, alt: base, style: 'image-rendering:pixelated' }),
        h('span.caption.truncate', { text: base.replace(/_/g, ' ') }),
      );
      grid.appendChild(cell);
    }
    if (!grid.children.length) {
      grid.appendChild(h('.caption.muted', { text: 'No bundled texture matches this slot.' }));
    }
  }

  applyBase(url, label) {
    const doc = this.doc;
    if (!doc) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = doc.w; c.height = doc.h;
      const g = c.getContext('2d');
      // Nearest, so a 16-pixel base blown up to a 4x sheet stays crisp blocks.
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, doc.w, doc.h);
      const data = g.getImageData(0, 0, doc.w, doc.h).data;
      this.writeLayer(data, `start from ${label}`);
      this.v.slots[this.kind][this.slot].base = label;
      this.syncTexture();
      markDirty('base texture'); scheduleSave(); this.onThumb?.();
      toastOk('Texture loaded', `Started from ${label.replace(/_/g, ' ')}.`);
    };
    img.onerror = () => toastWarn('Could not load', 'That texture failed to decode.');
    img.src = url;
  }

  /* --------------------------------------------------------- image import */
  /**
   * Bring a picture in — either across the whole sheet, or onto one face.
   *
   * The second is the interesting one, and the reason resolution is worth
   * changing: a cow's face is 8 × 8 model pixels, which is nothing, but at 8×
   * it is a 64 × 64 patch with room for a real photograph. The image is drawn
   * into that face's rectangle on the current layer, so everything around it
   * survives and the whole thing is one undo away.
   */
  async importImage() {
    const { pickFile } = await import('../../core/util.js');
    const file = await pickFile({ accept: 'image/*' });
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); this.placeImage(img, file.name); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toastWarn('Could not read', 'That file is not an image this browser can decode.');
    };
    img.src = url;
  }

  /**
   * Float the picture over the flat sheet so it can be dragged and resized
   * onto whatever it belongs on. A face is a small rectangle in a big sheet
   * and no dialog knows where a photograph of somebody's dog should sit on a
   * cow, so the answer is to let them put it there.
   *
   * With only the 3D view open there is no sheet to drag over, so that case
   * falls back to the older dialog, which picks a face from a list instead.
   */
  placeImage(img, name) {
    if (!this.editor || this.mode === 'model') { this.openImportDialog(img, name); return; }
    if (this.mode === 'sheet') this.editor.fit();
    const snaps = this.placeSnaps();
    const hovered = this.hoverPart
      ? snaps.find(sn => sn.part === this.hoverPart)
      : null;
    this.editor.beginPlace(img, {
      label: `Place ${name || 'image'}`,
      rect: hovered?.rect,
      snaps,
      onDone: applied => {
        if (!applied) return;
        this.syncTexture();
        toastOk('Image placed', hovered
          ? `Onto ${hovered.label.replace(/\s+·.*$/, '')} — undo puts it back.`
          : 'Undo puts the sheet back the way it was.');
      },
    });
    toastInfo('Drag it into place',
      'Corners resize, Shift frees the shape, arrows nudge. Enter places it, Escape drops it.');
  }

  /**
   * Every face of the model as a rectangle the placement box can snap to, in
   * document pixels. Biggest face first inside each part, because the big ones
   * are the ones anybody wants to put a picture on.
   */
  placeSnaps() {
    const k = this.scale;
    const out = [{ label: 'The whole sheet', part: null,
                   rect: { x: 0, y: 0, w: this.doc.w, h: this.doc.h } }];
    const byPart = new Map();
    for (const r of this.regions) {
      if (!byPart.has(r.part)) byPart.set(r.part, []);
      byPart.get(r.part).push(r);
    }
    for (const [part, faces] of byPart) {
      for (const f of [...faces].sort((a, b) => b.w * b.h - a.w * a.h)) {
        const box = f.cube.name ? ` ${f.cube.name.replace(/_/g, ' ')}` : '';
        out.push({
          part,
          label: `${part.replace(/_/g, ' ')}${box} · ${f.face}`,
          rect: { x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k },
        });
      }
    }
    return out.slice(0, 48);
  }

  openImportDialog(img, name) {
    const doc = this.doc;
    if (!doc) return;
    const k = this.scale;

    /* Faces, grouped by part, biggest first inside each group — the big ones
       are the ones anybody wants to put a picture on. */
    const byPart = new Map();
    for (const r of this.regions) {
      if (!byPart.has(r.part)) byPart.set(r.part, []);
      byPart.get(r.part).push(r);
    }
    const options = [{ value: 'sheet', label: 'The whole sheet' }];
    for (const [part, faces] of byPart) {
      for (const f of [...faces].sort((a, b) => b.w * b.h - a.w * a.h)) {
        /* A part can own several boxes — a cow's head carries its muzzle and
           both horns — so the box's own name goes in the label where it has
           one, or two entries read identically. */
        const box = f.cube.name ? ` ${f.cube.name.replace(/_/g, ' ')}` : '';
        options.push({
          value: `${part}|${f.face}|${f.x},${f.y},${f.w},${f.h}`,
          label: `${part.replace(/_/g, ' ')}${box} · ${f.face}  (${f.w * k} × ${f.h * k})`,
        });
      }
    }
    /* Whatever the cursor was last over is almost certainly what they mean. */
    const guess = this.hoverPart
      ? options.find(o => o.value.startsWith(`${this.hoverPart}|north|`)) ||
        options.find(o => o.value.startsWith(`${this.hoverPart}|`))
      : null;

    let target = guess?.value || 'sheet';
    let mode = 'fill';
    const preview = h('canvas.mob-import-preview');
    const caption = h('.caption.muted');

    const paint = () => {
      const [dw, dh] = [doc.w, doc.h];
      preview.width = dw; preview.height = dh;
      const g = preview.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, dw, dh);
      g.putImageData(new ImageData(new Uint8ClampedArray(this.activeLayerData()), dw, dh), 0, 0);
      const rect = rectFor(target);
      drawFitted(g, img, rect, mode);
      g.strokeStyle = 'rgba(126,104,255,.9)';
      g.lineWidth = Math.max(1, Math.round(dw / 96));
      g.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      caption.textContent =
        `${img.width} × ${img.height} into ${rect.w} × ${rect.h} pixels` +
        (target === 'sheet' ? '' : ` — ${rect.w / k} × ${rect.h / k} model pixels at ${k}×`);
    };
    const rectFor = value => {
      if (value === 'sheet') return { x: 0, y: 0, w: doc.w, h: doc.h };
      const [, , box] = value.split('|');
      const [x, y, w, hh] = box.split(',').map(Number);
      return { x: x * k, y: y * k, w: w * k, h: hh * k };
    };

    const m = modal({
      title: 'Import image',
      subtitle: name,
      width: 'wide',
      body: h('.mob-import',
        h('.mob-import-stage.checker', preview),
        h('.col.g-3',
          field('Put it', selectInput({
            options, value: target,
            onChange: v => { target = v; paint(); },
          }), 'Pick a face to drop the picture onto just that patch of the sheet.'),
          field('Scaling', segmented({
            options: [
              { value: 'fill', label: 'Fill', tip: 'Cover the area, cropping the overflow' },
              { value: 'fit', label: 'Fit', tip: 'Fit it all in, leaving the rest untouched' },
              { value: 'stretch', label: 'Stretch', tip: 'Squash it to the exact shape' },
            ],
            value: mode, block: true,
            onChange: v => { mode = v; paint(); },
          })),
          caption,
          this.scale === 1 && target !== 'sheet'
            ? note('At 1× a face is only a handful of pixels. Raise the resolution first if you want the picture to survive.', 'warn')
            : null,
        ),
      ),
      actions: [
        { label: 'Cancel' },
        { label: 'Import', primary: true, run: () => apply() },
      ],
    });

    const apply = () => {
      const c = document.createElement('canvas');
      c.width = doc.w; c.height = doc.h;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.putImageData(new ImageData(new Uint8ClampedArray(this.activeLayerData()), doc.w, doc.h), 0, 0);
      const rect = rectFor(target);
      drawFitted(g, img, rect, mode);
      this.writeLayer(g.getImageData(0, 0, doc.w, doc.h).data, 'import image');
      this.syncTexture();
      markDirty('texture import'); scheduleSave(); this.onThumb?.();
      toastOk('Image imported',
        target === 'sheet' ? `${img.width} × ${img.height} across the sheet.`
                           : `${img.width} × ${img.height} onto ${target.split('|').slice(0, 2).join(' · ').replace(/_/g, ' ')}.`);
    };
    paint();
  }

  /** The layer an import will land on, as raw bytes. */
  activeLayer() {
    const doc = this.doc;
    return doc.layers[Math.min(Math.max(0, doc.active | 0), doc.layers.length - 1)] || null;
  }

  activeLayerData() {
    const layer = this.activeLayer();
    return layer?.data || new Uint8ClampedArray(this.doc.w * this.doc.h * 4);
  }

  /**
   * Replace the active layer's pixels. Normally the editor takes it, so it is
   * one undo step; in 3D-only mode there is no editor mounted and the write
   * goes straight to the document instead of quietly doing nothing.
   */
  writeLayer(data, label) {
    if (this.editor?.replaceLayerData?.(data, label)) return;
    const layer = this.activeLayer();
    if (layer && layer.data.length === data.length) layer.data.set(data);
  }

  /* -------------------------------------------------------------- spawns */
  spawnSection() {
    const v = this.v;
    const rows = h('.col.g-2');
    const rebuild = () => {
      clear(rows);
      (v.spawns || []).forEach((sp, i) => rows.appendChild(this.spawnRow(sp, i, rebuild)));
      if (!v.spawns?.length) {
        rows.appendChild(note('With no rules at all this variant never spawns naturally. You can still summon it.', 'warn'));
      }
    };
    rebuild();
    /* A biome picked while targeting a newer release stays in the file and
       silently never matches, so it is called out here as well. */
    const staleNote = h('div');
    loadWorld().then(w => {
      const bad = unknownSpawnValues(v, state.project.mcVersion, w);
      clear(staleNote);
      if (bad.length) {
        staleNote.appendChild(note(
          `${bad.map(b => b.value.replace(/^#?minecraft:/, '')).join(', ')} ` +
          `${bad.length > 1 ? 'were' : 'was'} added in ${bad[0].since}, newer than this pack's target ` +
          `(${state.project.mcVersion}). ${bad.length > 1 ? 'Those rules' : 'That rule'} will never match.`,
          'warn'));
      }
    });
    return section('Where it spawns', [
      rows,
      staleNote,
      h('button.btn.btn-sm.btn-block', {
        onclick: () => {
          v.spawns = v.spawns || [];
          v.spawns.push({ type: 'minecraft:biome', priority: 1, values: [] });
          markDirty('spawn rule'); scheduleSave(); rebuild();
        },
      }, raw(icon('plus', 12)), h('span', { text: 'Add rule' })),
      note('The matching rule with the highest priority wins. Vanilla uses priority 0 with no condition as the fallback, and 1 for biome-specific ones.', 'info'),
    ], { key: 'mob-spawns', count: (v.spawns || []).length });
  }

  spawnRow(sp, index, rebuild) {
    const rebuildRow = () => rebuild();
    const v = this.v;
    const valuesHost = h('.col.g-1');
    const renderValues = () => {
      clear(valuesHost);
      if (sp.type === 'none') return;
      if (sp.type === 'minecraft:moon_brightness') {
        valuesHost.append(
          field('Min', stepper({
            value: sp.min ?? 0, min: 0, max: 1, step: 0.1,
            onChange: n => { sp.min = n; markDirty('spawn'); scheduleSave(); },
          })),
          field('Max', stepper({
            value: sp.max ?? 1, min: 0, max: 1, step: 0.1,
            onChange: n => { sp.max = n; markDirty('spawn'); scheduleSave(); },
          })),
        );
        return;
      }
      const chips = h('.chip-wrap');
      for (const val of sp.values || []) {
        chips.appendChild(h('span.chip', { text: val.replace(/^#?minecraft:/, m => m[0] === '#' ? '#' : '') },
          h('button.chip-x', {
            onclick: () => {
              sp.values = sp.values.filter(x => x !== val);
              markDirty('spawn'); scheduleSave(); renderValues();
            },
          }, raw(icon('close', 10)))));
      }
      valuesHost.append(chips, h('button.btn.btn-sm.btn-block', {
        onclick: () => this.openValuePicker(sp, renderValues),
      }, raw(icon('plus', 12)), h('span', { text: sp.type === 'minecraft:biome' ? 'Add biome' : 'Add structure' })));
      if (!sp.values?.length) {
        valuesHost.appendChild(h('.caption.muted', { text: 'No values yet — this rule will not match anything.' }));
      }
    };

    const row = h('.spawn-rule',
      h('.row.between.center-y.g-2',
        selectInput({
          options: CONDITION_TYPES.map(c => ({ value: c.id, label: c.label })),
          value: sp.type || 'none',
          onChange: t => {
            const wasFallback = sp.type === 'none';
            sp.type = t;
            sp.values = [];
            if (t === 'minecraft:moon_brightness') { sp.min = 0.9; sp.max = 1; }
            /* Vanilla gives conditional rules priority 1 and keeps 0 for the
               unconditional fallback, so a specific rule outranks it. */
            if (wasFallback && t !== 'none' && (sp.priority ?? 0) === 0) sp.priority = 1;
            if (t === 'none') sp.priority = 0;
            markDirty('spawn'); scheduleSave(); rebuildRow();
          },
        }),
        h('.row.g-1.center-y',
          h('span.caption.muted', { text: 'priority' }),
          stepper({
            value: sp.priority ?? 0, min: -32, max: 32, width: 64,
            onChange: n => { sp.priority = n; markDirty('spawn'); scheduleSave(); },
          }),
          iconButton('trash', {
            tip: 'Remove rule', cls: 'btn-sm btn-ghost btn-danger',
            onClick: () => {
              v.spawns.splice(index, 1);
              markDirty('spawn removed'); scheduleSave(); rebuild();
            },
          }),
        ),
      ),
      valuesHost,
    );
    renderValues();
    return row;
  }

  async openValuePicker(sp, after) {
    const w = await loadWorld();
    const version = state.project.mcVersion;
    const isBiome = sp.type === 'minecraft:biome';
    const plain = vocabularyFor(isBiome ? w.biomes : w.structures, version);
    const tags = vocabularyFor(isBiome ? w.biomeTags : w.structureTags, version);
    const listEl = h('.mob-pick-list');
    const search = h('input.input.input-sm', {
      type: 'search',
      placeholder: isBiome ? 'Search biomes and tags…' : 'Search structures and tags…',
      oninput: () => render(search.value.trim().toLowerCase()),
    });
    const m = modal({
      title: isBiome ? 'Biomes' : 'Structures',
      body: h('.col.g-2', search,
        h('.caption.muted', { text: 'A #tag covers a whole group at once — how vanilla does it.' }),
        listEl),
      width: 520,
    });
    const add = val => {
      sp.values = sp.values || [];
      if (!sp.values.includes(val)) sp.values.push(val);
      markDirty('spawn'); scheduleSave(); after(); m.close();
    };
    const render = q => {
      clear(listEl);
      const match = r => !q || r.id.toLowerCase().includes(q);
      const tagRows = tags.filter(match).slice(0, 40);
      const plainRows = plain.filter(match).slice(0, 140);
      /* Anything newer than the pack's target is still listed, but marked and
         inert — hiding it silently would just look like a missing biome. */
      const row = (r, value, extra) => h('button.mob-pick', {
        onclick: () => (r.available ? add(value) : null),
        disabled: !r.available,
        'data-tip': r.available ? '' : `Added in ${r.since}; this pack targets ${state.project.mcVersion}.`,
      }, h('span.mono', { text: r.id.replace(/^#minecraft:/, '#') }),
         r.available ? (extra || null) : badge(r.since, 'warn'));

      if (tagRows.length) listEl.appendChild(h('.eyebrow.p-1', { text: 'Tags' }));
      for (const t of tagRows) listEl.appendChild(row(t, t.id, badge('group')));
      if (plainRows.length) listEl.appendChild(h('.eyebrow.p-1', { text: isBiome ? 'Biomes' : 'Structures' }));
      for (const b of plainRows) listEl.appendChild(row(b, `minecraft:${b.id}`));
      if (!tagRows.length && !plainRows.length) {
        listEl.appendChild(h('.caption.muted.p-3', { text: 'Nothing matches.' }));
      }
    };
    render('');
  }

  /* -------------------------------------------------------------- sounds */
  /**
   * A sound variant is just a set of sound-event ids, so this panel offers two
   * ways to fill each one: type the id of a sound that already exists (a
   * vanilla one, or another pack's), or hand it a clip. A clip is stored the
   * same way a disc's audio is — decoded, re-encoded as Ogg Vorbis, and
   * written into the resource pack with a matching sounds.json entry — so the
   * event id it fills in is one this pack actually defines.
   */
  soundSection(version) {
    const v = this.v, mob = this.mob;
    const supported = version.features.includes(F.MOB_SOUND_VARIANTS) &&
      versionAtLeast(state.project.mcVersion, mob.soundSince);
    const body = h('.col.g-2');

    const rebuild = () => {
      clear(body);
      if (!supported) {
        body.appendChild(note(`Per-variant sounds need ${mob.soundSince} or newer. Everything else about this variant still works.`, 'warn'));
        return;
      }
      body.appendChild(switchRow({
        title: 'Give it its own sounds',
        desc: `Writes ${mob.soundRegistry}/${v.id}.json.`,
        checked: !!v.soundsEnabled,
        onChange: on => { v.soundsEnabled = on; markDirty('sounds'); scheduleSave(); rebuild(); },
      }));
      if (!v.soundsEnabled) return;

      const groups = mob.sounds.split ? ['adult', 'baby'] : ['adult'];
      for (const g of groups) {
        body.appendChild(h('.eyebrow', { text: mob.sounds.split ? g : 'sounds' }));
        for (const f of mob.sounds.fields) body.appendChild(this.soundRow(g, f, rebuild));
        body.appendChild(h('.row.g-2',
          h('button.btn.btn-sm.grow', {
            onclick: () => {
              v.sounds = v.sounds || {};
              v.sounds[g] = v.sounds[g] || {};
              for (const f of mob.sounds.fields) {
                if (this.clipFor(g, f)) continue;      // never overwrite a clip
                const base = f.replace(/_sound$/, '');
                v.sounds[g][f] = `minecraft:entity.${g === 'baby' ? 'baby_' : ''}${mob.id}.${base}`;
              }
              markDirty('sounds'); scheduleSave(); rebuild();
            },
          }, h('span', { text: `Fill with vanilla ${g} sounds` })),
        ));
      }
      const gaps = missingSoundFields(v, mob);
      if (gaps.length) {
        body.appendChild(note(`Every field is required. Still empty: ${gaps.join(', ')}.`, 'warn'));
      }
      const clips = this.allClips();
      if (clips.length) {
        const bytes = clips.reduce((n, c) => n + (c.encoded?.size || 0), 0);
        body.appendChild(note(
          `${clips.length} clip${clips.length > 1 ? 's' : ''} ship with this pack — ${formatBytes(bytes)} of Ogg Vorbis, plus the sounds.json entries that name them.`,
          'ok'));
      }
    };
    rebuild();
    return section('Sounds', [body], { key: 'mob-sounds' });
  }

  /** Where a clip lives on the variant. */
  clipFor(group, field) { return this.v.soundClips?.[group]?.[field] || null; }

  allClips() {
    const out = [];
    for (const g of Object.keys(this.v.soundClips || {})) {
      for (const f of Object.keys(this.v.soundClips[g] || {})) {
        const c = this.v.soundClips[g][f];
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** The event id this pack defines for one clip. */
  eventIdFor(group, field) {
    return `${state.project.namespace}:${mobSoundEvent(this.v.id, group, field)}`;
  }

  soundRow(group, field, rebuild) {
    const v = this.v;
    const label = field.replace(/_sound$/, '').replace(/_/g, ' ');
    const clip = this.clipFor(group, field);

    if (clip) {
      /* Keep the written id in step with the variant id, which the user can
         rename at any time. */
      v.sounds = v.sounds || {};
      v.sounds[group] = v.sounds[group] || {};
      v.sounds[group][field] = this.eventIdFor(group, field);
      return h('.snd-row',
        h('.row.between.center-y.g-2',
          h('span.caption', { text: label }),
          h('.row.g-1.center-y',
            iconButton('play', { tip: 'Listen', pos: 'left', cls: 'btn-sm btn-ghost', onClick: () => this.playClip(clip) }),
            iconButton('trash', { tip: 'Remove this clip', pos: 'left', cls: 'btn-sm btn-ghost btn-danger', onClick: () => this.removeClip(group, field, rebuild) }),
          ),
        ),
        h('.snd-meta.truncate', {
          text: `${clip.name} · ${formatTime(clip.durationSec || 0)}${clip.encoded ? ' · ' + formatBytes(clip.encoded.size) : ' · not encoded yet'}`,
        }),
        h('.snd-id.mono.truncate', { text: this.eventIdFor(group, field) }),
        clip.encoded ? null : note('This clip still needs converting to Ogg Vorbis before it can ship.', 'warn'),
      );
    }

    return h('.snd-row',
      h('.row.between.center-y.g-2',
        h('span.caption', { text: label }),
        h('.row.g-1.center-y',
          canRecord()
            ? iconButton('mic', { tip: 'Record a clip', pos: 'left', cls: 'btn-sm btn-ghost', onClick: () => this.recordClip(group, field, rebuild) })
            : null,
          iconButton('upload', { tip: 'Use an audio file', pos: 'left', cls: 'btn-sm btn-ghost', onClick: () => this.uploadClip(group, field, rebuild) }),
        ),
      ),
      textInput({
        value: v.sounds?.[group]?.[field] || '',
        placeholder: `minecraft:entity.${this.mob.id}.${field.replace(/_sound$/, '')}`,
        mono: true,
        onInput: val => {
          v.sounds = v.sounds || {};
          v.sounds[group] = v.sounds[group] || {};
          v.sounds[group][field] = val.trim();
          markDirty('sounds'); scheduleSave();
        },
      }),
    );
  }

  async uploadClip(group, field, rebuild) {
    const { pickFile } = await import('../../core/util.js');
    const file = await pickFile({ accept: 'audio/*' });
    if (file) await this.ingestClip(group, field, file, file.name, rebuild);
  }

  async recordClip(group, field, rebuild) {
    const { openRecorderDialog } = await import('./discs.js');
    openRecorderDialog(blob => {
      const name = `${field.replace(/_sound$/, '')}-${Date.now()}.webm`;
      this.ingestClip(group, field, new File([blob], name, { type: blob.type }), name, rebuild);
    });
  }

  /**
   * Decode, store, and encode one clip. The browser hands back whatever
   * container it likes from the recorder; only the Ogg re-encode ever reaches
   * the pack, which is the same path a music disc takes.
   */
  async ingestClip(group, field, file, name, rebuild) {
    const t = toast({ title: 'Reading audio…', message: name, kind: 'info', duration: 0 });
    try {
      const info = await analyseAudio(file);
      const assetId = await putAsset('audio', file, { name });
      const clip = {
        assetId, name, mime: file.type, size: file.size,
        durationSec: info.durationSec, encoded: null,
      };
      this.v.soundClips = this.v.soundClips || {};
      this.v.soundClips[group] = this.v.soundClips[group] || {};
      this.v.soundClips[group][field] = clip;
      markDirty('mob sound'); scheduleSave();
      t.dismiss();
      rebuild();
      await this.encodeClip(clip, info.buffer, rebuild);
    } catch (e) {
      t.dismiss();
      toastWarn('That audio could not be read', e.message);
    }
  }

  async encodeClip(clip, buffer, rebuild) {
    const t = toast({ title: 'Converting to Ogg Vorbis…', message: clip.name, kind: 'info', duration: 0 });
    try {
      await loadEncoder();
      const blob = await encodeOgg(buffer, { quality: 4 });
      clip.encoded = { assetId: await putAsset('audio', blob, { name: `${clip.name}.ogg`, encoded: true }), size: blob.size };
      markDirty('mob sound'); scheduleSave();
      t.dismiss();
      toastOk('Sound ready', `${clip.name} — ${formatBytes(blob.size)}.`);
      rebuild();
    } catch (e) {
      t.dismiss();
      toastWarn('Encoding failed', `${e.message} — the clip is kept, so you can try again.`);
      rebuild();
    }
  }

  async removeClip(group, field, rebuild) {
    delete this.v.soundClips?.[group]?.[field];
    if (this.v.sounds?.[group]) this.v.sounds[group][field] = '';
    markDirty('mob sound'); scheduleSave();
    rebuild();
    const { gcAssets } = await import('../../core/store.js');
    gcAssets().catch(() => {});
  }

  async playClip(clip) {
    try {
      const blob = await getAsset(clip.encoded?.assetId || clip.assetId);
      if (!blob) return toastWarn('Clip missing', 'Its audio is no longer in this browser.');
      const buf = await decodeToBuffer(blob.blob || blob);
      this.clipPlayer = this.clipPlayer || new Player();
      this.clipPlayer.load(buf).play();
    } catch (e) {
      toastWarn('Could not play that', e.message);
    }
  }

  /* --------------------------------------------------------------- about */
  aboutSection() {
    const mob = this.mob;
    return section(`About the ${mob.label.toLowerCase()}`, [
      h('.kv-grid',
        h('.kv-k', { text: 'Registry' }), h('.kv-v.mono', { text: `data/<ns>/${mob.registry}/` }),
        h('.kv-k', { text: 'Added' }), h('.kv-v', { text: mob.since }),
        h('.kv-k', { text: 'Texture' }), h('.kv-v', { text: `${mob.texture[0]} × ${mob.texture[1]}` }),
        mob.babyTexture ? h('.kv-k', { text: 'Baby texture' }) : null,
        mob.babyTexture ? h('.kv-v', { text: `${mob.babyTexture[0]} × ${mob.babyTexture[1]} · own model` }) : null,
        h('.kv-k', { text: 'Health' }), h('.kv-v', { text: `${mob.facts.health} (${mob.facts.health / 2} hearts)` }),
        h('.kv-k', { text: 'Model parts' }), h('.kv-v', { text: String(Object.keys(this.model.parts).length) }),
        h('.kv-k', { text: 'Vanilla variants' }), h('.kv-v', { text: mob.vanilla.join(', ') }),
        mob.sounds ? h('.kv-k', { text: 'Sound fields' }) : null,
        mob.sounds ? h('.kv-v', { text: `${mob.sounds.fields.length}${mob.sounds.split ? ' × adult and baby' : ''}` }) : null,
      ),
      note(mob.facts.note, 'info'),
    ], { key: 'mob-about', open: false });
  }

  /* -------------------------------------------------------------- output */
  outputSection() {
    const v = this.v, mob = this.mob, project = state.project;
    const json = variantJSON(v, mob, (kind, slot) => mobAssetId(project.namespace, v, kind, slot));
    const blanks = mobSlots(v, mob).filter(s => docIsBlank(s.doc));
    return section('What gets written', [
      blanks.length
        ? note(`${blanks.length} texture${blanks.length > 1 ? 's are' : ' is'} still blank: ${blanks.map(b => `${b.kind}${b.slot !== 'default' ? ' ' + b.slot : ''}`).join(', ')}.`, 'warn')
        : null,
      codeBlock(JSON.stringify(json, null, 2), { label: `data/${project.namespace}/${mob.registry}/${v.id}.json` }),
      codeBlock(summonCommand(project, v, { includeSlash: true }), { label: 'Test it' }),
      note('Variant changes need a world reload — /reload alone will not pick them up.', 'info'),
    ], { key: 'mob-output', open: false });
  }
}
