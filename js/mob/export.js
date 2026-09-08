/* ============================================================================
   Turning a variant into files.

   The one detail worth stating plainly, because both wiki pages I checked got
   it wrong: `asset_id` does NOT include the `textures/` segment. Vanilla's own
   cow reads

       "asset_id": "minecraft:entity/cow/cow_temperate"

   and the game expands that to
   `assets/minecraft/textures/entity/cow/cow_temperate.png`. Writing
   "minecraft:textures/entity/..." there sends it hunting for
   `textures/textures/...` and the mob renders as the missing-texture check.
   ========================================================================= */

import { bytesToPNG } from '../paint/compose.js';
import { flatten } from '../paint/render.js';

/**
 * Flatten a variant's texture doc to RGBA bytes.
 *
 * This is the editor's own compositor, not a second one: a mob texture is an
 * ordinary layered document, and its layers carry blend modes like any other.
 * A private copy here once ignored them, so Multiply looked right on the flat
 * sheet and wrong on the model — and, worse, exported wrong.
 */
export const flattenDoc = doc => flatten(doc);

/**
 * Where a variant's texture lives inside the resource pack, relative to
 * `assets/<namespace>/`. Wolves get one file per state; everything else gets
 * one per age.
 */
export function mobTexturePath(variant, kind, slot) {
  return `textures/${mobTextureName(variant, kind, slot)}.png`;
}

/** The same path, minus `textures/` and the extension — this is the asset id. */
export function mobTextureName(variant, kind, slot) {
  const baby = kind === 'baby' ? '_baby' : '';
  const state = slot && slot !== 'default' ? `_${slot}` : '';
  return `entity/${variant.mob}/${variant.id}${state}${baby}`;
}

export const mobAssetId = (ns, variant, kind, slot) =>
  `${ns}:${mobTextureName(variant, kind, slot)}`;

/** The finished PNG for one texture slot, or null if the slot is empty. */
export async function mobTexturePNG(variant, mob, kind, slot) {
  const entry = variant.slots?.[kind]?.[slot];
  if (!entry?.doc) return null;
  const bytes = flattenDoc(entry.doc);
  return bytesToPNG(bytes, entry.doc.w, entry.doc.h);
}

/** True when every pixel is transparent — worth warning about before export. */
export function docIsBlank(doc) {
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (let i = 3; i < layer.data.length; i += 4) if (layer.data[i] > 0) return false;
  }
  return true;
}

/* ---- Custom sounds ------------------------------------------------------ */
/*
   A variant can carry its own audio. The event id, the file inside the
   resource pack and the sounds.json key all derive from these two helpers, so
   the registry entry, the sound definition and the .ogg can never drift apart.
*/

/** The sounds.json key (and the id half of the event) for one clip. */
export const mobSoundEvent = (variantId, group, field) =>
  `mob.${variantId}.${group}.${field}`;

/** Where the clip's .ogg lives, relative to `assets/<namespace>/sounds/`. */
export const mobSoundPath = (variantId, group, field) =>
  `mob/${variantId}/${group}_${field}`;

/**
 * The /summon line for one variant. Handy for testing without waiting for the
 * right biome to generate.
 */
export function summonCommand(project, variant, { includeSlash = false } = {}) {
  const id = `${project.namespace}:${variant.id}`;
  return `${includeSlash ? '/' : ''}summon minecraft:${variant.mob} ~ ~ ~ {variant:"${id}"}`;
}
