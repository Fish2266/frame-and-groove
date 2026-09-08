/* ============================================================================
   Loot tables — how a disc is found rather than given.

   Three routes, and they are not equally safe, so the app says which is which:

     • Standalone — a table of your own at data/<ns>/loot_table/<id>. Nothing
       vanilla is touched. Use it with /loot, or from your own map's triggers.

     • Creeper drop — the real behaviour, where a creeper killed by a skeleton
       drops a disc. This one has to REPLACE minecraft's own creeper table,
       because vanilla offers no way to add to it. The replacement is built
       from the real table read out of your linked jar, so it reproduces
       vanilla exactly and then adds yours — but two packs that both replace
       it will still conflict, and the app says so.

     • Chest loot — same trade-off, for structure chests.

   Everything is emitted with minecraft:set_components, so a found disc carries
   the same sprite and song overrides the /give command uses.
   ========================================================================= */

import { getVersion, FEATURES, registryDir } from '../core/versions.js';
import { gameData, hasGameData, listGameData } from '../core/gameassets.js';

/** Chest tables worth offering, with the ones vanilla already puts discs in
 *  listed first — those are the least surprising places to add one. */
export const CHEST_TABLES = [
  { id: 'chests/simple_dungeon',       label: 'Dungeon',            vanillaDiscs: true },
  { id: 'chests/woodland_mansion',     label: 'Woodland mansion',   vanillaDiscs: true },
  { id: 'chests/ancient_city',         label: 'Ancient city',       vanillaDiscs: true },
  { id: 'chests/stronghold_corridor',  label: 'Stronghold corridor', vanillaDiscs: true },
  { id: 'chests/abandoned_mineshaft',  label: 'Mineshaft' },
  { id: 'chests/desert_pyramid',       label: 'Desert pyramid' },
  { id: 'chests/jungle_temple',        label: 'Jungle temple' },
  { id: 'chests/buried_treasure',      label: 'Buried treasure' },
  { id: 'chests/shipwreck_treasure',   label: 'Shipwreck treasure' },
  { id: 'chests/nether_bridge',        label: 'Nether fortress' },
  { id: 'chests/bastion_treasure',     label: 'Bastion treasure' },
  { id: 'chests/end_city_treasure',    label: 'End city treasure' },
  { id: 'chests/igloo_chest',          label: 'Igloo basement' },
  { id: 'chests/pillager_outpost',     label: 'Pillager outpost' },
  { id: 'chests/village/village_temple', label: 'Village temple' },
];

/** Only offer what the linked jar can actually supply a real base table for. */
export function availableChestTables() {
  const have = new Set(listGameData('loot_table/chests'));
  return CHEST_TABLES.filter(t => have.has(`loot_table/${t.id}`));
}

export const RARITY_WEIGHTS = [
  { id: 'common',   label: 'Common',    weight: 6,  hint: 'Turns up often' },
  { id: 'uncommon', label: 'Uncommon',  weight: 3,  hint: 'A nice surprise' },
  { id: 'rare',     label: 'Rare',      weight: 1,  hint: 'Worth hunting for' },
];
export const weightFor = id => (RARITY_WEIGHTS.find(r => r.id === id) || RARITY_WEIGHTS[1]).weight;

export function createLootSettings() {
  return {
    standalone: true,
    creeper: false,
    chests: [],           // chest table ids
    rarity: 'uncommon',
  };
}

/* ---- The item entry ------------------------------------------------------ */
/**
 * One disc as a loot entry, carrying the same component overrides the /give
 * command uses so a found disc is identical to a given one.
 */
export function discLootEntry(project, disc, { weight } = {}) {
  const v = getVersion(project.mcVersion);
  const ns = project.namespace;
  const modern = v.features.includes(FEATURES.JUKEBOX_PLAIN_ID);
  const components = {};

  if (v.features.includes(FEATURES.ITEM_MODEL)) components['minecraft:item_model'] = `${ns}:${disc.id}`;
  components['minecraft:jukebox_playable'] = modern ? `${ns}:${disc.id}` : { song: `${ns}:${disc.id}` };
  if (disc.name?.trim()) {
    components['minecraft:item_name'] = { text: disc.name, italic: false, ...(disc.nameColor ? { color: disc.nameColor } : {}) };
  }
  if (disc.rarity && disc.rarity !== 'common') components['minecraft:rarity'] = disc.rarity;
  if (disc.glint) components['minecraft:enchantment_glint_override'] = true;

  const entry = {
    type: 'minecraft:item',
    name: `minecraft:${disc.baseItem}`,
    functions: [{ function: 'minecraft:set_components', components }],
  };
  if (weight != null) entry.weight = weight;
  return entry;
}

/* ---- Standalone ---------------------------------------------------------- */
export function standaloneTable(project, disc) {
  return {
    type: 'minecraft:generic',
    pools: [{ rolls: 1, entries: [discLootEntry(project, disc)] }],
  };
}

/* ---- Creeper ------------------------------------------------------------- */
/**
 * Vanilla's creeper table with our discs added to the pool that already drops
 * one when a skeleton lands the kill — so the odds and the trigger stay
 * exactly what a player expects, with more possible outcomes.
 * Returns null when there is no real table to build on.
 */
export function creeperTable(project, discs) {
  const base = gameData('loot_table/entities/creeper');
  if (!base || !Array.isArray(base.pools)) return null;

  // The disc pool is the one conditioned on a skeleton attacker.
  const discPool = base.pools.find(pool =>
    (pool.conditions || []).some(c =>
      c.condition === 'minecraft:entity_properties' &&
      JSON.stringify(c.predicate || {}).includes('skeleton')));

  const entries = discs.map(d => discLootEntry(project, d, { weight: 1 }));
  if (discPool) {
    discPool.entries = [...(discPool.entries || []), ...entries];
  } else {
    base.pools.push({
      rolls: 1,
      conditions: [{
        condition: 'minecraft:entity_properties',
        entity: 'attacker',
        predicate: { 'minecraft:entity_type': '#minecraft:skeletons' },
      }],
      entries,
    });
  }
  return base;
}

/* ---- Chests -------------------------------------------------------------- */
/**
 * A vanilla chest table plus one extra pool holding our discs against an
 * `empty` entry, which is what actually controls the chance.
 */
export function chestTable(project, discs, chestId, rarity = 'uncommon') {
  const base = gameData(`loot_table/${chestId}`);
  if (!base || !Array.isArray(base.pools)) return null;

  const w = weightFor(rarity);
  const entries = discs.map(d => discLootEntry(project, d, { weight: w }));
  // Weighted against nothing, so the pool has a real chance of giving nothing.
  entries.push({ type: 'minecraft:empty', weight: Math.max(1, 40 - w * discs.length) });

  base.pools.push({ rolls: 1, entries });
  return base;
}

/* ---- Build --------------------------------------------------------------- */
/**
 * Every loot file this project should emit, as path -> JSON object.
 * @returns {{ files: Map, warnings: string[] }}
 */
export function buildLootFiles(project) {
  const files = new Map();
  const warnings = [];
  const dir = registryDir(project.mcVersion, 'loot_table');
  const ns = project.namespace;

  const withLoot = project.discs.filter(d => d.loot);
  if (!withLoot.length) return { files, warnings };

  /* Standalone tables — always safe. */
  for (const d of withLoot) {
    if (d.loot.standalone) {
      files.set(`data/${ns}/${dir}/${d.id}.json`, standaloneTable(project, d));
    }
  }

  /* Creeper drops. */
  const creeperDiscs = withLoot.filter(d => d.loot.creeper);
  if (creeperDiscs.length) {
    const table = creeperTable(project, creeperDiscs);
    if (table) {
      files.set(`data/minecraft/${dir}/entities/creeper.json`, table);
      warnings.push('Creeper drops replace Minecraft’s own creeper loot table. It is rebuilt from the real one so vanilla behaviour is intact, but another pack that also replaces it will conflict.');
    } else {
      warnings.push('Creeper drops need the real vanilla loot table. Link your Minecraft under Pack Settings and the table will be built from it.');
    }
  }

  /* Chest loot. */
  const byChest = new Map();
  for (const d of withLoot) {
    for (const chestId of d.loot.chests || []) {
      if (!byChest.has(chestId)) byChest.set(chestId, []);
      byChest.get(chestId).push(d);
    }
  }
  for (const [chestId, discs] of byChest) {
    const rarity = discs[0].loot.rarity || 'uncommon';
    const table = chestTable(project, discs, chestId, rarity);
    if (table) {
      files.set(`data/minecraft/${dir}/${chestId}.json`, table);
    } else {
      warnings.push(`Chest loot for ${chestId} needs the real vanilla table. Link your Minecraft to build it.`);
    }
  }
  if (byChest.size) {
    warnings.push(`Chest loot replaces ${byChest.size === 1 ? 'a vanilla chest table' : `${byChest.size} vanilla chest tables`}. Rebuilt from the real ones, but other packs replacing the same tables will conflict.`);
  }

  return { files, warnings };
}

export { hasGameData };
