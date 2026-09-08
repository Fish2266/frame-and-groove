/* ============================================================================
   Export — validate, preview the exact file layout, then hand over the zips.
   ========================================================================= */

import { h, raw, clear, add } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatBytes, plural, downloadBlob, copyText, debounce } from '../../core/util.js';
import { state, bus, getAsset, setRoute, saveProject, selectPainting, selectDisc, selectMob, selectSprite, setPref } from '../../core/store.js';
import { validateProject, projectStats } from '../../core/project.js';
import { getVersion } from '../../core/versions.js';
import { buildAll, packFileNames, giveCommand, givePaintingCommand, lootWarnings } from '../../export/packbuild.js';
import { ZipWriter, pathsToTree, CAN_DEFLATE } from '../../export/zip.js';
import {
  supportsFolderSave, pickFolder, rememberFolders, recallFolders, forgetFolders,
  checkPermission, folderLabel, folderAdvice, writeZipTo, writeTreeTo,
} from '../../export/savefolder.js';
import {
  panel,
  note,
  toast,
  emptyState,
  iconButton,
  codeBlock,
  progressBar,
  modal,
  field,
  segmented,
  badge,
} from '../kit.js';

export function buildExportView() {
  const body = h('.view-body.pad-top');
  const view = h('.view', { dataset: { view: 'export' } },
    h('.view-header',
      h('.vh-text',
        h('h1', { text: 'Export' }),
        h('p', { text: 'Custom paintings and discs always need two packs: the data pack that registers them and the resource pack that carries the art and audio. Install both.' }),
      ),
    ),
    body,
  );

  let plan = null;
  let building = false;

  async function render() {
    const p = state.project;
    if (!p) { clear(body).appendChild(emptyState({ scene: 'chest', title: 'No pack open', message: 'Pick one from your library to export it.' })); return; }

    const check = validateProject(p);
    const stats = projectStats(p);
    const names = packFileNames(p);
    const v = getVersion(p.mcVersion);

    clear(body).appendChild(h('.col.g-5',
      /* ---- Readiness ---- */
      check.errors.length
        ? panel('Not ready yet', h('.col.g-2',
            ...check.errors.map(e => issueRow(e, 'danger')),
          ))
        : panel('Ready to export', h('.col.g-3',
            note(`${[plural(stats.paintings, 'painting'), plural(stats.discs, 'disc'),
                    stats.mobs ? plural(stats.mobs, 'mob variant') : null,
                    stats.sprites ? plural(stats.sprites, 'renamed sprite') : null]
                   .filter(Boolean).join(', ')} for Minecraft ${v.label}.`, 'ok'),
            ...check.warnings.map(w => issueRow(w, 'warn')),
            h('.col.g-2', { id: 'loot-caveats' }),
          )),

      /* ---- Install straight into the game ---- */
      supportsFolderSave() ? installPanel(p, check) : null,

      /* ---- Downloads ---- */
      panel('Download', h('.col.g-4',
        h('.col.g-2',
          targetRow('package', 'Data pack', names.data,
            'Goes in your world’s datapacks folder. Registers the paintings and songs.',
            () => download('data')),
          targetRow('image', 'Resource pack', names.resource,
            'Goes in .minecraft/resourcepacks. Carries the PNGs, the sprites and the Ogg audio.',
            () => download('resource')),
        ),
        h('.divider'),
        h('.row.g-2.wrap',
          h('button.btn.btn-xl.btn-primary', {
            disabled: !check.ok || building,
            onclick: () => download('both'),
          }, raw(icon('download', 16)), h('span', { text: 'Download both packs' })),
          h('button.btn.btn-xl', {
            disabled: !check.ok || building,
            onclick: () => download('bundle'),
          }, raw(icon('package', 16)), h('span', { text: 'One bundle zip' })),
        ),
        progressHost,
        !CAN_DEFLATE ? note('This browser has no built-in deflate, so the zips are written uncompressed. They still install exactly the same, just larger.', 'warn') : null,
      )),

      /* ---- Preview + install ---- */
      h('.export-grid',
        panel('What is in the box', h('.filetree', { id: 'ft' }), {
          actions: iconButton('refresh', { tip: 'Rebuild preview', pos: 'left', onClick: () => buildPlan(true) }),
        }),
        h('.col.g-5',
          installGuidePanel(p),
          commandsPanel(p),
        ),
      ),
    ));

    buildPlan();
  }

  const progressHost = h('div');

  function issueRow(e, kind) {
    const jump = () => {
      if (e.scope === 'painting') { selectPainting(e.key); setRoute('paintings'); }
      else if (e.scope === 'disc') { selectDisc(e.key); setRoute('discs'); }
      else if (e.scope === 'mob') { selectMob(e.key); setRoute('mobs'); }
      else if (e.scope === 'sprite') { selectSprite(e.key); setRoute('sprites'); }
      else setRoute('pack');
    };
    return h(`.note${kind === 'danger' ? '.note-danger' : '.note-warn'}`, { style: 'align-items:center' },
      h('span.n-icon', raw(icon(kind === 'danger' ? 'alert' : 'warning', 15))),
      h('span.grow', { text: e.message }),
      e.scope !== 'pack' || e.field ? h('button.btn.btn-sm.btn-ghost', { onclick: jump, text: 'Fix' }) : null,
    );
  }

  function targetRow(iconName, title, filename, desc, run) {
    return h('.export-target',
      h('.et-icon', raw(icon(iconName, 17))),
      h('.et-main',
        h('.et-name', { text: title }),
        h('.et-meta', { text: filename }),
        h('.caption.muted', { style: 'margin-top:2px', text: desc }),
      ),
      h('button.btn.btn-sm', { onclick: run }, raw(icon('download', 13)), h('span', { text: 'Get' })),
    );
  }

  /* ---- Preview tree ---- */
  const buildPlan = debounce(async (force = false) => {
    const p = state.project;
    if (!p) return;
    const ft = view.querySelector('#ft');
    if (!ft) return;
    ft.innerHTML = '<div class="caption muted">Building preview…</div>';
    try {
      const { data, resource } = await buildAll(p, { getAudio: async id => (await getAsset(id))?.blob });
      plan = { data, resource };
      clear(ft);
      const caveats = lootWarnings();
      if (caveats.length) {
        const host = view.querySelector('#loot-caveats');
        if (host) { clear(host); for (const w of caveats) host.appendChild(note(w, 'warn')); }
      }
      ft.appendChild(treeBlock(`${p.namespace}_datapack.zip`, data));
      ft.appendChild(h('div', { style: 'height:10px' }));
      ft.appendChild(treeBlock(`${p.namespace}_resourcepack.zip`, resource));
    } catch (e) {
      console.error(e);
      clear(ft).appendChild(note(`Preview failed: ${e.message}`, 'danger'));
    }
  }, 200);

  function treeBlock(label, files) {
    const rows = [...files.entries()].map(([path, content]) => ({
      path, size: typeof content === 'string' ? new Blob([content]).size
        : content?.size ?? content?.length ?? 0,
    })).sort((a, b) => a.path.localeCompare(b.path));
    const total = rows.reduce((n, r) => n + r.size, 0);
    const tree = pathsToTree(rows);

    const out = h('div',
      h('.ft-row', h('span.ft-dir', { text: label }), h('span.ft-size', { text: formatBytes(total) })),
    );
    const walk = (node, depth, prefixes) => {
      const kids = [...node.children.values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      kids.forEach((child, i) => {
        const last = i === kids.length - 1;
        const branch = prefixes + (last ? '└─ ' : '├─ ');
        const ext = child.name.split('.').pop();
        const cls = child.dir ? 'ft-dir'
          : ext === 'json' ? 'ft-file ft-json'
          : ext === 'png' ? 'ft-file ft-png'
          : ext === 'ogg' ? 'ft-file ft-ogg'
          : ext === 'mcmeta' ? 'ft-file ft-mcmeta' : 'ft-file';
        out.appendChild(h('.ft-row',
          h('span', { style: 'color:var(--text-4)', text: branch }),
          h('span', { class: cls, text: child.name + (child.dir ? '/' : '') }),
          h('span.ft-size', { text: formatBytes(child.size) }),
        ));
        if (child.dir) walk(child, depth + 1, prefixes + (last ? '   ' : '│  '));
      });
    };
    walk(tree, 0, '');
    return out;
  }

  /* ---- Download ---- */
  async function download(which) {
    const p = state.project;
    if (!p || building) return;
    building = true;
    const prog = progressBar({ label: 'Assembling…' });
    clear(progressHost).appendChild(prog);
    try {
      await saveProject({ silent: true });
      const { data, resource } = await buildAll(p, {
        getAudio: async id => (await getAsset(id))?.blob,
        onProgress: msg => prog.set(0.1, msg),
      });
      const names = packFileNames(p);

      const makeZip = async (files, label) => {
        const z = new ZipWriter({
          comment: `${p.name} — built with Frame & Groove`,
          onProgress: (done, total, path) => prog.set(0.15 + 0.8 * (done / total), `${label}: ${path}`),
        });
        for (const [path, content] of files) z.file(path, content);
        return z.blob();
      };

      if (which === 'data' || which === 'both') {
        const blob = await makeZip(data, 'Data pack');
        downloadBlob(blob, names.data);
      }
      if (which === 'resource' || which === 'both') {
        const blob = await makeZip(resource, 'Resource pack');
        downloadBlob(blob, names.resource);
      }
      if (which === 'bundle') {
        const dz = await makeZip(data, 'Data pack');
        const rz = await makeZip(resource, 'Resource pack');
        prog.set(0.95, 'Wrapping the bundle…');
        const outer = new ZipWriter({ compress: false });
        outer.file(names.data, dz);
        outer.file(names.resource, rz);
        outer.file('INSTALL.txt', bundleReadme(p, names));
        downloadBlob(await outer.blob(), names.bundle);
      }

      prog.set(1, 'Done');
      toast({
        title: which === 'bundle' ? 'Bundle exported' : 'Packs exported',
        message: which === 'both' ? 'Two zips: install both.' : undefined,
        kind: 'ok',
      });
      setTimeout(() => clear(progressHost), 2200);
    } catch (e) {
      console.error(e);
      clear(progressHost).appendChild(note(`Export failed: ${e.message}`, 'danger'));
      toast({ title: 'Export failed', message: e.message, kind: 'error' });
    } finally {
      building = false;
    }
  }

  /* ---- Install straight into the game ------------------------------------
     Writes into folders you nominate once, so the loop becomes "click,
     alt-tab, /reload" instead of "export, find the zip, drag it, reload". */
  const installProgress = h('div');
  let installing = false;
  let folders = null;

  function installPanel(p, check) {
    const body = h('.col.g-4');
    const box = panel('Install', body);

    const row = (kind, label, hint) => {
      const handle = folders?.[kind] || null;
      const advice = handle ? folderAdvice(handle, kind) : null;
      return h('.col.g-2',
        h('.export-target',
          h('.et-icon', raw(icon(kind === 'data' ? 'package' : 'image', 16))),
          h('.et-main',
            h('.et-name', { text: label }),
            handle ? h('.et-meta', { text: folderLabel(handle) })
                   : h('.caption.muted', { text: hint }),
          ),
          h('button.btn.btn-sm', {
            onclick: async () => {
              try {
                const picked = await pickFolder(kind);
                folders = { ...(folders || {}), [kind]: picked };
                await rememberFolders(p.id, folders);
                paint();
              } catch { /* the picker was dismissed */ }
            },
          }, raw(icon(handle ? 'refresh' : 'folder', 13)),
             h('span', { text: handle ? 'Change' : 'Choose' })),
        ),
        advice ? note(advice, 'warn') : null,
      );
    };

    const paint = () => {
      const ready = folders?.data && folders?.resource;
      const asZip = state.prefs.installMode === 'zip';
      clear(body);
      add(body,
        h('.caption.muted', { text: 'Point this at your folders once and every build after that lands in the game directly \u2014 no download, no dragging.' }),
        row('data', 'Data pack folder', 'Usually <world>/datapacks'),
        row('resource', 'Resource pack folder', 'Usually .minecraft/resourcepacks'),
        h('.divider'),
        field('Write as', segmented({
          options: [
            { value: 'folder', label: 'Folder', hint: 'Unpacked \u2014 best while iterating' },
            { value: 'zip', label: 'Zip', hint: 'A single archive, ready to share' },
          ],
          value: asZip ? 'zip' : 'folder', block: true,
          onChange: v => { setPref('installMode', v); paint(); },
        })),
        installProgress,
        h('.row.g-2.wrap',
          h('button.btn.btn-xl.btn-primary', {
            disabled: !ready || !check.ok,
            onclick: () => runInstall(p),
          }, raw(icon('download', 16)),
             h('span', { text: ready ? 'Install to both' : 'Choose both folders first' })),
          (folders?.data || folders?.resource)
            ? h('button.btn.btn-xl', {
                onclick: async () => { await forgetFolders(p.id); folders = null; paint(); },
              }, raw(icon('x', 14)), h('span', { text: 'Forget' }))
            : null,
        ),
        !asZip ? note('Folder mode also deletes files the build no longer produces, so a renamed painting cannot leave its old texture behind.', 'info') : null,
      );
    };

    recallFolders(p.id).then(saved => { folders = folders || saved; paint(); });
    paint();
    return box;
  }

  async function runInstall(p) {
    if (installing) return;
    installing = true;
    const prog = progressBar({ label: 'Checking permission\u2026' });
    clear(installProgress).appendChild(prog);
    try {
      const handles = folders || await recallFolders(p.id);
      // Permission can lapse between sessions, and asking has to happen while
      // the click that got us here still counts as user activation.
      for (const kind of ['data', 'resource']) {
        const st = await checkPermission(handles[kind], { ask: true });
        if (st !== 'granted') throw new Error(`Permission to write to \u201C${folderLabel(handles[kind])}\u201D was not granted.`);
      }

      await saveProject({ silent: true });
      prog.set(0.15, 'Building\u2026');
      const { data, resource } = await buildAll(p, { getAudio: async id => (await getAsset(id))?.blob });
      const names = packFileNames(p);
      let summary;

      if (state.prefs.installMode === 'zip') {
        const mk = async files => { const z = new ZipWriter(); for (const [k, v] of files) z.file(k, v); return z.blob(); };
        prog.set(0.45, 'Writing the data pack\u2026');
        const a = await writeZipTo(handles.data, names.data, await mk(data));
        prog.set(0.78, 'Writing the resource pack\u2026');
        const b = await writeZipTo(handles.resource, names.resource, await mk(resource));
        summary = `${formatBytes(a.bytes + b.bytes)} written as two zips.`;
      } else {
        prog.set(0.3, 'Writing the data pack\u2026');
        const a = await writeTreeTo(handles.data, `${p.namespace}_datapack`, data,
          (pct, path) => prog.set(0.3 + pct * 0.32, path));
        prog.set(0.66, 'Writing the resource pack\u2026');
        const b = await writeTreeTo(handles.resource, `${p.namespace}_resourcepack`, resource,
          (pct, path) => prog.set(0.66 + pct * 0.3, path));
        const gone = a.removed + b.removed;
        summary = `${a.files + b.files} files written${gone ? `, ${plural(gone, 'stale file')} removed` : ''}.`;
      }

      prog.set(1, 'Installed');
      toast({ title: 'Installed', message: `${summary} Run /reload in your world to pick it up.`, kind: 'ok' });
      setTimeout(() => clear(installProgress), 3200);
    } catch (e) {
      console.error(e);
      clear(installProgress).appendChild(note(e.message, 'danger'));
      toast({ title: 'Could not install', message: e.message, kind: 'error' });
    } finally {
      installing = false;
    }
  }


  bus.on('route', r => { if (r === 'export') render(); });
  bus.on('project:open', () => { if (state.route === 'export') render(); });
  render();
  view.refresh = render;
  return view;
}

/* ---- Install instructions ----------------------------------------------- */
function installGuidePanel(p) {
  const step = (n, title, bodyEl) => h('.install-step',
    h('.is-num', { text: String(n) }),
    h('.is-body', h('strong', { text: title }), h('div', { style: 'margin-top:3px' }, bodyEl)),
  );
  return panel('Installing', h('div',
    step(1, 'Data pack', h('div',
      'Drop ', h('code', { text: `${p.namespace}_datapack.zip` }), ' into your world folder’s ',
      h('code', { text: 'datapacks' }), ' directory, then run ', h('code', { text: '/reload' }), '.',
    )),
    step(2, 'Resource pack', h('div',
      'Drop ', h('code', { text: `${p.namespace}_resourcepack.zip` }), ' into ',
      h('code', { text: '.minecraft/resourcepacks' }), ' and enable it under Options → Resource Packs.',
    )),
    step(3, 'Get your content', h('div',
      'Run ', h('code', { text: `/function ${p.namespace}:give_all` }),
      ' for everything, or place a blank painting on a wall and let it roll one of yours.',
    )),
    step(4, 'On a server', h('div',
      'The data pack goes in ', h('code', { text: 'world/datapacks' }), ' on the server. Players still need the resource pack — ',
      'set ', h('code', { text: 'resource-pack' }), ' in server.properties, or hand them the zip.',
    )),
  ), { actions: iconButton('folder', { tip: 'Where is my world folder?', pos: 'left', onClick: () => showFolderHelp() }) });
}

function showFolderHelp() {
  modal({
    title: 'Finding your folders',
    icon: 'folder',
    body: h('.col.g-4',
      h('.col.g-2',
        h('.eyebrow', { text: 'macOS' }),
        codeBlock('~/Library/Application Support/minecraft/saves/<world>/datapacks\n~/Library/Application Support/minecraft/resourcepacks'),
      ),
      h('.col.g-2',
        h('.eyebrow', { text: 'Windows' }),
        codeBlock('%APPDATA%\\.minecraft\\saves\\<world>\\datapacks\n%APPDATA%\\.minecraft\\resourcepacks'),
      ),
      h('.col.g-2',
        h('.eyebrow', { text: 'Linux' }),
        codeBlock('~/.minecraft/saves/<world>/datapacks\n~/.minecraft/resourcepacks'),
      ),
      note('In game you can also open Options → Resource Packs → Open Pack Folder, which jumps straight there.', 'info'),
    ),
    actions: [{ label: 'Close', primary: true }],
  });
}

/* ---- Commands ----------------------------------------------------------- */
function commandsPanel(p) {
  const lines = [];
  for (const d of p.discs) lines.push({ label: d.name || d.id, cmd: giveCommand(p, d, { includeSlash: true }) });
  for (const pt of p.paintings) lines.push({ label: pt.title || pt.id, cmd: givePaintingCommand(p, pt, { includeSlash: true }) });

  if (!lines.length) return panel('Commands', note('Add a painting or a disc and the commands appear here.', 'info'));

  const all = lines.map(l => l.cmd).join('\n');
  return panel('Commands', h('.col.g-3',
    h('.caption.muted', { text: 'Every /give this pack needs, for when you would rather paste than run a function.' }),
    h('.col.g-2', { style: 'max-height:220px;overflow-y:auto' },
      ...lines.map(l => h('.col.g-1',
        h('.row.between.g-2',
          h('span.caption.strong.truncate', { text: l.label }),
          h('button.btn.btn-sm.btn-ghost', {
            onclick: async e => {
              await copyText(l.cmd);
              e.currentTarget.textContent = 'Copied';
              setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1400);
            },
          }, 'Copy'),
        ),
        h('pre.code', { style: 'font-size:10px;max-height:52px', text: l.cmd }),
      )),
    ),
    h('button.btn.btn-sm', {
      style: 'align-self:flex-start',
      onclick: async () => { await copyText(all); toast({ title: 'All commands copied', kind: 'ok' }); },
    }, raw(icon('copy', 13)), h('span', { text: 'Copy all' })),
  ));
}

function bundleReadme(p, names) {
  return [
    p.name,
    '='.repeat(p.name.length),
    '',
    'This bundle holds BOTH halves of the pack. Install both — with only one,',
    'nothing shows up in game.',
    '',
    `  ${names.data}`,
    '      -> <world folder>/datapacks/      then run /reload',
    '',
    `  ${names.resource}`,
    '      -> .minecraft/resourcepacks/      then enable it in Options',
    '',
    `Namespace: ${p.namespace}`,
    `Target: Minecraft ${getVersion(p.mcVersion).label}`,
    '',
    `Get everything in game with:  /function ${p.namespace}:give_all`,
    '',
    'Made with Frame & Groove.',
  ].join('\n') + '\n';
}
