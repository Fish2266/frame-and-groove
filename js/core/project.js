/* ============================================================================
   Project schema, factories, validation and (de)serialisation.

   A project is one pack pair: a data pack and its matching resource pack.
   Pixel data lives as Uint8ClampedArray RGBA inside layers. In IndexedDB those
   are stored natively; for the .zip round-trip they are base64'd, which is what
   toJSON/fromJSON handle.
   ========================================================================= */

import { uid, slugifyId, slugifyNamespace, clamp, titleCase } from './util.js';
import { DEFAULT_VERSION, getVersion, isKnownVersion, PIXELS_PER_BLOCK, FEATURES, versionAtLeast } from './versions.js';

export const SCHEMA_VERSION = 8;
export const PROJECT_FILE = '.frame-and-groove/project.json';

/* ---- base64 <-> bytes --------------------------------------------------- */
export function bytesToB64(bytes) {
  if (!bytes) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function b64ToBytes(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ========================================================================= */
/* PIXEL DOCUMENT                                                            */
/* ========================================================================= */

export function createLayer(w, h, name = 'Layer', fill = null) {
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) {
    const [r, g, b, a] = fill;
    for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
  }
  return { id: uid('lay'), name, visible: true, locked: false, opacity: 1, blend: 'normal', data };
}

export function createPixelDoc(w, h, { layerName = 'Background' } = {}) {
  return { w, h, layers: [createLayer(w, h, layerName)], active: 0 };
}

export function docClone(doc) {
  return {
    w: doc.w, h: doc.h, active: doc.active,
    layers: doc.layers.map(l => ({ ...l, data: new Uint8ClampedArray(l.data) })),
  };
}

/** Resize a document's canvas, anchoring content by a 9-way anchor. */
export function docResize(doc, nw, nh, anchor = 'center') {
  const ox = anchor.includes('left') ? 0 : anchor.includes('right') ? nw - doc.w : Math.round((nw - doc.w) / 2);
  const oy = anchor.includes('top') ? 0 : anchor.includes('bottom') ? nh - doc.h : Math.round((nh - doc.h) / 2);
  for (const layer of doc.layers) {
    const next = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < doc.h; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= nh) continue;
      for (let x = 0; x < doc.w; x++) {
        const tx = x + ox;
        if (tx < 0 || tx >= nw) continue;
        const si = (y * doc.w + x) * 4, di = (ty * nw + tx) * 4;
        next[di] = layer.data[si]; next[di + 1] = layer.data[si + 1];
        next[di + 2] = layer.data[si + 2]; next[di + 3] = layer.data[si + 3];
      }
    }
    layer.data = next;
  }
  doc.w = nw; doc.h = nh;
  return doc;
}

/** Nearest-neighbour rescale of every layer — keeps art when the size changes. */
/**
 * Rescale a document's pixels in place.
 *
 * Nearest-neighbour by default, which is what pixel art wants: every colour in
 * the result was in the original. `average: true` switches the *downscale*
 * direction to an area average instead, for artwork that is really a
 * photograph — scaling a 512-pixel mob sheet back to 64 by dropping 63 pixels
 * in every 64 throws the picture away, where averaging keeps it readable.
 * Scaling up stays nearest either way, so up-then-down with `average` returns
 * exactly the art you started with.
 */
export function docRescale(doc, nw, nh, { average = false } = {}) {
  const ow = doc.w, oh = doc.h;
  if (ow === nw && oh === nh) return doc;
  const box = average && nw <= ow && nh <= oh;
  for (const layer of doc.layers) {
    const src = layer.data;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * oh / nh);
      const y1 = box ? Math.max(y0 + 1, Math.floor((y + 1) * oh / nh)) : y0 + 1;
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * ow / nw);
        const x1 = box ? Math.max(x0 + 1, Math.floor((x + 1) * ow / nw)) : x0 + 1;
        const di = (y * nw + x) * 4;
        if (!box) {
          const si = (Math.min(oh - 1, y0) * ow + Math.min(ow - 1, x0)) * 4;
          out[di] = src[si]; out[di + 1] = src[si + 1];
          out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
          continue;
        }
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const si = (yy * ow + xx) * 4;
          const sa = src[si + 3] / 255;
          // Weighted by alpha, so a transparent pixel cannot bleed its colour.
          r += src[si] * sa; g += src[si + 1] * sa; b += src[si + 2] * sa;
          a += src[si + 3]; n++;
        }
        if (a > 0) {
          // Un-premultiply: divide the colour by the total alpha, not the count.
          const k = 255 / a;
          out[di] = r * k; out[di + 1] = g * k; out[di + 2] = b * k;
        } else {
          /* Nothing to average. Carry the top-left sample's colour rather than
             zeroing it, so a fully transparent block keeps whatever the artist
             left under it and a round trip is byte-for-byte reversible. */
          const si = (y0 * ow + x0) * 4;
          out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
        }
        out[di + 3] = a / n;
      }
    }
    layer.data = out;
  }
  doc.w = nw; doc.h = nh;
  return doc;
}

export function docIsEmpty(doc) {
  return doc.layers.every(l => {
    const d = l.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  });
}

/* ========================================================================= */
/* PAINTING                                                                  */
/* ========================================================================= */

export const FRAME_STYLES = [
  { id: 'none',      name: 'None' },
  { id: 'oak',       name: 'Oak' },
  { id: 'dark_oak',  name: 'Dark Oak' },
  { id: 'birch',     name: 'Birch' },
  { id: 'spruce',    name: 'Spruce' },
  { id: 'stone',     name: 'Stone' },
  { id: 'deepslate', name: 'Deepslate' },
  { id: 'copper',    name: 'Copper' },
  { id: 'gold',      name: 'Gilded' },
  { id: 'iron',      name: 'Iron' },
  { id: 'rope',      name: 'Rope' },
  { id: 'hairline',  name: 'Hairline' },
];

export function createPainting(name = 'New Painting', w = 2, h = 2) {
  const pw = w * PIXELS_PER_BLOCK, ph = h * PIXELS_PER_BLOCK;
  return {
    key: uid('pnt'),
    id: slugifyId(name, 'painting'),
    title: name,
    author: '',
    titleColor: 'yellow',
    authorColor: 'gray',
    w, h,
    placeable: true,
    frame: { style: 'none', thickness: 1, tint: null, inner: true },
    wallBlock: 'block/oak_planks',   // what the in-game preview hangs it on
    doc: createPixelDoc(pw, ph),
    createdAt: Date.now(),
  };
}

export function paintingPixelSize(p) {
  return [p.w * PIXELS_PER_BLOCK, p.h * PIXELS_PER_BLOCK];
}

/* ========================================================================= */
/* DISC                                                                      */
/* ========================================================================= */

export const DISC_TEMPLATES = [
  { id: 'classic',  name: 'Classic' },
  { id: 'ring',     name: 'Ring' },
  { id: 'split',    name: 'Split' },
  { id: 'wedge',    name: 'Wedge' },
  { id: 'dots',     name: 'Dots' },
  { id: 'radial',   name: 'Radial' },
  { id: 'crescent', name: 'Crescent' },
  { id: 'shard',    name: 'Shard' },
];

export function createDiscSprite() {
  return {
    mode: 'template',              // 'template' | 'vanilla' | 'pixels'
    vanilla: null,                 // { base, recolor, hue, sat, val } for 'vanilla'
    template: 'classic',
    colors: {
      body:      '#1E1E22',
      bodyShade: '#131316',
      bodyLight: '#2E2E35',
      label:     '#4FBF6E',
      labelShade:'#2F8F4B',
      labelLight:'#7FE39B',
      center:    '#1A1A1E',
      ringGloss: '#3A3A44',
    },
    grooves: true,
    gloss: true,
    outline: true,
    doc: null,                     // lazily created 16x16 pixel doc for 'pixels'
  };
}

export function createDisc(name = 'New Track') {
  return {
    key: uid('dsc'),
    id: slugifyId(name, 'track'),
    name,
    artist: '',
    descriptionText: name,
    baseItem: 'music_disc_13',
    rarity: 'rare',
    nameColor: 'aqua',
    comparatorOutput: 8,
    range: 64,
    glint: false,
    hideSongTooltip: false,
    loot: { standalone: true, creeper: false, chests: [], rarity: 'uncommon' },
    audio: null,                   // see createAudio()
    sprite: createDiscSprite(),
    createdAt: Date.now(),
  };
}

export function createAudio(partial = {}) {
  return {
    assetId: null,                 // source file blob in Assets
    sourceName: '',
    mime: '',
    size: 0,
    durationSec: 0,
    sampleRate: 44100,
    channels: 2,
    peaks: null,                   // Float32Array pair for the waveform
    trimStart: 0,
    trimEnd: 0,                    // 0 means "to the end"
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    mono: true,
    normalize: false,
    quality: 4,                    // vorbis VBR -1..10
    generated: null,               // { style, seed, seconds, bpm } when synthesised
    encoded: null,                 // { assetId, size, bitrateKbps }
    ...partial,
  };
}

/** The number Minecraft needs: how long the exported clip actually is. */
export function audioClipLength(a) {
  if (!a || !a.durationSec) return 0;
  const end = a.trimEnd > 0 ? Math.min(a.trimEnd, a.durationSec) : a.durationSec;
  return Math.max(0, end - Math.max(0, a.trimStart));
}

/* ========================================================================= */
/* RENAMED SPRITE                                                            */
/* ========================================================================= */

/** Sprite resolutions, as a multiple of the vanilla 16 x 16 item sheet. */
export const SPRITE_SCALES = [1, 2, 4, 8];
export const SPRITE_BASE = 16;

/**
 * One retexture keyed to a name.
 *
 * The pack does not add an item: it teaches a vanilla item to look different
 * when it is called something in particular. `baseItem` is the item, and
 * `matchName` is the exact name — the anvil writes what you type, and the
 * match is character for character, capitals included.
 */
export function createNamedSprite(baseItem, matchName = 'New Name', scale = 1) {
  const px = SPRITE_BASE * scale;
  return {
    key: uid('spr'),
    id: slugifyId(matchName, 'sprite'),
    baseItem,
    matchName,
    scale,
    /* Item sprites are sampled by normalised coordinate like everything else
       in a resource pack, so a whole multiple of 16 simply gives more room to
       draw in and needs nothing declared anywhere. */
    doc: createPixelDoc(px, px, { layerName: 'Sprite' }),
    /* Which vanilla texture it was started from, purely so the editor can say
       so later. */
    base: null,
    notes: '',
    createdAt: Date.now(),
  };
}

export const spritePixelSize = s => SPRITE_BASE * Math.max(1, s.scale || 1);

export function suggestSpriteName(project) {
  const n = (project.sprites || []).length + 1;
  return `Sprite ${n}`;
}

/* ========================================================================= */
/* PROJECT                                                                   */
/* ========================================================================= */

/* ---- Mob variants -------------------------------------------------------- *
   A variant is one entry in a `<mob>_variant` registry: a texture (or three,
   for wolves), where it is allowed to spawn, and optionally its own sounds.
   Textures live as pixel docs so the editor can treat them like any other
   canvas in the app.                                                        */
export function createMobVariant(mobId, mob, name = 'New Variant', texScale = 1) {
  const slots = {};
  const kinds = mob.baby ? ['adult', 'baby'] : ['adult'];
  for (const kind of kinds) {
    slots[kind] = {};
    /* A baby is its own model on its own sheet — a baby pig is 32x32 where the
       adult is 64x64 — so the two ages never share a canvas size. */
    const base = (kind === 'baby' && mob.babyTexture) ? mob.babyTexture : mob.texture;
    const [w, h] = [base[0] * texScale, base[1] * texScale];
    for (const slot of (mob.assetSet || ['default'])) {
      slots[kind][slot] = { doc: createPixelDoc(w, h, { layerName: 'Texture' }), base: null };
    }
  }
  return {
    key: uid('mv'),
    id: slugifyId(name) || 'variant',
    name,
    mob: mobId,
    model: mob.models ? 'normal' : null,
    /* How many texels the artwork carries per model pixel. The game samples an
       entity texture by normalised coordinates, so any whole multiple of the
       model's own sheet size works and simply gives you more room to draw in. */
    texScale,
    slots,
    /* Priority 0 with no condition is vanilla's own "this is the default"
       entry, and the safest thing to start from. */
    spawns: [{ type: 'none', priority: 0, values: [] }],
    soundsEnabled: false,
    sounds: { adult: {}, baby: {} },
    /* Audio the user records or uploads for this variant, keyed the same way
       as `sounds`. Each entry points at stored blobs, never at raw bytes. */
    soundClips: { adult: {}, baby: {} },
    notes: '',
  };
}

/** Which texture slots a variant actually carries, flattened for iteration. */
export function mobSlots(variant, mob) {
  const out = [];
  for (const kind of Object.keys(variant.slots || {})) {
    for (const slot of Object.keys(variant.slots[kind] || {})) {
      out.push({ kind, slot, doc: variant.slots[kind][slot].doc, ref: variant.slots[kind][slot] });
    }
  }
  return out;
}

export function suggestMobName(project, mobLabel) {
  const n = (project.mobs || []).filter(m => m.mob === mobLabel).length + 1;
  return `${titleCase(mobLabel)} Variant ${n}`;
}

export function createProject(opts = {}) {
  const name = opts.name || 'Untitled Pack';
  const now = Date.now();
  return {
    schema: SCHEMA_VERSION,
    id: opts.id || uid('prj'),
    name,
    namespace: opts.namespace || slugifyNamespace(name),
    description: opts.description || `${name} — custom paintings and music discs.`,
    author: opts.author || '',
    packVersion: '1.0.0',
    license: '',
    mcVersion: opts.mcVersion || DEFAULT_VERSION,
    advanced: {
      // null anywhere means "use the target version's own number".
      // Formats are [major, minor] pairs from 1.21.9 on; older releases only
      // ever use the major.
      dataFormat: null,
      resourceFormat: null,
      dataMaxFormat: null,
      resourceMaxFormat: null,
      declareRange: true,
    },
    settings: {
      generateGiveFunction: true,
      generateReadme: true,
      embedProjectData: true,
      splitPacks: 'bundle',        // 'bundle' | 'separate'
      allPlaceable: true,
      soundCategory: 'record',
    },
    icon: null,                    // { w, h, data: Uint8ClampedArray } — pack.png
    paintings: [],
    discs: [],
    mobs: [],
    sprites: [],
    createdAt: now,
    updatedAt: now,
  };
}

/* ---- Derived pack formats ---------------------------------------------- */
/**
 * Resolve what actually goes in pack.mcmeta: the format pairs, whether this
 * target uses the modern min_format/max_format shape, and whether the numbers
 * are ones this tool ships as known-good.
 */
export function packFormats(project) {
  const v = getVersion(project.mcVersion);
  const a = project.advanced || {};
  const data = a.dataFormat ?? v.data;
  const resource = a.resourceFormat ?? v.resource;
  return {
    data, resource,
    dataMax: a.dataMaxFormat ?? data,
    resourceMax: a.resourceMaxFormat ?? resource,
    rangeShape: v.features.includes(FEATURES.RANGE_FORMAT),
    declareRange: a.declareRange !== false,
    verified: v.verified && !a.dataFormat && !a.resourceFormat,
  };
}

/* Which release each variant registry arrived in. Duplicated from the mob
   registry deliberately: importing it here would make core/project depend on
   the UI-facing mob module, and this is two lines that change once a year. */
/* Baby sheet sizes, mirroring `babyTexture` in mob/registry.js. Duplicated
   rather than imported so core/ stays independent of the mob module — the
   same reason MOB_SINCE is duplicated below. */
const MOB_BABY_TEXTURE = {
  cow: [64, 64], pig: [32, 32], chicken: [16, 16], wolf: [32, 32], cat: [32, 32],
};

const MOB_SINCE = {
  cow: '1.21.5', pig: '1.21.5', chicken: '1.21.5',
  frog: '1.21.5', cat: '1.21.5', wolf: '1.20.5',
  zombie_nautilus: '1.21.11',
};

/* ---- Validation --------------------------------------------------------- */
/**
 * Returns { errors:[], warnings:[] } — each entry is
 * { scope, key, field, message, fix? }.
 */
export function validateProject(project) {
  const errors = [], warnings = [];
  const push = (list, scope, key, field, message, fix) => list.push({ scope, key, field, message, fix });

  if (!project.name?.trim()) push(errors, 'pack', null, 'name', 'The pack needs a name.');
  const ns = project.namespace;
  if (!ns) push(errors, 'pack', null, 'namespace', 'The pack needs a namespace.');
  else if (!/^[a-z0-9_.-]+$/.test(ns)) push(errors, 'pack', null, 'namespace', 'Namespace may only contain a–z, 0–9, _ . and -');
  else if (ns === 'minecraft') push(errors, 'pack', null, 'namespace', 'The namespace "minecraft" would overwrite vanilla content. Pick another.');

  const v = getVersion(project.mcVersion);
  if (!isKnownVersion(project.mcVersion)) {
    push(warnings, 'pack', null, 'mcVersion',
      `This pack targets "${project.mcVersion}", which is not in the version table — it will be built with ${v.label} numbers. Pick a target in Pack Settings.`);
  }

  if (project.paintings.length && !v.features.includes('paintingVariants')) {
    push(errors, 'pack', null, 'mcVersion',
      `${v.label} cannot add new paintings without replacing vanilla ones. Target 1.21.2 or newer.`);
  }
  if (project.discs.length && !v.features.includes('jukeboxSongs')) {
    push(errors, 'pack', null, 'mcVersion', `${v.label} has no data-driven jukebox songs. Target 1.21 or newer.`);
  }
  if (project.discs.length && !v.features.includes('itemModel')) {
    push(warnings, 'pack', null, 'mcVersion',
      `${v.label} has no item_model component, so discs will keep their vanilla sprite in-game. Target 1.21.4+ for custom disc art.`);
  }

  const seenP = new Map();
  for (const p of project.paintings) {
    if (!p.id) push(errors, 'painting', p.key, 'id', 'Painting needs an id.');
    else if (!/^[a-z0-9_.-]+$/.test(p.id)) push(errors, 'painting', p.key, 'id', `"${p.id}" is not a valid resource id.`);
    if (seenP.has(p.id)) push(errors, 'painting', p.key, 'id', `Duplicate id "${p.id}" — ids must be unique inside a pack.`);
    seenP.set(p.id, true);
    if (p.w < 1 || p.h < 1 || p.w > 16 || p.h > 16) push(errors, 'painting', p.key, 'size', 'Painting size must be 1–16 blocks on each side.');
    if (docIsEmpty(p.doc)) push(warnings, 'painting', p.key, 'doc', `"${p.title || p.id}" has no artwork yet — it will export as a transparent painting.`);
  }

  const seenD = new Map();
  for (const d of project.discs) {
    if (!d.id) push(errors, 'disc', d.key, 'id', 'Disc needs an id.');
    else if (!/^[a-z0-9_.-]+$/.test(d.id)) push(errors, 'disc', d.key, 'id', `"${d.id}" is not a valid resource id.`);
    if (seenD.has(d.id)) push(errors, 'disc', d.key, 'id', `Duplicate id "${d.id}" — ids must be unique inside a pack.`);
    seenD.set(d.id, true);
    if (!d.audio?.encoded?.assetId) {
      push(errors, 'disc', d.key, 'audio', `"${d.name || d.id}" has no encoded audio. Add a track and let it convert to Ogg.`);
    } else {
      const len = audioClipLength(d.audio);
      if (len < 0.2) push(errors, 'disc', d.key, 'audio', `"${d.name || d.id}" is shorter than a fifth of a second.`);
      if (len > 600) push(warnings, 'disc', d.key, 'audio', `"${d.name || d.id}" runs ${Math.round(len / 60)} minutes — very large for a pack.`);
      if (!d.audio.mono) push(warnings, 'disc', d.key, 'audio', `"${d.name || d.id}" is stereo, so it will play flat instead of from the jukebox.`);
    }
    if (d.comparatorOutput < 0 || d.comparatorOutput > 15) push(errors, 'disc', d.key, 'comparatorOutput', 'Comparator output must be 0–15.');
    if (d.sprite?.mode === 'vanilla' && !d.sprite.vanilla?.recolor) {
      push(warnings, 'disc', d.key, 'sprite',
        `"${d.name || d.id}" ships a bundled texture exactly as it is. Recolour it, or draw your own in the pixel editor, before you publish.`);
    }
  }

  /* ---- Mob variants ----
     The registries only exist from a given release on, and a variant with no
     matching spawn rule simply never appears in a world — worth saying out
     loud, because the pack still installs cleanly. */
  const seenM = new Map();
  for (const m of project.mobs || []) {
    const label = m.name || m.id;
    if (!m.id) push(errors, 'mob', m.key, 'id', 'Variant needs an id.');
    else if (!/^[a-z0-9_.-]+$/.test(m.id)) push(errors, 'mob', m.key, 'id', `"${m.id}" is not a valid resource id.`);
    const dupKey = `${m.mob}/${m.id}`;
    if (seenM.has(dupKey)) {
      push(errors, 'mob', m.key, 'id', `Two ${m.mob} variants share the id "${m.id}".`);
    }
    seenM.set(dupKey, true);

    if (!MOB_SINCE[m.mob]) {
      push(errors, 'mob', m.key, 'mob', `"${m.mob}" is not a mob this tool can build variants for.`);
      continue;
    }
    if (!versionAtLeast(project.mcVersion, MOB_SINCE[m.mob])) {
      push(errors, 'mob', m.key, 'mob',
        `${m.mob} variants need ${MOB_SINCE[m.mob]} or newer; this pack targets ${project.mcVersion}.`);
    }
    if (!(m.spawns || []).length) {
      push(warnings, 'mob', m.key, 'spawns',
        `"${label}" has no spawn rules, so it will never appear on its own. You can still summon it.`);
    } else {
      for (const sp of m.spawns) {
        if ((sp.type === 'minecraft:biome' || sp.type === 'minecraft:structure') && !(sp.values || []).length) {
          push(warnings, 'mob', m.key, 'spawns',
            `"${label}" has a ${sp.type.split(':')[1]} rule with nothing selected — that rule never matches.`);
        }
      }
    }
    for (const kind of Object.keys(m.slots || {})) {
      for (const slot of Object.keys(m.slots[kind] || {})) {
        const doc = m.slots[kind][slot].doc;
        if (doc && docIsEmpty(doc)) {
          push(warnings, 'mob', m.key, 'texture',
            `"${label}" has a blank ${kind}${slot === 'default' ? '' : ' ' + slot} texture — it will export invisible.`);
        }
      }
    }
  }

  /* ---- Renamed sprites ----
     Two things can go wrong that the game will not tell you about: two sprites
     on the same item claiming the same name (only the first is ever drawn),
     and a name with trailing space, which an anvil will not let anyone type. */
  const seenS = new Map();
  const namesPerItem = new Map();
  for (const sp of project.sprites || []) {
    const label = sp.matchName || sp.id;
    if (!sp.id) push(errors, 'sprite', sp.key, 'id', 'Sprite needs an id.');
    else if (!/^[a-z0-9_.-]+$/.test(sp.id)) push(errors, 'sprite', sp.key, 'id', `"${sp.id}" is not a valid resource id.`);
    if (seenS.has(sp.id)) push(errors, 'sprite', sp.key, 'id', `Duplicate id "${sp.id}" — ids must be unique inside a pack.`);
    seenS.set(sp.id, true);

    if (!sp.baseItem) push(errors, 'sprite', sp.key, 'baseItem', `"${label}" has no item to sit on.`);
    const name = (sp.matchName || '').trim();
    if (!name) {
      push(errors, 'sprite', sp.key, 'matchName', 'A renamed sprite needs the name it answers to.');
    } else {
      if (name !== sp.matchName) {
        push(warnings, 'sprite', sp.key, 'matchName',
          `"${label}" has a space at one end of its name. An anvil trims those, so it would never match.`);
      }
      if (name.length > 50) {
        push(errors, 'sprite', sp.key, 'matchName',
          `"${name.slice(0, 20)}…" is ${name.length} characters. An anvil caps a name at 50, so nobody could type this one.`);
      }
      const key = `${sp.baseItem}\u0000${name}`;
      if (namesPerItem.has(key)) {
        push(errors, 'sprite', sp.key, 'matchName',
          `Two sprites on ${sp.baseItem} both answer to "${name}". Only the first would ever show.`);
      }
      namesPerItem.set(key, true);
    }
    if (sp.doc && docIsEmpty(sp.doc)) {
      push(warnings, 'sprite', sp.key, 'doc', `"${label}" has no artwork yet — it would export as an invisible item.`);
    }
  }
  if ((project.sprites || []).length && !v.features.includes(FEATURES.COMPONENT_SELECT)) {
    push(errors, 'pack', null, 'mcVersion',
      `${v.label} cannot pick a model from an item's name. Renamed sprites need 26.1 or newer.`);
  }

  if (!project.paintings.length && !project.discs.length && !(project.mobs || []).length &&
      !(project.sprites || []).length) {
    push(warnings, 'pack', null, null, 'This pack is empty. Add a painting, a disc, a mob variant or a renamed sprite before exporting.');
  }
  return { errors, warnings, ok: errors.length === 0 };
}

/* ---- Serialisation ------------------------------------------------------ */
function docToJSON(doc) {
  if (!doc) return null;
  return { w: doc.w, h: doc.h, active: doc.active,
    layers: doc.layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked,
      opacity: l.opacity, blend: l.blend, data: bytesToB64(l.data) })) };
}
function docFromJSON(j) {
  if (!j) return null;
  const need = Math.max(0, (j.w | 0) * (j.h | 0) * 4);
  /* Layer data is normally base64, but a document can arrive from an older
     save, a hand-edited file, or a structuredClone that kept the typed array.
     Rather than throw and take the whole project down with it, each of those
     shapes is accepted and anything unreadable becomes a blank layer. */
  const decode = raw => {
    if (raw instanceof Uint8ClampedArray) return new Uint8ClampedArray(raw);
    if (ArrayBuffer.isView(raw)) return new Uint8ClampedArray(raw.buffer.slice(0));
    if (Array.isArray(raw)) return Uint8ClampedArray.from(raw);
    if (raw && typeof raw === 'object') {
      // A typed array that went through JSON.stringify: {"0":12,"1":255,…}
      const out = new Uint8ClampedArray(need);
      for (const k of Object.keys(raw)) {
        const i = +k;
        if (Number.isInteger(i) && i >= 0 && i < need) out[i] = raw[k];
      }
      return out;
    }
    if (typeof raw === 'string') {
      try {
        const bytes = b64ToBytes(raw);
        if (bytes) return new Uint8ClampedArray(bytes);
      } catch { /* falls through to a blank layer */ }
    }
    return new Uint8ClampedArray(need);
  };
  return { w: j.w, h: j.h, active: j.active | 0,
    layers: (j.layers || []).map(l => ({ ...l, data: decode(l.data) })) };
}

/** Plain-JSON form for the zip round-trip (and any future export). */
export function projectToJSON(project) {
  return {
    ...project,
    icon: project.icon ? { w: project.icon.w, h: project.icon.h, data: bytesToB64(project.icon.data) } : null,
    paintings: project.paintings.map(p => ({ ...p, doc: docToJSON(p.doc) })),
    discs: project.discs.map(d => ({
      ...d,
      sprite: { ...d.sprite, doc: docToJSON(d.sprite.doc) },
      audio: d.audio ? { ...d.audio, peaks: d.audio.peaks ? bytesToB64(new Uint8Array(new Float32Array(d.audio.peaks).buffer)) : null } : null,
    })),
    /* Every texture slot holds a pixel document, and a document's layer data is
       a typed array — JSON.stringify would turn it into an object of numbered
       keys, so each one is encoded the same way paintings and sprites are. */
    mobs: (project.mobs || []).map(m => ({
      ...m,
      slots: mapSlots(m.slots, slot => ({ ...slot, doc: docToJSON(slot.doc) })),
    })),
    sprites: (project.sprites || []).map(s => ({ ...s, doc: docToJSON(s.doc) })),
  };
}

/** Walk a variant's kind → slot → entry map, replacing each entry. */
function mapSlots(slots, fn) {
  const out = {};
  for (const kind of Object.keys(slots || {})) {
    out[kind] = {};
    for (const name of Object.keys(slots[kind] || {})) out[kind][name] = fn(slots[kind][name]);
  }
  return out;
}

export function projectFromJSON(j) {
  const p = migrate({ ...j });
  return {
    ...p,
    icon: p.icon ? { w: p.icon.w, h: p.icon.h, data: new Uint8ClampedArray(b64ToBytes(p.icon.data)) } : null,
    paintings: (p.paintings || []).map(x => ({ ...x, doc: docFromJSON(x.doc) })),
    discs: (p.discs || []).map(d => ({
      ...d,
      sprite: { ...createDiscSprite(), ...d.sprite, doc: docFromJSON(d.sprite?.doc) },
      audio: d.audio ? { ...createAudio(), ...d.audio,
        peaks: d.audio.peaks ? new Float32Array(b64ToBytes(d.audio.peaks).buffer) : null } : null,
    })),
    mobs: (p.mobs || []).map(m => ({
      ...m,
      slots: mapSlots(m.slots, slot => ({ ...slot, doc: docFromJSON(slot.doc) })),
    })),
    sprites: (p.sprites || []).map(s => ({ ...s, doc: docFromJSON(s.doc) })),
  };
}

/* ---- Migration ---------------------------------------------------------- */
export function migrate(p) {
  let s = p.schema || 1;
  if (s < 2) {
    p.settings = { ...createProject().settings, ...(p.settings || {}) };
    p.advanced = { ...createProject().advanced, ...(p.advanced || {}) };
    s = 2;
  }
  if (s < 3) {
    for (const d of p.discs || []) {
      if (d.sprite && !('grooves' in d.sprite)) { d.sprite.grooves = true; d.sprite.gloss = true; d.sprite.outline = true; }
      if (d.audio && d.audio.quality == null) d.audio.quality = 4;
    }
    for (const pt of p.paintings || []) {
      if (pt.frame && pt.frame.thickness == null) pt.frame.thickness = 1;
    }
    s = 3;
  }
  if (s < 4) {
    // Formats used to be bare integers and the range lived in four separate
    // fields; both became [major, minor] pairs when 1.21.9 changed the shape.
    const a = p.advanced || (p.advanced = {});
    const pair = n => (n == null ? null : (Array.isArray(n) ? n : [n, 0]));
    a.dataFormat = pair(a.dataFormat);
    a.resourceFormat = pair(a.resourceFormat);
    a.dataMaxFormat = pair(a.dataMax ?? null);
    a.resourceMaxFormat = pair(a.resMax ?? null);
    a.declareRange = a.useSupportedFormats !== false;
    delete a.dataMin; delete a.dataMax; delete a.resMin; delete a.resMax;
    delete a.useSupportedFormats;
    s = 4;
  }
  if (s < 5) {
    for (const d of p.discs || []) {
      if (!d.loot) d.loot = { standalone: true, creeper: false, chests: [], rarity: 'uncommon' };
      if (d.sprite && d.sprite.vanilla === undefined) d.sprite.vanilla = null;
    }
    s = 5;
  }
  if (s < 6) {
    // Mob variants are new; older packs simply have none.
    if (!Array.isArray(p.mobs)) p.mobs = [];
    s = 6;
  }
  if (s < 7) {
    /* Baby slots used to be created at the adult's sheet size, which the game
       reads as a scrambled texture. Resample rather than discard: the art is
       the user's, and a nearest-neighbour rescale keeps it recognisable. */
    for (const m of p.mobs || []) {
      const want = MOB_BABY_TEXTURE[m.mob];
      if (!want) continue;
      for (const entry of Object.values(m.slots?.baby || {})) {
        const doc = entry?.doc;
        if (doc && (doc.w !== want[0] || doc.h !== want[1])) resampleDocJSON(doc, want[0], want[1]);
      }
    }
    s = 7;
  }
  if (s < 8) {
    // Renamed sprites are new; older packs simply have none.
    if (!Array.isArray(p.sprites)) p.sprites = [];
    s = 8;
  }
  p.schema = SCHEMA_VERSION;
  return p;
}

/**
 * Point-resample every layer of a document in place, in whichever form its
 * pixels are currently in. Migration runs before docFromJSON, so a layer here
 * may still be base64 from a saved file or already a typed array in memory.
 */
function resampleDocJSON(doc, nw, nh) {
  const ow = doc.w | 0, oh = doc.h | 0;
  if (!ow || !oh) { doc.w = nw; doc.h = nh; return; }
  for (const layer of doc.layers || []) {
    const src = typeof layer.data === 'string'
      ? b64ToBytes(layer.data)
      : (ArrayBuffer.isView(layer.data) ? layer.data : null);
    const out = new Uint8ClampedArray(nw * nh * 4);
    if (src && src.length >= ow * oh * 4) {
      for (let y = 0; y < nh; y++) {
        const sy = Math.min(oh - 1, Math.floor(y * oh / nh));
        for (let x = 0; x < nw; x++) {
          const sx = Math.min(ow - 1, Math.floor(x * ow / nw));
          const si = (sy * ow + sx) * 4, di = (y * nw + x) * 4;
          out[di] = src[si]; out[di + 1] = src[si + 1];
          out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
        }
      }
    }
    layer.data = typeof layer.data === 'string' ? bytesToB64(out) : out;
  }
  doc.w = nw; doc.h = nh;
}

/* ---- Helpers ------------------------------------------------------------ */
export function nextUniqueId(base, existing) {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export function projectStats(project) {
  return {
    paintings: project.paintings.length,
    discs: project.discs.length,
    mobs: (project.mobs || []).length,
    sprites: (project.sprites || []).length,
    totalSeconds: project.discs.reduce((n, d) => n + audioClipLength(d.audio), 0),
    blocks: project.paintings.reduce((n, p) => n + p.w * p.h, 0),
  };
}

export function suggestPaintingName(project) {
  const n = project.paintings.length + 1;
  return `Painting ${n}`;
}
export function suggestDiscName(project) {
  const n = project.discs.length + 1;
  return `Track ${n}`;
}

export { titleCase, clamp };
