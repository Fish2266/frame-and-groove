/* ============================================================================
   Importer — read a pack zip back into an editable project.

   Two routes:
     1. Packs this tool exported carry the whole project inside
        .frame-and-groove/project.json, so everything comes back intact —
        layers, frames, sprite palettes, disc metadata.
     2. Anything else is reverse-engineered from the pack itself: registry
        JSON for the numbers, PNGs for the art, Ogg files for the audio. You
        lose layers you never had, but you get a fully editable project.

   Both routes accept a bundle (a zip holding the two pack zips), a single
   pack, or a loose folder-shaped zip.
   ========================================================================= */

import { unzip, textOf, jsonOf } from './zip.js';
import {
  createProject, createPainting, createDisc, createPixelDoc, createAudio,
  projectFromJSON, PROJECT_FILE, createDiscSprite,
} from '../core/project.js';
import { MC_VERSIONS, DEFAULT_VERSION, PIXELS_PER_BLOCK } from '../core/versions.js';
import { uid, slugifyId, slugifyNamespace, titleCase } from '../core/util.js';

/* ---- Entry point -------------------------------------------------------- */
/**
 * @param {File|Blob|ArrayBuffer} input
 * @param {object} deps { putAsset(kind, blob, meta) -> assetId, decodeAudio(blob) -> meta }
 * @returns {{ project, report }}
 */
export async function importPack(input, deps = {}) {
  const report = { source: '', notes: [], warnings: [], counts: { paintings: 0, discs: 0 } };
  let files = await unzip(input);

  /* Bundle? Flatten the inner zips into one namespace-agnostic map. */
  const inner = [...files.keys()].filter(k => /\.zip$/i.test(k));
  if (inner.length && ![...files.keys()].some(k => k === 'pack.mcmeta')) {
    const merged = new Map();
    for (const name of inner) {
      const sub = await unzip(files.get(name));
      const tag = /resource/i.test(name) ? 'resource' : /data/i.test(name) ? 'data' : null;
      for (const [p, v] of sub) merged.set(tag ? `${tag}::${p}` : p, v);
    }
    report.notes.push(`Read a bundle containing ${inner.length} packs.`);
    files = merged;
  }

  /* Normalise: strip a single wrapping folder, and the data::/resource:: tags. */
  files = normalize(files);

  /* Route 1 — an embedded project. */
  const embedded = files.get(PROJECT_FILE);
  if (embedded) {
    report.source = 'project';
    const json = JSON.parse(textOf(embedded));
    const project = projectFromJSON(json);
    project.id = uid('prj');
    await relinkAudio(project, files, deps, report);
    report.counts = { paintings: project.paintings.length, discs: project.discs.length };
    report.notes.unshift('This pack was made with Frame & Groove, so everything came back exactly as you left it.');
    return { project, report };
  }

  /* Route 2 — rebuild from the pack contents. */
  report.source = 'pack';
  const project = await reconstruct(files, deps, report);
  report.counts = { paintings: project.paintings.length, discs: project.discs.length };
  return { project, report };
}

/* ---- Normalisation ------------------------------------------------------ */
function normalize(files) {
  const out = new Map();
  for (const [k, v] of files) {
    let p = k.replace(/^(data|resource)::/, '');
    out.set(p, v);
  }
  // If everything shares one top folder, drop it.
  const keys = [...out.keys()].filter(k => !k.startsWith('__MACOSX') && !/(^|\/)\.DS_Store$/.test(k));
  const roots = new Set(keys.map(k => k.split('/')[0]));
  if (roots.size === 1 && !keys.includes('pack.mcmeta')) {
    const root = [...roots][0] + '/';
    const shifted = new Map();
    for (const k of keys) shifted.set(k.slice(root.length), out.get(k));
    return shifted;
  }
  const clean = new Map();
  for (const k of keys) clean.set(k, out.get(k));
  return clean;
}

/* ---- Route 1 helper ----------------------------------------------------- */
/**
 * The project JSON carries the *references* to audio, not the audio: blobs
 * live in this browser's asset store, which a zip from another machine knows
 * nothing about. So every reference is re-pointed at the .ogg that travelled
 * in the zip beside it — discs first, then any clip a mob variant carries.
 */
async function relinkAudio(project, files, deps, report) {
  const ns = project.namespace;
  await relinkMobSounds(project, files, deps, report);
  for (const d of project.discs) {
    const oggPath = `assets/${ns}/sounds/music/${d.id}.ogg`;
    const bytes = files.get(oggPath);
    if (!bytes) {
      report.warnings.push(`"${d.name}" lost its audio — ${oggPath} was not in the zip.`);
      d.audio = null;
      continue;
    }
    const blob = new Blob([bytes], { type: 'audio/ogg' });
    const assetId = await deps.putAsset('audio', blob, { name: `${d.id}.ogg` });
    const prev = d.audio || createAudio();
    let meta = {};
    try { meta = (await deps.decodeAudio?.(blob)) || {}; } catch { /* keep declared values */ }
    d.audio = {
      ...createAudio(),
      ...prev,
      assetId,
      sourceName: `${d.id}.ogg`,
      mime: 'audio/ogg',
      size: blob.size,
      durationSec: meta.durationSec || prev.durationSec || 0,
      sampleRate: meta.sampleRate || prev.sampleRate || 44100,
      channels: meta.channels ?? prev.channels ?? 1,
      peaks: meta.peaks || prev.peaks || null,
      // The zip only carries the already-rendered clip, so edits start fresh
      // from that clip rather than from a source we no longer have.
      trimStart: 0, trimEnd: 0, gain: 1, fadeIn: 0, fadeOut: 0,
      reimported: true,
      encoded: { assetId, size: blob.size },
    };
  }
}

async function relinkMobSounds(project, files, deps, report) {
  const ns = project.namespace;
  const { mobSoundPath } = await import('../mob/export.js');
  for (const variant of project.mobs || []) {
    for (const group of Object.keys(variant.soundClips || {})) {
      for (const fieldName of Object.keys(variant.soundClips[group] || {})) {
        const clip = variant.soundClips[group][fieldName];
        if (!clip) continue;
        const path = `assets/${ns}/sounds/${mobSoundPath(variant.id, group, fieldName)}.ogg`;
        const bytes = files.get(path);
        if (!bytes) {
          report.warnings.push(`"${variant.name}" lost its ${fieldName.replace(/_/g, ' ')} — ${path} was not in the zip.`);
          delete variant.soundClips[group][fieldName];
          if (variant.sounds?.[group]) variant.sounds[group][fieldName] = '';
          continue;
        }
        const blob = new Blob([bytes], { type: 'audio/ogg' });
        const assetId = await deps.putAsset('audio', blob, { name: `${variant.id}-${fieldName}.ogg` });
        clip.assetId = assetId;
        clip.mime = 'audio/ogg';
        clip.size = blob.size;
        clip.encoded = { assetId, size: blob.size };
      }
    }
  }
}

/* ---- Route 2: reconstruct from pack contents ---------------------------- */
async function reconstruct(files, deps, report) {
  const meta = jsonOf(files.get('pack.mcmeta'));
  const project = createProject({ name: 'Imported Pack' });
  project.id = uid('prj');

  /* Guess the version from whichever format shape the pack uses. */
  const packMeta = meta?.pack || {};
  const major = f => (Array.isArray(f) ? f[0] : typeof f === 'number' ? Math.trunc(f) : null);
  const fmt = major(packMeta.pack_format ?? packMeta.min_format);
  if (fmt != null) {
    const hit = MC_VERSIONS.find(v => !v.custom && (v.data[0] === fmt || v.resource[0] === fmt));
    project.mcVersion = hit?.id || DEFAULT_VERSION;
    const shape = packMeta.min_format != null ? 'min_format' : 'pack_format';
    report.notes.push(hit
      ? `${shape} ${fmt} looks like Minecraft ${hit.label}.`
      : `${shape} ${fmt} is not in this tool's version table — defaulted to ${DEFAULT_VERSION}. Check it in Pack Settings.`);
  }
  const desc = meta?.pack?.description;
  if (typeof desc === 'string') project.description = desc;
  else if (Array.isArray(desc)) project.description = desc.map(x => (typeof x === 'string' ? x : x?.text || '')).join('').trim();

  /* Namespace: whichever one owns the most content. */
  const nsCount = new Map();
  for (const k of files.keys()) {
    const m = k.match(/^(?:data|assets)\/([a-z0-9_.-]+)\//);
    if (m && m[1] !== 'minecraft') nsCount.set(m[1], (nsCount.get(m[1]) || 0) + 1);
  }
  const ns = [...nsCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (ns) { project.namespace = slugifyNamespace(ns); project.name = titleCase(ns); }

  const lang = jsonOf(files.get(`assets/${project.namespace}/lang/en_us.json`)) || {};

  /* ---- Paintings ---- */
  for (const [path, bytes] of files) {
    const m = path.match(/^data\/([a-z0-9_.-]+)\/painting_variants?\/(.+)\.json$/);
    if (!m) continue;
    const entry = jsonOf(bytes);
    if (!entry) continue;
    const id = m[2];
    const w = Math.max(1, entry.width | 0 || 1), h = Math.max(1, entry.height | 0 || 1);
    const p = createPainting(componentText(entry.title) || titleCase(id), w, h);
    p.id = slugifyId(id, 'painting');
    p.title = componentText(entry.title) || lang[`painting.${m[1]}.${id}.title`] || titleCase(id);
    p.author = componentText(entry.author) || lang[`painting.${m[1]}.${id}.author`] || '';
    p.titleColor = entry.title?.color || 'yellow';
    p.authorColor = entry.author?.color || 'gray';

    const assetId = String(entry.asset_id || `${m[1]}:${id}`);
    const [aNs, aPath] = assetId.includes(':') ? assetId.split(':') : ['minecraft', assetId];
    const png = files.get(`assets/${aNs}/textures/painting/${aPath}.png`);
    if (png) {
      const doc = await pngToDoc(png, w * PIXELS_PER_BLOCK, h * PIXELS_PER_BLOCK, report, id);
      if (doc) p.doc = doc;
    } else {
      report.warnings.push(`Painting "${id}" points at ${assetId} but that texture is not in the pack.`);
    }
    project.paintings.push(p);
  }

  /* ---- Placeable tag ---- */
  const tag = jsonOf(files.get('data/minecraft/tags/painting_variant/placeable.json'))
           || jsonOf(files.get('data/minecraft/tags/painting_variants/placeable.json'));
  if (tag?.values) {
    const set = new Set(tag.values.map(v => String(v).split(':').pop()));
    for (const p of project.paintings) p.placeable = set.has(p.id);
  }

  /* ---- Discs ---- */
  const sounds = jsonOf(files.get(`assets/${project.namespace}/sounds.json`)) || {};
  for (const [path, bytes] of files) {
    const m = path.match(/^data\/([a-z0-9_.-]+)\/jukebox_songs?\/(.+)\.json$/);
    if (!m) continue;
    const entry = jsonOf(bytes);
    if (!entry) continue;
    const id = m[2];
    const langKey = `jukebox_song.${m[1]}.${id}`;
    const label = componentText(entry.description) || lang[langKey] || titleCase(id);
    const d = createDisc(label.includes(' - ') ? label.split(' - ').slice(1).join(' - ') : label);
    d.id = slugifyId(id, 'track');
    if (label.includes(' - ')) d.artist = label.split(' - ')[0];
    d.comparatorOutput = Math.max(0, Math.min(15, entry.comparator_output | 0));
    const se = entry.sound_event;
    d.range = (typeof se === 'object' && se?.range) || 64;

    /* Locate the audio via sounds.json, falling back to the conventional path. */
    const eventKey = (typeof se === 'string' ? se : se?.sound_id || '').split(':').pop();
    const soundDef = sounds[eventKey];
    let oggPath = null;
    const nameRef = soundDef?.sounds?.[0];
    const ref = typeof nameRef === 'string' ? nameRef : nameRef?.name;
    if (ref) {
      const [rNs, rPath] = ref.includes(':') ? ref.split(':') : [project.namespace, ref];
      oggPath = `assets/${rNs}/sounds/${rPath}.ogg`;
    }
    if (!oggPath || !files.has(oggPath)) oggPath = `assets/${project.namespace}/sounds/music/${id}.ogg`;

    const oggBytes = files.get(oggPath);
    if (oggBytes) {
      const blob = new Blob([oggBytes], { type: 'audio/ogg' });
      const assetId = await deps.putAsset('audio', blob, { name: `${id}.ogg` });
      let am = {};
      try { am = (await deps.decodeAudio?.(blob)) || {}; } catch {}
      d.audio = {
        ...createAudio(),
        assetId, sourceName: `${id}.ogg`, mime: 'audio/ogg', size: blob.size,
        durationSec: am.durationSec || entry.length_in_seconds || 0,
        sampleRate: am.sampleRate || 44100,
        channels: am.channels ?? 1,
        peaks: am.peaks || null,
        mono: (am.channels ?? 1) === 1,
        reimported: true,
        encoded: { assetId, size: blob.size },
      };
    } else {
      report.warnings.push(`"${d.name}" has no audio file at ${oggPath}.`);
    }

    /* Sprite: if there is a custom item texture, bring it in as pixel art. */
    const sprPng = files.get(`assets/${project.namespace}/textures/item/${id}.png`);
    if (sprPng) {
      const doc = await pngToDoc(sprPng, 16, 16, report, id);
      if (doc) { d.sprite = { ...createDiscSprite(), mode: 'pixels', doc }; }
    }
    project.discs.push(d);
  }

  if (!project.paintings.length && !project.discs.length) {
    report.warnings.push('No painting variants or jukebox songs were found in this zip.');
  }
  return project;
}

/* ---- helpers ------------------------------------------------------------ */
function componentText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(componentText).join('');
  if (typeof c === 'object') return c.text ?? (c.translate ? '' : '') ;
  return '';
}

async function pngToDoc(bytes, expectW, expectH, report, label) {
  try {
    const blob = new Blob([bytes], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, 0, 0);
    bmp.close?.();
    const img = g.getImageData(0, 0, c.width, c.height);
    const doc = createPixelDoc(c.width, c.height, { layerName: 'Imported' });
    doc.layers[0].data.set(img.data);
    if ((expectW && c.width !== expectW) || (expectH && c.height !== expectH)) {
      report.warnings.push(`"${label}" texture is ${c.width}x${c.height} but the entry declares ${expectW}x${expectH}. Kept the texture as-is.`);
    }
    return doc;
  } catch (e) {
    report.warnings.push(`Could not read the texture for "${label}": ${e.message}`);
    return null;
  }
}

/** Quick look at a zip without importing — used by the drop preview. */
export async function inspectPack(input) {
  const files = normalize(await unzip(input));
  return {
    hasProject: files.has(PROJECT_FILE),
    paintings: [...files.keys()].filter(k => /\/painting_variants?\/.+\.json$/.test(k)).length,
    discs: [...files.keys()].filter(k => /\/jukebox_songs?\/.+\.json$/.test(k)).length,
    fileCount: files.size,
    mcmeta: jsonOf(files.get('pack.mcmeta')),
  };
}
