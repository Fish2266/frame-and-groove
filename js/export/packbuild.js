/* ============================================================================
   Pack builder — the exact file layout Minecraft expects.

   A custom painting or disc is always two packs working together:
     • the DATA pack registers it (painting_variant / jukebox_song),
     • the RESOURCE pack supplies the art and the audio.
   Nothing appears in game unless both are installed, so this builder always
   emits the pair and the export screen always presents them together.
   ========================================================================= */

import { getVersion, FEATURES, registryDir, MC_COLORS, formatValue, versionAtLeast } from '../core/versions.js';
import { packFormats, audioClipLength, projectToJSON, PROJECT_FILE } from '../core/project.js';
import { paintingPNG, bytesToPNG, toPackIcon } from '../paint/compose.js';
import { shippingSpriteData } from '../disc/sprite.js';
import { buildLootFiles } from './loot.js';
import { MOBS, variantJSON, soundVariantJSON } from '../mob/registry.js';
import { mobTexturePNG, mobAssetId, mobTexturePath, mobSoundEvent, mobSoundPath } from '../mob/export.js';
import { loadItems, itemById } from '../sprite/items.js';
import {
  spritePNG, spriteTexturePath, spriteModelPath, spriteModelJSON,
  namedItemFiles, giveSpriteCommand,
} from '../sprite/export.js';
import { canvasToBlob } from '../core/util.js';

const F = FEATURES;

/* ---- Small helpers ------------------------------------------------------ */
const nsId = (ns, id) => `${ns}:${id}`;

/** A mob's variants are writable once the target reaches that mob's own release. */
function mobVariantSupported(project, mob, v) {
  if (!v.features.includes(FEATURES.MOB_VARIANTS)) {
    // The wolf registry shipped in 1.20.5, before the blanket flag applies.
    return versionAtLeast(project.mcVersion, mob.since) && mob.since === '1.20.5';
  }
  return versionAtLeast(project.mcVersion, mob.since);
}
const soundEventName = id => `music_disc.${id}`;

function colorOf(name) {
  return MC_COLORS.some(c => c.id === name) ? name : null;
}

/** A text component for pack.mcmeta descriptions and in-game titles. */
function textComponent(text, color, extra = {}) {
  const c = { text: String(text ?? '') };
  const col = colorOf(color);
  if (col) c.color = col;
  return { ...c, ...extra };
}

/* ========================================================================= */
/* DATA PACK                                                                 */
/* ========================================================================= */

/* Caveats from the last data-pack build — replacing a vanilla loot table is a
   real trade-off and the export screen has to be able to say so. */
let lastLootWarnings = [];
export const lootWarnings = () => lastLootWarnings;

export function buildDataPackFiles(project) {
  const files = new Map();
  const v = getVersion(project.mcVersion);
  const fmt = packFormats(project);
  const ns = project.namespace;

  /* pack.mcmeta */
  files.set('pack.mcmeta', mcmetaJSON(project, fmt, 'data'));

  /* painting_variant entries */
  if (v.features.includes(F.PAINTING_VARIANTS)) {
    const dir = registryDir(project.mcVersion, 'painting_variant');
    for (const p of project.paintings) {
      const entry = {
        asset_id: nsId(ns, p.id),
        width: p.w,
        height: p.h,
      };
      if (p.title?.trim()) entry.title = textComponent(p.title, p.titleColor);
      if (p.author?.trim()) entry.author = textComponent(p.author, p.authorColor);
      files.set(`data/${ns}/${dir}/${p.id}.json`, JSON.stringify(entry, null, 2) + '\n');
    }

    /* #minecraft:placeable — what a blank painting is allowed to become */
    const placeable = project.paintings.filter(p => p.placeable).map(p => nsId(ns, p.id));
    if (placeable.length) {
      const tagDir = registryDir(project.mcVersion, 'tags_painting');
      files.set(`data/minecraft/${tagDir}/placeable.json`,
        JSON.stringify({ replace: false, values: placeable }, null, 2) + '\n');
    }
  }

  /* ---- Mob variants ----------------------------------------------------
     One JSON per variant, in that mob's own registry folder. The wolf's
     registry predates the rest, so each mob is checked against its own
     introduction rather than one blanket flag. */
  for (const variant of project.mobs || []) {
    const mob = MOBS[variant.mob];
    if (!mob || !mobVariantSupported(project, mob, v)) continue;
    const entry = variantJSON(variant, mob, (kind, slot) => mobAssetId(ns, variant, kind, slot));
    files.set(`data/${ns}/${mob.registry}/${variant.id}.json`,
              JSON.stringify(entry, null, 2) + '\n');

    if (variant.soundsEnabled && mob.sounds &&
        v.features.includes(F.MOB_SOUND_VARIANTS) &&
        versionAtLeast(project.mcVersion, mob.soundSince)) {
      const sv = soundVariantJSON(variant, mob);
      if (sv) {
        files.set(`data/${ns}/${mob.soundRegistry}/${variant.id}.json`,
                  JSON.stringify(sv, null, 2) + '\n');
      }
    }
  }

  /* jukebox_song entries */
  if (v.features.includes(F.JUKEBOX_SONGS)) {
    const dir = registryDir(project.mcVersion, 'jukebox_song');
    for (const d of project.discs) {
      const len = Math.max(0.1, audioClipLength(d.audio));
      const soundEvent = { sound_id: nsId(ns, soundEventName(d.id)) };
      if (d.range && d.range !== 16) soundEvent.range = Number(d.range);
      const entry = {
        sound_event: soundEvent,
        description: { translate: `jukebox_song.${ns}.${d.id}` },
        length_in_seconds: Math.round(len * 100) / 100,
        comparator_output: Math.max(0, Math.min(15, d.comparatorOutput | 0)),
      };
      files.set(`data/${ns}/${dir}/${d.id}.json`, JSON.stringify(entry, null, 2) + '\n');
    }
  }

  /* loot tables */
  const loot = buildLootFiles(project);
  for (const [path, json] of loot.files) {
    files.set(path, JSON.stringify(json, null, 2) + '\n');
  }
  lastLootWarnings = loot.warnings;

  /* helper functions */
  if (project.settings?.generateGiveFunction) {
    const fnDir = registryDir(project.mcVersion, 'function');
    if (project.discs.length) {
      files.set(`data/${ns}/${fnDir}/give_discs.mcfunction`, giveDiscsFunction(project));
    }
    if (project.paintings.length) {
      files.set(`data/${ns}/${fnDir}/give_paintings.mcfunction`, givePaintingsFunction(project));
    }
    if ((project.sprites || []).length && v.features.includes(F.COMPONENT_SELECT)) {
      files.set(`data/${ns}/${fnDir}/give_sprites.mcfunction`, giveSpritesFunction(project, v));
    }
    const lines = ['# Everything this pack adds, handed to the nearest player.', ''];
    if (project.discs.length) lines.push(`function ${ns}:give_discs`);
    if (project.paintings.length) lines.push(`function ${ns}:give_paintings`);
    if ((project.sprites || []).length && v.features.includes(F.COMPONENT_SELECT)) lines.push(`function ${ns}:give_sprites`);
    files.set(`data/${ns}/${fnDir}/give_all.mcfunction`, lines.join('\n') + '\n');
  }

  if (project.settings?.generateReadme) files.set('README.txt', readmeText(project, 'data'));

  return files;
}

/* ========================================================================= */
/* RESOURCE PACK                                                             */
/* ========================================================================= */

export async function buildResourcePackFiles(project, { getAudio } = {}) {
  const files = new Map();
  const v = getVersion(project.mcVersion);
  const fmt = packFormats(project);
  const ns = project.namespace;
  const lang = {};

  files.set('pack.mcmeta', mcmetaJSON(project, fmt, 'resource'));

  /* ---- Paintings ---- */
  for (const p of project.paintings) {
    files.set(`assets/${ns}/textures/painting/${p.id}.png`, await paintingPNG(p));
    if (p.title?.trim())  lang[`painting.${ns}.${p.id}.title`]  = p.title;
    if (p.author?.trim()) lang[`painting.${ns}.${p.id}.author`] = p.author;
  }

  const soundsJson = {};

  /* ---- Mob variants: textures, and any audio the variant carries ---------
     A clip becomes three things that have to agree: the .ogg, the sounds.json
     entry that names it, and the id written into the sound-variant JSON.
     All three come from mobSoundEvent/mobSoundPath so they cannot drift. */
  for (const variant of project.mobs || []) {
    const mob = MOBS[variant.mob];
    if (!mob || !mobVariantSupported(project, mob, v)) continue;
    for (const kind of Object.keys(variant.slots || {})) {
      for (const slot of Object.keys(variant.slots[kind] || {})) {
        const png = await mobTexturePNG(variant, mob, kind, slot);
        if (png) files.set(`assets/${ns}/${mobTexturePath(variant, kind, slot)}`, png);
      }
    }
    if (!variant.soundsEnabled) continue;
    for (const group of Object.keys(variant.soundClips || {})) {
      for (const fieldName of Object.keys(variant.soundClips[group] || {})) {
        const clip = variant.soundClips[group][fieldName];
        if (!clip?.encoded?.assetId || !getAudio) continue;
        const blob = await getAudio(clip.encoded.assetId);
        if (!blob) continue;
        const path = mobSoundPath(variant.id, group, fieldName);
        files.set(`assets/${ns}/sounds/${path}.ogg`, blob);
        soundsJson[mobSoundEvent(variant.id, group, fieldName)] = {
          category: 'neutral',
          sounds: [{ name: `${ns}:${path}` }],
        };
      }
    }
  }

  /* ---- Discs ---- */
  for (const d of project.discs) {
    /* audio */
    if (d.audio?.encoded?.assetId && getAudio) {
      const blob = await getAudio(d.audio.encoded.assetId);
      if (blob) files.set(`assets/${ns}/sounds/music/${d.id}.ogg`, blob);
    }
    soundsJson[soundEventName(d.id)] = {
      category: project.settings?.soundCategory || 'record',
      sounds: [{ name: `${ns}:music/${d.id}`, stream: true }],
    };

    /* sprite + item model, only where the version can use them */
    if (v.features.includes(F.ITEM_MODEL)) {
      const size = 16;
      const bytes = spriteBytes(d, size);
      files.set(`assets/${ns}/textures/item/${d.id}.png`, await bytesToPNG(bytes, size, size));
      files.set(`assets/${ns}/models/item/${d.id}.json`, JSON.stringify({
        parent: 'minecraft:item/generated',
        textures: { layer0: `${ns}:item/${d.id}` },
      }, null, 2) + '\n');
    }
    if (v.features.includes(F.ITEMS_DEFINITIONS)) {
      files.set(`assets/${ns}/items/${d.id}.json`, JSON.stringify({
        model: { type: 'minecraft:model', model: `${ns}:item/${d.id}` },
      }, null, 2) + '\n');
    }

    const artist = d.artist?.trim();
    lang[`jukebox_song.${ns}.${d.id}`] = artist ? `${artist} - ${d.name}` : d.name;
  }

  /* ---- Renamed sprites ----------------------------------------------------
     Three files per sprite — the artwork, a model that hangs it the way the
     base item hangs, and a share of the branch on the vanilla item. The last
     of those is one file per base item however many sprites sit on it, so it
     is built from the whole list at once rather than inside this loop. */
  const sprites = (project.sprites || []).filter(sp => sp.baseItem && sp.matchName?.trim() && sp.doc);
  if (sprites.length && v.features.includes(F.COMPONENT_SELECT)) {
    await loadItems();
    for (const sp of sprites) {
      const png = await spritePNG(sp);
      if (png) files.set(`assets/${ns}/${spriteTexturePath(sp)}`, png);
      files.set(`assets/${ns}/${spriteModelPath(sp)}`,
        JSON.stringify(spriteModelJSON(ns, sp, itemById(sp.baseItem)), null, 2) + '\n');
    }
    for (const [path, json] of namedItemFiles(ns, sprites, itemById)) {
      files.set(path, JSON.stringify(json, null, 2) + '\n');
    }
  }

  if (Object.keys(soundsJson).length) {
    files.set(`assets/${ns}/sounds.json`, JSON.stringify(soundsJson, null, 2) + '\n');
  }
  if (Object.keys(lang).length) {
    files.set(`assets/${ns}/lang/en_us.json`, JSON.stringify(lang, null, 2) + '\n');
  }
  if (project.settings?.generateReadme) files.set('README.txt', readmeText(project, 'resource'));

  return files;
}

/**
 * The 16×16 that ships for a disc, whichever way it was made.
 * A vanilla-based sprite falls back to the parametric one if the game textures
 * are not loaded, so an export never silently produces a blank item.
 */
export function spriteBytes(disc, size = 16) {
  return shippingSpriteData(disc, size);
}

/* ========================================================================= */
/* COMMANDS                                                                  */
/* ========================================================================= */

/**
 * The /give line for one disc. This is the piece that makes a custom disc
 * possible without replacing a vanilla one: a stock disc item carries an
 * item_model override for the sprite and a jukebox_playable override for the
 * song, so the vanilla disc it borrows from keeps working untouched.
 */
export function giveCommand(project, disc, { player = '@s', includeSlash = false } = {}) {
  const v = getVersion(project.mcVersion);
  const ns = project.namespace;
  const modern = v.features.includes(F.JUKEBOX_PLAIN_ID);   // 1.21.5+
  const parts = [];

  if (v.features.includes(F.ITEM_MODEL)) parts.push(`minecraft:item_model="${ns}:${disc.id}"`);

  if (modern) {
    parts.push(`minecraft:jukebox_playable="${ns}:${disc.id}"`);
  } else {
    parts.push(`minecraft:jukebox_playable={song:"${ns}:${disc.id}"${disc.hideSongTooltip ? ',show_in_tooltip:false' : ''}}`);
  }

  if (disc.name?.trim()) {
    const col = colorOf(disc.nameColor);
    if (modern) {
      const snbt = [`text:"${escapeSNBT(disc.name)}"`];
      if (col) snbt.push(`color:"${col}"`);
      snbt.push('italic:false');
      parts.push(`minecraft:item_name={${snbt.join(',')}}`);
    } else {
      const json = JSON.stringify({ text: disc.name, ...(col ? { color: col } : {}), italic: false });
      parts.push(`minecraft:item_name='${json.replace(/'/g, "\\'")}'`);
    }
  }

  if (disc.rarity && disc.rarity !== 'common') parts.push(`minecraft:rarity="${disc.rarity}"`);
  if (disc.glint) parts.push('minecraft:enchantment_glint_override=true');
  if (modern && disc.hideSongTooltip) parts.push(`minecraft:tooltip_display={hidden_components:["minecraft:jukebox_playable"]}`);

  return `${includeSlash ? '/' : ''}give ${player} minecraft:${disc.baseItem}[${parts.join(',')}] 1`;
}

/** The /give line for one painting. */
export function givePaintingCommand(project, painting, { player = '@s', includeSlash = false } = {}) {
  const ns = project.namespace;
  return `${includeSlash ? '/' : ''}give ${player} minecraft:painting[minecraft:entity_data={id:"minecraft:painting",variant:"${ns}:${painting.id}"}] 1`;
}

function escapeSNBT(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function giveDiscsFunction(project) {
  const out = [
    `# ${project.name} — custom music discs`,
    '# Run with:  /function ' + project.namespace + ':give_discs',
    '#',
    '# Each line hands out a stock disc item wearing this pack\'s sprite and song.',
    '# The vanilla disc it borrows from is untouched and still works normally.',
    '',
  ];
  for (const d of project.discs) {
    out.push(`# ${d.name}${d.artist ? ' — ' + d.artist : ''}`);
    out.push(giveCommand(project, d, { player: '@s' }));
    out.push('');
  }
  return out.join('\n');
}

function giveSpritesFunction(project, v) {
  const modern = v.features.includes(F.JUKEBOX_PLAIN_ID);   // 1.21.5+ NBT text
  const out = [
    `# ${project.name} — renamed sprites`,
    '# Run with:  /function ' + project.namespace + ':give_sprites',
    '#',
    '# Each line hands over a stock item already carrying the name that makes',
    '# this pack retexture it. Naming one in an anvil does exactly the same.',
    '',
  ];
  for (const sp of project.sprites || []) {
    if (!sp.baseItem || !sp.matchName?.trim()) continue;
    out.push(`# ${sp.matchName} — a ${sp.baseItem.replace(/_/g, ' ')}`);
    out.push(giveSpriteCommand(sp, { player: '@s', modern }));
    out.push('');
  }
  return out.join('\n');
}

function givePaintingsFunction(project) {
  const out = [
    `# ${project.name} — custom paintings`,
    '# Run with:  /function ' + project.namespace + ':give_paintings',
    '#',
    '# These hand you a painting item locked to one variant. If a future game',
    '# version changes how the item stores its variant, place a blank painting',
    '# instead — anything in the #minecraft:placeable tag can turn up that way.',
    '',
  ];
  for (const p of project.paintings) {
    out.push(`# ${p.title || p.id} (${p.w}x${p.h})`);
    out.push(givePaintingCommand(project, p, { player: '@s' }));
    out.push('');
  }
  return out.join('\n');
}

/* ========================================================================= */
/* DESCRIPTIONS & README                                                     */
/* ========================================================================= */

/**
 * pack.mcmeta, in whichever shape the target version reads.
 *
 * Up to 1.21.8 that is a single `pack_format` integer plus an optional
 * `supported_formats` window. From 1.21.9 it is `min_format` / `max_format`,
 * where a bare integer max means "any minor of that major" — which is what we
 * want, so a pack keeps loading across later patch releases.
 */
export function mcmetaJSON(project, fmt, half) {
  const isData = half === 'data';
  const min = isData ? fmt.data : fmt.resource;
  const max = isData ? fmt.dataMax : fmt.resourceMax;
  const pack = { description: descriptionComponent(project, isData ? 'Data' : 'Resources') };

  if (fmt.rangeShape) {
    pack.min_format = formatValue(min, { bound: 'min' });
    pack.max_format = formatValue(fmt.declareRange ? max : min, { bound: 'max' });
  } else {
    const major = Array.isArray(min) ? min[0] : min;
    pack.pack_format = major;
    if (fmt.declareRange) {
      const maxMajor = Array.isArray(max) ? max[0] : max;
      pack.supported_formats = { min_inclusive: major, max_inclusive: Math.max(major, maxMajor) };
    }
  }
  return JSON.stringify({ pack }, null, 2) + '\n';
}

function descriptionComponent(project, half) {
  const desc = (project.description || '').trim();
  return [
    { text: project.name, color: 'white', bold: true },
    { text: `  ${half}\n`, color: 'dark_gray', bold: false },
    { text: desc.slice(0, 120) || packSummary(project), color: 'gray' },
  ];
}

/** "3 paintings · 2 discs · 1 sprite" — only the parts that exist. */
function packSummary(project) {
  const bits = [];
  const n = (list, one) => { const c = (list || []).length; if (c) bits.push(`${c} ${c === 1 ? one : one + 's'}`); };
  n(project.paintings, 'painting');
  n(project.discs, 'disc');
  n(project.mobs, 'mob variant');
  n(project.sprites, 'renamed sprite');
  return bits.join(' · ') || 'an empty pack';
}

function readmeText(project, half) {
  const ns = project.namespace;
  const v = getVersion(project.mcVersion);
  const L = [];
  L.push(project.name);
  L.push('='.repeat(project.name.length));
  L.push('');
  L.push(project.description || '');
  if (project.author) L.push(`By ${project.author}`);
  L.push('');
  L.push(`This is the ${half === 'data' ? 'DATA PACK' : 'RESOURCE PACK'} half.`);
  L.push('Custom paintings and music discs need both halves installed together;');
  L.push('with only one, nothing shows up in game.');
  L.push('');
  L.push(`Built for Minecraft ${v.label}   (namespace: ${ns})`);
  L.push('');
  if (half === 'data') {
    L.push('INSTALL');
    L.push('  Single player : drag this zip into  <world folder>/datapacks/');
    L.push('  Server        : drag this zip into  world/datapacks/');
    L.push('  Then run  /reload  (or rejoin the world).');
  } else {
    L.push('INSTALL');
    L.push('  Drag this zip into  .minecraft/resourcepacks/');
    L.push('  Then enable it in  Options -> Resource Packs.');
  }
  L.push('');
  if (project.paintings.length) {
    L.push(`PAINTINGS (${project.paintings.length})`);
    for (const p of project.paintings) L.push(`  ${p.w}x${p.h}  ${ns}:${p.id}   ${p.title || ''}`);
    L.push('');
    L.push('  Place a blank painting on a wall with enough room and any of these');
    L.push('  can appear, or use  /function ' + ns + ':give_paintings  for a specific one.');
    L.push('');
  }
  if (project.discs.length) {
    L.push(`MUSIC DISCS (${project.discs.length})`);
    for (const d of project.discs) {
      const len = Math.round(audioClipLength(d.audio));
      L.push(`  ${String(Math.floor(len / 60))}:${String(len % 60).padStart(2, '0')}  ${ns}:${d.id}   ${d.name}`);
    }
    L.push('');
    L.push('  Get them with  /function ' + ns + ':give_discs');
    L.push('');
  }
  if ((project.sprites || []).length) {
    L.push(`RENAMED SPRITES (${project.sprites.length})`);
    for (const sp of project.sprites) {
      L.push(`  ${sp.baseItem} named "${sp.matchName}"  ->  ${ns}:item/${sp.id}`);
    }
    L.push('');
    L.push('  Name any of those items in an anvil, exactly as written above, and');
    L.push('  it wears this pack\'s texture. Anything else keeps the vanilla one.');
    L.push('  This does mean the pack takes over  assets/minecraft/items/<item>.json');
    L.push('  for each item listed, so another pack that edits the same item and');
    L.push('  loads above this one will win.');
    L.push('');
  }
  L.push('Made with Frame & Groove.');
  return L.join('\n') + '\n';
}

/* ========================================================================= */
/* TOP LEVEL                                                                 */
/* ========================================================================= */

export async function buildAll(project, { getAudio, onProgress } = {}) {
  onProgress?.('Writing registry entries…');
  const data = buildDataPackFiles(project);
  onProgress?.('Rendering artwork…');
  const resource = await buildResourcePackFiles(project, { getAudio });

  /* pack.png for both halves */
  const iconBytes = await packIconBytes(project);
  if (iconBytes) { data.set('pack.png', iconBytes); resource.set('pack.png', iconBytes); }

  /* the editable project, tucked where Minecraft will ignore it */
  if (project.settings?.embedProjectData) {
    const json = JSON.stringify(projectToJSON(project));
    data.set(PROJECT_FILE, json);
  }
  return { data, resource, warnings: lastLootWarnings };
}

/* ---- Pack icon ----------------------------------------------------------
   Until somebody draws one, pack.png is a contact sheet of what is actually
   in the pack: every painting, disc, mob and renamed sprite, laid out on a
   grid. One thing fills the square; a dozen tile it. It is a far better
   answer than the first painting, because the first painting says nothing
   about the eleven other things installing this pack will add.               */

const ICON_SIZE = 64;
const ICON_MAX_TILES = 16;

/** A canvas holding one RGBA buffer, at its own size. */
function canvasOf(data, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  return c;
}

/** The head of a mob variant, cropped out of its sheet. */
function mobHeadCanvas(variant, mob, bytes, doc) {
  const head = Object.values(mob.model.parts)[0]?.cubes?.[0];
  if (!head) return null;
  const src = canvasOf(bytes, doc.w, doc.h);
  const k = doc.w / mob.texture[0];              // texels per model pixel
  const [u, v] = head.uv;
  const [hw, hh, hd] = head.size;
  const c = document.createElement('canvas');
  c.width = Math.round(hw * k); c.height = Math.round(hh * k);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, (u + hd) * k, (v + hd) * k, hw * k, hh * k, 0, 0, c.width, c.height);
  return c;
}

/**
 * One canvas per thing in the pack, interleaved by kind so a pack of eleven
 * paintings and one mob still shows the mob.
 */
async function packIconTiles(project) {
  const { composePainting } = await import('../paint/compose.js');
  const { flattenDoc } = await import('../mob/export.js');
  const { flattenSprite } = await import('../sprite/export.js');

  const groups = [];
  const paintings = [];
  for (const p of project.paintings || []) {
    const { data, w, h } = composePainting(p);
    paintings.push(canvasOf(data, w, h));
  }
  if (paintings.length) groups.push(paintings);

  const discs = (project.discs || []).map(d => canvasOf(spriteBytes(d, 16), 16, 16));
  if (discs.length) groups.push(discs);

  const sprites = [];
  for (const sp of project.sprites || []) {
    if (!sp.doc) continue;
    sprites.push(canvasOf(flattenSprite(sp.doc), sp.doc.w, sp.doc.h));
  }
  if (sprites.length) groups.push(sprites);

  const mobs = [];
  for (const variant of project.mobs || []) {
    const mob = MOBS[variant.mob];
    const entry = variant.slots?.adult?.[mob?.assetSet?.[0] || 'default'];
    if (!mob || !entry?.doc) continue;
    const c = mobHeadCanvas(variant, mob, flattenDoc(entry.doc), entry.doc);
    if (c) mobs.push(c);
  }
  if (mobs.length) groups.push(mobs);

  const out = [];
  for (let round = 0; out.length < ICON_MAX_TILES; round++) {
    let took = false;
    for (const g of groups) {
      if (round >= g.length) continue;
      out.push(g[round]);
      took = true;
      if (out.length >= ICON_MAX_TILES) break;
    }
    if (!took) break;
  }
  return out;
}

/** Fit one tile inside a cell — whole-number scaling wherever it fits. */
function drawTile(g, tile, x, y, cell) {
  const fit = Math.min(cell / tile.width, cell / tile.height);
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  const w = Math.max(1, Math.round(tile.width * scale));
  const h = Math.max(1, Math.round(tile.height * scale));
  g.imageSmoothingEnabled = scale < 1;
  g.imageSmoothingQuality = 'high';
  g.drawImage(tile, Math.round(x + (cell - w) / 2), Math.round(y + (cell - h) / 2), w, h);
}

/**
 * The grid a given number of tiles wants — as square as it can be, with no
 * empty row left over: six things go three across and two down, not three by
 * three with a third of the icon blank.
 */
function iconGrid(n) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.ceil(n / cols) };
}

/** Pack icon: the drawn one if there is one, else a contact sheet of the pack. */
export async function packIconBytes(project) {
  if (project.icon?.data) {
    const c = toPackIcon(project.icon.data, project.icon.w, project.icon.h, ICON_SIZE);
    return new Uint8Array(await (await canvasToBlob(c)).arrayBuffer());
  }

  const tiles = await packIconTiles(project);
  if (!tiles.length) return null;

  const c = document.createElement('canvas');
  c.width = ICON_SIZE; c.height = ICON_SIZE;
  const g = c.getContext('2d');
  const { cols, rows } = iconGrid(tiles.length);
  const cell = Math.min(ICON_SIZE / cols, ICON_SIZE / rows);
  const top = (ICON_SIZE - cell * rows) / 2;
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(cols, tiles.length - row * cols);
    // A short last row is centred rather than left-aligned against a gap.
    const left = (ICON_SIZE - cell * inRow) / 2;
    for (let i = 0; i < inRow; i++) {
      drawTile(g, tiles[row * cols + i], left + i * cell, top + row * cell, cell);
    }
  }
  return new Uint8Array(await (await canvasToBlob(c)).arrayBuffer());
}

/** Suggested file names. */
export function packFileNames(project) {
  const base = (project.namespace || 'pack').replace(/[^a-z0-9_.-]/g, '');
  return {
    data:     `${base}_datapack.zip`,
    resource: `${base}_resourcepack.zip`,
    bundle:   `${base}_pack.zip`,
  };
}
