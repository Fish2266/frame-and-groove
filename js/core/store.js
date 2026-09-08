/* ============================================================================
   Store — app state, subscriptions, undo history and autosave.
   ========================================================================= */

import { Projects, Assets, Prefs } from './db.js';
import { projectToJSON, projectFromJSON, createProject, projectStats } from './project.js';
import { debounce, uid } from './util.js';

/* ---- Tiny emitter ------------------------------------------------------- */
class Emitter {
  #m = new Map();
  on(evt, fn) {
    if (!this.#m.has(evt)) this.#m.set(evt, new Set());
    this.#m.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) { const off = this.on(evt, (...a) => { off(); fn(...a); }); return off; }
  off(evt, fn) { this.#m.get(evt)?.delete(fn); }
  emit(evt, ...a) {
    const s = this.#m.get(evt);
    if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error(`[bus:${evt}]`, e); } }
    const any = this.#m.get('*');
    if (any) for (const fn of [...any]) { try { fn(evt, ...a); } catch (e) { console.error(e); } }
  }
}
export const bus = new Emitter();

/**
 * Subscribe on behalf of a DOM node, and stop when that node leaves the page.
 *
 * A component that lives inside something rebuilt on every render — an
 * inspector row, a status chip — has no natural place to hang a disposer, and
 * a plain bus.on there leaks one listener and one detached subtree per render.
 * This unhooks itself the first time it fires for a node that is gone.
 */
export function bindLive(el, evt, handler) {
  const off = bus.on(evt, (...args) => {
    if (!el.isConnected) { off(); return; }
    handler(...args);
  });
  return off;
}

/* ========================================================================= */
/* HISTORY                                                                   */
/* ========================================================================= */

export class History {
  constructor(limit = 160) { this.limit = limit; this.stack = []; this.index = -1; }
  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get currentLabel() { return this.stack[this.index]?.label || null; }

  push(entry) {
    // Drop the redo tail, then append.
    if (this.index < this.stack.length - 1) this.stack.length = this.index + 1;
    this.stack.push({ id: uid('h'), at: Date.now(), icon: 'edit', ...entry });
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    bus.emit('history:change', this);
  }
  /** Merge into the previous entry when the same logical action continues. */
  amend(entry) {
    const top = this.stack[this.index];
    if (top && top.mergeKey && top.mergeKey === entry.mergeKey) {
      top.redo = entry.redo; top.label = entry.label || top.label;
      bus.emit('history:change', this);
      return true;
    }
    return false;
  }
  undo() {
    if (!this.canUndo) return false;
    const e = this.stack[this.index--];
    try { e.undo(); } catch (err) { console.error('undo failed', err); }
    bus.emit('history:change', this);
    bus.emit('history:applied', e, 'undo');
    return e;
  }
  redo() {
    if (!this.canRedo) return false;
    const e = this.stack[++this.index];
    try { e.redo(); } catch (err) { console.error('redo failed', err); }
    bus.emit('history:change', this);
    bus.emit('history:applied', e, 'redo');
    return e;
  }
  /** Jump to a point in the timeline (from the history panel). */
  goto(targetIndex) {
    targetIndex = Math.max(-1, Math.min(this.stack.length - 1, targetIndex));
    while (this.index > targetIndex) this.undo();
    while (this.index < targetIndex) this.redo();
  }
  clear() { this.stack.length = 0; this.index = -1; bus.emit('history:change', this); }
}

/* ---- Layer patch helpers (small undo records for pixel edits) ----------- */

/** Snapshot a layer's bytes cheaply. */
export const snapshot = layer => new Uint8ClampedArray(layer.data);

/**
 * Build an undo entry from a before-snapshot and a layer's current state,
 * storing only the changed bounding box.
 */
export function makeLayerPatch(doc, layer, before, label, icon = 'pencil') {
  const w = doc.w, h = doc.h, after = layer.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (before[i] !== after[i] || before[i + 1] !== after[i + 1] ||
          before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;                       // nothing changed
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const prev = new Uint8ClampedArray(bw * bh * 4);
  const next = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    const src = ((minY + y) * w + minX) * 4, dst = y * bw * 4;
    prev.set(before.subarray(src, src + bw * 4), dst);
    next.set(after.subarray(src, src + bw * 4), dst);
  }
  const apply = buf => {
    for (let y = 0; y < bh; y++) {
      const dst = ((minY + y) * w + minX) * 4, src = y * bw * 4;
      layer.data.set(buf.subarray(src, src + bw * 4), dst);
    }
  };
  return { label, icon, bytes: prev.length * 2, undo: () => apply(prev), redo: () => apply(next) };
}

/* ========================================================================= */
/* APP STATE                                                                 */
/* ========================================================================= */

export const state = {
  ready: false,
  route: 'library',            // library | paintings | discs | pack | export
  project: null,               // live project object
  projectDirty: false,
  saving: false,
  lastSavedAt: 0,
  selPainting: null,           // painting.key
  selDisc: null,               // disc.key
  selMob: null,                // mob variant.key
  selSprite: null,             // renamed sprite.key
  library: [],                 // project index records
  prefs: {
    theme: 'deepslate',
    grain: true,
    textures: true,
    sound: true,
    soundVolume: 55,
    pixelGrid: true,
    blockGrid: true,
    reduceMotion: false,
    palette: 'overworld',
    recentColors: [],
    customPalettes: {},
    firstRun: true,
    autoPlayPreview: true,
  },
  history: new History(),
};

export function setRoute(route, opts = {}) {
  if (state.route === route && !opts.force) return;
  state.route = route;
  bus.emit('route', route, opts);
}

export function markDirty(reason = 'edit') {
  state.projectDirty = true;
  bus.emit('project:dirty', reason);
  scheduleSave();
}

/* ---- Persistence -------------------------------------------------------- */
export async function loadPrefs() {
  const stored = await Prefs.get('prefs', null);
  if (stored) Object.assign(state.prefs, stored);
  applyPrefs();
}
export const savePrefs = debounce(() => Prefs.set('prefs', { ...state.prefs }), 350);

export function setPref(key, value) {
  state.prefs[key] = value;
  applyPrefs();
  savePrefs();
  bus.emit('prefs', key, value);
}

export function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = state.prefs.theme || 'deepslate';
  document.body.dataset.grain = state.prefs.grain ? 'on' : 'off';
  root.dataset.textures = state.prefs.textures === false ? 'off' : 'on';
  if (state.prefs.reduceMotion) root.style.setProperty('--d-base', '0ms');
  else root.style.removeProperty('--d-base');
  // Layout widths are left to the stylesheet so its responsive steps stay in
  // charge; an inline custom property here would outrank every media query.
}

export async function refreshLibrary() {
  state.library = await Projects.list();
  bus.emit('library', state.library);
  return state.library;
}

function indexRecord(project, thumb) {
  const s = projectStats(project);
  return {
    id: project.id,
    name: project.name,
    namespace: project.namespace,
    mcVersion: project.mcVersion,
    createdAt: project.createdAt,
    updatedAt: Date.now(),
    paintings: s.paintings,
    discs: s.discs,
    mobs: s.mobs,
    thumb: thumb ?? null,
    doc: projectToJSON(project),
  };
}

let _thumbMaker = null;
/** ui/thumbs.js installs a renderer here so the store stays presentation-free. */
export function setThumbnailRenderer(fn) { _thumbMaker = fn; }

export async function saveProject({ silent = false } = {}) {
  if (!state.project) return;
  state.saving = true;
  if (!silent) bus.emit('save:state', 'saving');
  try {
    let thumb = null;
    try { thumb = _thumbMaker ? await _thumbMaker(state.project) : null; }
    catch (e) { console.warn('thumbnail failed', e); }
    state.project.updatedAt = Date.now();
    await Projects.save(indexRecord(state.project, thumb));
    state.projectDirty = false;
    state.lastSavedAt = Date.now();
    bus.emit('save:state', 'saved');
    bus.emit('project:saved', state.project);
  } catch (e) {
    console.error('save failed', e);
    bus.emit('save:state', 'error', e);
    throw e;
  } finally {
    state.saving = false;
  }
}

export const scheduleSave = debounce(() => { saveProject({ silent: true }).catch(() => {}); }, 900);

export async function openProject(id) {
  const rec = await Projects.get(id);
  if (!rec) throw new Error('That project is no longer in your library.');
  state.project = projectFromJSON(rec.doc);
  state.project.id = rec.id;
  state.history.clear();
  state.projectDirty = false;
  state.selPainting = state.project.paintings[0]?.key || null;
  state.selDisc = state.project.discs[0]?.key || null;
  state.selMob = state.project.mobs?.[0]?.key || null;
  bus.emit('project:open', state.project);
  await Prefs.set('lastProject', id);
  return state.project;
}

export async function newProject(opts) {
  const p = createProject(opts);
  state.project = p;
  state.history.clear();
  state.selPainting = null; state.selDisc = null; state.selMob = null;
  await saveProject({ silent: true });
  await refreshLibrary();
  bus.emit('project:open', p);
  await Prefs.set('lastProject', p.id);
  return p;
}

export async function adoptProject(project) {
  state.project = project;
  state.history.clear();
  state.selPainting = project.paintings[0]?.key || null;
  state.selMob = project.mobs?.[0]?.key || null;
  state.selDisc = project.discs[0]?.key || null;
  await saveProject({ silent: true });
  await refreshLibrary();
  bus.emit('project:open', project);
  await Prefs.set('lastProject', project.id);
  return project;
}

export async function closeProject() {
  if (state.projectDirty) { try { await saveProject({ silent: true }); } catch {} }
  state.project = null;
  state.history.clear();
  bus.emit('project:close');
  await Prefs.remove('lastProject');
}

export async function deleteProject(id) {
  await Projects.remove(id);
  if (state.project?.id === id) { state.project = null; bus.emit('project:close'); }
  await refreshLibrary();
}

export async function duplicateProject(id) {
  const rec = await Projects.get(id);
  if (!rec) return null;
  const p = projectFromJSON(rec.doc);
  const newId = uid('prj');
  p.id = newId;
  p.name = `${p.name} copy`;
  p.createdAt = Date.now();
  // Clone every asset the copy references so the two projects stay independent.
  const assets = await Assets.forProject(id);
  const map = new Map();
  for (const a of assets) {
    const nid = uid('ast');
    map.set(a.id, nid);
    await Assets.put({ ...a, id: nid, projectId: newId });
  }
  const remap = id => (id && map.has(id) ? map.get(id) : id);
  for (const d of p.discs) {
    if (d.audio) {
      d.audio.assetId = remap(d.audio.assetId);
      if (d.audio.encoded) d.audio.encoded.assetId = remap(d.audio.encoded.assetId);
    }
  }
  for (const m of p.mobs || []) {
    for (const group of Object.values(m.soundClips || {})) {
      for (const clip of Object.values(group || {})) {
        if (!clip) continue;
        clip.assetId = remap(clip.assetId);
        if (clip.encoded) clip.encoded.assetId = remap(clip.encoded.assetId);
      }
    }
  }
  await Projects.save({ ...indexRecord(p, rec.thumb), id: newId, createdAt: p.createdAt });
  await refreshLibrary();
  return newId;
}

/* ---- Selection accessors ------------------------------------------------ */
export const currentPainting = () => state.project?.paintings.find(p => p.key === state.selPainting) || null;
export const currentDisc     = () => state.project?.discs.find(d => d.key === state.selDisc) || null;

export function selectPainting(key) { state.selPainting = key; bus.emit('select:painting', key); }
export function selectDisc(key)     { state.selDisc = key;     bus.emit('select:disc', key); }
export function selectMob(key)      { state.selMob = key;      bus.emit('select:mob', key); }
export function selectSprite(key)   { state.selSprite = key;   bus.emit('select:sprite', key); }

/* ---- Recent colours ----------------------------------------------------- */
export function pushRecentColor(hex) {
  const list = state.prefs.recentColors.filter(c => c !== hex);
  list.unshift(hex);
  state.prefs.recentColors = list.slice(0, 24);
  savePrefs();
  bus.emit('colors:recent');
}

/* ---- Asset helpers ------------------------------------------------------ */
export async function putAsset(kind, blob, meta = {}) {
  const id = uid('ast');
  await Assets.put({
    id, projectId: state.project.id, kind, blob,
    mime: blob.type, size: blob.size, name: meta.name || '', meta, at: Date.now(),
  });
  return id;
}
export async function getAsset(id) { return id ? Assets.get(id) : null; }

/** Every asset id the project still points at — discs and mob sound clips. */
function liveAssetIds(project) {
  const live = [];
  for (const d of project.discs || []) {
    if (d.audio?.assetId) live.push(d.audio.assetId);
    if (d.audio?.encoded?.assetId) live.push(d.audio.encoded.assetId);
  }
  for (const m of project.mobs || []) {
    for (const group of Object.values(m.soundClips || {})) {
      for (const clip of Object.values(group || {})) {
        if (clip?.assetId) live.push(clip.assetId);
        if (clip?.encoded?.assetId) live.push(clip.encoded.assetId);
      }
    }
  }
  return live;
}

/** Remove assets no longer referenced by anything in the project. */
export async function gcAssets() {
  if (!state.project) return 0;
  return Assets.gc(state.project.id, liveAssetIds(state.project));
}
