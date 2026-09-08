/* ============================================================================
   Minecraft target versions.

   Two things vary by version and both change the bytes we write:
     1. The format numbers in pack.mcmeta (data and resource differ), and
        *how* they are written — see below.
     2. Which features are legal — data-driven paintings, item_model, and the
        shape of the jukebox_playable component all landed at different times.

   Two format eras:
     • Up to 1.21.8  — a single `pack_format` integer, optionally with
       `supported_formats: {min_inclusive, max_inclusive}`.
     • From 1.21.9   — `min_format` / `max_format`, each either an integer or
       a [major, minor] pair. A bare integer means "that major, minor 0" for
       min, and "that major, any minor" for max.

   Mojang also switched to year-based names after 1.21.x: the release after
   1.21.11 is 26.1, then 26.2. Numbers here are transcribed from the wiki's
   pack format table; anything newer than the table can be entered by hand
   with the Custom target, which is the escape hatch when Mojang moves again.
   ========================================================================= */

/** Feature keys used across the app. */
export const FEATURES = {
  JUKEBOX_SONGS:      'jukeboxSongs',       // data/<ns>/jukebox_song/*.json
  PAINTING_VARIANTS:  'paintingVariants',   // data/<ns>/painting_variant/*.json
  PLACEABLE_TAG:      'placeableTag',       // #minecraft:placeable painting tag
  ITEM_MODEL:         'itemModel',          // minecraft:item_model component
  ITEMS_DEFINITIONS:  'itemsDefinitions',   // assets/<ns>/items/<id>.json
  TOOLTIP_DISPLAY:    'tooltipDisplay',     // minecraft:tooltip_display component
  JUKEBOX_PLAIN_ID:   'jukeboxPlainId',     // jukebox_playable = "ns:id"
  SINGULAR_FOLDERS:   'singularFolders',    // data/<ns>/function not /functions
  RANGE_FORMAT:       'rangeFormat',        // min_format / max_format in mcmeta
  MOB_VARIANTS:       'mobVariants',        // data/<ns>/cow_variant/*.json and friends
  MOB_SOUND_VARIANTS: 'mobSoundVariants',   // <mob>_sound_variant, 26.1+
  COMPONENT_SELECT:   'componentSelect',    // item models that branch on a component
};

const F = FEATURES;

/* Everything from 1.21.4 on shares the same capability set; spelling it once
   keeps the table below about versions rather than about repetition. */
const MODERN = [
  F.JUKEBOX_SONGS, F.PAINTING_VARIANTS, F.PLACEABLE_TAG,
  F.ITEM_MODEL, F.ITEMS_DEFINITIONS, F.SINGULAR_FOLDERS,
];
const MODERN_5 = [...MODERN, F.TOOLTIP_DISPLAY, F.JUKEBOX_PLAIN_ID, F.MOB_VARIANTS];
const MODERN_9 = [...MODERN_5, F.RANGE_FORMAT];
/* `minecraft:component` as a select property — the one that lets an item's
   name choose its model — was read out of the 26.2 client's own
   SelectItemModelProperties. Whether some earlier release already had it is
   not something this table can honestly claim, so it is granted from 26.1 on
   and no further back: a pack that quietly does nothing in game is worse than
   one that says up front it needs a newer target. */
const MODERN_26 = [...MODERN_9, F.MOB_SOUND_VARIANTS, F.COMPONENT_SELECT];

/**
 * Ordered oldest → newest.
 * `data` / `resource` are [major, minor] pairs.
 */
export const MC_VERSIONS = [
  {
    id: '1.21', label: '1.21 – 1.21.1', era: '1.21',
    data: [48, 0], resource: [34, 0], verified: true,
    features: [F.JUKEBOX_SONGS, F.SINGULAR_FOLDERS],
    note: 'Custom jukebox songs exist, but paintings still have to replace vanilla ones and discs need a replaced texture.',
  },
  {
    id: '1.21.2', label: '1.21.2 – 1.21.3', era: '1.21',
    data: [57, 0], resource: [42, 0], verified: true,
    features: [F.JUKEBOX_SONGS, F.PAINTING_VARIANTS, F.PLACEABLE_TAG, F.SINGULAR_FOLDERS],
    note: 'Paintings become data-driven here — the first version where you can add new ones without overwriting vanilla art.',
  },
  {
    id: '1.21.4', label: '1.21.4', era: '1.21',
    data: [61, 0], resource: [46, 0], verified: true,
    features: MODERN,
    note: 'The item_model component arrives. The first version where a custom disc can carry its own sprite without replacing a vanilla disc.',
  },
  {
    id: '1.21.5', label: '1.21.5', era: '1.21',
    data: [71, 0], resource: [55, 0], verified: true,
    features: MODERN_5,
    note: 'Component shapes change: jukebox_playable becomes a bare song id and show_in_tooltip moves into tooltip_display.',
  },
  {
    id: '1.21.6', label: '1.21.6', era: '1.21',
    data: [80, 0], resource: [63, 0], verified: true,
    features: MODERN_5,
  },
  {
    id: '1.21.7', label: '1.21.7 – 1.21.8', era: '1.21',
    data: [81, 0], resource: [64, 0], verified: true,
    features: MODERN_5,
  },
  {
    id: '1.21.9', label: '1.21.9 – 1.21.10', era: '1.21',
    data: [88, 0], resource: [69, 0], verified: true,
    features: MODERN_9,
    note: 'pack.mcmeta changes shape: min_format and max_format replace pack_format, and formats gain a minor number.',
  },
  {
    id: '1.21.11', label: '1.21.11', era: '1.21',
    data: [94, 1], resource: [75, 0], verified: true,
    features: MODERN_9,
  },
  {
    id: '26.1', label: '26.1 – 26.1.2', era: '26',
    data: [101, 1], resource: [84, 0], verified: true,
    features: MODERN_26,
    note: 'Version names go year-based from here: 26.1 is the release after 1.21.11.',
  },
  {
    id: '26.2', label: '26.2', era: '26',
    data: [107, 1], resource: [88, 0], verified: true,
    features: MODERN_26,
    recommended: true,
    note: 'The current release. Writes the modern min_format / max_format pack.mcmeta.',
  },
  {
    id: '26.3', label: '26.3 (snapshot)', era: '26',
    /* Read from 26.3-snapshot-8's own version.json. Snapshot numbers can move
       again before release, so this is marked unverified: link the game jar in
       Pack settings to take the exact pair from whatever build you run. */
    data: [116, 0], resource: [96, 0], verified: false,
    features: MODERN_26,
    snapshot: true,
    note: 'Numbers taken from 26.3-snapshot-8. Link your game jar to pin them to the build you actually play.',
  },
  {
    id: 'custom', label: 'Custom — set the numbers yourself', era: 'custom',
    data: [107, 1], resource: [88, 0], verified: false,
    features: MODERN_26,
    custom: true,
    note: 'For a release newer than this list, or a snapshot. Set both format numbers in Advanced — everything else behaves like the current release.',
  },
];

export const DEFAULT_VERSION = '26.2';

/* ---- The linked game -----------------------------------------------------
   A client jar states its own pack formats in version.json, which beats any
   table this file could carry: it is what the game will actually accept, and
   it works for snapshots and for releases newer than anything listed above.
   gameassets.js installs it here when a jar is linked. */
let linkedVersion = null;

export function setLinkedVersion(meta) {
  if (!meta?.packVersion) { linkedVersion = null; return null; }
  linkedVersion = {
    id: 'linked',
    label: `${meta.version} — from your game`,
    era: 'linked',
    data: meta.packVersion.data,
    resource: meta.packVersion.resource,
    verified: true,
    linked: true,
    /* The numbers decide the capabilities, which is what makes this work for
       a release newer than anything in the table above. The thresholds are the
       data formats of the releases that introduced each shape:
         88  (1.21.9) — min_format / max_format in pack.mcmeta
         101 (26.1)   — the <mob>_sound_variant registries
       A jar reporting 116 (the 26.3 snapshots) therefore gets everything. */
    features: meta.packVersion.data[0] >= 101 ? MODERN_26
            : meta.packVersion.data[0] >= 88 ? MODERN_9
            : MODERN_5,
    note: `Read straight out of ${meta.name}. These are the exact numbers this copy of the game accepts.`,
  };
  return linkedVersion;
}
export const getLinkedVersion = () => linkedVersion;

/** The selector's list: the linked game first, then the shipped table. */
export function availableVersions() {
  return linkedVersion ? [linkedVersion, ...MC_VERSIONS] : [...MC_VERSIONS];
}

export function getVersion(id) {
  if (id === 'linked' && linkedVersion) return linkedVersion;
  return MC_VERSIONS.find(v => v.id === id) || MC_VERSIONS.find(v => v.id === DEFAULT_VERSION);
}
/** Whether an id is actually in the table. A project carrying an id we no
 *  longer know silently gets the newest numbers, which would be a quiet way
 *  to ship a broken pack — callers surface this instead. */
export const isKnownVersion = id =>
  (id === 'linked' && !!linkedVersion) || MC_VERSIONS.some(v => v.id === id);
export function hasFeature(versionId, feature) {
  return getVersion(versionId).features.includes(feature);
}

/* ---- Format helpers ----------------------------------------------------- */
/** [94, 1] -> "94.1" for display. */
export const formatLabel = f => (Array.isArray(f) ? (f[1] ? `${f[0]}.${f[1]}` : `${f[0]}`) : String(f));

/** Parse "94.1" or "94" back into [major, minor]. Returns null if unusable. */
export function parseFormat(text) {
  const m = String(text ?? '').trim().match(/^(\d+)(?:[.,](\d+))?$/);
  if (!m) return null;
  return [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
}

/**
 * The JSON value for a min_format / max_format field.
 * A bare integer is the compact, idiomatic form when the minor is zero; for a
 * max bound a bare integer additionally means "any minor of that major", which
 * is what we want so a pack keeps loading on later patch releases.
 */
export function formatValue(f, { bound = 'min' } = {}) {
  const [maj, min] = Array.isArray(f) ? f : [f, 0];
  if (bound === 'max') return maj;          // any minor of this major
  return min ? [maj, min] : maj;
}

/** Human labels for the feature checklist shown in Pack Settings. */
export const FEATURE_LABELS = {
  [F.PAINTING_VARIANTS]: 'Custom paintings without replacing vanilla art',
  [F.PLACEABLE_TAG]:     'Paintings obtainable from the placeable tag',
  [F.JUKEBOX_SONGS]:     'Custom jukebox songs',
  [F.ITEM_MODEL]:        'Custom disc sprites without replacing a vanilla disc',
  [F.ITEMS_DEFINITIONS]: 'Item model definitions (assets/<ns>/items)',
  [F.TOOLTIP_DISPLAY]:   'tooltip_display component',
  [F.JUKEBOX_PLAIN_ID]:  'Bare-id jukebox_playable syntax',
  [F.RANGE_FORMAT]:      'Modern min_format / max_format pack.mcmeta',
  [F.MOB_VARIANTS]:      'Custom mob variants with their own spawn biomes',
  [F.MOB_SOUND_VARIANTS]: 'Per-variant mob sounds',
  [F.COMPONENT_SELECT]:  'Item textures chosen by the item\u2019s name',
};

export const FEATURE_ORDER = [
  F.PAINTING_VARIANTS, F.PLACEABLE_TAG, F.JUKEBOX_SONGS,
  F.ITEM_MODEL, F.ITEMS_DEFINITIONS, F.RANGE_FORMAT,
  F.MOB_VARIANTS, F.MOB_SOUND_VARIANTS, F.COMPONENT_SELECT,
];

/* ---- Registry folder names --------------------------------------------- */
/** Singular from 1.21 on; kept as a function so the shape is one place to
 *  change if that ever flips back. */
/**
 * Is `versionId` at least `otherId`, by the order of the table above?
 * Wolf variants predate every entry here, so anything the table does not know
 * is treated as already-supported rather than blocked.
 */
export function versionAtLeast(versionId, otherId) {
  const ids = MC_VERSIONS.filter(v => !v.custom).map(v => v.id);
  const a = ids.indexOf(versionId), b = ids.indexOf(otherId);
  if (versionId === 'custom') return true;
  if (b < 0) return true;
  if (a < 0) return true;
  return a >= b;
}

export function registryDir(versionId, kind) {
  const singular = hasFeature(versionId, F.SINGULAR_FOLDERS);
  const map = {
    painting_variant: 'painting_variant',
    jukebox_song:     'jukebox_song',
    function:         singular ? 'function' : 'functions',
    loot_table:       singular ? 'loot_table' : 'loot_tables',
    tags_painting:    'tags/painting_variant',
  };
  return map[kind] || kind;
}

/* ---- Disc base items ---------------------------------------------------- */
/** Any of these can carry a custom item_model + jukebox_playable. The vanilla
 *  disc keeps working; the component overrides only change what this copy
 *  looks like and plays. */
export const DISC_BASE_ITEMS = [
  { id: 'music_disc_13',        label: '13',        hue: 200 },
  { id: 'music_disc_cat',       label: 'Cat',       hue: 100 },
  { id: 'music_disc_blocks',    label: 'Blocks',    hue: 30  },
  { id: 'music_disc_chirp',     label: 'Chirp',     hue: 10  },
  { id: 'music_disc_far',       label: 'Far',       hue: 130 },
  { id: 'music_disc_mall',      label: 'Mall',      hue: 160 },
  { id: 'music_disc_mellohi',   label: 'Mellohi',   hue: 300 },
  { id: 'music_disc_stal',      label: 'Stal',      hue: 45  },
  { id: 'music_disc_strad',     label: 'Strad',     hue: 25  },
  { id: 'music_disc_ward',      label: 'Ward',      hue: 90  },
  { id: 'music_disc_11',        label: '11',        hue: 0   },
  { id: 'music_disc_wait',      label: 'Wait',      hue: 190 },
  { id: 'music_disc_otherside', label: 'Otherside', hue: 270 },
  { id: 'music_disc_5',         label: '5',         hue: 220 },
  { id: 'music_disc_pigstep',   label: 'Pigstep',   hue: 330 },
  { id: 'music_disc_relic',     label: 'Relic',     hue: 40  },
  { id: 'music_disc_creator',   label: 'Creator',   hue: 280 },
  { id: 'music_disc_precipice', label: 'Precipice', hue: 210 },
];

export const RARITIES = [
  { id: 'common',    label: 'Common',    color: '#FFFFFF' },
  { id: 'uncommon',  label: 'Uncommon',  color: '#55FF55' },
  { id: 'rare',      label: 'Rare',      color: '#55FFFF' },
  { id: 'epic',      label: 'Epic',      color: '#FF55FF' },
];

/** Minecraft chat colour codes, for title/author styling. */
export const MC_COLORS = [
  { id: 'white',        hex: '#FFFFFF' }, { id: 'light_gray',  hex: '#AAAAAA' },
  { id: 'gray',         hex: '#555555' }, { id: 'black',       hex: '#000000' },
  { id: 'red',          hex: '#FF5555' }, { id: 'dark_red',    hex: '#AA0000' },
  { id: 'gold',         hex: '#FFAA00' }, { id: 'yellow',      hex: '#FFFF55' },
  { id: 'green',        hex: '#55FF55' }, { id: 'dark_green',  hex: '#00AA00' },
  { id: 'aqua',         hex: '#55FFFF' }, { id: 'dark_aqua',   hex: '#00AAAA' },
  { id: 'blue',         hex: '#5555FF' }, { id: 'dark_blue',   hex: '#0000AA' },
  { id: 'light_purple', hex: '#FF55FF' }, { id: 'dark_purple', hex: '#AA00AA' },
];

/** Vanilla painting sizes, for the size picker's quick presets. */
export const PAINTING_PRESETS = [
  { w: 1, h: 1, name: 'Kebab / Aztec' },
  { w: 2, h: 1, name: 'Pool / Courbet' },
  { w: 1, h: 2, name: 'Wanderer / Graham' },
  { w: 2, h: 2, name: 'Match / Bust' },
  { w: 4, h: 2, name: 'Fighters' },
  { w: 4, h: 3, name: 'Skeleton / Donkey Kong' },
  { w: 4, h: 4, name: 'Pointer / Pigscene' },
  { w: 2, h: 3, name: 'Earth / Wind' },
  { w: 3, h: 3, name: 'Baroque' },
];

export const MAX_PAINTING_BLOCKS = 8;   // practical editor cap
export const PIXELS_PER_BLOCK    = 16;  // vanilla painting resolution
