/* ============================================================================
   Game data — read from the copy of Minecraft you already own.

   Textures come from the bundled pack (core/texturepack.js) and need no setup
   at all. This module exists for the two things a texture pack cannot supply:

     • The exact pack format numbers your game accepts, straight out of the
       jar's version.json. That beats any table baked in here, and it cannot go
       stale — it works for snapshots this app has never heard of.
     • Vanilla loot tables. Putting a disc in creeper drops or a dungeon chest
       means rewriting a vanilla table, and the only way to do that without
       guessing at its contents is to start from the real one.

   Entirely optional: skip it and everything except those two features works.
   Nothing is uploaded. The jar is read in this tab and only the few small JSON
   files listed below are kept.
   ========================================================================= */

import { unzip } from '../export/zip.js';
import { Cache, Prefs } from './db.js';
import { setLinkedVersion } from './versions.js';
import { bus } from './store.js';

const DATA_KEY = 'game-data-v2';
const META_KEY = 'game-data-meta-v2';

/* Just the vanilla data the loot features need. A client jar holds tens of
   thousands of entries; filtering before the inflate keeps this near-instant. */
const WANTED = [
  /^data\/minecraft\/loot_table\/entities\/creeper\.json$/,
  /^data\/minecraft\/loot_table\/chests\/.+\.json$/,
  /^data\/minecraft\/tags\/item\/creeper_drop_music_discs\.json$/,
];

const state = { ready: false, data: new Map(), meta: null };
export const gameAssets = state;

const dataName = path => path.replace(/^data\/minecraft\//, '').replace(/\.json$/, '');

/* ========================================================================= */
/* LINKING                                                                   */
/* ========================================================================= */

/**
 * @param {File} file a Minecraft client .jar
 * @param {(msg:string, pct:number)=>void} onProgress
 */
export async function linkJar(file, onProgress = () => {}) {
  onProgress('Opening the jar…', 0.05);
  const files = await unzip(file, {
    filter: path => path === 'version.json' || WANTED.some(re => re.test(path)),
    onProgress: pct => onProgress('Reading game data…', 0.1 + pct * 0.7),
  });

  onProgress('Sorting…', 0.85);
  const decoder = new TextDecoder();
  const picked = {};
  for (const [path, bytes] of files) {
    if (!WANTED.some(re => re.test(path))) continue;
    try { picked[dataName(path)] = JSON.parse(decoder.decode(bytes)); } catch { /* skip */ }
  }

  const version = readVersionJson(files, file.name);
  if (!Object.keys(picked).length && !version.packVersion) {
    throw new Error('That does not look like a Minecraft client jar. Pick one from your versions folder — not a mod, and not a server jar.');
  }

  const meta = { name: file.name, count: Object.keys(picked).length, at: Date.now(), ...version };
  await Cache.set(DATA_KEY, picked);
  await Prefs.set(META_KEY, meta);

  state.data = new Map(Object.entries(picked));
  state.meta = meta;
  state.ready = true;
  setLinkedVersion(meta);
  onProgress('Done', 1);
  bus.emit('assets:changed', meta);
  return meta;
}

/** Restore a previously linked jar. Called once at boot. */
export async function loadCachedAssets() {
  try {
    const meta = await Prefs.get(META_KEY, null);
    if (!meta) return null;
    const picked = await Cache.get(DATA_KEY);
    state.data = new Map(Object.entries(picked || {}));
    state.meta = meta;
    state.ready = true;
    setLinkedVersion(meta);
    bus.emit('assets:changed', meta);
    return meta;
  } catch (e) {
    console.warn('[game data] could not restore', e);
    return null;
  }
}

export async function unlinkAssets() {
  await Cache.remove(DATA_KEY);
  await Prefs.remove(META_KEY);
  state.data = new Map();
  state.meta = null;
  state.ready = false;
  setLinkedVersion(null);
  bus.emit('assets:changed', null);
}

/**
 * Every client jar carries a version.json stating the pack formats the game
 * accepts:
 *   "pack_version": { "resource_major": 88, "resource_minor": 0,
 *                     "data_major": 107,   "data_minor": 1 }
 * That is the authority, and it is why linking is worth offering at all.
 */
function readVersionJson(files, filename) {
  const fallback = { version: filename.replace(/\.jar$/i, '').trim(), packVersion: null };
  try {
    const vj = files.get('version.json');
    if (!vj) return fallback;
    const j = JSON.parse(new TextDecoder().decode(vj));
    const pv = j.pack_version || {};
    const has = Number.isFinite(pv.resource_major) && Number.isFinite(pv.data_major);
    return {
      version: j.name || j.id || fallback.version,
      versionId: j.id || null,
      stable: j.stable !== false,
      packVersion: has ? {
        resource: [pv.resource_major, pv.resource_minor || 0],
        data: [pv.data_major, pv.data_minor || 0],
      } : null,
    };
  } catch { return fallback; }
}

/* ========================================================================= */
/* ACCESS                                                                    */
/* ========================================================================= */

export const hasAssets = () => state.ready;
export const assetMeta = () => state.meta;

/** A vanilla data file, e.g. 'loot_table/entities/creeper'. */
export function gameData(name) {
  const v = state.data.get(name);
  return v ? structuredClone(v) : null;
}
export const hasGameData = name => state.data.has(name);
export const listGameData = prefix => [...state.data.keys()].filter(k => k.startsWith(prefix)).sort();

export const JAR_PATHS = {
  mac: '~/Library/Application Support/minecraft/versions/<version>/<version>.jar',
  win: '%APPDATA%\\.minecraft\\versions\\<version>\\<version>.jar',
  linux: '~/.minecraft/versions/<version>/<version>.jar',
};
