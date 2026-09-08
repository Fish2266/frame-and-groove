/* ============================================================================
   Library — every pack you have made, and the front door for new ones.
   ========================================================================= */

import { h, raw, clear, add } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { relTime, plural, slugifyNamespace, formatTime, fuzzyScore } from '../../core/util.js';
import {
  state,
  bus,
  refreshLibrary,
  openProject,
  newProject,
  deleteProject,
  duplicateProject,
  setRoute,
  adoptProject,
  putAsset,
} from '../../core/store.js';
import { availableVersions, DEFAULT_VERSION, getVersion } from '../../core/versions.js';
import { projectStats } from '../../core/project.js';
import {
  modal,
  toast,
  confirmDialog,
  contextMenu,
  field,
  textInput,
  selectInput,
  emptyState,
  note,
  badge,
  dropzone,
  progressBar,
} from '../kit.js';
import { importPack, inspectPack } from '../../export/importer.js';
import { analyseAudio } from '../../audio/engine.js';

export function buildLibraryView() {
  const grid = h('.lib-grid.stagger');
  const search = h('input.input.lib-search', {
    type: 'search', placeholder: 'Search packs…',
    oninput: () => render(),
  });
  const searchWrap = h('.input-group', h('span.input-icon', raw(icon('search', 14))), search);

  const sortSel = h('select.select', { style: 'width:150px', onchange: () => render() },
    h('option', { value: 'updated' }, 'Last edited'),
    h('option', { value: 'created' }, 'Date created'),
    h('option', { value: 'name' }, 'Name'),
    h('option', { value: 'size' }, 'Most content'),
  );

  const view = h('.view', { dataset: { view: 'library' } },
    h('.view-header',
      h('.vh-text',
        h('h1', { text: 'Your packs' }),
        h('p', { text: 'Every pack you build here exports as a matching data pack and resource pack. Drop an exported zip back in to keep working on it.' }),
      ),
      h('.row.g-2',
        h('button.btn.btn-lg', { onclick: () => openImportFlow() },
          raw(icon('upload', 15)), h('span', { text: 'Import pack' })),
        h('button.btn.btn-lg.btn-primary', { onclick: () => openNewProjectDialog() },
          raw(icon('plus', 15)), h('span', { text: 'New pack' })),
      ),
    ),
    h('.lib-toolbar', searchWrap, sortSel, h('.spacer'), h('.caption.muted', { id: 'lib-count' })),
    h('.view-body', grid),
    /* Mojang asks that anything unofficial says so where people can see it,
       and it is a fair thing to say anyway: this is a fan tool. */
    h('.lib-footer',
      h('span.caption.muted', { text: 'Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.' }),
    ),
  );

  function render() {
    const q = search.value.trim();
    const sort = sortSel.value;
    let rows = [...state.library];
    if (q) {
      rows = rows.map(r => ({ r, s: Math.max(fuzzyScore(q, r.name), fuzzyScore(q, r.namespace)) }))
        .filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.r);
    } else {
      rows.sort((a, b) =>
        sort === 'name' ? a.name.localeCompare(b.name)
        : sort === 'created' ? (b.createdAt || 0) - (a.createdAt || 0)
        : sort === 'size' ? ((b.paintings + b.discs) - (a.paintings + a.discs))
        : (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    clear(grid);
    const count = view.querySelector('#lib-count');
    if (count) count.textContent = rows.length ? `${plural(rows.length, 'pack')}` : '';

    if (!state.library.length) {
      grid.style.display = 'block';
      grid.appendChild(firstRunPanel());
      return;
    }
    grid.style.display = '';

    if (!rows.length) {
      grid.style.display = 'block';
      grid.appendChild(emptyState({
        scene: 'glass', title: 'Nothing matches',
        message: `No pack is called “${q}”.`,
        action: h('button.btn', { text: 'Clear search', onclick: () => { search.value = ''; render(); } }),
      }));
      return;
    }

    grid.appendChild(h('button.proj-card.proj-card-new', { onclick: () => openNewProjectDialog() },
      raw(icon('plus', 24)),
      h('.strong', { text: 'New pack' }),
      h('.caption', { text: 'Paintings and discs' }),
    ));

    for (const rec of rows) grid.appendChild(projectCard(rec));
  }

  bus.on('library', render);
  render();
  view.refresh = render;
  return view;
}

/* ---- Card --------------------------------------------------------------- */
function projectCard(rec) {
  const v = getVersion(rec.mcVersion);
  const card = h('button.proj-card', {
    onclick: () => open(rec.id),
    oncontextmenu: e => { e.preventDefault(); cardMenu(rec, { x: e.clientX, y: e.clientY }); },
  },
    h('.pc-art',
      rec.thumb ? h('img', { src: rec.thumb, alt: '', loading: 'lazy' })
        : h('.center.full', { style: 'height:100%;color:var(--text-4)' }, raw(icon('package', 28))),
    ),
    h('.pc-body',
      h('.pc-name.truncate', { text: rec.name }),
      h('.pc-ns.truncate', { text: rec.namespace }),
      h('.pc-stats',
        h('span.stat-mini', raw(icon('frame', 12)), h('span', { text: String(rec.paintings || 0) })),
        h('span.stat-mini', raw(icon('disc', 12)), h('span', { text: String(rec.discs || 0) })),
        rec.mobs ? h('span.stat-mini', raw(icon('sparkle', 12)), h('span', { text: String(rec.mobs) })) : null,
        h('.spacer'),
        h('span.caption', { text: relTime(rec.updatedAt) }),
      ),
    ),
    h('span.btn.btn-sm.btn-icon.pc-menu', {
      'aria-label': 'More',
      onclick: e => { e.stopPropagation(); cardMenu(rec, e.currentTarget); },
    }, raw(icon('more', 14))),
  );
  card.title = `${rec.name} — Minecraft ${v.label}`;
  return card;
}

function cardMenu(rec, at) {
  contextMenu([
    { label: 'Open', icon: 'chevRight', run: () => open(rec.id) },
    { label: 'Duplicate', icon: 'duplicate', run: async () => {
        await duplicateProject(rec.id);
        toast({ title: 'Duplicated', message: `“${rec.name} copy” is in your library.`, kind: 'ok' });
      } },
    '-',
    { label: 'Delete…', icon: 'trash', destructive: true, run: async () => {
        const ok = await confirmDialog({
          title: `Delete “${rec.name}”?`,
          message: 'The project and its audio are removed from this browser. Any zip you already exported is untouched.',
          confirmLabel: 'Delete pack', danger: true,
        });
        if (!ok) return;
        await deleteProject(rec.id);
        toast({ title: 'Pack deleted', kind: 'ok' });
      } },
  ], at);
}

async function open(id) {
  try {
    await openProject(id);
    setRoute('pack');
  } catch (e) {
    toast({ title: 'Could not open that pack', message: e.message, kind: 'error' });
    await refreshLibrary();
  }
}

/* ---- First run ---------------------------------------------------------- */
function firstRunPanel() {
  const step = (n, title, body) => h('.install-step',
    h('.is-num', { text: String(n) }),
    h('.is-body', h('strong', { text: title }), h('div', { style: 'margin-top:2px' }, body)),
  );
  return h('.col.g-6', { style: 'max-width:760px;margin:24px auto 0' },
    h('.card.card-pad.col.g-4',
      h('.row.g-4.items-start',
        h('.logo-mark.logo-mark-lg', raw(icon('sparkle', 30))),
        h('.col.g-1',
          h('h2.title', { text: 'Make your first pack' }),
          h('p.body', { text: 'A pack holds any number of paintings, music discs, mob variants and renamed item textures. Frame & Groove writes both halves Minecraft needs — the data pack that registers them and the resource pack that carries the art and audio.' }),
        ),
      ),
      h('.divider'),
      h('div',
        step(1, 'Name it and pick a version', 'The version decides which features are available and which pack_format numbers get written.'),
        step(2, 'Paint and record', 'Full pixel editor with layers, frames that adapt to any size, and a disc forge for sprites. Record straight from your microphone or drop in a file.'),
        step(3, 'Export both halves', 'One click gives you the data pack, the resource pack, and the exact commands to get your discs in game.'),
      ),
      h('.row.g-2.wrap',
        h('button.btn.btn-xl.btn-primary', { onclick: () => openNewProjectDialog() },
          raw(icon('plus', 16)), h('span', { text: 'New pack' })),
        h('button.btn.btn-xl', { onclick: () => openSampleFlow() },
          raw(icon('sparkle', 16)), h('span', { text: 'Open the sampler' })),
        h('button.btn.btn-xl', { onclick: () => openImportFlow() },
          raw(icon('upload', 16)), h('span', { text: 'Import a pack' })),
      ),
      h('.caption.muted', { text: 'The sampler is a finished pack built live by the app — three paintings, two tracks, a cow and a sword that catches fire when you name it, all generated. Export it straight into a world, or pull it apart to see how each piece is made.' }),
    ),
    note('Custom paintings need Minecraft 1.21.2 or newer. Disc sprites that do not replace a vanilla disc need 1.21.4, mob variants 1.21.5, and item textures chosen by an item\u2019s name 26.1.', 'info'),
  );
}

/* ---- Sample pack -------------------------------------------------------- */
export function openSampleFlow() {
  const prog = progressBar({ label: 'Starting…' });
  const m = modal({
    title: 'Building the sampler',
    subtitle: 'Drawing the paintings and composing the music, right now, in this tab.',
    icon: 'sparkle',
    dismissable: false,
    body: h('.col.g-3',
      prog,
      h('.caption.muted', { text: 'Nothing is downloaded — every pixel and every note is generated on your machine.' }),
    ),
  });
  (async () => {
    try {
      const { buildSamplePack } = await import('../samplepack.js');
      await buildSamplePack((step, pct) => prog.set(pct, step));
      m.close();
      setRoute('pack');
      toast({
        title: 'Sampler ready',
        message: 'Three paintings, two tracks. Head to Export when you want it in a world.',
        kind: 'ok',
      });
    } catch (e) {
      console.error(e);
      m.close();
      toast({ title: 'Could not build the sampler', message: e.message, kind: 'error' });
    }
  })();
  return m;
}

/* ---- New project -------------------------------------------------------- */
export function openNewProjectDialog() {
  let name = '';
  let namespace = '';
  let nsTouched = false;
  let mcVersion = DEFAULT_VERSION;

  const nsInput = textInput({
    value: '', placeholder: 'my_gallery', mono: true,
    onInput: v => { nsTouched = true; namespace = slugifyNamespace(v); nsInput.value = namespace; updateHint(); },
  });
  const nameInput = textInput({
    value: '', placeholder: 'Gallery of the Deep', 'data-autofocus': '',
    onInput: v => {
      name = v;
      if (!nsTouched) { namespace = slugifyNamespace(v || 'pack'); nsInput.value = namespace; }
      updateHint();
    },
  });

  const hint = h('.field-hint');
  const versionNote = h('.caption.muted');
  const featureList = h('.feature-list');

  function updateHint() {
    hint.textContent = namespace
      ? `Files land under data/${namespace}/ and assets/${namespace}/.`
      : 'A short lowercase id that keeps your content from clashing with anyone else’s.';
  }
  function updateVersion() {
    const v = getVersion(mcVersion);
    versionNote.textContent = v.note || '';
    clear(featureList);
    const rows = [
      ['paintingVariants', 'Paintings without replacing vanilla art'],
      ['itemModel', 'Disc sprites without replacing a vanilla disc'],
      ['jukeboxSongs', 'Custom jukebox songs'],
    ];
    for (const [f, label] of rows) {
      const ok = v.features.includes(f);
      featureList.appendChild(h('.feature-row', { dataset: { ok: String(ok) } },
        h('span.fr-icon', raw(icon(ok ? 'checkCirc' : 'xCirc', 14))),
        h('span', { text: label }),
      ));
    }
    if (!v.verified) {
      featureList.appendChild(note(`Pack format numbers for ${v.label} are a best-known value. You can override them later in Pack Settings.`, 'warn'));
    }
  }

  updateHint(); updateVersion();

  modal({
    title: 'New pack',
    subtitle: 'Two things to decide now. Everything else is changeable later.',
    icon: 'package',
    body: h('.col.g-4',
      field('Pack name', nameInput),
      field('Namespace', nsInput, ''),
      hint,
      h('.divider'),
      field('Minecraft version', selectInput({
        options: (() => {
          const all = availableVersions();
          const linked = all.filter(v => v.linked);
          const rest = all.filter(v => !v.linked).reverse();
          return [...linked, ...rest].map(v => ({
            value: v.id,
            label: v.linked ? `${v.label}  ·  exact` : v.recommended ? `${v.label}  ·  recommended` : v.label,
          }));
        })(),
        value: mcVersion,
        onChange: v => { mcVersion = v; updateVersion(); },
      })),
      versionNote,
      featureList,
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create pack', primary: true,
        run: async () => {
          const finalName = name.trim() || 'Untitled Pack';
          const ns = namespace || slugifyNamespace(finalName);
          if (ns === 'minecraft') { toast({ title: 'Pick another namespace', message: '“minecraft” would overwrite vanilla content.', kind: 'error' }); return false; }
          await newProject({ name: finalName, namespace: ns, mcVersion });
          setRoute('pack');
          toast({ title: 'Pack created', message: 'Add a painting or a disc to get going.', kind: 'ok' });
        },
      },
    ],
  });
}

/* ---- Import ------------------------------------------------------------- */
export function openImportFlow(preFile = null) {
  const stage = h('.col.g-3');
  const m = modal({
    title: 'Import a pack',
    subtitle: 'Packs exported from here come back exactly as you left them. Packs from anywhere else are rebuilt from their registry files, art and audio.',
    icon: 'upload', width: 'wide',
    body: stage,
    actions: [{ label: 'Close' }],
  });

  const dz = dropzone({
    label: 'Drop a pack zip, or click to choose',
    hint: 'A data pack, a resource pack, or a bundle holding both',
    accept: '.zip,application/zip', iconName: 'package',
    onFiles: files => run(files[0]),
  });
  stage.appendChild(dz);

  async function run(file) {
    if (!file) return;
    clear(stage);
    const prog = progressBar({ label: 'Reading archive…' });
    prog.classList.add('progress-indeterminate');
    add(stage, h('.row.g-2', raw(icon('package', 16)), h('span.strong', { text: file.name })), prog);

    try {
      const peek = await inspectPack(file);
      prog.set(0.3, peek.hasProject ? 'Found an editable project inside — restoring it.' : 'Rebuilding the project from the pack contents…');

      const { project, report } = await importPack(file, {
        putAsset: async (kind, blob, meta) => {
          // The project is not adopted yet, so park the asset under its future id.
          const id = `ast_${Math.random().toString(36).slice(2, 10)}`;
          const { Assets } = await import('../../core/db.js');
          await Assets.put({ id, projectId: '__pending__', kind, blob, mime: blob.type, size: blob.size, name: meta?.name || '', at: Date.now() });
          pending.push(id);
          return id;
        },
        decodeAudio: async blob => {
          try {
            const a = await analyseAudio(blob);
            return { durationSec: a.durationSec, sampleRate: a.sampleRate, channels: a.channels, peaks: a.peaks };
          } catch { return {}; }
        },
      });

      prog.set(0.8, 'Saving to your library…');
      await adoptProject(project);

      /* Re-home the assets now that the project has an id. */
      const { Assets } = await import('../../core/db.js');
      for (const id of pending) {
        const rec = await Assets.get(id);
        if (rec) await Assets.put({ ...rec, projectId: project.id });
      }
      pending.length = 0;

      prog.set(1, 'Done');
      const s = projectStats(project);
      clear(stage);
      add(stage,
        note(report.source === 'project'
          ? 'This pack was made with Frame & Groove, so every layer, frame and palette came back intact.'
          : 'Rebuilt from the pack contents. Artwork imports as a single flattened layer.', 'ok'),
        h('.card.card-pad.col.g-2',
          h('.row.between', h('span.strong', { text: project.name }), badge(getVersion(project.mcVersion).label)),
          h('.row.g-4',
            h('span.stat-mini', raw(icon('frame', 13)), h('span', { text: plural(s.paintings, 'painting') })),
            h('span.stat-mini', raw(icon('disc', 13)), h('span', { text: plural(s.discs, 'disc') })),
            s.totalSeconds ? h('span.stat-mini', raw(icon('clock', 13)), h('span', { text: formatTime(s.totalSeconds) })) : null,
          ),
        ),
        ...report.notes.map(n => note(n, 'info')),
        ...report.warnings.slice(0, 6).map(n => note(n, 'warn')),
        report.warnings.length > 6 ? h('.caption.muted', { text: `…and ${report.warnings.length - 6} more notes.` }) : null,
        h('button.btn.btn-lg.btn-primary', {
          style: 'align-self:flex-start',
          onclick: () => { m.close(); setRoute('pack'); },
        }, raw(icon('chevRight', 15)), h('span', { text: 'Open pack' })),
      );
      toast({ title: 'Pack imported', message: `${project.name} is in your library.`, kind: 'ok' });
    } catch (e) {
      console.error(e);
      clear(stage);
      add(stage,
        note(`That file could not be read as a Minecraft pack. ${e.message}`, 'danger'),
        h('button.btn', { onclick: () => { clear(stage); stage.appendChild(dz); }, text: 'Try another file' }),
      );
    }
  }

  const pending = [];
  if (preFile) run(preFile);
  return m;
}
