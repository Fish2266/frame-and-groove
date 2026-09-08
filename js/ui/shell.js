/* ============================================================================
   Shell — chrome, routing, global shortcuts, and the app-wide drop target.
   ========================================================================= */

import { h, raw, clear, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { hasMod, keyLabel, plural, debounce } from '../core/util.js';
import {
  state,
  bus,
  setRoute,
  saveProject,
  closeProject,
  setPref,
} from '../core/store.js';
import { getVersion } from '../core/versions.js';
import { validateProject } from '../core/project.js';
import { openPalette, paletteOpen } from './cmdk.js';
import { modal, toast, switchRow, note, badge, iconButton, field, segmented, slider } from './kit.js';
import { gameLinkRow, texturePackRow, openGameLinkDialog } from './gamelink.js';
import { sfxPreview } from './sfx.js';
import { markCanvas } from './brandmark.js';
import { pixIcon } from './pixicons.js';

/* Each rail icon carries its own accent so the rail reads as five different
   places rather than five tinted copies of the same glyph. Art keeps the
   painting's own palette; the rest borrow their section's colour. */
const ROUTES = [
  { id: 'library',   label: 'Packs',  pix: 'packs',  accent: '#B99A62', needsProject: false },
  { id: 'pack',      label: 'Pack',   pix: 'pack',   accent: '#3FD98B', needsProject: true },
  { id: 'paintings', label: 'Art',    pix: 'art',    accent: '#F2B33D', needsProject: true },
  { id: 'discs',     label: 'Music',  pix: 'music',  accent: '#B084F5', needsProject: true },
  { id: 'mobs',      label: 'Mobs',   pix: 'mobs',   accent: '#5FC9E8', needsProject: true },
  { id: 'sprites',   label: 'Items',  pix: 'sprites', accent: '#E8896B', needsProject: true },
  { id: 'export',    label: 'Export', pix: 'export', accent: '#3FD98B', needsProject: true },
];

export function buildShell(views) {
  /* ---- Top bar ---- */
  const crumbs = h('.crumbs');
  const saveChip = h('.save-chip', { dataset: { state: 'idle' } }, h('.dot'), h('span', { text: '' }));

  const topbar = h('.topbar',
    h('.logo.no-drag',
      h('.logo-mark', markCanvas(28)),
      h('.col',
        h('.logo-word', 'Frame ', h('em', '&'), ' Groove'),
      ),
    ),
    h('.divider-v', { style: 'height:20px;margin:0 4px' }),
    crumbs,
    h('.spacer'),
    saveChip,
    h('button.btn.btn-sm.btn-ghost.no-drag', {
      'data-tip': `Command palette  ${keyLabel('mod+K')}`, 'data-tip-pos': 'bottom',
      onclick: () => palette(),
    }, raw(icon('search', 14)), h('span.caption', { text: keyLabel('mod+K') })),
    iconButton('keyboard', { tip: 'Keyboard shortcuts  ?', pos: 'bottom', cls: 'btn-ghost btn-sm no-drag', onClick: () => showShortcuts() }),
    iconButton('sliders', { tip: 'Preferences', pos: 'left', cls: 'btn-ghost btn-sm no-drag', onClick: e => showPreferences(e.currentTarget) }),
  );

  /* ---- Rail ---- */
  const rail = h('.rail');
  const railBtns = new Map();
  for (const r of ROUTES) {
    if (r.id === 'pack') rail.appendChild(h('.rail-sep'));
    const b = h('button.rail-btn', {
      'aria-current': 'false',
      dataset: { route: r.id },
      'data-tip': r.label, 'data-tip-pos': 'right',
      onclick: () => setRoute(r.id),
    }, h('span.rb-icon', pixIcon(r.pix, 2, { accent: r.accent, accentLight: r.accent })),
       h('span.rb-label', { text: r.label }));
    railBtns.set(r.id, b);
    rail.appendChild(b);
  }
  rail.appendChild(h('.spacer'));
  const themeBtn = h('button.rail-btn', {
    'data-tip-pos': 'right',
    onclick: () => setPref('theme', state.prefs.theme === 'bone' ? 'deepslate' : 'bone'),
  });
  /* The label describes where the button takes you, not where you are — and it
     re-syncs on any preference change, so the Preferences sheet cannot leave
     this button telling a different story. */
  const syncThemeBtn = () => {
    const goingDark = state.prefs.theme === 'bone';
    themeBtn.innerHTML = icon(goingDark ? 'moon' : 'sun', 19);
    themeBtn.appendChild(h('span.rb-label', { text: goingDark ? 'Dark' : 'Light' }));
    themeBtn.dataset.tip = goingDark ? 'Switch to dark' : 'Switch to light';
  };
  syncThemeBtn();
  bus.on('prefs', key => { if (key === 'theme') syncThemeBtn(); });
  rail.appendChild(themeBtn);

  /* ---- View host ---- */
  const viewhost = h('.viewhost');
  for (const [id, el] of Object.entries(views)) { el.hidden = true; el.dataset.route = id; viewhost.appendChild(el); }

  const shell = h('.shell', rail, viewhost);
  const app = h('#app', topbar, shell);

  /* ---- Routing ---- */
  function applyRoute(route) {
    const hasProject = !!state.project;
    for (const r of ROUTES) {
      const b = railBtns.get(r.id);
      b.setAttribute('aria-current', String(r.id === route));
      b.disabled = r.needsProject && !hasProject;
    }
    for (const [id, el] of Object.entries(views)) el.hidden = id !== route;
    views[route]?.refresh?.();
    renderCrumbs(route);
    document.documentElement.dataset.route = route;
    document.documentElement.setAttribute('data-domain',
      route === 'paintings' ? 'paintings' : route === 'discs' ? 'discs' : '');
  }

  function renderCrumbs(route) {
    clear(crumbs);
    const p = state.project;
    if (!p) { crumbs.appendChild(h('span.crumb.current', { text: 'Library' })); return; }
    crumbs.append(
      h('button.crumb', { text: 'Library', onclick: () => setRoute('library') }),
      h('span.sep', raw(icon('chevRight', 12))),
      h('button.crumb', { text: p.name || 'Untitled', onclick: () => setRoute('pack') }),
    );
    const cur = ROUTES.find(r => r.id === route);
    if (route !== 'library' && route !== 'pack') {
      crumbs.append(h('span.sep', raw(icon('chevRight', 12))), h('span.crumb.current', { text: cur.label }));
    }
    crumbs.append(h('span', { style: 'margin-left:8px' }, badge(getVersion(p.mcVersion).label)));
  }

  /* A quiet dot on Export when the pack will not build, so problems surface
     while you are still working rather than at the moment you try to ship. */
  const syncFlags = debounce(() => {
    const btn = railBtns.get('export');
    btn.querySelector('.rb-flag')?.remove();
    if (!state.project) return;
    const { errors, warnings } = validateProject(state.project);
    if (!errors.length && !warnings.length) return;
    const kind = errors.length ? 'error' : 'warn';
    const n = errors.length || warnings.length;
    btn.appendChild(h('span.rb-flag', { dataset: { kind } }));
    btn.dataset.tip = `Export — ${plural(n, errors.length ? 'problem' : 'note')}`;
  }, 400);

  bus.on('route', applyRoute);
  bus.on('project:open', () => { applyRoute(state.route); renderCrumbs(state.route); syncFlags(); });
  bus.on('project:close', () => { applyRoute('library'); });
  bus.on('project:dirty', syncFlags);
  bus.on('project:saved', syncFlags);

  /* ---- Save indicator ---- */
  let saveTimer;
  const setSave = (mode, text) => {
    saveChip.dataset.state = mode;
    saveChip.querySelector('span').textContent = text;
  };
  bus.on('project:dirty', () => setSave('dirty', 'Unsaved'));
  bus.on('save:state', (s, err) => {
    clearTimeout(saveTimer);
    if (s === 'saving') setSave('saving', 'Saving…');
    else if (s === 'saved') {
      setSave('saved', 'Saved');
      saveTimer = setTimeout(() => setSave('idle', ''), 2600);
    } else setSave('error', 'Save failed');
    if (s === 'error') toast({ title: 'Could not save', message: err?.message, kind: 'error' });
  });

  /* ---- Global keys ---- */
  on(window, 'keydown', e => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;

    if (hasMod(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
    if (hasMod(e) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject().then(() => toast({ title: 'Saved', kind: 'ok', duration: 1400 })); return; }
    if (typing || paletteOpen() || document.querySelector('.overlay')) return;

    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
    if (hasMod(e) && e.key >= '1' && e.key <= '7') {
      e.preventDefault();
      const r = ROUTES[+e.key - 1];
      if (r && !(r.needsProject && !state.project)) setRoute(r.id);
    }
  });

  /* ---- Global drop ---- */
  let dropOverlay = null;
  let dragDepth = 0;
  const showDrop = () => {
    if (dropOverlay) return;
    dropOverlay = h('.global-drop',
      h('.gd-card',
        h('span', { style: 'color:var(--accent)' }, raw(icon('package', 34))),
        h('.title-sm', { text: 'Drop to import' }),
        h('.caption', { text: 'Pack zips open as projects · images and audio go into what you have open' }),
      ));
    document.body.appendChild(dropOverlay);
  };
  const hideDrop = () => { dropOverlay?.remove(); dropOverlay = null; dragDepth = 0; };

  on(window, 'dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; showDrop(); } });
  on(window, 'dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  on(window, 'dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hideDrop(); });
  on(window, 'drop', async e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    hideDrop();
    const file = e.dataTransfer.files[0];
    const name = file.name.toLowerCase();
    if (name.endsWith('.zip')) {
      const { openImportFlow } = await import('./views/library.js');
      setRoute('library');
      openImportFlow(file);
    } else if (file.type.startsWith('audio/')) {
      if (!state.project) { toast({ title: 'Open a pack first', message: 'Audio needs somewhere to live.', kind: 'warn' }); return; }
      setRoute('discs');
      bus.emit('drop:audio', file);
    } else if (file.type.startsWith('image/')) {
      if (!state.project) { toast({ title: 'Open a pack first', kind: 'warn' }); return; }
      bus.emit('drop:image', file);
    } else {
      toast({ title: 'Not something this app reads', message: file.name, kind: 'warn' });
    }
  });

  /* ---- Beforeunload guard ---- */
  on(window, 'beforeunload', e => {
    if (state.projectDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  applyRoute(state.route);
  return app;
}

/* ========================================================================= */
/* PALETTE                                                                   */
/* ========================================================================= */

function palette() {
  const cmds = [];
  const p = state.project;

  cmds.push(
    { group: 'Go', label: 'Library', icon: 'library', key: 'mod+1', weight: 10, run: () => setRoute('library') },
  );
  if (p) {
    cmds.push(
      { group: 'Go', label: 'Pack settings', icon: 'package', key: 'mod+2', weight: 9, run: () => setRoute('pack') },
      { group: 'Go', label: 'Paintings', icon: 'frame', key: 'mod+3', weight: 9, run: () => setRoute('paintings') },
      { group: 'Go', label: 'Music discs', icon: 'disc', key: 'mod+4', weight: 9, run: () => setRoute('discs') },
      { group: 'Go', label: 'Export', icon: 'download', key: 'mod+5', weight: 9, run: () => setRoute('export') },
      { group: 'Create', label: 'New painting', icon: 'plus', weight: 8, run: () => { setRoute('paintings'); setTimeout(() => bus.emit('cmd:new-painting'), 40); } },
      { group: 'Create', label: 'New music disc', icon: 'plus', weight: 8, run: () => { setRoute('discs'); setTimeout(() => bus.emit('cmd:new-disc'), 40); } },
      { group: 'Create', label: 'New mob variant', icon: 'plus', weight: 8, keywords: 'cow pig chicken frog wolf cat spawn biome', run: () => { setRoute('mobs'); setTimeout(() => bus.emit('cmd:new-mob'), 40); } },
    { group: 'Create', label: 'New renamed sprite', icon: 'plus', weight: 8, keywords: 'item texture anvil rename sword custom name', run: () => { setRoute('sprites'); setTimeout(() => bus.emit('cmd:new-sprite'), 40); } },
      { group: 'Pack', label: 'Save now', icon: 'save', key: 'mod+S', run: () => saveProject().then(() => toast({ title: 'Saved', kind: 'ok', duration: 1400 })) },
      { group: 'Pack', label: 'Close pack', icon: 'x', run: async () => { await closeProject(); setRoute('library'); } },
    );
    for (const pt of p.paintings) {
      cmds.push({
        group: 'Paintings', label: pt.title || pt.id, icon: 'frame',
        keywords: `painting ${pt.id}`, hint: `${pt.w}×${pt.h}`,
        run: () => { state.selPainting = pt.key; setRoute('paintings', { force: true }); },
      });
    }
    for (const d of p.discs) {
      cmds.push({
        group: 'Discs', label: d.name || d.id, icon: 'disc',
        keywords: `disc song ${d.id}`,
        run: () => { state.selDisc = d.key; setRoute('discs', { force: true }); },
      });
    }
  }
  cmds.push(
    { group: 'Create', label: 'New pack', icon: 'package', weight: 7, run: async () => { const m = await import('./views/library.js'); m.openNewProjectDialog(); } },
    { group: 'Create', label: 'Import a pack', icon: 'upload', weight: 6, run: async () => { const m = await import('./views/library.js'); setRoute('library'); m.openImportFlow(); } },
    { group: 'Create', label: 'Open the sampler', icon: 'sparkle', weight: 5, keywords: 'sample demo example', run: async () => { const m = await import('./views/library.js'); m.openSampleFlow(); } },
    { group: 'App', label: state.prefs.theme === 'bone' ? 'Switch to dark' : 'Switch to light', icon: state.prefs.theme === 'bone' ? 'moon' : 'sun', run: () => setPref('theme', state.prefs.theme === 'bone' ? 'deepslate' : 'bone') },
    { group: 'App', label: 'Preferences', icon: 'sliders', run: () => showPreferences() },
    { group: 'App', label: 'Link your Minecraft', icon: 'cube', keywords: 'jar textures assets real game', run: () => openGameLinkDialog() },
    { group: 'App', label: 'Keyboard shortcuts', icon: 'keyboard', key: '?', run: () => showShortcuts() },
  );
  openPalette(cmds);
}

/* ========================================================================= */
/* PREFERENCES                                                               */
/* ========================================================================= */

export function showPreferences() {
  modal({
    title: 'Preferences',
    icon: 'sliders',
    body: h('.col.g-2',
      field('Textures', texturePackRow()),
      field('Game data', gameLinkRow(),
        'Optional. Adds exact pack formats and the vanilla loot tables that creeper and chest drops need.'),
      h('.divider'),
      field('Theme', segmented({
        options: [
          { value: 'deepslate', label: 'Deepslate', icon: 'moon' },
          { value: 'bone', label: 'Bone', icon: 'sun' },
        ],
        value: state.prefs.theme, block: true, large: true,
        onChange: v => setPref('theme', v),
      })),
      h('.divider'),
      switchRow({
        title: 'Block textures',
        desc: 'Generated stone and deepslate under the chrome. Off gives a flat, plain surface.',
        checked: state.prefs.textures !== false,
        onChange: v => { setPref('textures', v); document.documentElement.dataset.textures = v ? 'on' : 'off'; },
      }),
      switchRow({
        title: 'Stone grain',
        desc: 'A very fine noise over the whole app. Turn it off for a flatter look.',
        checked: state.prefs.grain, onChange: v => setPref('grain', v),
      }),
      h('.divider'),
      switchRow({
        title: 'Interface sounds',
        desc: 'Short synthesised clicks, the way the game\u2019s menus behave. Nothing is loaded — they are generated on the spot.',
        checked: state.prefs.sound !== false,
        onChange: v => { setPref('sound', v); if (v) sfxPreview('ok'); },
      }),
      field('Volume', h('.row.g-2',
        h('.grow', slider({
          min: 0, max: 100, value: state.prefs.soundVolume ?? 55,
          onInput: v => { state.prefs.soundVolume = v; },
          onChange: v => { setPref('soundVolume', v); sfxPreview('click'); },
          format: v => `${v}%`,
        })),
        h('button.btn.btn-sm', { dataset: { quiet: '' }, onclick: () => sfxPreview('place') },
          raw(icon('volume', 13)), h('span', { text: 'Test' })),
      )),
      h('.divider'),
      switchRow({
        title: 'Reduce motion',
        desc: 'Cuts transitions and animation for a calmer interface.',
        checked: state.prefs.reduceMotion, onChange: v => setPref('reduceMotion', v),
      }),
      h('.divider'),
      switchRow({
        title: 'Pixel grid by default',
        desc: 'Show the one-pixel grid whenever an editor opens.',
        checked: state.prefs.pixelGrid, onChange: v => setPref('pixelGrid', v),
      }),
      switchRow({
        title: 'Block grid by default',
        desc: 'Mark every sixteen pixels, so you can see where the blocks fall.',
        checked: state.prefs.blockGrid, onChange: v => setPref('blockGrid', v),
      }),
      h('.divider'),
      h('.caption.muted', { text: 'Everything you make is stored in this browser and never leaves your machine. There are no accounts, no analytics and no servers — the microphone is only ever read while you are actually recording.' }),
      h('.divider'),
      h('.caption.muted', { text: 'Frame \u0026 Groove is a free, unofficial fan tool, offered as is with no warranty. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.' }),
    ),
    actions: [{ label: 'Done', primary: true }],
  });
}

/* ========================================================================= */
/* SHORTCUTS                                                                 */
/* ========================================================================= */

const SHORTCUTS = [
  ['Everywhere', [
    ['mod+K', 'Command palette'],
    ['mod+S', 'Save now'],
    ['mod+1…7', 'Jump between sections'],
    ['?', 'This sheet'],
  ]],
  ['Editor — tools', [
    ['B', 'Pencil'], ['E', 'Eraser'], ['G', 'Fill'], ['I', 'Eyedropper'],
    ['L', 'Line'], ['R', 'Rectangle'], ['O', 'Ellipse'], ['N', 'Gradient'],
    ['S', 'Shade'], ['M', 'Select'], ['W', 'Magic wand'], ['V', 'Move'], ['H', 'Pan'],
  ]],
  ['Editor — canvas', [
    ['Space drag', 'Pan'],
    ['mod+scroll', 'Zoom'],
    ['0', 'Fit to window'],
    ['1', 'Zoom to 100%'],
    ['[ / ]', 'Brush size'],
    ['X', 'Swap colours'],
    ['Alt', 'Temporary eyedropper'],
    ['Right drag', 'Draw with the secondary colour'],
  ]],
  ['Editor — edit', [
    ['mod+Z', 'Undo'],
    ['mod+Shift+Z', 'Redo'],
    ['mod+A', 'Select all'],
    ['mod+D', 'Deselect'],
    ['mod+C / mod+V', 'Copy / paste'],
    ['Delete', 'Clear layer or selection'],
  ]],
];

export function showShortcuts() {
  modal({
    title: 'Keyboard shortcuts',
    icon: 'keyboard', width: 'wide',
    body: h('.col.g-5',
      ...SHORTCUTS.map(([group, rows]) => h('.col.g-2',
        h('.eyebrow', { text: group }),
        h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 20px' },
          ...rows.map(([k, label]) => h('.row.between.g-3',
            h('span.body-sm', { text: label }),
            h('span.row.g-1', ...keyLabel(k).split(/(?<=\S)\s(?=\S)/).map(part => h('kbd', { text: part }))),
          )),
        ),
      )),
    ),
    actions: [{ label: 'Close', primary: true }],
  });
}
