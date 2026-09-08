/* ============================================================================
   What Minecraft will actually accept.

   Mob variants are not a general "reskin any mob" system: the game only reads
   variant registries for the handful of mobs listed here, and each one has its
   own shape. Everything below was read out of the 26.2 client's own data pack
   rather than from a wiki, because the two disagreed on the single most
   important field — `asset_id` carries no `textures/` prefix, and `model` is
   simply absent for the normal model rather than set to "normal".
   ========================================================================= */

import { MOB_MODELS, BABY_MODELS, MODEL_MESHES } from './models.js';

/** Sound-variant field sets, verbatim from the vanilla registries. */
const SOUNDS = {
  cow: { split: false, fields: ['ambient_sound', 'death_sound', 'hurt_sound', 'step_sound'] },
  pig: { split: true, fields: ['ambient_sound', 'death_sound', 'eat_sound', 'hurt_sound', 'step_sound'] },
  chicken: { split: true, fields: ['ambient_sound', 'death_sound', 'hurt_sound', 'step_sound'] },
  wolf: {
    split: true,
    fields: ['ambient_sound', 'death_sound', 'growl_sound', 'hurt_sound',
             'pant_sound', 'step_sound', 'whine_sound'],
  },
  cat: {
    split: true,
    fields: ['ambient_sound', 'beg_for_food_sound', 'death_sound', 'eat_sound',
             'hiss_sound', 'hurt_sound', 'purr_sound', 'purreow_sound', 'stray_ambient_sound'],
  },
};

export const MOBS = {
  cow: {
    id: 'cow', label: 'Cow', registry: 'cow_variant', since: '1.21.5',
    texture: [64, 64], model: MOB_MODELS.cow,
    baby: true, babyTexture: BABY_MODELS.cow.texture, babyModel: BABY_MODELS.cow,
    models: ['normal', 'cold', 'warm'],
    sounds: SOUNDS.cow, soundRegistry: 'cow_sound_variant', soundSince: '26.1',
    vanilla: ['temperate', 'cold', 'warm'],
    bases: ['cow_temperate', 'cow_cold', 'cow_warm', 'mooshroom_red', 'mooshroom_brown'],
    facts: { health: 10, spawnEggs: true,
      note: 'Cold and warm cows use different models, not just different skins.' },
  },
  pig: {
    id: 'pig', label: 'Pig', registry: 'pig_variant', since: '1.21.5',
    texture: [64, 64], model: MOB_MODELS.pig,
    baby: true, babyTexture: BABY_MODELS.pig.texture, babyModel: BABY_MODELS.pig,
    models: ['normal', 'cold'],
    sounds: SOUNDS.pig, soundRegistry: 'pig_sound_variant', soundSince: '26.1',
    vanilla: ['temperate', 'cold', 'warm'],
    bases: ['pig_temperate', 'pig_cold', 'pig_warm'],
    facts: { health: 10, note: 'The warm pig reuses the normal model; only the cold one differs.' },
  },
  chicken: {
    id: 'chicken', label: 'Chicken', registry: 'chicken_variant', since: '1.21.5',
    texture: [64, 32], model: MOB_MODELS.chicken,
    baby: true, babyTexture: BABY_MODELS.chicken.texture, babyModel: BABY_MODELS.chicken,
    models: ['normal', 'cold'],
    sounds: SOUNDS.chicken, soundRegistry: 'chicken_sound_variant', soundSince: '26.1',
    vanilla: ['temperate', 'cold', 'warm'],
    bases: ['chicken_temperate', 'chicken_cold', 'chicken_warm'],
    facts: { health: 4, note: 'The baby chicken is a 16 × 16 sheet — the smallest in the game.' },
  },
  frog: {
    id: 'frog', label: 'Frog', registry: 'frog_variant', since: '1.21.5',
    texture: [48, 48], model: MOB_MODELS.frog,
    baby: false, models: null,
    sounds: null,
    vanilla: ['temperate', 'cold', 'warm'],
    bases: ['frog_temperate', 'frog_cold', 'frog_warm'],
    facts: { health: 10,
      note: 'Frogs have no baby variant — tadpoles are a separate entity with their own texture.' },
  },
  wolf: {
    id: 'wolf', label: 'Wolf', registry: 'wolf_variant', since: '1.20.5',
    texture: [64, 32], model: MOB_MODELS.wolf,
    baby: true, babyTexture: BABY_MODELS.wolf.texture, babyModel: BABY_MODELS.wolf,
    models: null,
    /* The wolf is the only mob that needs three textures per age: the game
       swaps them as it is tamed and as it gets angry. */
    assetSet: ['wild', 'tame', 'angry'],
    /* wolf_sound_variant existed from 1.21.5, but 26.1 restructured it into
       adult_sounds/baby_sounds — the shape written here — so 26.1 is the
       honest floor rather than 1.21.5. */
    sounds: SOUNDS.wolf, soundRegistry: 'wolf_sound_variant', soundSince: '26.1',
    vanilla: ['pale', 'ashen', 'black', 'chestnut', 'rusty', 'snowy', 'spotted', 'striped', 'woods'],
    bases: ['wolf', 'wolf_ashen', 'wolf_black', 'wolf_chestnut', 'wolf_rusty',
            'wolf_snowy', 'wolf_spotted', 'wolf_striped', 'wolf_woods'],
    facts: { health: 8,
      note: 'Wolf variants predate the rest — they shipped in 1.20.5, a year before the others.' },
  },
  cat: {
    id: 'cat', label: 'Cat', registry: 'cat_variant', since: '1.21.5',
    texture: [64, 32], model: MOB_MODELS.cat,
    baby: true, babyTexture: BABY_MODELS.cat.texture, babyModel: BABY_MODELS.cat,
    models: null,
    sounds: SOUNDS.cat, soundRegistry: 'cat_sound_variant', soundSince: '26.1',
    vanilla: ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico',
              'persian', 'ragdoll', 'white', 'jellie', 'all_black'],
    bases: ['cat_tabby', 'cat_black', 'cat_red', 'cat_siamese', 'cat_british_shorthair',
            'cat_calico', 'cat_persian', 'cat_ragdoll', 'cat_white', 'cat_jellie',
            'cat_all_black', 'ocelot'],
    facts: { health: 10,
      note: 'Stray cats spawn in villages; all_black only appears around a full moon or in swamp huts.' },
  },
  zombie_nautilus: {
    id: 'zombie_nautilus', label: 'Zombie nautilus', registry: 'zombie_nautilus_variant',
    since: '1.21.11',
    texture: [128, 128], model: MOB_MODELS.zombie_nautilus,
    /* The bundled sheets sit under entity/nautilus/, not entity/zombie_nautilus/. */
    textureDir: 'nautilus',
    baby: false, models: ['normal', 'warm'],
    sounds: null,
    vanilla: ['temperate', 'warm'],
    bases: ['zombie_nautilus', 'zombie_nautilus_coral'],
    facts: { health: 20,
      note: 'The newest variant registry, and the only mob here with no baby variant and a 128×128 sheet.' },
  },
};

/**
 * The mesh for one age and one named model.
 *
 * Babies have their own model, not a scaled adult — and only one of it: the
 * client ships no cold or warm baby mesh, so a calf wears the same shape
 * whichever model its variant declares, and only its skin changes.
 */
export function mobModelFor(mob, kind, model = null) {
  if (kind === 'baby' && mob.babyModel) return mob.babyModel;
  if (model && model !== 'normal') return MODEL_MESHES[mob.id]?.[model] || mob.model;
  return mob.model;
}

/** True when this mob draws a genuinely different shape for that model name. */
export const hasOwnMesh = (mob, model) =>
  !!(model && model !== 'normal' && MODEL_MESHES[mob.id]?.[model]);

/** The sheet size for one age, in pixels. */
export const mobTextureSize = (mob, kind) =>
  (kind === 'baby' && mob.babyTexture) ? mob.babyTexture : mob.texture;

/**
 * The bundled vanilla texture for one base, age and state. The pack names them
 * uniformly: `<base>[_<state>][_baby]`, so `wolf` + `tame` + baby is
 * `wolf_tame_baby`, and a temperate cow calf is `cow_temperate_baby`.
 */
export function baseTextureName(mob, base, kind = 'adult', slot = null) {
  const state = mob.assetSet && slot && slot !== mob.assetSet[0] ? `_${slot}` : '';
  return `entity/${mob.textureDir || mob.id}/${base}${state}${kind === 'baby' ? '_baby' : ''}`;
}

export const MOB_LIST = Object.values(MOBS);
export const mobById = id => MOBS[id] || null;

/** The three condition types the game understands, and nothing else. */
export const CONDITION_TYPES = [
  { id: 'none', label: 'Always', hint: 'A fallback with no condition — give it priority 0.' },
  { id: 'minecraft:biome', label: 'Biome', hint: 'Spawns where the biome matches.' },
  { id: 'minecraft:structure', label: 'Structure', hint: 'Spawns inside a structure.' },
  { id: 'minecraft:moon_brightness', label: 'Moon brightness', hint: '0 is a new moon, 1 is full.' },
];

/**
 * The variant JSON exactly as the game expects it.
 * `resolve(kind, key)` returns the asset id for a texture slot.
 */
export function variantJSON(variant, mob, resolve) {
  const out = {};
  if (mob.assetSet) {
    out.assets = {};
    for (const slot of mob.assetSet) out.assets[slot] = resolve('adult', slot);
    if (mob.baby) {
      out.baby_assets = {};
      for (const slot of mob.assetSet) out.baby_assets[slot] = resolve('baby', slot);
    }
  } else {
    out.asset_id = resolve('adult', null);
    if (mob.baby) out.baby_asset_id = resolve('baby', null);
  }
  // Vanilla omits `model` for the normal one rather than writing "normal".
  if (mob.models && variant.model && variant.model !== 'normal') out.model = variant.model;
  out.spawn_conditions = spawnConditionsJSON(variant.spawns || []);
  return out;
}

export function spawnConditionsJSON(spawns) {
  return spawns.map(s => {
    const entry = {};
    if (s.type && s.type !== 'none') {
      const cond = { type: s.type };
      if (s.type === 'minecraft:biome') {
        cond.biomes = s.values?.length === 1 ? s.values[0] : (s.values || []);
      } else if (s.type === 'minecraft:structure') {
        cond.structures = s.values?.length === 1 ? s.values[0] : (s.values || []);
      } else if (s.type === 'minecraft:moon_brightness') {
        const r = {};
        if (s.min != null) r.min = s.min;
        if (s.max != null) r.max = s.max;
        cond.range = Object.keys(r).length ? r : 0;
      }
      entry.condition = cond;
    }
    entry.priority = s.priority ?? 0;
    return entry;
  });
}

/** The sound variant JSON, split into adult/baby where the registry wants it. */
export function soundVariantJSON(variant, mob) {
  const spec = mob.sounds;
  if (!spec) return null;
  const pick = bag => {
    const out = {};
    for (const f of spec.fields) {
      const v = (bag || {})[f];
      if (v) out[f] = v;
    }
    return out;
  };
  if (!spec.split) return pick(variant.sounds?.adult);
  return { adult_sounds: pick(variant.sounds?.adult), baby_sounds: pick(variant.sounds?.baby) };
}

/** Every sound field that must be filled for the file to be valid. */
export function missingSoundFields(variant, mob) {
  const spec = mob.sounds;
  if (!spec || !variant.soundsEnabled) return [];
  const gaps = [];
  const check = (bag, where) => {
    for (const f of spec.fields) if (!(bag || {})[f]) gaps.push(`${where}${f}`);
  };
  check(variant.sounds?.adult, spec.split ? 'adult · ' : '');
  if (spec.split) check(variant.sounds?.baby, 'baby · ');
  return gaps;
}
