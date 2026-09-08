/* ============================================================================
   The items a renamed sprite can be built on.

   Not every item can be retextured from one picture. A block item is a cube
   with six faces and its own model; a bow has four models and a predicate; a
   potion is two layers with a tint. What this feature needs is the plain case:
   an item whose whole appearance is one flat 16 × 16 sprite, drawn by
   `item/generated` (in the inventory and flat in the hand) or `item/handheld`
   (tilted, the way a sword is held).

   assets/itemdata/items.json is the list of exactly those, read out of the
   game's own assets rather than typed by hand: every entry is an item whose
   `items/<id>.json` is a bare model pointing at a `models/item/<name>.json`
   with one of those two parents and a single `layer0` texture — and whose
   texture the bundled set actually carries, so the picker can show it.
   ========================================================================= */

let catalogue = null;
let loading = null;

/** Load the list once. Safe to call from anywhere; later calls reuse it. */
export function loadItems() {
  if (catalogue) return Promise.resolve(catalogue);
  if (loading) return loading;
  loading = fetch('assets/itemdata/items.json', { cache: 'force-cache' })
    .then(r => r.json())
    .then(doc => {
      catalogue = {
        meta: { source: doc.source || '', note: doc.note || '' },
        items: (doc.items || []).map(i => ({
          id: i.id,
          name: i.name || i.id,
          /** The vanilla sprite's file name, which is not always the item's. */
          tex: i.tex || i.id,
          /** item/handheld rather than item/generated — swords, tools, rods. */
          hand: !!i.hand,
          /** The vanilla model this item points at, when it is not `id`. */
          model: i.model || i.id,
          since: i.since || null,
        })),
      };
      catalogue.byId = new Map(catalogue.items.map(i => [i.id, i]));
      return catalogue;
    })
    .catch(() => {
      // A missing catalogue must not take the view down with it.
      catalogue = { meta: {}, items: [], byId: new Map() };
      return catalogue;
    });
  return loading;
}

export const itemsLoaded = () => !!catalogue;
export const allItems = () => catalogue?.items || [];
export const itemById = id => catalogue?.byId.get(id) || null;

/** The vanilla texture path for an item, as the bundled set names it. */
export const itemTextureName = item => `item/${item?.tex || item?.id || ''}`;

/** The model parent a sprite for this item has to use to hang right in hand. */
export const itemParent = item => (item?.hand ? 'minecraft:item/handheld' : 'minecraft:item/generated');

/**
 * Search the catalogue. Matches the id and the English name, and ranks a
 * prefix hit above a hit in the middle so "sword" leads with the swords.
 */
export function searchItems(query, { limit = 400 } = {}) {
  const q = query.trim().toLowerCase().replace(/\s+/g, '_');
  const list = allItems();
  if (!q) return list.slice(0, limit);
  const out = [];
  for (const item of list) {
    const id = item.id, name = item.name.toLowerCase().replace(/\s+/g, '_');
    const at = id.indexOf(q) < 0 ? name.indexOf(q) : id.indexOf(q);
    if (at < 0) continue;
    out.push({ item, rank: at === 0 ? 0 : 1, at });
  }
  out.sort((a, b) => a.rank - b.rank || a.at - b.at || a.item.id.localeCompare(b.item.id));
  return out.slice(0, limit).map(o => o.item);
}
