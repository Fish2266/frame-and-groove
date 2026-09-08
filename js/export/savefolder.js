/* ============================================================================
   Installing without the download dance.

   The normal loop is: export, find the zip in Downloads, drag it into the
   right folder, reload the world. Repeat for every tweak. Browsers that
   support the File System Access API can skip all of it — pick your
   datapacks and resourcepacks folders once, and every export after that
   writes straight into them.

   Two shapes are offered, because they suit different moments:
     • Zip     — what you would have downloaded, ready to share.
     • Folder  — unpacked. Minecraft loads a plain folder exactly like a zip,
                 and it is far better while you are iterating: no archive to
                 replace, and /reload picks up the change immediately.

   Directory handles are stored per project, so the second install is one
   click. Permission is re-checked every time, because the browser can and
   does drop it between sessions.
   ========================================================================= */

import { Prefs } from '../core/db.js';

export const supportsFolderSave = () =>
  typeof window.showDirectoryPicker === 'function' && window.isSecureContext;

const KEY = id => `folder:${id}`;

/* ---- Picking and remembering -------------------------------------------- */

/**
 * Ask for a folder.
 * @param {'data'|'resource'} kind — only used to give the picker a stable id,
 *   so the OS reopens where you were last time for that kind.
 */
export async function pickFolder(kind) {
  const handle = await window.showDirectoryPicker({
    id: `fg-${kind}`,
    mode: 'readwrite',
    startIn: 'documents',
  });
  return handle;
}

export async function rememberFolders(projectId, handles) {
  await Prefs.set(KEY(projectId), handles);
}

export async function recallFolders(projectId) {
  return (await Prefs.get(KEY(projectId), null)) || null;
}

export async function forgetFolders(projectId) {
  await Prefs.remove(KEY(projectId));
}

/**
 * Confirm we may still write here. Returns 'granted', 'prompt' or 'denied';
 * `ask` triggers the browser's own permission prompt, which needs to happen
 * inside a user gesture.
 */
export async function checkPermission(handle, { ask = false } = {}) {
  if (!handle?.queryPermission) return 'denied';
  const opts = { mode: 'readwrite' };
  let state = await handle.queryPermission(opts);
  if (state === 'prompt' && ask) state = await handle.requestPermission(opts);
  return state;
}

/** A readable path for the UI. Browsers only expose the folder's own name. */
export const folderLabel = handle => handle?.name || 'a folder';

/* ---- Writing ------------------------------------------------------------- */

async function writeFile(dirHandle, name, data) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/** Resolve (creating as needed) a nested path under a directory. */
async function ensureDir(root, segments) {
  let dir = root;
  for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create: true });
  return dir;
}

/** Write a single zip into the chosen folder. */
export async function writeZipTo(dirHandle, filename, blob) {
  await writeFile(dirHandle, filename, blob);
  return { files: 1, bytes: blob.size };
}

/**
 * Write a pack unpacked, as `<folderName>/…`.
 *
 * Files that vanished since last time are removed, so renaming a painting
 * does not leave its old texture behind for the game to keep loading.
 */
export async function writeTreeTo(dirHandle, folderName, files, onProgress) {
  const root = await dirHandle.getDirectoryHandle(folderName, { create: true });

  const wanted = new Set([...files.keys()]);
  let done = 0, bytes = 0;

  for (const [path, content] of files) {
    const parts = path.split('/');
    const name = parts.pop();
    const dir = parts.length ? await ensureDir(root, parts) : root;
    const data = typeof content === 'string' ? new Blob([content]) : content;
    await writeFile(dir, name, data);
    bytes += data.size ?? data.byteLength ?? 0;
    // Count first: arguments to an optional call are not evaluated when the
    // callback is missing, so `onProgress?.(++done)` silently never counts.
    done++;
    onProgress?.(done / files.size, path);
  }

  const removed = await pruneStale(root, wanted, '');
  return { files: done, bytes, removed };
}

/** Delete anything under `dir` that the new build did not produce. */
async function pruneStale(dir, wanted, prefix) {
  let removed = 0;
  const entries = [];
  for await (const [name, handle] of dir.entries()) entries.push([name, handle]);

  for (const [name, handle] of entries) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      removed += await pruneStale(handle, wanted, path);
      // Drop the directory too if the build left nothing in it.
      let empty = true;
      for await (const _ of handle.keys()) { empty = false; break; }
      if (empty) { await dir.removeEntry(name); removed++; }
    } else if (!wanted.has(path)) {
      await dir.removeEntry(name);
      removed++;
    }
  }
  return removed;
}

/* ---- Guardrails ---------------------------------------------------------- */

/**
 * A gentle sanity check on where someone is about to write. Not a
 * restriction — plenty of people keep packs elsewhere — just a nudge when the
 * folder name suggests a mistake, since this writes and deletes real files.
 */
export function folderAdvice(handle, kind) {
  const n = (handle?.name || '').toLowerCase();
  if (kind === 'data') {
    if (n === 'datapacks') return null;
    if (n === 'resourcepacks') return 'That looks like your resource packs folder — data packs go in a world’s datapacks folder.';
    if (n === 'saves' || n === 'minecraft' || n === '.minecraft') return 'Pick the datapacks folder inside a world, not the folder above it.';
    return `Data packs normally live in <world>/datapacks. This is “${handle?.name}”.`;
  }
  if (n === 'resourcepacks') return null;
  if (n === 'datapacks') return 'That looks like a datapacks folder — resource packs go in .minecraft/resourcepacks.';
  return `Resource packs normally live in .minecraft/resourcepacks. This is “${handle?.name}”.`;
}
