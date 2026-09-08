/* ============================================================================
   Textures.

   The app ships its own texture set, so every preview shows real block, item
   and entity art from the first launch, with no setup and nothing to link.
   Files live under assets/textures/ exactly as they do in a resource pack:
   block/oak_planks, item/music_disc_13, painting/alban, entity/cow/cow_cold.

   Nothing here ever reaches an exported pack. These are for showing you what
   your work will look like in game; the pack you build contains your artwork
   and your audio only.
   ========================================================================= */

const ROOT = 'assets/textures';
const MANIFEST = `${ROOT}/manifest.json`;

const state = {
  ready: false,
  names: new Set(),
  meta: null,
  paintingBlocks: {},    // 'painting/alban' -> [wBlocks, hBlocks]
  canvases: new Map(),   // name -> decoded HTMLCanvasElement
  pending: new Map(),    // name -> in-flight decode promise
};

export const textures = state;

/** Read the manifest. Cheap: one small JSON, no images. */
export async function loadTexturePack() {
  if (state.ready) return state.meta;
  try {
    const res = await fetch(MANIFEST, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const m = await res.json();
    state.names = new Set(m.textures || []);
    state.paintingBlocks = m.paintingBlocks || {};
    state.meta = { source: m.source, count: m.count, note: m.note };
    state.ready = state.names.size > 0;
    return state.meta;
  } catch (e) {
    console.warn('[textures] bundled pack unavailable, falling back to generated', e);
    state.ready = false;
    return null;
  }
}

export const packReady = () => state.ready;
export const packMeta = () => state.meta;
export const hasTexture = name => state.names.has(name);
/**
 * An absolute URL. It must be absolute: these get written into CSS custom
 * properties, and a relative url() inside a custom property resolves against
 * the *stylesheet* that uses it, not the document — which would send every
 * lookup hunting under css/.
 */
export const textureURL = name =>
  (state.names.has(name) ? new URL(`${ROOT}/${name}.png`, document.baseURI).href : null);

export function listTextures(prefix = '') {
  const out = [];
  for (const n of state.names) if (n.startsWith(prefix)) out.push(n);
  return out.sort();
}

/** Decoded canvas, or null if it is not loaded yet. Never blocks. */
export const textureCanvasSync = name => state.canvases.get(name) || null;

/** Decode one texture into a canvas, caching both the result and the promise
 *  so a hundred callers asking at once still only fetch it once. */
export function decodeTexture(name) {
  if (state.canvases.has(name)) return Promise.resolve(state.canvases.get(name));
  if (state.pending.has(name)) return state.pending.get(name);
  if (!state.names.has(name)) return Promise.resolve(null);

  const p = (async () => {
    try {
      const res = await fetch(`${ROOT}/${name}.png`, { cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const bmp = await createImageBitmap(await res.blob());
      const c = document.createElement('canvas');
      // A tall strip is an animation; take the first frame, which is the
      // square at the top.
      const frame = bmp.height > bmp.width && bmp.height % bmp.width === 0 ? bmp.width : bmp.height;
      c.width = bmp.width; c.height = frame;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = false;
      g.drawImage(bmp, 0, 0, bmp.width, frame, 0, 0, bmp.width, frame);
      bmp.close?.();
      state.canvases.set(name, c);
      return c;
    } catch (e) {
      console.warn('[textures] could not decode', name, e);
      return null;
    } finally {
      state.pending.delete(name);
    }
  })();
  state.pending.set(name, p);
  return p;
}

/** Warm a set so synchronous drawing can rely on them being there. */
export async function preload(names) {
  const got = await Promise.all(names.map(n => decodeTexture(n)));
  return names.filter((_, i) => got[i]);
}

/**
 * Every vanilla painting the pack ships, with its size in blocks.
 * The size comes from the manifest rather than from decoding all thirty-odd
 * images just to populate a picker.
 */
export function vanillaPaintings() {
  const out = [];
  for (const n of state.names) {
    if (!n.startsWith('painting/')) continue;
    const [w, h] = state.paintingBlocks[n] || [1, 1];
    out.push({ name: n, id: n.slice('painting/'.length), w, h });
  }
  return out.sort((a, b) => (a.w * a.h) - (b.w * b.h) || a.id.localeCompare(b.id));
}

/** Every music disc the bundled pack ships. */
export function vanillaDiscIds() {
  const ids = [];
  for (const n of state.names) {
    const m = n.match(/^item\/(music_disc_[a-z0-9_]+)$/);
    if (m) ids.push(m[1]);
  }
  return ids.sort();
}

/** The textures the app draws synchronously and so must have decoded up front. */
export const CORE_TEXTURES = [
  'block/oak_planks', 'block/dark_oak_planks', 'block/spruce_planks', 'block/birch_planks',
  'block/stone', 'block/cobblestone', 'block/deepslate', 'block/dirt',
  'block/grass_block_top', 'block/grass_block_side', 'block/grass_block_side_overlay',
  'block/jukebox_side', 'block/jukebox_top',
  'block/note_block', 'block/oxidized_copper',
  /* The empty-state chest is drawn from the real chest entity sheet rather
     than from planks and a hand-drawn latch. */
  'entity/chest/normal',
];

/** Warm the core blocks and every music disc. Around thirty 16×16 PNGs — far
 *  cheaper than the first frame that would otherwise draw a blank tile. */
export async function preloadCore() {
  await preload([...CORE_TEXTURES, ...vanillaDiscIds().map(id => `item/${id}`)]);
}

/** Blocks offered as painting backdrops — anything flat and wall-like. */
export const WALL_CANDIDATES = [
  'block/oak_planks', 'block/spruce_planks', 'block/birch_planks', 'block/jungle_planks',
  'block/acacia_planks', 'block/dark_oak_planks', 'block/mangrove_planks', 'block/cherry_planks',
  'block/bamboo_planks', 'block/crimson_planks', 'block/warped_planks', 'block/pale_oak_planks',
  'block/stone', 'block/stone_bricks', 'block/cobblestone', 'block/mossy_cobblestone',
  'block/deepslate', 'block/deepslate_bricks', 'block/deepslate_tiles', 'block/polished_deepslate',
  'block/andesite', 'block/diorite', 'block/granite', 'block/calcite', 'block/tuff',
  'block/sandstone', 'block/red_sandstone', 'block/quartz_block_side', 'block/prismarine_bricks',
  'block/dark_prismarine', 'block/purpur_block', 'block/end_stone_bricks', 'block/nether_bricks',
  'block/blackstone', 'block/polished_blackstone_bricks', 'block/bookshelf', 'block/white_wool',
  'block/light_gray_concrete', 'block/copper_block', 'block/oxidized_copper', 'block/iron_block',
];
