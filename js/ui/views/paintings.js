/* ============================================================================
   Paintings — list, editor, and everything that makes one a painting rather
   than a rectangle of pixels: block size, an adaptive frame, and the title
   card the game shows.
   ========================================================================= */

import { h, raw, clear, $$, observeResize } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { slugifyId, titleCase, copyText } from '../../core/util.js';
import { state, bus, markDirty, selectPainting, currentPainting } from '../../core/store.js';
import {
  createPainting,
  docRescale,
  docResize,
  docIsEmpty,
  docClone,
  FRAME_STYLES,
  nextUniqueId,
  suggestPaintingName,
} from '../../core/project.js';
import { PIXELS_PER_BLOCK, PAINTING_PRESETS, MAX_PAINTING_BLOCKS, MC_COLORS, getVersion, FEATURES } from '../../core/versions.js';
import { PixelEditor } from '../editor.js';
import { paintingThumbCanvas } from '../thumbs.js';
import { paintingCanvas } from '../../paint/compose.js';
import { drawPaintingScene, wallBlocks, allWallBlocks, getWallBlock, DEFAULT_WALL } from '../pixelart.js';
import { openVanillaPaintingPicker } from '../vanillapaintings.js';
import { textureURL, decodeTexture } from '../../core/texturepack.js';
;
import { frameSwatch, autoThickness } from '../../paint/frames.js';
import {
  section,
  iconButton,
  toast,
  contextMenu,
  confirmDialog,
  modal,
  field,
  textInput,
  segmented,
  switchRow,
  emptyState,
  note,
  codeBlock,
  makeSortable,
} from '../kit.js';
import { givePaintingCommand } from '../../export/packbuild.js';

export function buildPaintingsView() {
  const list = h('.wk-sidebar-list');

  let filter = '';
  const filterInput = h('input.input.input-sm', {
    type: 'search', placeholder: 'Filter…',
    oninput: e => { filter = e.target.value.trim().toLowerCase(); renderList(); },
  });
  const filterRow = h('div', { hidden: true }, filterInput);

  const host = h('.grow', { style: 'display:flex;min-width:0' });
  let editor = null;

  const view = h('.view', { dataset: { view: 'paintings' } },
    h('.workspace',
      h('.wk-sidebar',
        h('.wk-sidebar-head',
          h('.row.between.g-2',
            h('span.eyebrow', { text: 'Paintings' }),
            iconButton('plus', { tip: 'New painting', pos: 'left', cls: 'btn-sm', onClick: e => newMenu(e.currentTarget) }),
          ),
          filterRow,
        ),
        list,
        h('.wk-sidebar-foot',
          h('button.btn.btn-block.btn-sm', { onclick: e => newMenu(e.currentTarget) },
            raw(icon('plus', 13)), h('span', { text: 'New painting' }), raw(icon('chevDown', 11))),
        ),
      ),
      host,
    ),
  );

  function renderList() {
    clear(list);
    const p = state.project;
    if (!p) return;
    // The filter only earns its space once the list is long enough to need it.
    filterRow.hidden = p.paintings.length < 7;
    if (filterRow.hidden) filter = '';
    if (!p.paintings.length) {
      list.appendChild(h('.col.g-2.p-3.center', { style: 'text-align:center;color:var(--text-4)' },
        raw(icon('frame', 26)),
        h('.caption', { text: 'No paintings yet.' }),
      ));
      return;
    }
    const shown = filter
      ? p.paintings.filter(x => (x.title || '').toLowerCase().includes(filter) || x.id.includes(filter))
      : p.paintings;

    if (!shown.length) {
      list.appendChild(h('.caption.muted.p-3', { style: 'text-align:center', text: `Nothing matches “${filter}”.` }));
      return;
    }

    for (const pt of shown) {
      const row = h('.list-row', {
        'aria-selected': String(pt.key === state.selPainting),
        dataset: { index: p.paintings.indexOf(pt) },
        onclick: () => select(pt.key),
        oncontextmenu: e => { e.preventDefault(); rowMenu(pt, { x: e.clientX, y: e.clientY }); },
      },
        h('.lr-thumb.checker.checker-sm', paintingThumbCanvas(pt, 34)),
        h('.lr-main',
          h('.lr-title.truncate', { text: pt.title || pt.id }),
          h('.lr-sub.truncate', { text: `${pt.w}×${pt.h} · ${pt.id}` }),
        ),
        pt.placeable ? null : h('span', { style: 'color:var(--text-4)', 'data-tip': 'Not in the placeable tag', 'data-tip-pos': 'left' }, raw(icon('eyeOff', 12))),
        h('.lr-actions',
          iconButton('more', { tip: '', cls: 'btn-sm btn-ghost', onClick: e => { e.stopPropagation(); rowMenu(pt, e.currentTarget); } }),
        ),
      );
      list.appendChild(row);
    }

    // Reordering is only meaningful over the whole list, not a filtered view.
    if (!filter) {
      makeSortable(list, {
        onReorder: (from, to) => {
          const [moved] = p.paintings.splice(from, 1);
          p.paintings.splice(to, 0, moved);
          markDirty('painting:reorder');
          renderList();
        },
      });
    }
  }

  function rowMenu(pt, at) {
    contextMenu([
      { label: 'Rename…', icon: 'type', run: () => renamePainting(pt) },
      { label: 'Duplicate', icon: 'duplicate', run: () => duplicatePainting(pt) },
      { label: 'Export PNG', icon: 'download', run: () => exportPaintingPNG(pt) },
      '-',
      { label: 'Copy /give command', icon: 'copy', run: async () => {
          await copyText(givePaintingCommand(state.project, pt, { includeSlash: true }));
          toast({ title: 'Command copied', kind: 'ok', duration: 1800 });
        } },
      '-',
      { label: 'Delete', icon: 'trash', destructive: true, run: () => deletePainting(pt) },
    ], at);
  }

  function select(key) {
    selectPainting(key);
    renderList();
    mountEditor();
  }

  function mountEditor() {
    const pt = currentPainting();
    editor?.destroy();
    editor = null;
    clear(host);

    if (!state.project?.paintings.length) {
      host.appendChild(h('.grow.center',
        emptyState({
          scene: 'frame',
          title: 'No paintings yet',
          message: 'A painting is a PNG at sixteen pixels per block, plus a registry entry that tells the game how big it is. Make one and both get written for you.',
          action: h('.row.g-2.wrap',
            h('button.btn.btn-lg.btn-primary', { onclick: () => addPainting() },
              raw(icon('plus', 15)), h('span', { text: 'New painting' })),
            h('button.btn.btn-lg', { onclick: () => addPainting({ fromImage: true }) },
              raw(icon('image', 15)), h('span', { text: 'From an image' })),
            h('button.btn.btn-lg', { onclick: () => addFromVanilla() },
              raw(icon('frame', 15)), h('span', { text: 'From a vanilla painting' })),
          ),
        }),
      ));
      return;
    }
    if (!pt) { select(state.project.paintings[0].key); return; }

    editor = new PixelEditor({
      doc: pt.doc,
      blockSize: PIXELS_PER_BLOCK,
      filename: pt.id,
      frameOf: () => ({ frame: pt.frame, blocksW: pt.w, blocksH: pt.h }),
      extraPanels: () => paintingPanels(pt, () => editor, () => { renderList(); editor?.redraw(); }),
      onEdit: () => { renderList(); bus.emit('painting:changed', pt); },
    });
    editor.mount(host);
  }

  /** Three ways in, because a blank canvas is the worst of them. */
  function newMenu(anchor) {
    contextMenu([
      { label: 'Blank painting', icon: 'plus', run: () => addPainting() },
      { label: 'From an image\u2026', icon: 'image', run: () => addPainting({ fromImage: true }) },
      { label: 'From a vanilla painting\u2026', icon: 'frame', run: () => addFromVanilla() },
    ], anchor);
  }

  /** Open one of the bundled vanilla paintings as a starting canvas. */
  function addFromVanilla() {
    openVanillaPaintingPicker(pick => {
      const p = state.project;
      const pt = createPainting(titleCase(pick.id), pick.w, pick.h);
      pt.id = nextUniqueId(slugifyId(pick.id), p.paintings.map(x => x.id));
      pt.title = titleCase(pick.id);
      pt.author = '';
      pt.doc.layers[0].name = 'Vanilla';
      pt.doc.layers[0].data.set(pick.imageData.data);
      p.paintings.push(pt);
      markDirty('painting:add');
      select(pt.key);
      toast({
        title: `Opened “${titleCase(pick.id)}”`,
        message: `${pick.w}×${pick.h} blocks. It is a starting canvas — paint over it.`,
        kind: 'ok',
      });
    });
  }

  function addPainting(opts = {}) {
    const p = state.project;
    const name = suggestPaintingName(p);
    const pt = createPainting(name, 2, 2);
    pt.id = nextUniqueId(slugifyId(name), p.paintings.map(x => x.id));
    p.paintings.push(pt);
    markDirty('painting:add');
    select(pt.key);
    if (opts.fromImage) setTimeout(() => import('../importdialog.js').then(m => m.openImportDialog(editor)), 60);
  }

  async function renamePainting(pt) {
    const { promptDialog } = await import('../kit.js');
    const v = await promptDialog({
      title: 'Rename painting', label: 'Title', value: pt.title,
      hint: 'Shown on the painting’s info card in game.',
    });
    if (v == null) return;
    pt.title = v;
    markDirty(); renderList(); editor?.refreshPanels();
  }

  function duplicatePainting(pt) {
    const p = state.project;
    const copy = {
      ...pt, key: `pnt_${Math.random().toString(36).slice(2, 10)}`,
      id: nextUniqueId(pt.id + '_copy', p.paintings.map(x => x.id)),
      title: pt.title + ' copy',
      doc: { ...pt.doc, layers: pt.doc.layers.map(l => ({ ...l, data: new Uint8ClampedArray(l.data) })) },
      frame: { ...pt.frame },
    };
    p.paintings.splice(p.paintings.indexOf(pt) + 1, 0, copy);
    markDirty(); select(copy.key);
    toast({ title: 'Painting duplicated', kind: 'ok', duration: 1800 });
  }

  async function deletePainting(pt) {
    const ok = await confirmDialog({
      title: `Delete “${pt.title || pt.id}”?`,
      message: 'The artwork and its registry entry are removed from this pack.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const p = state.project;
    const i = p.paintings.indexOf(pt);
    p.paintings.splice(i, 1);
    markDirty();
    selectPainting(p.paintings[Math.min(i, p.paintings.length - 1)]?.key || null);
    renderList(); mountEditor();
  }

  async function exportPaintingPNG(pt) {
    const { paintingCanvas } = await import('../../paint/compose.js');
    const { canvasToBlob, downloadBlob } = await import('../../core/util.js');
    const blob = await canvasToBlob(paintingCanvas(pt));
    downloadBlob(blob, `${pt.id}.png`);
  }

  view.refresh = () => { renderList(); mountEditor(); };
  view.addPainting = addPainting;
  view.destroy = () => editor?.destroy();
  bus.on('project:open', () => view.refresh());
  return view;
}

/* ========================================================================= */
/* INSPECTOR PANELS                                                          */
/* ========================================================================= */

function paintingPanels(pt, getEditor, onChange) {
  const project = state.project;
  const v = getVersion(project.mcVersion);
  const canPaint = v.features.includes(FEATURES.PAINTING_VARIANTS);

  /* ---- Identity ---- */
  const titleInput = textInput({
    value: pt.title, placeholder: 'Untitled',
    onInput: val => { pt.title = val; markDirty(); onChange(); },
  });
  const authorInput = textInput({
    value: pt.author, placeholder: 'Your name',
    onInput: val => { pt.author = val; markDirty(); },
  });
  const idInput = textInput({
    value: pt.id, mono: true,
    onInput: val => {
      const clean = slugifyId(val, pt.id);
      pt.id = clean;
      if (idInput.value !== clean) idInput.value = clean;
      markDirty(); onChange();
    },
  });

  const colorSel = (current, onPick) => h('.row.g-1.wrap',
    ...MC_COLORS.map(c => h('button.swatch', {
      style: { background: c.hex, width: '17px', height: '17px' },
      title: titleCase(c.id),
      'aria-pressed': String(c.id === current),
      onclick: e => {
        onPick(c.id);
        $$('.swatch', e.currentTarget.parentElement).forEach(s => s.setAttribute('aria-pressed', String(s === e.currentTarget)));
      },
    })),
  );

  const identity = section('Painting', [
    field('Title', titleInput),
    field('Title colour', colorSel(pt.titleColor, v2 => { pt.titleColor = v2; markDirty(); })),
    field('Author', authorInput),
    field('Author colour', colorSel(pt.authorColor, v2 => { pt.authorColor = v2; markDirty(); })),
    field('Resource id', idInput, `Written to data/${project.namespace}/painting_variant/${pt.id}.json`),
  ], { key: 'pt-identity' });

  /* ---- Size ---- */
  const readout = h('.size-readout', { text: `${pt.w} × ${pt.h} blocks · ${pt.w * PIXELS_PER_BLOCK} × ${pt.h * PIXELS_PER_BLOCK} px` });
  const picker = h('.size-picker', {
    style: `grid-template-columns:repeat(${MAX_PAINTING_BLOCKS},1fr)`,
    onmouseleave: () => paintCells(pt.w, pt.h),
  });
  const cells = [];
  for (let y = 1; y <= MAX_PAINTING_BLOCKS; y++) {
    for (let x = 1; x <= MAX_PAINTING_BLOCKS; x++) {
      const cell = h('.size-cell', {
        dataset: { x, y },
        title: `${x} × ${y}`,
        onmouseenter: () => paintCells(x, y),
        onclick: () => changeSize(x, y),
      });
      cells.push(cell); picker.appendChild(cell);
    }
  }
  function paintCells(w, hh) {
    for (const c of cells) c.dataset.in = String(+c.dataset.x <= w && +c.dataset.y <= hh);
    readout.textContent = `${w} × ${hh} blocks · ${w * PIXELS_PER_BLOCK} × ${hh * PIXELS_PER_BLOCK} px`;
  }
  paintCells(pt.w, pt.h);

  async function changeSize(w, hh) {
    if (w === pt.w && hh === pt.h) return;
    const nw = w * PIXELS_PER_BLOCK, nh = hh * PIXELS_PER_BLOCK;
    let mode = 'extend';
    if (!docIsEmpty(pt.doc)) {
      mode = await askResizeMode(pt, w, hh);
      if (!mode) { paintCells(pt.w, pt.h); return; }
    }

    /* Resizing throws pixels away, so it belongs in the undo timeline like
       any other destructive edit. Snapshot both ends and swap between them. */
    const before = { w: pt.w, h: pt.h, doc: docClone(pt.doc) };
    if (mode === 'rescale') docRescale(pt.doc, nw, nh);
    else docResize(pt.doc, nw, nh, 'center');
    pt.w = w; pt.h = hh;
    const after = { w: pt.w, h: pt.h, doc: docClone(pt.doc) };

    const restore = snap => {
      pt.w = snap.w; pt.h = snap.h;
      pt.doc.w = snap.doc.w; pt.doc.h = snap.doc.h;
      pt.doc.active = snap.doc.active;
      pt.doc.layers = snap.doc.layers.map(l => ({ ...l, data: new Uint8ClampedArray(l.data) }));
      // The editor's canvases are sized to the old document; rebuild them.
      getEditor()?.resized();
      markDirty();
      onChange();
      bus.emit('painting:resized', pt);
    };
    state.history.push({
      label: `Resize to ${w}\u00D7${hh}`, icon: 'crop',
      undo: () => restore(before),
      redo: () => restore(after),
    });

    getEditor()?.resized();
    markDirty();
    onChange();
    bus.emit('painting:resized', pt);
    getEditor()?.refreshPanels();
  }

  const presets = h('.row.g-1.wrap',
    ...PAINTING_PRESETS.map(p => h('button.btn.btn-sm.btn-ghost', {
      style: 'padding:0 6px;height:22px;font-size:11px',
      title: `Vanilla sizes: ${p.name}`,
      onclick: () => changeSize(p.w, p.h),
    }, `${p.w}×${p.h}`)),
  );

  const sizeSection = section('Size', [
    picker, readout,
    h('.eyebrow', { style: 'margin-top:4px', text: 'Vanilla sizes' }),
    presets,
  ], { key: 'pt-size' });

  /* ---- Frame ---- */
  const frameGrid = h('.frame-grid');
  for (const f of FRAME_STYLES) {
    const cnv = h('canvas', { width: 22, height: 22 });
    if (f.id === 'none') {
      const g = cnv.getContext('2d');
      g.fillStyle = '#5C6268'; g.fillRect(0, 0, 22, 22);
      g.strokeStyle = 'rgba(255,255,255,.25)';
      g.beginPath(); g.moveTo(4, 18); g.lineTo(18, 4); g.stroke();
    } else {
      const sw = frameSwatch(f.id, 22, Math.min(pt.w, pt.h));
      cnv.getContext('2d').putImageData(new ImageData(sw.data, 22, 22), 0, 0);
    }
    frameGrid.appendChild(h('button.frame-opt', {
      'aria-pressed': String(pt.frame.style === f.id),
      onclick: e => {
        pt.frame.style = f.id;
        $$('.frame-opt', frameGrid).forEach(o => o.setAttribute('aria-pressed', String(o === e.currentTarget)));
        markDirty(); onChange();
      },
    }, cnv, h('.fo-name', { text: f.name })));
  }

  const thickRow = segmented({
    options: [
      { value: 0, label: 'Auto' }, { value: 1, label: 'Thin' },
      { value: 2, label: 'Med' }, { value: 3, label: 'Thick' },
    ],
    value: pt.frame.thickness ?? 0, block: true,
    onChange: val => { pt.frame.thickness = +val; markDirty(); onChange(); },
  });

  const frameSection = section('Frame', [
    frameGrid,
    h('.caption.muted', { text: `Frames redraw for the painting’s size — auto uses ${autoThickness(pt.w, pt.h)}px here.` }),
    field('Thickness', thickRow),
    switchRow({
      title: 'Inner shadow', desc: 'A one-pixel edge so the art sits inside the frame.',
      checked: pt.frame.inner !== false,
      onChange: val => { pt.frame.inner = val; markDirty(); onChange(); },
    }),
  ], { key: 'pt-frame', count: pt.frame.style === 'none' ? null : undefined });

  /* ---- Behaviour ---- */
  const behaviour = section('In game', [
    switchRow({
      title: 'Can appear on walls',
      desc: 'Adds it to #minecraft:placeable so a blank painting can turn into this one.',
      checked: pt.placeable,
      onChange: val => { pt.placeable = val; markDirty(); onChange(); },
    }),
    !canPaint ? note(`${getVersion(project.mcVersion).label} cannot register new paintings. Switch to 1.21.2 or newer in Pack Settings.`, 'danger') : null,
    codeBlock(givePaintingCommand(project, pt, { includeSlash: true }), { label: 'Give this painting' }),
  ], { key: 'pt-behaviour', open: false });

  /* ---- Preview ---- */
  const sceneCanvas = h('canvas.wall-scene');
  const wallBox = h('.wall-box', sceneCanvas);
  const scaleNote = h('.caption.muted');

  const wallPicker = h('.wall-picker');

  const paintPicker = () => {
    clear(wallPicker);
    const current = pt.wallBlock || DEFAULT_WALL;
    const shown = wallBlocks();
    // Whatever is selected must always appear, even when it came from the
    // full block list rather than the shortlist.
    if (!shown.some(b => b.id === current)) shown.unshift(getWallBlock(current));
    for (const b of shown) {
      const url = textureURL(b.game);
      wallPicker.appendChild(h('button.wall-chip', {
        'aria-pressed': String(current === b.id),
        title: b.name,
        onclick: () => { setWall(b.id); },
      },
        h('span.wc-swatch', url ? { style: { backgroundImage: `url("${url}")` } } : { dataset: { block: b.gen } }),
        h('span.wc-name', { text: b.name.split(' ')[0] }),
      ));
    }
    wallPicker.appendChild(h('button.wall-chip.wall-chip-more', {
      title: 'Every block in the pack',
      onclick: () => openWallBrowser(pt.wallBlock || DEFAULT_WALL, setWall),
    }, h('span.wc-swatch.wc-more', raw(icon('more', 14))), h('span.wc-name', { text: 'More' })));
  };

  const setWall = async id => {
    pt.wallBlock = id;
    markDirty();
    await decodeTexture(getWallBlock(id).game);
    paintPicker();
    paintPreview();
  };

  const preview = section('On the wall', [
    wallBox,
    h('.row.between.g-2', scaleNote, null),
    h('.eyebrow', { text: 'Wall block' }),
    wallPicker,
  ], { key: 'pt-preview' });
  paintPicker();

  const paintPreview = () => {
    const box = wallBox.getBoundingClientRect();
    const w = Math.max(160, Math.round(box.width || 200));
    const hh = Math.round(w * 0.78);
    const info = drawPaintingScene(sceneCanvas, w, hh, {
      art: paintingCanvas(pt),
      blocksW: pt.w, blocksH: pt.h,
      wall: pt.wallBlock || DEFAULT_WALL,
    });
    scaleNote.textContent = `${pt.w} × ${pt.h} blocks, shown at ${info.px}px per block`;
  };

  // Once for layout, once after it has a measured width, then whenever the
  // inspector column changes size.
  queueMicrotask(paintPreview);
  requestAnimationFrame(paintPreview);
  const offResize = observeResize(wallBox, paintPreview);

  /* These panels are rebuilt whenever the editor refreshes, so the listeners
     have to come off with them or they pile up one set per rebuild. */
  const offChanged = bus.on('painting:changed', x => { if (x === pt) paintPreview(); });
  const offResized = bus.on('painting:resized', x => { if (x === pt) paintPreview(); });
  const offAssets = bus.on('assets:installed', () => paintPreview());
  preview.dispose = () => { offChanged(); offResized(); offAssets(); offResize(); };

  return [identity, sizeSection, frameSection, preview, behaviour];
}

/* ---- Resize prompt ------------------------------------------------------ */
function askResizeMode(pt, w, hh) {
  return new Promise(resolve => {
    let answered = false;
    const choose = mode => { answered = true; resolve(mode); };

    modal({
      title: `Resize to ${w} \u00D7 ${hh} blocks?`,
      subtitle: `The canvas goes from ${pt.doc.w}\u00D7${pt.doc.h} to ${w * PIXELS_PER_BLOCK}\u00D7${hh * PIXELS_PER_BLOCK} pixels, and there is artwork here already.`,
      icon: 'crop',
      body: ({ close }) => h('.col.g-2',
        resizeOption('crop', 'Keep pixels, change the canvas',
          'Art stays exactly as drawn and is centred in the new size. Anything past the edge is trimmed.',
          () => { choose('extend'); close(); }),
        resizeOption('zoomIn', 'Scale the artwork',
          'Every pixel is stretched to fit. Clean when you double or halve, blocky otherwise.',
          () => { choose('rescale'); close(); }),
      ),
      actions: [{ label: 'Cancel', run: () => choose(null) }],
      onClose: () => { if (!answered) resolve(null); },
    });
  });
}

function resizeOption(iconName, title, desc, run) {
  return h('button.card.card-pad.card-interactive.row.g-3', { onclick: run, style: 'text-align:left;width:100%' },
    h('span', { style: 'color:var(--accent);flex:none' }, raw(icon(iconName, 20))),
    h('.col.g-1.grow',
      h('.strong', { text: title }),
      h('.caption', { text: desc }),
    ),
    h('span', { style: 'color:var(--text-4);flex:none' }, raw(icon('chevRight', 16))),
  );
}

/* ---- Block browser -------------------------------------------------------
   Every block in the bundled pack, searchable. A painting can hang on
   anything, and picking the right backdrop is half of judging whether the art
   works — so the shortlist is a convenience, not a limit. */
function openWallBrowser(current, onPick) {
  const grid = h('.block-grid');
  const all = allWallBlocks();
  const count = h('.caption.muted');

  const render = q => {
    clear(grid);
    const needle = q.trim().toLowerCase();
    const shown = needle ? all.filter(b => b.id.includes(needle.replace(/\s+/g, '_'))) : all;
    count.textContent = `${shown.length} of ${all.length} blocks`;
    for (const b of shown.slice(0, 400)) {
      const url = textureURL(b.game);
      grid.appendChild(h('button.block-tile', {
        'aria-pressed': String(b.id === current),
        title: b.name,
        onclick: () => { onPick(b.id); m.close(); },
      },
        h('span.bt-swatch', url ? { style: { backgroundImage: `url("${url}")` } } : {}),
        h('span.bt-name', { text: b.name }),
      ));
    }
    if (shown.length > 400) {
      grid.appendChild(h('.caption.muted', { style: 'grid-column:1/-1', text: 'Narrow the search to see the rest.' }));
    }
  };

  const search = h('input.input', {
    type: 'search', placeholder: 'Search blocks…', 'data-autofocus': '',
    oninput: e => render(e.target.value),
  });

  const m = modal({
    title: 'Choose a wall',
    subtitle: 'Any block in the bundled texture pack.',
    icon: 'cube', width: 'wide',
    body: h('.col.g-3',
      h('.row.g-2', h('.grow', search), count),
      h('.block-grid-scroll', grid),
    ),
    actions: [{ label: 'Cancel' }],
  });
  render('');
  return m;
}
