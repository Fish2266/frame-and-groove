/* ============================================================================
   Pack settings — identity, target version, icon, and the escape hatches.
   ========================================================================= */

import { h, raw, clear, add } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { slugifyNamespace, formatBytes, relTime, plural, formatTime } from '../../core/util.js';
import { state, bus, markDirty, setRoute, deleteProject } from '../../core/store.js';
import { availableVersions, getVersion, FEATURE_LABELS, FEATURE_ORDER, formatLabel, parseFormat } from '../../core/versions.js';
import { gameLinkRow } from '../gamelink.js';
import { packFormats, projectStats } from '../../core/project.js';
import { storageEstimate, requestPersistence } from '../../core/db.js';
import {
  panel,
  section,
  field,
  textInput,
  textArea,
  selectInput,
  switchRow,
  note,
  toast,
  confirmDialog,
  badge,
  emptyState,
  modal,
} from '../kit.js';
import { PixelEditor } from '../editor.js';
import { createPixelDoc } from '../../core/project.js';
import { flatten } from '../../paint/render.js';
import { packIconBytes, mcmetaJSON } from '../../export/packbuild.js';

export function buildPackView() {
  const body = h('.view-body.pad-top');
  const view = h('.view', { dataset: { view: 'pack' } },
    h('.view-header',
      h('.vh-text',
        h('h1', { id: 'pack-title', text: 'Pack' }),
        h('p', { id: 'pack-sub' }),
      ),
      h('.row.g-2',
        h('button.btn.btn-lg', { onclick: () => setRoute('export') },
          raw(icon('package', 15)), h('span', { text: 'Export' })),
      ),
    ),
    body,
  );

  function render() {
    const p = state.project;
    if (!p) { clear(body).appendChild(emptyState({ scene: 'chest', title: 'No pack open', message: 'Pick one from your library to start editing it.' })); return; }
    const v = getVersion(p.mcVersion);
    const fmt = packFormats(p);
    const stats = projectStats(p);

    view.querySelector('#pack-title').textContent = p.name;
    view.querySelector('#pack-sub').textContent =
      [plural(stats.paintings, 'painting'), plural(stats.discs, 'disc'),
       stats.mobs ? plural(stats.mobs, 'mob variant') : null,
       stats.sprites ? plural(stats.sprites, 'renamed sprite') : null,
       stats.totalSeconds ? formatTime(stats.totalSeconds) + ' of audio' : null,
      ].filter(Boolean).join(' · ');

    clear(body).appendChild(h('.settings-wrap',
      /* ---- Identity ---- */
      panel('Identity', h('.col.g-4',
        h('.row.g-4.items-start',
          h('.col.g-2',
            h('.field-label', { text: 'Pack icon' }),
            packIconSlot(p),
            h('.caption.muted', { style: 'max-width:96px;text-align:center', text: '64×64 pack.png' }),
          ),
          h('.grow.col.g-4',
            h('.form-grid',
              field('Pack name', textInput({
                value: p.name, onInput: val => { p.name = val; markDirty(); view.querySelector('#pack-title').textContent = val || 'Untitled'; },
              })),
              field('Namespace', textInput({
                value: p.namespace, mono: true,
                onInput: val => {
                  const clean = slugifyNamespace(val);
                  p.namespace = clean;
                  markDirty();
                },
                onChange: () => render(),
              }), `data/${p.namespace}/ · assets/${p.namespace}/`),
              field('Author', textInput({ value: p.author, placeholder: 'Your name', onInput: val => { p.author = val; markDirty(); } })),
              field('Pack version', textInput({ value: p.packVersion, mono: true, onInput: val => { p.packVersion = val; markDirty(); } })),
            ),
            field('Description', textArea({
              value: p.description, rows: 2,
              onInput: val => { p.description = val; markDirty(); },
            }), 'Shown under the pack name in Minecraft’s pack list.'),
          ),
        ),
      )),

      /* ---- Version ---- */
      panel('Minecraft version', h('.col.g-4',
        field('Target', selectInput({
          options: versionOptions(),
          value: p.mcVersion,
          onChange: val => { p.mcVersion = val; markDirty(); render(); },
        })),
        gameLinkRow(),
        v.note ? note(v.note, v.verified ? 'info' : 'warn') : null,
        h('.row.g-3',
          h('.version-card.grow',
            h('.col', h('.vc-num', { text: formatLabel(fmt.data) }), h('.vc-lbl', { text: 'Data pack format' })),
            h('.spacer'),
            fmt.verified ? badge('verified', 'accent') : badge('custom', 'warn'),
          ),
          h('.version-card.grow',
            h('.col', h('.vc-num', { text: formatLabel(fmt.resource) }), h('.vc-lbl', { text: 'Resource pack format' })),
            h('.spacer'),
            fmt.verified ? badge('verified', 'accent') : badge('custom', 'warn'),
          ),
        ),
        note(fmt.rangeShape
          ? 'This target writes the modern pack.mcmeta: min_format and max_format, with the minor number where the version has one.'
          : 'This target writes the older pack.mcmeta: a single pack_format integer, plus a supported_formats window.', 'info'),
        h('.col.g-1',
          h('.eyebrow', { text: 'What this version can do' }),
          h('.feature-list', ...FEATURE_ORDER.map(f => {
            const ok = v.features.includes(f);
            return h('.feature-row', { dataset: { ok: String(ok) } },
              h('span.fr-icon', raw(icon(ok ? 'checkCirc' : 'xCirc', 14))),
              h('span', { text: FEATURE_LABELS[f] }));
          })),
        ),
        advancedFormats(p, render),
      )),

      /* ---- Output ---- */
      panel('What gets written', h('.col.g-2',
        switchRow({
          title: 'Helper functions',
          desc: `Adds /function ${p.namespace}:give_discs and give_paintings so you can get everything in game without typing components.`,
          checked: p.settings.generateGiveFunction,
          onChange: val => { p.settings.generateGiveFunction = val; markDirty(); },
        }),
        switchRow({
          title: 'README in each pack',
          desc: 'A plain-text install guide and content list next to pack.mcmeta.',
          checked: p.settings.generateReadme,
          onChange: val => { p.settings.generateReadme = val; markDirty(); },
        }),
        switchRow({
          title: 'Embed the editable project',
          desc: 'Tucks this project into the data pack so dropping the zip back in reopens it with every layer intact. Minecraft ignores the extra file.',
          checked: p.settings.embedProjectData,
          onChange: val => { p.settings.embedProjectData = val; markDirty(); },
        }),
        switchRow({
          title: 'All paintings placeable',
          desc: 'Keeps every painting in #minecraft:placeable. Turn off to control it per painting.',
          checked: p.settings.allPlaceable,
          onChange: val => {
            p.settings.allPlaceable = val;
            if (val) for (const pt of p.paintings) pt.placeable = true;
            markDirty();
          },
        }),
      )),

      /* ---- Storage ---- */
      storagePanel(p),

      /* ---- Danger ---- */
      panel('Danger zone', h('.col.g-3',
        note('Deleting removes the project and its audio from this browser. Anything you already exported is untouched.', 'warn'),
        h('.row.g-2',
          h('button.btn.btn-danger', {
            onclick: async () => {
              const ok = await confirmDialog({
                title: `Delete “${p.name}”?`,
                message: 'This cannot be undone from inside the app.',
                confirmLabel: 'Delete pack', danger: true,
              });
              if (!ok) return;
              await deleteProject(p.id);
              setRoute('library');
              toast({ title: 'Pack deleted', kind: 'ok' });
            },
          }, raw(icon('trash', 14)), h('span', { text: 'Delete this pack' })),
        ),
      )),
    ));
  }

  bus.on('project:open', render);
  bus.on('route', r => { if (r === 'pack') render(); });
  render();
  view.refresh = render;
  return view;
}

/** Linked game first, then newest-first through the shipped table. */
function versionOptions() {
  const all = availableVersions();
  const linked = all.filter(v => v.linked);
  const rest = all.filter(v => !v.linked).reverse();
  return [...linked, ...rest].map(v => ({
    value: v.id,
    label: v.linked ? `${v.label}  ·  exact`
      : v.recommended ? `${v.label}  ·  recommended`
      : v.label,
  }));
}

/* ---- Pack icon ---------------------------------------------------------- */
function packIconSlot(p) {
  const slot = h('.packicon-slot.checker.checker-sm', h('.pi-over', { text: 'Edit' }));
  const paint = async () => {
    const bytes = await packIconBytes(p);
    clear(slot).appendChild(h('.pi-over', { text: 'Edit' }));
    if (!bytes) {
      slot.prepend(h('.center.full', { style: 'color:var(--text-4);height:100%' }, raw(icon('image', 24))));
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const img = h('img', { src: url, style: 'image-rendering:pixelated;width:100%;height:100%', onload: () => URL.revokeObjectURL(url), onerror: () => URL.revokeObjectURL(url) });
    slot.prepend(img);
  };
  paint();
  slot.addEventListener('click', () => openIconEditor(p, paint));
  return slot;
}

function openIconEditor(p, onDone) {
  if (!p.icon) {
    p.icon = { w: 64, h: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
    // Seed from whatever the pack would otherwise use.
    packIconBytes(p).then(async bytes => {
      if (!bytes) return;
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = false; g.drawImage(bmp, 0, 0, 64, 64);
      p.icon.data.set(g.getImageData(0, 0, 64, 64).data);
      ed.redraw();
    });
  }
  const doc = createPixelDoc(64, 64, { layerName: 'Icon' });
  doc.layers[0].data.set(p.icon.data);

  const host = h('div', { style: 'display:flex;min-height:0' });
  modal({
    title: 'Pack icon',
    subtitle: 'The 64×64 pack.png shown beside your pack in Minecraft’s list.',
    icon: 'image', width: 'xwide', flush: true,
    body: host,
    actions: [
      { label: 'Clear', run: () => { p.icon = null; markDirty(); onDone(); } },
      { label: 'Done', primary: true, run: () => {
          p.icon = { w: 64, h: 64, data: flatten(doc) };
          markDirty(); onDone();
        } },
    ],
    onClose: () => ed.destroy(),
  });
  const ed = new PixelEditor({ doc, filename: 'pack', onEdit: () => {} });
  ed.mount(host);
}

/* ---- Advanced formats --------------------------------------------------- */
function advancedFormats(p, rerender) {
  const v = getVersion(p.mcVersion);
  const a = p.advanced;
  const fmt = packFormats(p);

  /** A format field that accepts "107" or "107.1" and stores [major, minor]. */
  const fmtInput = (current, fallback, apply) => {
    const err = h('.field-error', { hidden: true });
    const input = h('input.input.input-mono', {
      value: current ? formatLabel(current) : '',
      placeholder: formatLabel(fallback),
      oninput: e => {
        const raw = e.target.value.trim();
        if (raw === '') { err.hidden = true; apply(null); markDirty(); return; }
        const parsed = parseFormat(raw);
        err.hidden = !!parsed;
        if (!parsed) { err.textContent = 'Use a number like 107, or 107.1'; return; }
        apply(parsed);
        markDirty();
      },
      onchange: () => rerender(),
    });
    return h('.col.g-1', input, err);
  };

  return section('Advanced', [
    note('Mojang changes these numbers most releases. If a pack shows as “incompatible” in game, set them by hand here — nothing else about the pack is affected.', 'info'),
    v.custom ? note('The Custom target exists exactly for this: a release newer than the built-in list, or a snapshot. Fill both numbers in below.', 'warn') : null,

    h('.eyebrow', { text: fmt.rangeShape ? 'min_format' : 'pack_format' }),
    h('.form-grid',
      field('Data pack', fmtInput(a.dataFormat, v.data, val => { a.dataFormat = val; })),
      field('Resource pack', fmtInput(a.resourceFormat, v.resource, val => { a.resourceFormat = val; })),
    ),

    switchRow({
      title: fmt.rangeShape ? 'Declare a max_format too' : 'Declare a supported range',
      desc: fmt.rangeShape
        ? 'Writes max_format so one zip stays valid across later patch releases.'
        : 'Writes supported_formats so one zip loads across several game versions.',
      checked: a.declareRange !== false,
      onChange: val => { a.declareRange = val; markDirty(); rerender(); },
    }),

    a.declareRange !== false ? h('div',
      h('.eyebrow', { style: 'margin-bottom:6px', text: fmt.rangeShape ? 'max_format' : 'supported_formats upper bound' }),
      h('.form-grid',
        field('Data pack', fmtInput(a.dataMaxFormat, fmt.dataMax, val => { a.dataMaxFormat = val; })),
        field('Resource pack', fmtInput(a.resourceMaxFormat, fmt.resourceMax, val => { a.resourceMaxFormat = val; })),
      ),
    ) : null,

    h('.col.g-2',
      h('.eyebrow', { text: 'Resulting pack.mcmeta' }),
      h('pre.code', { text: mcmetaPreview(p, fmt) }),
    ),

    h('button.btn.btn-sm', {
      style: 'align-self:flex-start',
      onclick: () => {
        Object.assign(a, {
          dataFormat: null, resourceFormat: null,
          dataMaxFormat: null, resourceMaxFormat: null, declareRange: true,
        });
        markDirty(); rerender();
      },
    }, raw(icon('refresh', 13)), h('span', { text: 'Reset to this version\u2019s defaults' })),
  ].filter(Boolean), { key: 'pack-advanced', open: !!v.custom });
}

/** Show exactly what will be written, so nobody has to guess. */
function mcmetaPreview(p, fmt) {
  try {
    const json = JSON.parse(mcmetaJSON(p, fmt, 'data'));
    // The description is a long text component; the formats are the point here.
    json.pack.description = '\u2026';
    return JSON.stringify(json, null, 2);
  } catch { return '{}'; }
}

/* ---- Storage ------------------------------------------------------------ */
function storagePanel(p) {
  const bodyEl = h('.col.g-3');
  const el = panel('Storage', bodyEl);
  (async () => {
    const est = await storageEstimate();
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    add(clear(bodyEl),
      h('.meta-grid',
        h('dt', { text: 'Created' }), h('dd', { text: new Date(p.createdAt).toLocaleString() }),
        h('dt', { text: 'Last saved' }), h('dd', { text: relTime(p.updatedAt) }),
        h('dt', { text: 'Project id' }), h('dd', { text: p.id }),
      ),
      est ? h('.col.g-2',
        h('.row.between',
          h('span.caption', { text: 'Browser storage used by this app' }),
          h('span.caption.mono', { text: `${formatBytes(est.usage)} of ${formatBytes(est.quota)}` })),
        h('.progress', h('.bar', { style: `width:${Math.max(1, est.pct * 100).toFixed(1)}%` })),
      ) : null,
      persisted
        ? note('This browser has marked your packs as persistent, so they survive storage pressure.', 'ok')
        : h('.col.g-2',
            note('Browsers can clear site data when space runs low. Ask for persistent storage so your packs stay put — and export anything you care about.', 'warn'),
            h('button.btn.btn-sm', {
              style: 'align-self:flex-start',
              onclick: async e => {
                const ok = await requestPersistence();
                toast({
                  title: ok ? 'Storage is now persistent' : 'The browser declined',
                  message: ok ? 'Your packs will not be evicted automatically.' : 'Keep exporting your packs as backups.',
                  kind: ok ? 'ok' : 'warn',
                });
                if (ok) e.currentTarget.replaceWith(note('This browser has marked your packs as persistent.', 'ok'));
              },
            }, raw(icon('shield', 13)), h('span', { text: 'Request persistent storage' })),
          ),
    );
  })();
  return el;
}
