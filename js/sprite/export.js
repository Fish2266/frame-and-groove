/* ============================================================================
   Renamed sprites — how a name on an item turns into a texture.

   Since the item model rewrite, an item's appearance is chosen by
   `assets/<namespace>/items/<item>.json`, and that file can branch. The branch
   used here is:

       {
         "model": {
           "type": "minecraft:select",
           "property": "minecraft:component",
           "component": "minecraft:custom_name",
           "cases": [ { "when": "Flame", "model": { … } } ],
           "fallback": { "type": "minecraft:model",
                         "model": "minecraft:item/stone_sword" }
         }
       }

   Read out of the 26.2 client rather than a wiki:
     • `minecraft:component` is a registered select property
       (SelectItemModelProperties, alongside custom_model_data and the rest),
       backed by ComponentContents.
     • The case value is decoded with the component's own codec and compared
       with equals(), so a bare string "Flame" decodes to the same literal text
       component an anvil writes — AnvilMenu sets CUSTOM_NAME to
       Component.literal(name), with no style and a 50-character limit.

   Two consequences worth stating, because they decide the file layout:
     1. The branch lives on the *vanilla* item, so the file goes in the
        `minecraft` namespace and every sprite built on the same base item has
        to share one file. They are merged here rather than written per sprite.
     2. The fallback is what an unnamed item falls back to, so it has to be the
        vanilla model — otherwise the pack quietly retextures every stone sword
        in the world instead of only the ones called Flame.
   ========================================================================= */

import { flatten } from '../paint/render.js';
import { bytesToPNG } from '../paint/compose.js';

/** Flatten a sprite's document, blend modes and all. */
export const flattenSprite = doc => flatten(doc);

/** Where the artwork lands, relative to `assets/<ns>/`. */
export const spriteTexturePath = sprite => `textures/item/${sprite.id}.png`;
export const spriteModelPath   = sprite => `models/item/${sprite.id}.json`;

/** The model file one sprite needs — a flat sprite, hung like its base item. */
export const spriteModelJSON = (ns, sprite, item) => ({
  parent: item?.hand ? 'minecraft:item/handheld' : 'minecraft:item/generated',
  textures: { layer0: `${ns}:item/${sprite.id}` },
});

/** The finished PNG, or null when the sprite has no document yet. */
export async function spritePNG(sprite) {
  if (!sprite?.doc) return null;
  return bytesToPNG(flattenSprite(sprite.doc), sprite.doc.w, sprite.doc.h);
}

/**
 * Every `items/<base>.json` this project needs, keyed by path inside the
 * resource pack. Sprites sharing a base item merge into one file, in the order
 * they appear in the project, and a base item with no sprites is not written
 * at all — an untouched vanilla item is better left alone.
 *
 * @param {object[]} sprites  the project's sprites, already filtered to valid ones
 * @param {(id:string) => object|null} lookup  the item catalogue
 */
export function namedItemFiles(ns, sprites, lookup) {
  const byBase = new Map();
  for (const s of sprites) {
    if (!s.baseItem || !s.matchName?.trim()) continue;
    if (!byBase.has(s.baseItem)) byBase.set(s.baseItem, []);
    byBase.get(s.baseItem).push(s);
  }

  const files = new Map();
  for (const [base, list] of byBase) {
    const item = lookup(base);
    const cases = [];
    const seen = new Set();
    for (const s of list) {
      const when = s.matchName.trim();
      // The game reads the first matching case; a repeat would never be hit.
      if (seen.has(when)) continue;
      seen.add(when);
      cases.push({ when, model: { type: 'minecraft:model', model: `${ns}:item/${s.id}` } });
    }
    if (!cases.length) continue;
    files.set(`assets/minecraft/items/${base}.json`, {
      model: {
        type: 'minecraft:select',
        property: 'minecraft:component',
        component: 'minecraft:custom_name',
        cases,
        fallback: { type: 'minecraft:model', model: `minecraft:item/${item?.model || base}` },
      },
    });
  }
  return files;
}

/** Base items this project takes over, for warnings and the readme. */
export const spriteBaseItems = sprites =>
  [...new Set(sprites.filter(s => s.baseItem).map(s => s.baseItem))];

/**
 * The /give line that hands over an item already wearing the name.
 *
 * From 1.21.5 a text component in a command is plain NBT, so the name is
 * written directly; before that the component argument wanted a JSON string,
 * which is the quoted form.
 */
export function giveSpriteCommand(sprite, { player = '@s', includeSlash = false, modern = true } = {}) {
  const name = sprite.matchName?.trim() || '';
  const value = modern
    ? `"${escapeSNBT(name)}"`
    : `'${JSON.stringify(name).replace(/'/g, "\\'")}'`;
  return `${includeSlash ? '/' : ''}give ${player} minecraft:${sprite.baseItem}[minecraft:custom_name=${value}] 1`;
}

const escapeSNBT = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** True when every pixel is transparent — worth warning about before export. */
export function spriteIsBlank(doc) {
  if (!doc) return true;
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (let i = 3; i < layer.data.length; i += 4) if (layer.data[i] > 0) return false;
  }
  return true;
}
