/* ============================================================================
   Pixel editor.

   One component drives every canvas in the app — paintings, disc sprites and
   the pack icon — because they are all the same thing: a layered RGBA document
   at a small, exact size. The stage keeps the document at native resolution
   and scales it with a CSS transform, so zooming never resamples the art and
   a 64×64 painting stays as cheap to redraw at 32× as it is at 1×.
   ========================================================================= */

import { h, raw, on, $$, drag, clear, setChildren, scrollIntoViewIfNeeded } from '../core/dom.js';
import { icon } from '../core/icons.js';
import {
  clamp, hexToRgba, rgbaToHex, rgbToHsv, hsvToRgb, rafBatch,
  hasMod, pickFile, downloadBlob, canvasToBlob, plural,
} from '../core/util.js';
import { state, bus, markDirty, pushRecentColor, snapshot, makeLayerPatch } from '../core/store.js';
import { createLayer, docClone } from '../core/project.js';
import {
  flatten, flattenImageData, contentBounds, flipHorizontal, flipVertical,
  shift, countColors,
} from '../paint/render.js';
import { drawFrame } from '../paint/frames.js';
import {
  plot, strokeLine, drawRect, drawEllipse, floodFill, magicWand, rectMask, invertMask,
  gradientFill, shadePixels, snapAngle, outlineOpaque, autoShade, replaceColor,
  maskBounds, BRUSH_SHAPES,
} from '../paint/tools.js';
import { PALETTES, PALETTE_IDS, getPalette } from '../paint/palettes.js';
import { medianCut } from '../paint/palettes.js';
import {
  toast, contextMenu, promptDialog, slider, segmented, section, iconButton, checkbox,
} from './kit.js';
import { openImportDialog } from './importdialog.js';
import { fileToImage } from '../paint/imageimport.js';

const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

export const TOOLS = [
  { id: 'pencil',   icon: 'pencil',   key: 'B', name: 'Pencil' },
  { id: 'eraser',   icon: 'eraser',   key: 'E', name: 'Eraser' },
  { id: 'bucket',   icon: 'bucket',   key: 'G', name: 'Fill' },
  { id: 'picker',   icon: 'pipette',  key: 'I', name: 'Eyedropper' },
  { sep: true },
  { id: 'line',     icon: 'line',     key: 'L', name: 'Line' },
  { id: 'rect',     icon: 'rect',     key: 'R', name: 'Rectangle' },
  { id: 'ellipse',  icon: 'circle',   key: 'O', name: 'Ellipse' },
  { id: 'gradient', icon: 'gradient', key: 'N', name: 'Gradient' },
  { sep: true },
  { id: 'shade',    icon: 'shade',    key: 'S', name: 'Shade' },
  { id: 'select',   icon: 'select',   key: 'M', name: 'Select' },
  { id: 'wand',     icon: 'wand',     key: 'W', name: 'Magic wand' },
  { id: 'move',     icon: 'move',     key: 'V', name: 'Move' },
  { sep: true },
  { id: 'pan',      icon: 'hand',     key: 'H', name: 'Pan' },
];

const DRAW_TOOLS = new Set(['pencil', 'eraser', 'shade']);
const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse', 'gradient', 'select']);

export class PixelEditor {
  /**
   * @param {object} opts
   *   doc            pixel document (required)
   *   onEdit()       called after every committed change
   *   frameOf()      optional -> { frame, blocksW, blocksH } for a live frame
   *   extraPanels()  optional -> elements appended to the panel column
   *   blockSize      draw a block grid every N pixels
   *   compact        drop the busier chrome (used for 16×16 sprites)
   */
  constructor(opts) {
    this.o = opts;
    this.doc = opts.doc;
    this.tool = 'pencil';
    this.primary = state.prefs.recentColors[0] || '#E8ECF2';
    this.secondary = '#12161A';
    this.brushSize = 1;
    this.brushShape = 'circle';
    this.opacity = 255;
    this.tolerance = 12;
    this.contiguous = true;
    this.fillShapes = false;
    this.symX = false; this.symY = false;
    this.zoom = 8; this.panX = 0; this.panY = 0;
    this.mask = null;
    this.gradType = 'linear'; this.gradDither = 'bayer'; this.gradSteps = 0;
    this.shadeAmount = 0.12;
    this.refImage = null; this.refOpacity = 0.4;
    this.showGrid = state.prefs.pixelGrid;
    this.showBlockGrid = state.prefs.blockGrid;
    this.showFrame = true;
    this.clipboard = null;
    this._drawing = null;
    /* A picture floating over the canvas, waiting to be dragged into place. */
    this.place = null;
    this._suppressMenu = false;
    this._disposers = [];
    this._panelDisposers = [];
    this._layerThumbs = new Map();
  }

  /* ---------------------------------------------------------------- mount */
  mount(container) {
    this.root = h('.editor');
    this.root.append(this._buildToolDock(), this._buildStage(), this._buildPanels());
    clear(container).appendChild(this.root);

    this._installKeys();
    this._installWheel();
    this._installDrop();
    requestAnimationFrame(() => { this.fit(); this.redraw(); this._syncStatus(); });
    this._ro = new ResizeObserver(rafBatch(() => this._applyTransform()));
    this._ro.observe(this.stage);
    return this;
  }

  destroy() {
    this.cancelPlace();
    this._disposers.forEach(d => d());
    this._panelDisposers.forEach(d => d());
    this._disposers = []; this._panelDisposers = [];
    this._ro?.disconnect();
    this.root?.remove();
  }

  setDoc(doc) {
    this.cancelPlace();
    this.doc = doc;
    this.mask = null;
    this._syncCanvasSizes();
    this.fit();
    this.redraw();
    this._renderLayers();
    this._syncStatus();
  }

  /**
   * Call after something outside the editor changes the document's dimensions —
   * a painting's block size, for instance. The backing canvases have to be
   * re-created at the new resolution before anything is drawn into them.
   */
  resized({ refit = true } = {}) {
    this.mask = null;
    this._syncCanvasSizes();
    if (refit) this.fit();
    else this._applyTransform();
    this.redraw();
    this._renderLayers();
    this._syncStatus();
  }

  get layer() { return this.doc.layers[clamp(this.doc.active, 0, this.doc.layers.length - 1)]; }

  /* ------------------------------------------------------------- tool dock */
  _buildToolDock() {
    const dock = h('.tooldock');
    for (const t of TOOLS) {
      if (t.sep) { dock.appendChild(h('.rail-sep')); continue; }
      dock.appendChild(h('button.tool-btn', {
        dataset: { tool: t.id },
        'aria-pressed': String(this.tool === t.id),
        'data-tip': `${t.name}  ${t.key}`, 'data-tip-pos': 'right',
        onclick: () => this.setTool(t.id),
      }, raw(icon(t.icon, 17))));
    }
    this.dock = dock;
    return dock;
  }

  setTool(id) {
    if (this.tool === id) return;
    this.tool = id;
    $$('.tool-btn', this.dock).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
    this.stage.dataset.tool = id;
    this._renderToolOptions();
    this._drawOverlay();
    this._syncStatus();
  }

  /* ----------------------------------------------------------------- stage */
  _buildStage() {
    const wrap = h('.stage-wrap');

    this.undoBtn = iconButton('undo', { tip: 'Undo  ⌘Z', pos: 'bottom', cls: 'btn-ghost btn-sm', onClick: () => state.history.undo() });
    this.redoBtn = iconButton('redo', { tip: 'Redo  ⇧⌘Z', pos: 'bottom', cls: 'btn-ghost btn-sm', onClick: () => state.history.redo() });
    this._disposers.push(bus.on('history:change', () => this._syncHistoryButtons()));

    this.toolOpts = h('.sb-group');
    this.symXBtn = iconButton('symmetry', { tip: 'Mirror left ↔ right', pos: 'bottom', cls: 'btn-ghost btn-sm', onClick: () => this._toggleSym('x') });
    this.symYBtn = iconButton('flipV', { tip: 'Mirror top ↕ bottom', pos: 'bottom', cls: 'btn-ghost btn-sm', onClick: () => this._toggleSym('y') });
    this.gridBtn = iconButton('grid', { tip: 'Pixel grid', pos: 'bottom', cls: 'btn-ghost btn-sm', onClick: () => this._toggleGrid() });
    this.blockBtn = iconButton('cube', { tip: 'Block grid', pos: 'bottom', cls: 'btn-ghost btn-sm', onClick: () => this._toggleBlockGrid() });

    this.stageBar = h('.stage-bar',
      h('.sb-group', this.undoBtn, this.redoBtn),
      h('.sb-sep'),
      this.toolOpts,
      h('.spacer'),
      h('.sb-group', this.symXBtn, this.symYBtn),
      h('.sb-sep'),
      h('.sb-group', this.gridBtn, this.blockBtn),
      h('.sb-sep'),
      h('.sb-group',
        iconButton('flipH', { tip: 'Flip layer horizontally', pos: 'bottom', onClick: () => this._transform('flipH') }),
        iconButton('flipV', { tip: 'Flip layer vertically', pos: 'bottom', onClick: () => this._transform('flipV') }),
      ),
      h('.sb-sep'),
      h('.sb-group',
        h('button.btn.btn-sm', { onclick: e => this._imageMenu(e.currentTarget) },
          raw(icon('image', 13)), h('span', { text: 'Image' }), raw(icon('chevDown', 11))),
        iconButton('more', { tip: 'More', pos: 'left', onClick: e => this._moreMenu(e.currentTarget) }),
      ),
    );

    this.checker = h('.cv-checker.checker');
    this.cvRef = h('canvas.cv-ref');
    this.cvMain = h('canvas.cv-main');
    this.cvPlace = h('canvas.cv-place');
    this.cvFrame = h('canvas.cv-frame');
    this.cvOverlay = h('canvas.cv-overlay');
    this.gridEl = h('.cv-grid');
    this.guideX = h('.sym-guide.sym-guide-x', { hidden: true });
    this.guideY = h('.sym-guide.sym-guide-y', { hidden: true });
    this.shadowEl = h('.cv-shadow');

    this.inner = h('.stage-inner',
      this.shadowEl, this.checker, this.cvRef, this.cvMain, this.cvPlace,
      this.cvFrame, this.cvOverlay, this.gridEl, this.guideX, this.guideY);
    this.stage = h('.stage', { dataset: { tool: this.tool } }, this.inner);

    this.zoomLabel = h('span.zoom-val', { text: '800%' });
    this.coordLabel = h('span.coord', { text: '—' });
    this.hud = h('.stage-hud',
      h('button', { 'aria-label': 'Zoom out', onclick: () => this.zoomBy(-1) }, raw(icon('minus', 14))),
      this.zoomLabel,
      h('button', { 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1) }, raw(icon('plus', 14))),
      h('span.hud-sep'),
      h('button', { 'aria-label': 'Fit to window', 'data-tip': 'Fit  0', 'data-tip-pos': 'top', onclick: () => this.fit() }, raw(icon('target', 14))),
      this.coordLabel,
    );

    this.statusBar = h('.status-bar');

    this._installPointer();
    wrap.append(
      this.stageBar,
      h('.grow.relative', { style: 'display:flex;flex-direction:column;min-height:0' }, this.stage, this.hud),
      this.statusBar,
    );
    this._syncCanvasSizes();
    this._renderToolOptions();
    this._syncHistoryButtons();
    return wrap;
  }

  _syncCanvasSizes() {
    for (const c of [this.cvMain, this.cvOverlay, this.cvFrame, this.cvRef, this.cvPlace]) {
      c.width = this.doc.w; c.height = this.doc.h;
    }
    this.ctxMain = this.cvMain.getContext('2d', { willReadFrequently: true });
    this.ctxPlace = this.cvPlace.getContext('2d');
    this.ctxOverlay = this.cvOverlay.getContext('2d');
    this.ctxFrame = this.cvFrame.getContext('2d');
    this.ctxRef = this.cvRef.getContext('2d');
    for (const g of [this.ctxMain, this.ctxOverlay, this.ctxFrame, this.ctxRef]) g.imageSmoothingEnabled = false;
    if (this.place) this._placeRedraw();
  }

  _syncHistoryButtons() {
    if (!this.undoBtn) return;
    this.undoBtn.disabled = !state.history.canUndo;
    this.redoBtn.disabled = !state.history.canRedo;
    this.undoBtn.dataset.tip = state.history.canUndo ? `Undo ${state.history.currentLabel}  ⌘Z` : 'Nothing to undo';
  }

  /* ------------------------------------------------------------- transform */
  _applyTransform() {
    const w = this.doc.w * this.zoom, hh = this.doc.h * this.zoom;
    this.inner.style.width = w + 'px';
    this.inner.style.height = hh + 'px';
    this.inner.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px)`;
    this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
    this._paintGrid();
  }

  fit(animate = false) {
    const r = this.stage.getBoundingClientRect();
    if (!r.width) return;
    const pad = 56;
    const raw = Math.min((r.width - pad) / this.doc.w, (r.height - pad) / this.doc.h);
    let z = ZOOMS[0];
    for (const cand of ZOOMS) if (cand <= raw) z = cand;
    if (raw < 1) z = Math.max(0.25, Math.floor(raw * 8) / 8);
    if (animate) this.inner.classList.add('is-easing');
    this.zoom = z; this.panX = 0; this.panY = 0;
    this._applyTransform();
    if (animate) setTimeout(() => this.inner.classList.remove('is-easing'), 280);
  }

  zoomBy(dir, anchor) {
    const i = ZOOMS.findIndex(z => z >= this.zoom - 0.001);
    const at = i < 0 ? ZOOMS.length - 1 : i;
    const next = ZOOMS[clamp(at + (dir > 0 ? 1 : -1), 0, ZOOMS.length - 1)];
    this.setZoom(next, anchor);
  }

  setZoom(z, anchor) {
    z = clamp(z, 0.25, 64);
    if (anchor) {
      const r = this.stage.getBoundingClientRect();
      const cx = anchor.x - r.left - r.width / 2 - this.panX;
      const cy = anchor.y - r.top - r.height / 2 - this.panY;
      const k = z / this.zoom;
      this.panX -= cx * (k - 1);
      this.panY -= cy * (k - 1);
    }
    this.zoom = z;
    this._applyTransform();
  }

  _installWheel() {
    this._disposers.push(on(this.stage, 'wheel', e => {
      e.preventDefault();
      if (hasMod(e) || e.ctrlKey) {
        this.zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX, y: e.clientY });
      } else if (e.shiftKey) {
        this.panX -= e.deltaY; this._applyTransform();
      } else {
        this.panX -= e.deltaX; this.panY -= e.deltaY;
        this._applyTransform();
      }
    }, { passive: false }));
  }

  /* --------------------------------------------------------------- pointer */
  _eventToPixel(e) {
    const r = this.cvMain.getBoundingClientRect();
    /* A canvas that has not been laid out yet measures zero, and dividing by
       that hands back Infinity — which then propagates into a placement
       rectangle and puts the box somewhere no scrollbar can reach. The zoom
       is the same scale the layout would have used, so it stands in. */
    const sx = r.width ? r.width / this.doc.w : this.zoom;
    const sy = r.height ? r.height / this.doc.h : this.zoom;
    return {
      x: Math.floor((e.clientX - r.left) / sx),
      y: Math.floor((e.clientY - r.top) / sy),
    };
  }

  _installPointer() {
    let spaceHeld = false;
    this._disposers.push(on(window, 'keydown', e => {
      if (e.code === 'Space' && !e.repeat && !this._isTyping()) { spaceHeld = true; this.stage.dataset.spacePan = 'true'; }
    }));
    this._disposers.push(on(window, 'keyup', e => {
      if (e.code === 'Space') { spaceHeld = false; this.stage.dataset.spacePan = 'false'; }
    }));
    this._disposers.push(on(window, 'blur', () => { spaceHeld = false; this.stage.dataset.spacePan = 'false'; }));

    this._disposers.push(on(this.stage, 'pointermove', e => {
      const p = this._eventToPixel(e);
      this.hoverPx = p;
      const inside = p.x >= 0 && p.y >= 0 && p.x < this.doc.w && p.y < this.doc.h;
      this.coordLabel.textContent = inside ? `${p.x}, ${p.y}` : '—';
      if (!this._drawing) this._drawOverlay();
    }));
    this._disposers.push(on(this.stage, 'pointerleave', () => {
      this.hoverPx = null; this.coordLabel.textContent = '—'; this._drawOverlay();
    }));

    this._disposers.push(drag(this.stage, {
      buttons: [0, 1, 2],
      onStart: (c, e) => {
        const panning = spaceHeld || e.button === 1 || this.tool === 'pan';
        /* A floating picture owns the canvas until it is placed or dropped —
           a stray pencil stroke underneath it would be invisible until then. */
        if (this.place && !panning) { c.cancel = true; return; }
        if (panning) {
          c.pan = { x: this.panX, y: this.panY };
          this.stage.dataset.panning = 'true';
          return;
        }
        const alt = e.altKey;
        const tool = alt ? 'picker' : this.tool;
        c.tool = tool;
        this._beginStroke(tool, this._eventToPixel(e), {
          shift: e.shiftKey, alt, secondary: e.button === 2, ctrl: hasMod(e),
        });
      },
      onMove: (c, e) => {
        if (c.pan) {
          this.panX = c.pan.x + c.dx; this.panY = c.pan.y + c.dy;
          this._applyTransform();
          return;
        }
        this._continueStroke(this._eventToPixel(e), { shift: e.shiftKey, alt: e.altKey });
      },
      onEnd: (c, e) => {
        this.stage.dataset.panning = 'false';
        // A right-drag draws; a right-click without movement opens the menu.
        if (c.button === 2 && c.moved) this._suppressMenu = true;
        if (c.pan) return;
        this._endStroke(this._eventToPixel(e), { shift: e.shiftKey });
      },
    }));

    this._disposers.push(on(this.stage, 'contextmenu', e => {
      e.preventDefault();
      if (this._suppressMenu) { this._suppressMenu = false; return; }
      const p = this._eventToPixel(e);
      this._canvasMenu(p, { x: e.clientX, y: e.clientY });
    }));
  }

  _canvasMenu(p, at) {
    const hasSel = !!this.mask;
    contextMenu([
      { label: 'Pick colour here', icon: 'pipette', run: () => this._pick(p) },
      {
        label: 'Fill with primary', icon: 'bucket',
        run: () => this._commit('Fill', () => floodFill(this.layer.data, this.doc.w, this.doc.h, p.x, p.y,
          hexToRgba(this.primary), { tolerance: this.tolerance, contiguous: this.contiguous, mask: this.mask }), 'bucket'),
      },
      '-',
      { label: 'Select all', icon: 'select', key: 'mod+A', run: () => this.selectAll() },
      { label: 'Deselect', key: 'mod+D', disabled: !hasSel, run: () => this.deselect() },
      { label: 'Invert selection', disabled: !hasSel, run: () => { this.mask = invertMask(this.mask); this._drawOverlay(); this._syncStatus(); } },
      hasSel ? { label: 'Fill selection', icon: 'bucket', run: () => this.fillSelection() } : null,
      '-',
      { label: 'Copy', icon: 'copy', key: 'mod+C', run: () => this.copySelection() },
      { label: 'Paste', icon: 'file', key: 'mod+V', disabled: !this.clipboard, run: () => this.pasteClipboard() },
      '-',
      { label: hasSel ? 'Clear selection' : 'Clear layer', icon: 'trash', destructive: true, run: () => this.clearLayer() },
    ].filter(Boolean), at);
  }

  /* ----------------------------------------------------------- stroke flow */
  _colorFor(opts) { return hexToRgba(opts.secondary ? this.secondary : this.primary); }

  _brushOpts(extra = {}) {
    return { size: this.brushSize, shape: this.brushShape, alpha: this.opacity, mask: this.mask, ...extra };
  }

  _mirrors(p) {
    const out = [p];
    const w = this.doc.w, hh = this.doc.h;
    if (this.symX) out.push({ x: w - 1 - p.x, y: p.y });
    if (this.symY) out.push({ x: p.x, y: hh - 1 - p.y });
    if (this.symX && this.symY) out.push({ x: w - 1 - p.x, y: hh - 1 - p.y });
    return out;
  }

  _beginStroke(tool, p, mod) {
    if (this.layer?.locked && !['picker', 'select', 'wand', 'pan'].includes(tool)) {
      toast({ title: 'This layer is locked', message: 'Unlock it in the Layers panel to draw on it.', kind: 'warn', duration: 2600 });
      return;
    }
    if (tool === 'picker') { this._pick(p); return; }

    this._drawing = { tool, start: p, last: p, mod, before: null };

    if (DRAW_TOOLS.has(tool)) {
      this._drawing.before = snapshot(this.layer);
      this._applyDab(tool, p, mod);
      this.redraw();
    } else if (tool === 'bucket') {
      this._commit(mod.secondary ? 'Fill (secondary)' : 'Fill', () => {
        for (const q of this._mirrors(p)) {
          floodFill(this.layer.data, this.doc.w, this.doc.h, q.x, q.y, this._colorFor(mod),
            { tolerance: this.tolerance, contiguous: this.contiguous, mask: this.mask });
        }
      }, 'bucket');
      this._drawing = null;
    } else if (tool === 'wand') {
      const m = magicWand(this.layer.data, this.doc.w, this.doc.h,
        clamp(p.x, 0, this.doc.w - 1), clamp(p.y, 0, this.doc.h - 1), this.tolerance, this.contiguous);
      this.mask = mod.shift && this.mask ? this._unionMask(this.mask, m) : m;
      this._drawing = null;
      this._drawOverlay(); this._renderToolOptions(); this._syncStatus();
    } else if (tool === 'move') {
      this._drawing.before = snapshot(this.layer);
      this._drawing.origin = new Uint8ClampedArray(this.layer.data);
    }
  }

  _continueStroke(p) {
    const d = this._drawing;
    if (!d) return;
    if (DRAW_TOOLS.has(d.tool)) {
      this._lineDab(d.tool, d.last, p, d.mod);
      d.last = p;
      this.redraw();
    } else if (d.tool === 'move') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      this.layer.data.set(shift(d.origin, this.doc.w, this.doc.h, dx, dy, false));
      this.redraw();
    } else {
      d.last = p;
      this._drawOverlay();
    }
  }

  _endStroke(p, mod) {
    const d = this._drawing;
    if (!d) return;
    this._drawing = null;

    if (DRAW_TOOLS.has(d.tool)) {
      this._push(d.before,
        d.tool === 'eraser' ? 'Erase' : d.tool === 'shade' ? 'Shade' : 'Draw',
        d.tool === 'eraser' ? 'eraser' : d.tool === 'shade' ? 'shade' : 'pencil');
      return;
    }
    if (d.tool === 'move') { this._push(d.before, 'Move', 'move'); return; }

    let end = p;
    if (mod.shift && d.tool === 'line') {
      const [ex, ey] = snapAngle(d.start.x, d.start.y, p.x, p.y);
      end = { x: ex, y: ey };
    } else if (mod.shift && (d.tool === 'rect' || d.tool === 'ellipse' || d.tool === 'select')) {
      const s = Math.max(Math.abs(p.x - d.start.x), Math.abs(p.y - d.start.y));
      end = { x: d.start.x + Math.sign(p.x - d.start.x || 1) * s, y: d.start.y + Math.sign(p.y - d.start.y || 1) * s };
    }

    if (d.tool === 'select') {
      if (Math.abs(end.x - d.start.x) < 1 && Math.abs(end.y - d.start.y) < 1) this.deselect();
      else this.mask = rectMask(this.doc.w, this.doc.h, d.start.x, d.start.y, end.x, end.y);
      this._drawOverlay(); this._renderToolOptions(); this._syncStatus();
      return;
    }

    const color = this._colorFor(d.mod);
    const labels = { line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', gradient: 'Gradient' };
    this._commit(labels[d.tool] || 'Draw', () => {
      const startMirrors = this._mirrors(d.start);
      const endMirrors = this._mirrors(end);
      for (let i = 0; i < startMirrors.length; i++) {
        const a = startMirrors[i], b = endMirrors[i];
        if (d.tool === 'line') strokeLine(this.layer.data, this.doc.w, this.doc.h, a.x, a.y, b.x, b.y, color, this._brushOpts());
        else if (d.tool === 'rect') drawRect(this.layer.data, this.doc.w, this.doc.h, a.x, a.y, b.x, b.y, color, this._brushOpts({ fill: this.fillShapes }));
        else if (d.tool === 'ellipse') drawEllipse(this.layer.data, this.doc.w, this.doc.h, a.x, a.y, b.x, b.y, color, this._brushOpts({ fill: this.fillShapes }));
        else if (d.tool === 'gradient') gradientFill(this.layer.data, this.doc.w, this.doc.h, a.x, a.y, b.x, b.y,
          hexToRgba(this.primary), hexToRgba(this.secondary),
          { type: this.gradType, dither: this.gradDither, steps: this.gradSteps, mask: this.mask });
      }
    }, d.tool === 'gradient' ? 'gradient' : 'pencil');

    this.ctxOverlay.clearRect(0, 0, this.doc.w, this.doc.h);
    this._drawOverlay();
  }

  _applyDab(tool, p, mod) {
    for (const q of this._mirrors(p)) {
      if (tool === 'shade') {
        shadePixels(this.layer.data, this.doc.w, this.doc.h, q.x, q.y,
          mod.secondary ? this.shadeAmount : -this.shadeAmount,
          { size: this.brushSize, shape: this.brushShape, mask: this.mask, hueShift: 10 });
      } else {
        plot(this.layer.data, this.doc.w, this.doc.h, q.x, q.y,
          this._colorFor(mod), this._brushOpts({ erase: tool === 'eraser' }));
      }
    }
  }

  _lineDab(tool, from, to, mod) {
    const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y);
    const steps = Math.max(dx, dy);
    if (steps === 0) return this._applyDab(tool, to, mod);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._applyDab(tool, {
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t),
      }, mod);
    }
  }

  /* --------------------------------------------------- painting from 3D *
     The 3D view resolves a click to a texel and hands it here, so a stroke
     made on the model is the same kind of edit as one made on the flat sheet:
     same layer, same tools, one entry in the same undo history. */
  paintExternal(x, y, { begin = false, alt = false, button = 0 } = {}) {
    if (x < 0 || y < 0 || x >= this.doc.w || y >= this.doc.h) return;
    const p = { x, y };
    const mod = { secondary: button === 2 };
    const tool = alt ? 'eyedropper' : this.tool;

    if (tool === 'eyedropper') { this._pick(p); return; }
    if (tool === 'fill') {
      if (!begin) return;
      this._commit('fill', () => {
        floodFill(this.layer.data, this.doc.w, this.doc.h, p.x, p.y,
          this._colorFor(mod), { tolerance: this.tolerance, contiguous: this.contiguous, mask: this.mask });
      }, 'fill');
      return;
    }
    if (begin || !this._external) {
      this._external = { before: snapshot(this.layer), last: p, tool };
      this._applyDab(tool, p, mod);
    } else {
      this._lineDab(tool, this._external.last, p, mod);
      this._external.last = p;
    }
    this.redraw();
  }

  /** Close an external stroke, pushing exactly one undo entry for it. */
  endExternal() {
    if (!this._external) return;
    const { before, tool } = this._external;
    this._external = null;
    this._push(before, tool === 'eraser' ? 'erase (3D)' : 'paint (3D)', tool === 'eraser' ? 'eraser' : 'pencil');
  }

  /**
   * Swap the active layer's pixels wholesale — importing an image or starting
   * from a base texture. Undoable like any other edit.
   */
  replaceLayerData(data, label = 'replace') {
    if (data.length !== this.layer.data.length) return false;
    this._commit(label, () => this.layer.data.set(data), 'image');
    return true;
  }

  /* ------------------------------------------------------------ drag & drop */
  /**
   * Drop a picture straight onto the canvas. This is the shortest path there
   * is from "I have a PNG of a face" to "the face is on the pig": the file
   * lands where it was dropped, already floating, already draggable.
   */
  _installDrop() {
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    const over = e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.stage.dataset.dropping = 'true';
    };
    const leave = e => {
      if (e.relatedTarget && this.stage.contains(e.relatedTarget)) return;
      this.stage.dataset.dropping = 'false';
    };
    const drop = e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.stage.dataset.dropping = 'false';
      const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
      if (!file) {
        toast({ title: 'Not an image', message: 'Drop a PNG, JPG, GIF or WebP.', kind: 'warn' });
        return;
      }
      this.placeFromFileHandle(file, { at: this._eventToPixel(e), ...(this.o.placeOptions?.() || {}) });
    };
    this._disposers.push(
      on(this.stage, 'dragover', over),
      on(this.stage, 'dragenter', over),
      on(this.stage, 'dragleave', leave),
      on(this.stage, 'drop', drop),
    );
  }

  /* --------------------------------------------------------- image import */
  /**
   * Two ways in, because they answer different questions. "Fit to the canvas"
   * converts a photograph into pixel art at exactly this size, which is what a
   * painting wants. "Place by hand" hands you the picture as a floating
   * rectangle to drag and resize, which is what a texture sheet wants: a face
   * is a small patch of a big sheet, and only you know where it goes.
   */
  _imageMenu(anchor) {
    contextMenu([
      { label: 'Fit to the canvas…', icon: 'image', hint: 'Convert and quantise',
        run: () => openImportDialog(this) },
      { label: 'Place by hand…', icon: 'target', hint: 'Drag and resize it yourself',
        run: () => this.placeFromFile() },
    ], anchor);
  }

  /** Ask for a file, then float it over the canvas. */
  async placeFromFile(o = {}) {
    const file = await pickFile({ accept: 'image/*' });
    if (!file) return null;
    return this.placeFromFileHandle(file, o);
  }

  async placeFromFileHandle(file, o = {}) {
    try {
      const img = await fileToImage(file);
      return this.beginPlace(img, { label: `Place ${file.name || 'image'}`, ...o });
    } catch (e) {
      toast({ title: 'Could not read that image', message: e.message, kind: 'error' });
      return null;
    }
  }

  /* ========================================================================
     Placing a picture by hand.

     The import dialog converts an image to fit the whole canvas, which is
     what a painting usually wants. This is the other half: the image arrives
     as a floating rectangle over the canvas, and it is dragged and resized
     until it sits where it belongs — over a mob's face, say — before anything
     is written to a layer. Nothing is committed until Place is pressed, so
     the document underneath is untouched the whole time and the result is one
     undo step.

     The box is positioned in percentages of the document, so it tracks zoom
     and pan for free: `.stage-inner` is sized in pixels and only translated,
     never scaled, which means a percentage lands on the same texel at every
     zoom while the handles keep their own size on screen.
     ==================================================================== */

  /**
   * @param {CanvasImageSource} img
   * @param {object} o
   *   rect        {x,y,w,h} in document pixels — where it starts
   *   label       what the undo entry is called
   *   snaps       [{ label, rect }] offered in the "Snap to" menu
   *   onDone(applied) called after Place or Cancel
   */
  beginPlace(img, o = {}) {
    if (!img) return null;
    this.cancelPlace();
    const iw = img.width || img.naturalWidth || this.doc.w;
    const ih = img.height || img.naturalHeight || this.doc.h;
    const rect = o.rect || this._defaultPlaceRect(iw, ih, o.at);
    this.place = {
      img, iw, ih,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      aspect: iw / ih,
      keepAspect: true,
      smooth: true,
      opacity: 1,
      flipX: false, flipY: false,
      asNewLayer: false,
      label: o.label || 'Place image',
      snaps: o.snaps || null,
      onDone: o.onDone || null,
    };
    this.stage.dataset.placing = 'true';
    this._buildPlaceBar();
    this._placeRedraw();
    return this.place;
  }

  /**
   * The biggest whole scale that fits, centred — on the canvas, or on the
   * point it was dropped at when there is one.
   */
  _defaultPlaceRect(iw, ih, at = null) {
    const fit = Math.min(this.doc.w / iw, this.doc.h / ih);
    /* Dropped on a spot, it arrives at its own size — you dropped a 32-pixel
       patch because you meant a 32-pixel patch. Opened from the button, with
       nowhere in particular in mind, it fills what it can. */
    const k = at ? Math.min(1, fit) : (fit >= 1 ? Math.floor(fit) : fit);
    const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
    const cx = at ? at.x : this.doc.w / 2;
    const cy = at ? at.y : this.doc.h / 2;
    return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
  }

  /** Move the box to an exact rectangle — how the face snaps work. */
  setPlaceRect(rect, { cover = true } = {}) {
    const p = this.place;
    if (!p) return;
    if (p.keepAspect) {
      /* Cover the target and centre the overflow, which is what putting a
         photograph on a square face wants; `cover:false` fits it inside. */
      const k = cover ? Math.max(rect.w / p.iw, rect.h / p.ih)
                      : Math.min(rect.w / p.iw, rect.h / p.ih);
      p.w = p.iw * k; p.h = p.ih * k;
      p.x = rect.x + (rect.w - p.w) / 2;
      p.y = rect.y + (rect.h - p.h) / 2;
    } else {
      p.x = rect.x; p.y = rect.y; p.w = rect.w; p.h = rect.h;
    }
    this._placeRedraw();
  }

  cancelPlace() {
    if (!this.place) return;
    const done = this.place.onDone;
    this.place = null;
    this.placeBox?.remove(); this.placeBox = null;
    this.placeBar?.remove(); this.placeBar = null;
    if (this.stage) this.stage.dataset.placing = 'false';
    this._clearPlaceCanvas();
    done?.(false);
  }

  /** Burn the floating image into the document. */
  applyPlace() {
    const p = this.place;
    if (!p) return;
    const { w, h } = this.doc;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!p.asNewLayer) g.putImageData(new ImageData(new Uint8ClampedArray(this.layer.data), w, h), 0, 0);
    this._paintPlaced(g, p);
    const data = g.getImageData(0, 0, w, h);
    const done = p.onDone;
    const label = p.label;
    const asNewLayer = p.asNewLayer;
    this.place = null;
    this.placeBox?.remove(); this.placeBox = null;
    this.placeBar?.remove(); this.placeBar = null;
    this.stage.dataset.placing = 'false';
    this._clearPlaceCanvas();
    this.applyImageData(data, { asNewLayer, label });
    done?.(true);
  }

  /** The one drawImage call every preview and the commit both go through. */
  _paintPlaced(g, p) {
    g.save();
    g.globalAlpha = p.opacity;
    g.imageSmoothingEnabled = p.smooth;
    g.imageSmoothingQuality = 'high';
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    g.translate(cx, cy);
    g.scale(p.flipX ? -1 : 1, p.flipY ? -1 : 1);
    g.drawImage(p.img, -p.w / 2, -p.h / 2, p.w, p.h);
    g.restore();
  }

  _clearPlaceCanvas() {
    this.ctxPlace?.clearRect(0, 0, this.cvPlace.width, this.cvPlace.height);
  }

  _placeRedraw() {
    const p = this.place;
    if (!p || !this.ctxPlace) return;
    this._clearPlaceCanvas();
    this._paintPlaced(this.ctxPlace, p);
    if (!this.placeBox) this._buildPlaceBox();
    const b = this.placeBox.style;
    b.left = (p.x / this.doc.w * 100) + '%';
    b.top = (p.y / this.doc.h * 100) + '%';
    b.width = (p.w / this.doc.w * 100) + '%';
    b.height = (p.h / this.doc.h * 100) + '%';
    if (this.placeSize) {
      this.placeSize.textContent =
        `${Math.round(p.w)} × ${Math.round(p.h)} px  ·  ${Math.round(p.x)}, ${Math.round(p.y)}`;
    }
  }

  _buildPlaceBox() {
    const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const box = h('.place-box');
    for (const dir of HANDLES) box.appendChild(h('i.place-handle', { dataset: { dir } }));
    this.placeBox = box;
    this.inner.appendChild(box);

    const start = {};
    const begin = (c, e) => {
      const p = this.place;
      start.x = p.x; start.y = p.y; start.w = p.w; start.h = p.h;
      start.dir = e.target?.dataset?.dir || null;
      e.stopPropagation();
    };
    const move = (c, e) => {
      const p = this.place;
      if (!p) return;
      const dx = c.dx / this.zoom, dy = c.dy / this.zoom;
      if (!start.dir) {
        p.x = start.x + dx; p.y = start.y + dy;
        if (!e.altKey) { p.x = Math.round(p.x); p.y = Math.round(p.y); }
        this._placeRedraw();
        return;
      }
      this._resizePlace(start, dx, dy, e);
    };
    this._disposers.push(drag(box, { onStart: begin, onMove: move }));
  }

  /**
   * Resize from one handle. Corners hold the aspect ratio when it is locked;
   * edges never do, because dragging one edge is how you deliberately squash
   * something. Shift inverts whichever the lock is set to.
   */
  _resizePlace(start, dx, dy, e) {
    const p = this.place;
    const dir = start.dir;
    const corner = dir.length === 2;
    const lock = corner && (e.shiftKey ? !p.keepAspect : p.keepAspect);
    let { x, y, w, hh } = { x: start.x, y: start.y, w: start.w, hh: start.h };

    if (dir.includes('e')) w = start.w + dx;
    if (dir.includes('w')) { w = start.w - dx; x = start.x + dx; }
    if (dir.includes('s')) hh = start.h + dy;
    if (dir.includes('n')) { hh = start.h - dy; y = start.y + dy; }

    const MIN = 1;
    if (lock) {
      // Follow whichever axis the pointer moved further along.
      const byW = Math.abs(w - start.w) >= Math.abs(hh - start.h);
      if (byW) hh = w / p.aspect; else w = hh * p.aspect;
      if (dir.includes('w')) x = start.x + start.w - w;
      if (dir.includes('n')) y = start.y + start.h - hh;
    }
    if (w < MIN) { w = MIN; if (dir.includes('w')) x = start.x + start.w - MIN; }
    if (hh < MIN) { hh = MIN; if (dir.includes('n')) y = start.y + start.h - MIN; }

    if (!e.altKey) {
      x = Math.round(x); y = Math.round(y);
      w = Math.max(MIN, Math.round(w)); hh = Math.max(MIN, Math.round(hh));
    }
    p.x = x; p.y = y; p.w = w; p.h = hh;
    this._placeRedraw();
  }

  /** The bar that owns the placement — it replaces nothing, it sits above. */
  _buildPlaceBar() {
    const p = this.place;
    this.placeSize = h('span.place-size');
    const toggle = (name, tip, get, set) => iconButton(name, {
      tip, pos: 'bottom', cls: 'btn-sm btn-ghost',
      onClick: e => {
        set(!get());
        e.currentTarget.dataset.on = String(get());
        this._placeRedraw();
      },
    });

    const opacity = slider({
      min: 10, max: 100, value: 100,
      onInput: v => { p.opacity = v / 100; this._placeRedraw(); },
      format: v => `${v}%`,
    });
    opacity.style.width = '92px';

    const aspectBtn = toggle('link', 'Hold the shape while resizing  (Shift to invert)',
      () => p.keepAspect, v => p.keepAspect = v);
    aspectBtn.dataset.on = 'true';
    const smoothBtn = toggle('sparkle', 'Smooth the scaling — off gives hard pixels',
      () => p.smooth, v => p.smooth = v);
    smoothBtn.dataset.on = 'true';
    const layerBtn = toggle('layers', 'Land on a new layer instead of this one',
      () => p.asNewLayer, v => p.asNewLayer = v);
    layerBtn.dataset.on = 'false';

    this.placeBar = h('.place-bar',
      h('span.caption.muted', { text: 'Placing' }),
      this.placeSize,
      h('.sb-sep'),
      iconButton('flipH', { tip: 'Flip horizontally', pos: 'bottom', cls: 'btn-sm btn-ghost',
        onClick: () => { p.flipX = !p.flipX; this._placeRedraw(); } }),
      iconButton('flipV', { tip: 'Flip vertically', pos: 'bottom', cls: 'btn-sm btn-ghost',
        onClick: () => { p.flipY = !p.flipY; this._placeRedraw(); } }),
      aspectBtn, smoothBtn, layerBtn,
      h('.sb-sep'),
      h('span.caption.muted', { text: 'Opacity' }), opacity,
      p.snaps?.length ? h('.sb-sep') : null,
      p.snaps?.length
        ? h('button.btn.btn-sm', { onclick: e => this._placeSnapMenu(e.currentTarget) },
            raw(icon('target', 13)), h('span', { text: 'Snap to…' }))
        : null,
      h('.sb-sep'),
      h('button.btn.btn-sm', { onclick: () => this.cancelPlace() }, h('span', { text: 'Cancel' })),
      h('button.btn.btn-sm.btn-primary', { onclick: () => this.applyPlace() },
        raw(icon('check', 13)), h('span', { text: 'Place' })),
    );
    this.stage.parentElement.appendChild(this.placeBar);
  }

  _placeSnapMenu(anchor) {
    const p = this.place;
    contextMenu(p.snaps.map(sn => ({
      label: sn.label,
      hint: `${sn.rect.w} × ${sn.rect.h}`,
      run: () => this.setPlaceRect(sn.rect),
    })), anchor);
  }

  _pick(p) {
    if (p.x < 0 || p.y < 0 || p.x >= this.doc.w || p.y >= this.doc.h) return;
    const flat = flatten(this.doc);
    const i = (p.y * this.doc.w + p.x) * 4;
    if (flat[i + 3] === 0) { toast({ title: 'Nothing there to pick', kind: 'info', duration: 1200 }); return; }
    const hex = rgbaToHex(flat[i], flat[i + 1], flat[i + 2]);
    this.setPrimary(hex);
    toast({ title: hex.toUpperCase(), kind: 'info', duration: 1100 });
  }

  /* ----------------------------------------------------------- commit/undo */
  _commit(label, fn, iconName = 'edit') {
    const before = snapshot(this.layer);
    fn();
    this._push(before, label, iconName);
  }

  _push(before, label, iconName) {
    const layer = this.layer;
    const patch = makeLayerPatch(this.doc, layer, before, label, iconName);
    this.redraw();
    if (!patch) return;
    state.history.push({
      label, icon: iconName,
      undo: () => { patch.undo(); this.redraw(); this._thumbFor(layer); this._syncStatus(); this.o.onEdit?.(); },
      redo: () => { patch.redo(); this.redraw(); this._thumbFor(layer); this._syncStatus(); this.o.onEdit?.(); },
    });
    this._thumbFor(layer);
    this._syncStatus();
    markDirty('paint');
    this.o.onEdit?.();
  }

  _commitStructural(label, fn, iconName = 'layers') {
    const before = docClone(this.doc);
    fn();
    const after = docClone(this.doc);
    const restore = src => {
      this.doc.w = src.w; this.doc.h = src.h; this.doc.active = src.active;
      this.doc.layers = src.layers.map(l => ({ ...l, data: new Uint8ClampedArray(l.data) }));
      this._syncCanvasSizes(); this.redraw(); this._renderLayers(); this._applyTransform(); this._syncStatus();
      this.o.onEdit?.();
    };
    state.history.push({ label, icon: iconName, undo: () => restore(before), redo: () => restore(after) });
    this.redraw(); this._renderLayers(); this._syncStatus();
    markDirty('paint');
    this.o.onEdit?.();
  }

  /* ---------------------------------------------------------------- render */
  redraw = rafBatch(() => {
    if (!this.ctxMain) return;
    this.ctxMain.putImageData(flattenImageData(this.doc), 0, 0);
    this._drawFrameLayer();
    this._drawOverlay();
    this.o.onPreview?.();
  });

  _drawFrameLayer() {
    const info = this.o.frameOf?.();
    this.ctxFrame.clearRect(0, 0, this.doc.w, this.doc.h);
    if (!info || !this.showFrame || !info.frame || info.frame.style === 'none') return;
    const buf = new Uint8ClampedArray(this.doc.w * this.doc.h * 4);
    drawFrame(buf, this.doc.w, this.doc.h, info.frame, info.blocksW, info.blocksH);
    this.ctxFrame.putImageData(new ImageData(buf, this.doc.w, this.doc.h), 0, 0);
  }

  _drawOverlay() {
    const g = this.ctxOverlay;
    if (!g) return;
    const w = this.doc.w, hh = this.doc.h;
    const d = this._drawing;
    const hasMask = !!this.mask;
    const showShape = d && SHAPE_TOOLS.has(d.tool);
    const showBrush = this.hoverPx && !d && !this.place && DRAW_TOOLS.has(this.tool);
    /* Guides are pixel-aligned rectangles supplied by the host — the mob
       editor uses them to outline which part of the sheet is which face. */
    const guides = this.o.guides?.() || null;

    if (!showShape && !showBrush && !hasMask && !guides?.length) { g.clearRect(0, 0, w, hh); return; }

    /* One buffer, one upload. Reading the canvas back to draw the selection
       edge would cost a full readback on every pointer move, so everything
       that goes on the overlay is composed here first. */
    const buf = new Uint8ClampedArray(w * hh * 4);

    if (showShape) {
      let end = d.last;
      if (d.mod?.shift && d.tool === 'line') { const [ex, ey] = snapAngle(d.start.x, d.start.y, end.x, end.y); end = { x: ex, y: ey }; }
      const color = this._colorFor(d.mod);
      const opts = this._brushOpts({ mask: null });
      if (d.tool === 'line') strokeLine(buf, w, hh, d.start.x, d.start.y, end.x, end.y, color, opts);
      else if (d.tool === 'rect') drawRect(buf, w, hh, d.start.x, d.start.y, end.x, end.y, color, { ...opts, fill: this.fillShapes });
      else if (d.tool === 'ellipse') drawEllipse(buf, w, hh, d.start.x, d.start.y, end.x, end.y, color, { ...opts, fill: this.fillShapes });
      else if (d.tool === 'gradient') gradientFill(buf, w, hh, d.start.x, d.start.y, end.x, end.y,
        hexToRgba(this.primary), hexToRgba(this.secondary), { type: this.gradType, dither: this.gradDither, steps: this.gradSteps });
      else if (d.tool === 'select') drawRect(buf, w, hh, d.start.x, d.start.y, end.x, end.y, [255, 255, 255, 190], { size: 1, mask: null });
      this._liveSize(d.start, end, d.tool);
    } else if (showBrush) {
      for (const q of this._mirrors(this.hoverPx)) {
        plot(buf, w, hh, q.x, q.y, [255, 255, 255, 70], { size: this.brushSize, shape: this.brushShape });
      }
    }

    if (guides?.length) {
      const dot = (x, y, c) => {
        if (x < 0 || y < 0 || x >= w || y >= hh) return;
        const i = (y * w + x) * 4;
        // Guides sit under the cursor and selection, never over them.
        if (buf[i + 3]) return;
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
      };
      for (const gd of guides) {
        const c = gd.color || [255, 255, 255, 60];
        const x1 = gd.x + gd.w - 1, y1 = gd.y + gd.h - 1;
        for (let x = gd.x; x <= x1; x++) { dot(x, gd.y, c); dot(x, y1, c); }
        for (let y = gd.y; y <= y1; y++) { dot(gd.x, y, c); dot(x1, y, c); }
      }
    }

    if (hasMask) {
      const m = this.mask;
      const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= hh) ? 0 : m[y * w + x];
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          // Interior pixels are not the edge; only outline the boundary.
          if (at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) continue;
          const i = (y * w + x) * 4;
          const on = ((x + y) & 1) === 0;
          buf[i] = on ? 255 : 20; buf[i + 1] = on ? 255 : 20;
          buf[i + 2] = on ? 255 : 24; buf[i + 3] = 235;
        }
      }
    }

    g.putImageData(new ImageData(buf, w, hh), 0, 0);
  }

  _liveSize(a, b, tool) {
    if (!this.sizeChip) return;
    const w = Math.abs(b.x - a.x) + 1, hh = Math.abs(b.y - a.y) + 1;
    const len = Math.round(Math.hypot(b.x - a.x, b.y - a.y)) + 1;
    this.sizeChip.hidden = false;
    this.sizeChip.textContent = tool === 'line' || tool === 'gradient' ? `${len} px` : `${w} × ${hh}`;
  }

  _paintGrid() {
    const z = this.zoom;
    const layers = [];
    if (this.showGrid && z >= 5) {
      layers.push(`repeating-linear-gradient(0deg, rgba(255,255,255,.10) 0 1px, transparent 1px ${z}px)`);
      layers.push(`repeating-linear-gradient(90deg, rgba(255,255,255,.10) 0 1px, transparent 1px ${z}px)`);
    }
    if (this.showBlockGrid && this.o.blockSize) {
      const b = this.o.blockSize * z;
      layers.push(`repeating-linear-gradient(0deg, var(--block-grid) 0 1px, transparent 1px ${b}px)`);
      layers.push(`repeating-linear-gradient(90deg, var(--block-grid) 0 1px, transparent 1px ${b}px)`);
    }
    this.gridEl.style.backgroundImage = layers.join(',');
  }

  /* ------------------------------------------------------------ tool opts */
  _renderToolOptions() {
    const box = this.toolOpts;
    clear(box);
    const t = this.tool;
    this.sizeChip = h('span.live-size', { hidden: true });
    const add = (...els) => box.append(...els.filter(Boolean));

    if (DRAW_TOOLS.has(t)) {
      const s = slider({ min: 1, max: 16, value: this.brushSize, onInput: v => { this.brushSize = v; this._drawOverlay(); }, format: v => `${v}px` });
      s.style.width = '104px';
      add(h('span.caption', { text: 'Size' }), s,
        segmented({
          options: BRUSH_SHAPES.map(sh => ({ value: sh, icon: sh === 'circle' ? 'circle' : sh === 'square' ? 'rect' : 'target', hint: sh })),
          value: this.brushShape, onChange: v => { this.brushShape = v; this._drawOverlay(); },
        }));
      if (t === 'pencil') {
        const o = slider({ min: 8, max: 255, value: this.opacity, onInput: v => this.opacity = v, format: v => `${Math.round(v / 255 * 100)}%` });
        o.style.width = '84px';
        add(h('.sb-sep'), h('span.caption', { text: 'Opacity' }), o);
      }
      if (t === 'shade') {
        const a = slider({ min: 2, max: 40, value: this.shadeAmount * 100, onInput: v => this.shadeAmount = v / 100, format: v => `${v}%` });
        a.style.width = '84px';
        add(h('.sb-sep'), h('span.caption', { text: 'Strength' }), a,
          h('span.caption.muted', { text: 'right-drag lightens' }));
      }
    } else if (t === 'bucket' || t === 'wand') {
      const tol = slider({ min: 0, max: 100, value: this.tolerance, onInput: v => this.tolerance = v, format: v => `${v}` });
      tol.style.width = '104px';
      add(h('span.caption', { text: 'Tolerance' }), tol,
        checkbox({ label: 'Contiguous', checked: this.contiguous, onChange: v => this.contiguous = v }));
      if (t === 'wand' && this.mask) {
        add(h('.sb-sep'),
          h('button.btn.btn-sm.btn-ghost', { text: 'Invert', onclick: () => { this.mask = invertMask(this.mask); this._drawOverlay(); this._syncStatus(); } }),
          h('button.btn.btn-sm.btn-ghost', { text: 'Deselect', onclick: () => this.deselect() }));
      }
    } else if (t === 'rect' || t === 'ellipse') {
      add(segmented({
        options: [{ value: 'outline', label: 'Outline' }, { value: 'fill', label: 'Filled' }],
        value: this.fillShapes ? 'fill' : 'outline',
        onChange: v => { this.fillShapes = v === 'fill'; this._drawOverlay(); },
      }));
      const s = slider({ min: 1, max: 8, value: this.brushSize, onInput: v => this.brushSize = v, format: v => `${v}px` });
      s.style.width = '74px';
      add(h('.sb-sep'), h('span.caption', { text: 'Stroke' }), s,
        h('span.caption.muted', { text: 'Shift = square' }));
    } else if (t === 'gradient') {
      add(segmented({
        options: [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }],
        value: this.gradType, onChange: v => { this.gradType = v; this._drawOverlay(); },
      }), h('.sb-sep'),
        h('span.caption', { text: 'Dither' }),
        segmented({
          options: [{ value: 'none', label: 'Off' }, { value: 'bayer', label: 'Ordered' }, { value: 'noise', label: 'Noise' }],
          value: this.gradDither, onChange: v => { this.gradDither = v; this._drawOverlay(); },
        }));
      const st = slider({ min: 0, max: 16, value: this.gradSteps, onInput: v => { this.gradSteps = v; this._drawOverlay(); }, format: v => v === 0 ? 'smooth' : `${v}` });
      st.style.width = '90px';
      add(h('.sb-sep'), h('span.caption', { text: 'Bands' }), st);
    } else if (t === 'select') {
      add(h('span.caption', { text: 'Drag to select · click to clear · Shift for a square' }));
      if (this.mask) add(h('.sb-sep'),
        h('button.btn.btn-sm.btn-ghost', { text: 'Invert', onclick: () => { this.mask = invertMask(this.mask); this._drawOverlay(); this._syncStatus(); } }),
        h('button.btn.btn-sm.btn-ghost', { text: 'Fill', onclick: () => this.fillSelection() }),
        h('button.btn.btn-sm.btn-ghost', { text: 'Clear', onclick: () => this.clearLayer() }));
    } else if (t === 'move') {
      add(h('span.caption', { text: 'Drag to move the active layer' }), h('.sb-sep'),
        h('button.btn.btn-sm.btn-ghost', { text: 'Centre', onclick: () => this.centerLayer() }));
    } else if (t === 'picker') {
      add(h('span.caption', { text: 'Click to sample · hold Alt with any tool' }));
    } else if (t === 'pan') {
      add(h('span.caption', { text: 'Drag to pan · hold Space with any tool' }));
    }
    add(this.sizeChip);
  }

  /* ------------------------------------------------------------ status bar */
  _syncStatus = rafBatch(() => {
    if (!this.statusBar) return;
    const sel = this.mask ? maskBounds(this.mask, this.doc.w, this.doc.h) : null;
    const flat = flatten(this.doc);
    const colors = countColors(flat);
    const bounds = contentBounds(flat, this.doc.w, this.doc.h);
    setChildren(this.statusBar,
      h('span.sb-item', raw(icon('crop', 12)), h('span', { text: `${this.doc.w} × ${this.doc.h}` })),
      h('span.sb-item', raw(icon('layers', 12)), h('span.truncate', { text: this.layer?.name || '—' })),
      h('span.sb-item', raw(icon('palette', 12)), h('span', { text: `${colors} colour${colors === 1 ? '' : 's'}` })),
      bounds ? h('span.sb-item', raw(icon('target', 12)), h('span', { text: `art ${bounds.w}×${bounds.h}` })) : null,
      h('.spacer'),
      sel ? h('span.sb-item.accented', raw(icon('select', 12)), h('span', { text: `selection ${sel.w}×${sel.h}` })) : null,
      (this.symX || this.symY) ? h('span.sb-item.accented', raw(icon('symmetry', 12)),
        h('span', { text: this.symX && this.symY ? 'mirror both' : this.symX ? 'mirror ↔' : 'mirror ↕' })) : null,
    );
    this.guideX.hidden = !this.symX;
    this.guideY.hidden = !this.symY;
  });

  /* ---------------------------------------------------------------- panels */
  _buildPanels() {
    const col = h('.edpanels');
    this.panelScroll = h('.edpanels-scroll');
    col.appendChild(this.panelScroll);
    this._fillPanels();
    this.panels = col;
    return col;
  }

  _fillPanels() {
    this._panelDisposers.forEach(d => d());
    this._panelDisposers = [];
    clear(this.panelScroll);
    this.panelScroll.appendChild(this._buildColorBlock());
    this.panelScroll.appendChild(this._buildPaletteSection());
    for (const extra of (this.o.extraPanels?.() || [])) {
      this.panelScroll.appendChild(extra);
      // A panel can hand back its own teardown; honour it on the next rebuild.
      if (typeof extra.dispose === 'function') this._panelDisposers.push(extra.dispose);
    }
    if (this.refImage) this.panelScroll.appendChild(this._buildReferenceSection());
    this.panelScroll.appendChild(this._buildLayersSection());
    this.panelScroll.appendChild(this._buildHistorySection());
  }

  refreshPanels() {
    if (!this.panelScroll) return;
    const y = this.panelScroll.scrollTop;
    this._fillPanels();
    this.panelScroll.scrollTop = y;
  }

  /* ---- colour ---- */
  _buildColorBlock() {
    const primaryChip = h('.color-chip.primary', { style: { background: this.primary }, title: 'Primary — left click' });
    const secondaryChip = h('.color-chip.secondary', { style: { background: this.secondary }, title: 'Secondary — right click' });

    const svCanvas = h('canvas', { width: 200, height: 128 });
    const sv = h('.sv-area', svCanvas, h('.sv-cursor'));
    const hueStrip = h('.hue-strip', h('.strip-knob'));
    const alphaStrip = h('.alpha-strip.checker.checker-sm', h('.a-grad'), h('.strip-knob'));
    const hexInput = h('input.input.input-sm.input-mono', { style: 'text-transform:uppercase', 'aria-label': 'Hex colour' });

    let [H, S, V] = rgbToHsv(...hexToRgba(this.primary).slice(0, 3));
    let A = hexToRgba(this.primary)[3];
    let editingSecondary = false;

    const paint = (emit = true) => {
      const g = svCanvas.getContext('2d');
      const base = hsvToRgb(H, 1, 1);
      const gx = g.createLinearGradient(0, 0, svCanvas.width, 0);
      gx.addColorStop(0, '#fff'); gx.addColorStop(1, `rgb(${base[0]},${base[1]},${base[2]})`);
      g.fillStyle = gx; g.fillRect(0, 0, svCanvas.width, svCanvas.height);
      const gy = g.createLinearGradient(0, 0, 0, svCanvas.height);
      gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, '#000');
      g.fillStyle = gy; g.fillRect(0, 0, svCanvas.width, svCanvas.height);

      const cur = sv.querySelector('.sv-cursor');
      cur.style.left = (S * 100) + '%';
      cur.style.top = ((1 - V) * 100) + '%';
      hueStrip.querySelector('.strip-knob').style.left = (H / 360 * 100) + '%';
      alphaStrip.querySelector('.strip-knob').style.left = (A / 255 * 100) + '%';

      const [r, gg, b] = hsvToRgb(H, S, V);
      alphaStrip.querySelector('.a-grad').style.background =
        `linear-gradient(90deg, rgba(${r},${gg},${b},0), rgb(${r},${gg},${b}))`;
      const hex = rgbaToHex(r, gg, b, A);
      cur.style.background = hex;
      hexInput.value = hex.toUpperCase();
      if (emit) {
        if (editingSecondary) { this.secondary = hex; secondaryChip.style.background = hex; }
        else { this.primary = hex; primaryChip.style.background = hex; }
      }
    };

    const loadInto = hex => {
      const [r, g2, b, a] = hexToRgba(hex);
      [H, S, V] = rgbToHsv(r, g2, b); A = a;
      paint(false);
    };

    const rel = (el, e) => {
      const b = el.getBoundingClientRect();
      return { x: clamp((e.clientX - b.left) / b.width, 0, 1), y: clamp((e.clientY - b.top) / b.height, 0, 1) };
    };
    const track = (el, cb) => this._panelDisposers.push(drag(el, {
      onStart: (c, e) => cb(rel(el, e)),
      onMove: (c, e) => cb(rel(el, e)),
      onEnd: () => pushRecentColor(editingSecondary ? this.secondary : this.primary),
    }));
    track(sv, p => { S = p.x; V = 1 - p.y; paint(); });
    track(hueStrip, p => { H = p.x * 360; paint(); });
    track(alphaStrip, p => { A = Math.round(p.x * 255); paint(); });

    hexInput.addEventListener('input', () => {
      const v = hexInput.value.trim();
      if (/^#?[0-9a-fA-F]{3,8}$/.test(v)) {
        const [r, g2, b, a] = hexToRgba(v);
        [H, S, V] = rgbToHsv(r, g2, b); A = a;
        paint();
      }
    });
    hexInput.addEventListener('blur', () => pushRecentColor(editingSecondary ? this.secondary : this.primary));

    const setTarget = (secondary) => {
      editingSecondary = secondary;
      primaryChip.dataset.active = String(!secondary);
      secondaryChip.dataset.active = String(secondary);
      loadInto(secondary ? this.secondary : this.primary);
    };
    primaryChip.addEventListener('click', () => setTarget(false));
    secondaryChip.addEventListener('click', () => setTarget(true));
    setTarget(false);

    this._syncColorUI = () => {
      primaryChip.style.background = this.primary;
      secondaryChip.style.background = this.secondary;
      loadInto(editingSecondary ? this.secondary : this.primary);
    };
    queueMicrotask(() => paint(false));

    return h('.color-block',
      h('.color-duo',
        h('.color-chips', primaryChip, secondaryChip,
          h('button.color-swap', { 'data-tip': 'Swap  X', 'data-tip-pos': 'left', onclick: () => this.swapColors() }, raw(icon('refresh', 10)))),
        h('.grow', hexInput),
      ),
      sv, hueStrip, alphaStrip,
    );
  }

  setPrimary(hex) { this.primary = hex; this._syncColorUI?.(); pushRecentColor(hex); }
  setSecondary(hex) { this.secondary = hex; this._syncColorUI?.(); }
  swapColors() { const t = this.primary; this.primary = this.secondary; this.secondary = t; this._syncColorUI?.(); }

  /* ---- palette ---- */
  _buildPaletteSection() {
    const grid = h('.palette-grid');
    const recentGrid = h('.palette-grid');
    const hint = h('.caption.muted');

    const build = id => {
      clear(grid);
      const pal = getPalette(id);
      hint.textContent = pal.hint;
      for (const c of pal.colors) {
        grid.appendChild(h('button.swatch', {
          style: { background: c }, title: `${c.toUpperCase()}  ·  shift-click for secondary`,
          'aria-pressed': String(c.toLowerCase() === this.primary.toLowerCase()),
          onclick: e => { if (e.shiftKey) this.setSecondary(c); else this.setPrimary(c); build(id); },
          oncontextmenu: e => { e.preventDefault(); this.setSecondary(c); },
        }));
      }
    };
    const buildRecent = () => {
      clear(recentGrid);
      for (const c of state.prefs.recentColors.slice(0, 16)) {
        recentGrid.appendChild(h('button.swatch', {
          style: { background: c }, title: c.toUpperCase(),
          onclick: e => { if (e.shiftKey) this.setSecondary(c); else this.setPrimary(c); },
        }));
      }
      if (!state.prefs.recentColors.length) recentGrid.appendChild(h('.caption.muted', { text: 'Colours you use show up here.' }));
    };

    const current = PALETTE_IDS.includes(state.prefs.palette) ? state.prefs.palette : 'overworld';
    const sel = h('select.select.input-sm', {
      onchange: e => { state.prefs.palette = e.target.value; build(e.target.value); },
    }, ...PALETTE_IDS.map(id => h('option', { value: id, selected: id === current }, PALETTES[id].name)));

    build(current);
    buildRecent();
    this._panelDisposers.push(bus.on('colors:recent', buildRecent));

    return section('Palette', [
      sel, hint, grid,
      h('.row.between.g-2', { style: 'margin-top:8px' },
        h('.eyebrow', { text: 'Recent' }),
        h('button.btn.btn-sm.btn-ghost', {
          style: 'height:20px;padding:0 6px;font-size:10px',
          'data-tip': 'Build a palette from what is on this canvas', 'data-tip-pos': 'left',
          onclick: () => this._paletteFromArtwork(),
        }, 'From art'),
      ),
      recentGrid,
    ], { key: 'ed-palette' });
  }

  _paletteFromArtwork() {
    const flat = flatten(this.doc);
    const pts = [];
    for (let i = 0; i < flat.length; i += 4) {
      if (flat[i + 3] < 128) continue;
      pts.push([flat[i], flat[i + 1], flat[i + 2]]);
    }
    if (!pts.length) { toast({ title: 'Nothing on the canvas yet', kind: 'info' }); return; }
    const pal = medianCut(pts, 16).map(c => rgbaToHex(c[0], c[1], c[2]));
    for (const c of pal.reverse()) pushRecentColor(c);
    toast({ title: 'Palette pulled from your artwork', message: `${pal.length} colours added to Recent.`, kind: 'ok' });
  }

  /* ---- reference ---- */
  _buildReferenceSection() {
    return section('Reference', [
      h('.caption.muted', { text: 'Sits under your artwork as a guide. It never exports.' }),
      h('.row.g-2',
        h('span.caption', { style: 'width:52px', text: 'Opacity' }),
        h('.grow', slider({
          min: 5, max: 100, value: Math.round(this.refOpacity * 100),
          onInput: v => { this.refOpacity = v / 100; this.cvRef.style.opacity = this.refOpacity; },
          format: v => `${v}%`,
        })),
      ),
      h('.row.g-2',
        h('button.btn.btn-sm.grow', { onclick: () => this._loadReference() }, raw(icon('refresh', 12)), h('span', { text: 'Replace' })),
        h('button.btn.btn-sm.btn-danger', {
          onclick: () => { this.refImage = null; this.ctxRef.clearRect(0, 0, this.doc.w, this.doc.h); this.refreshPanels(); },
        }, raw(icon('trash', 12))),
      ),
    ], { key: 'ed-reference' });
  }

  /* ---- layers ---- */
  _buildLayersSection() {
    this.layerList = h('.layer-list');
    this._renderLayers();
    const sec = section('Layers', [this.layerList], {
      key: 'ed-layers', count: this.doc.layers.length,
      actions: [
        iconButton('plus', { tip: 'New layer', pos: 'left', onClick: () => this.addLayer() }),
        iconButton('duplicate', { tip: 'Duplicate', pos: 'left', onClick: () => this.duplicateLayer() }),
        iconButton('trash', { tip: 'Delete', pos: 'left', onClick: () => this.deleteLayer() }),
      ],
    });
    this._layerSection = sec;
    return sec;
  }

  _renderLayers() {
    if (!this.layerList) return;
    clear(this.layerList);
    this._layerThumbs.clear();
    const ordered = [...this.doc.layers].reverse();

    for (const layer of ordered) {
      const idx = this.doc.layers.indexOf(layer);
      const thumb = h('canvas', { width: this.doc.w, height: this.doc.h });
      const row = h('.layer-row', {
        draggable: 'true',
        'aria-selected': String(idx === this.doc.active),
        dataset: { hidden: String(!layer.visible), idx },
        onclick: () => { this.doc.active = idx; this._renderLayers(); this._syncStatus(); },
        oncontextmenu: e => { e.preventDefault(); this._layerMenu(layer, idx, { x: e.clientX, y: e.clientY }); },

        ondragstart: e => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
          row.dataset.dragging = 'true';
        },
        ondragend: () => {
          row.dataset.dragging = 'false';
          $$('.layer-row', this.layerList).forEach(r => { delete r.dataset.dropbefore; delete r.dataset.dropafter; });
        },
        ondragover: e => {
          e.preventDefault();
          const r = row.getBoundingClientRect();
          const above = (e.clientY - r.top) < r.height / 2;
          $$('.layer-row', this.layerList).forEach(x => { delete x.dataset.dropbefore; delete x.dataset.dropafter; });
          if (above) row.dataset.dropbefore = 'true'; else row.dataset.dropafter = 'true';
        },
        ondrop: e => {
          e.preventDefault();
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (!Number.isInteger(from) || from === idx) return;
          const r = row.getBoundingClientRect();
          const above = (e.clientY - r.top) < r.height / 2;
          // The list renders top-down but the stack is bottom-up, so "above"
          // in the list means a higher index in the document.
          let to = above ? idx + 1 : idx;
          if (from < to) to -= 1;
          to = clamp(to, 0, this.doc.layers.length - 1);
          if (to !== from) this.moveLayer(from, to);
        },
      },
        h('button.lay-vis', {
          'aria-label': layer.visible ? 'Hide layer' : 'Show layer',
          onclick: e => {
            e.stopPropagation();
            layer.visible = !layer.visible;
            this.redraw(); this._renderLayers(); markDirty(); this.o.onEdit?.();
          },
        }, raw(icon(layer.visible ? 'eye' : 'eyeOff', 13))),
        h('.lay-thumb.checker.checker-sm', thumb),
        h('.lay-main',
          h('.lay-name.truncate', { text: layer.name, ondblclick: e => this._renameLayer(e.currentTarget, layer) }),
          h('.lay-meta', { text: `${Math.round((layer.opacity ?? 1) * 100)}%${(layer.blend && layer.blend !== 'normal') ? ' · ' + layer.blend : ''}` }),
        ),
        layer.locked ? h('span', { style: 'color:var(--text-4)' }, raw(icon('lock', 12))) : null,
      );
      this.layerList.appendChild(row);
      this._paintThumb(thumb, layer);
      this._layerThumbs.set(layer.id, thumb);
    }

    const active = this.layer;
    if (active) {
      this.layerList.appendChild(h('.divider', { style: 'margin:8px 2px' }));
      const op = slider({
        min: 0, max: 100, value: Math.round((active.opacity ?? 1) * 100),
        onInput: v => { active.opacity = v / 100; this.redraw(); },
        onChange: () => { markDirty(); this.o.onEdit?.(); this._renderLayers(); },
        format: v => `${v}%`,
      });
      this.layerList.appendChild(h('.col.g-2',
        h('.row.g-2', h('span.caption', { style: 'width:52px', text: 'Opacity' }), h('.grow', op)),
        h('.row.g-2',
          h('span.caption', { style: 'width:52px', text: 'Blend' }),
          h('select.select.input-sm.grow', {
            onchange: e => { active.blend = e.target.value; this.redraw(); markDirty(); this.o.onEdit?.(); this._renderLayers(); },
          }, ...['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten']
            .map(b => h('option', { value: b, selected: b === (active.blend || 'normal') }, b[0].toUpperCase() + b.slice(1)))),
        ),
        h('.row.g-3',
          checkbox({ label: 'Lock', checked: !!active.locked, onChange: v => { active.locked = v; this._renderLayers(); markDirty(); } }),
          h('button.btn.btn-sm.btn-ghost', {
            disabled: this.doc.active <= 0, style: 'margin-left:auto',
            onclick: () => this.mergeDown(),
          }, raw(icon('layers', 12)), h('span', { text: 'Merge down' })),
        ),
      ));
    }
    if (this._layerSection) {
      const c = this._layerSection.querySelector('.badge-count');
      if (c) c.textContent = String(this.doc.layers.length);
    }
  }

  _paintThumb(canvas, layer) {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.putImageData(new ImageData(new Uint8ClampedArray(layer.data), this.doc.w, this.doc.h), 0, 0);
  }
  _thumbFor(layer) {
    const t = this._layerThumbs.get(layer.id);
    if (t) this._paintThumb(t, layer);
  }

  _renameLayer(el, layer) {
    el.contentEditable = 'true';
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges(); sel.addRange(range);
    const finish = () => {
      el.contentEditable = 'false';
      const v = el.textContent.trim() || 'Layer';
      layer.name = v; el.textContent = v;
      markDirty(); this.o.onEdit?.(); this._syncStatus();
    };
    el.addEventListener('blur', finish, { once: true });
    el.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.textContent = layer.name; el.blur(); }
    });
  }

  _layerMenu(layer, idx, at) {
    contextMenu([
      { label: 'Rename', icon: 'type', run: () => {
          const el = $$('.layer-row', this.layerList).find(r => +r.dataset.idx === idx)?.querySelector('.lay-name');
          if (el) this._renameLayer(el, layer);
        } },
      { label: 'Duplicate', icon: 'duplicate', run: () => this.duplicateLayer(idx) },
      { label: layer.locked ? 'Unlock' : 'Lock', icon: layer.locked ? 'unlock' : 'lock', run: () => { layer.locked = !layer.locked; this._renderLayers(); markDirty(); } },
      '-',
      { label: 'Move up', icon: 'arrowUp', disabled: idx >= this.doc.layers.length - 1, run: () => this.moveLayer(idx, idx + 1) },
      { label: 'Move down', icon: 'arrowDown', disabled: idx <= 0, run: () => this.moveLayer(idx, idx - 1) },
      { label: 'Merge down', icon: 'layers', disabled: idx <= 0, run: () => this.mergeDown(idx) },
      '-',
      { label: 'Clear', icon: 'eraser', run: () => this.clearLayer(idx) },
      { label: 'Delete', icon: 'trash', destructive: true, disabled: this.doc.layers.length <= 1, run: () => this.deleteLayer(idx) },
    ], at);
  }

  /* ---- history ---- */
  _buildHistorySection() {
    const list = h('.hist-list');
    const render = () => {
      clear(list);
      const hs = state.history;
      list.appendChild(h('.hist-row', {
        dataset: { current: String(hs.index < 0) },
        onclick: () => hs.goto(-1),
      }, h('span.hr-icon', raw(icon('file', 12))), h('span', { text: 'Opened' })));
      hs.stack.forEach((e, i) => {
        list.appendChild(h('.hist-row', {
          dataset: { current: String(i === hs.index), future: String(i > hs.index) },
          onclick: () => hs.goto(i),
        }, h('span.hr-icon', raw(icon(e.icon || 'edit', 12))), h('span.truncate', { text: e.label })));
      });
      // scrollIntoView walks every scrollable ancestor, so a stroke would drag
      // the whole inspector down to the history panel. Scroll the list itself.
      scrollIntoViewIfNeeded(list.querySelector('[data-current="true"]'), list);
    };
    render();
    this._panelDisposers.push(bus.on('history:change', render));
    return section('History', [list], { key: 'ed-history', open: false });
  }

  /* ------------------------------------------------------------- commands */
  addLayer() {
    this._commitStructural('Add layer', () => {
      const l = createLayer(this.doc.w, this.doc.h, `Layer ${this.doc.layers.length + 1}`);
      this.doc.layers.splice(this.doc.active + 1, 0, l);
      this.doc.active += 1;
    });
  }
  duplicateLayer(idx = this.doc.active) {
    this._commitStructural('Duplicate layer', () => {
      const src = this.doc.layers[idx];
      const copy = { ...src, id: `lay_${Math.random().toString(36).slice(2, 9)}`, name: src.name + ' copy', data: new Uint8ClampedArray(src.data) };
      this.doc.layers.splice(idx + 1, 0, copy);
      this.doc.active = idx + 1;
    });
  }
  deleteLayer(idx = this.doc.active) {
    if (this.doc.layers.length <= 1) {
      toast({ title: 'A document needs at least one layer', message: 'Clear it instead if you want a blank canvas.', kind: 'warn' });
      return;
    }
    this._commitStructural('Delete layer', () => {
      this.doc.layers.splice(idx, 1);
      this.doc.active = clamp(this.doc.active >= idx ? this.doc.active - 1 : this.doc.active, 0, this.doc.layers.length - 1);
    });
  }
  moveLayer(from, to) {
    this._commitStructural('Reorder layers', () => {
      const [l] = this.doc.layers.splice(from, 1);
      this.doc.layers.splice(to, 0, l);
      this.doc.active = to;
    });
  }
  mergeDown(idx = this.doc.active) {
    if (idx <= 0) return;
    this._commitStructural('Merge down', () => {
      const top = this.doc.layers[idx], below = this.doc.layers[idx - 1];
      below.data = flatten({ w: this.doc.w, h: this.doc.h, layers: [below, top], active: 0 });
      below.opacity = 1; below.blend = 'normal';
      this.doc.layers.splice(idx, 1);
      this.doc.active = idx - 1;
    });
  }
  clearLayer(idx = this.doc.active) {
    const layer = this.doc.layers[idx];
    const saved = this.doc.active;
    this.doc.active = idx;
    const before = snapshot(layer);
    if (this.mask) { for (let i = 0; i < this.mask.length; i++) if (this.mask[i]) layer.data[i * 4 + 3] = 0; }
    else layer.data.fill(0);
    this._push(before, this.mask ? 'Clear selection' : 'Clear layer', 'eraser');
    this.doc.active = saved;
  }
  fillSelection() {
    if (!this.mask) return;
    const c = hexToRgba(this.primary);
    this._commit('Fill selection', () => {
      const d = this.layer.data;
      for (let i = 0; i < this.mask.length; i++) {
        if (!this.mask[i]) continue;
        const j = i * 4;
        d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = c[3] ?? 255;
      }
    }, 'bucket');
  }

  selectAll() { this.mask = new Uint8Array(this.doc.w * this.doc.h).fill(255); this._drawOverlay(); this._renderToolOptions(); this._syncStatus(); }
  deselect() { this.mask = null; this._drawOverlay(); this._renderToolOptions(); this._syncStatus(); }

  centerLayer() {
    const b = contentBounds(this.layer.data, this.doc.w, this.doc.h);
    if (!b) { toast({ title: 'This layer is empty', kind: 'info', duration: 1600 }); return; }
    const dx = Math.round((this.doc.w - b.w) / 2 - b.x);
    const dy = Math.round((this.doc.h - b.h) / 2 - b.y);
    if (!dx && !dy) { toast({ title: 'Already centred', kind: 'info', duration: 1400 }); return; }
    this._commit('Centre layer', () => {
      this.layer.data.set(shift(this.layer.data, this.doc.w, this.doc.h, dx, dy, false));
    }, 'move');
  }

  _transform(kind) {
    this._commit(kind === 'flipH' ? 'Flip horizontal' : 'Flip vertical', () => {
      const fn = kind === 'flipH' ? flipHorizontal : flipVertical;
      this.layer.data.set(fn(this.layer.data, this.doc.w, this.doc.h));
    }, kind);
  }

  copySelection() {
    const src = flatten(this.doc);
    const b = this.mask ? maskBounds(this.mask, this.doc.w, this.doc.h) : { x: 0, y: 0, w: this.doc.w, h: this.doc.h };
    if (!b) return;
    const out = new Uint8ClampedArray(b.w * b.h * 4);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const sx = b.x + x, sy = b.y + y;
      if (this.mask && !this.mask[sy * this.doc.w + sx]) continue;
      const si = (sy * this.doc.w + sx) * 4, di = (y * b.w + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
    this.clipboard = { data: out, w: b.w, h: b.h };
    toast({ title: 'Copied', message: `${b.w} × ${b.h} pixels`, kind: 'ok', duration: 1500 });
  }

  pasteClipboard() {
    if (!this.clipboard) return;
    const { data, w, h: ch } = this.clipboard;
    this._commit('Paste', () => {
      const ox = Math.floor((this.doc.w - w) / 2), oy = Math.floor((this.doc.h - ch) / 2);
      for (let y = 0; y < ch; y++) for (let x = 0; x < w; x++) {
        const tx = ox + x, ty = oy + y;
        if (tx < 0 || ty < 0 || tx >= this.doc.w || ty >= this.doc.h) continue;
        const si = (y * w + x) * 4;
        if (data[si + 3] === 0) continue;
        const di = (ty * this.doc.w + tx) * 4;
        this.layer.data[di] = data[si]; this.layer.data[di + 1] = data[si + 1];
        this.layer.data[di + 2] = data[si + 2]; this.layer.data[di + 3] = data[si + 3];
      }
    }, 'copy');
  }

  /* ---- toggles ---- */
  _toggleSym(axis) {
    if (axis === 'x') { this.symX = !this.symX; this.symXBtn.classList.toggle('btn-primary', this.symX); }
    else { this.symY = !this.symY; this.symYBtn.classList.toggle('btn-primary', this.symY); }
    this._drawOverlay();
    this._syncStatus();
  }
  _toggleGrid() { this.showGrid = !this.showGrid; this.gridBtn.classList.toggle('btn-primary', this.showGrid); this._paintGrid(); }
  _toggleBlockGrid() { this.showBlockGrid = !this.showBlockGrid; this.blockBtn.classList.toggle('btn-primary', this.showBlockGrid); this._paintGrid(); }

  _moreMenu(anchor) {
    contextMenu([
      { type: 'label', label: 'Layer' },
      { label: 'Outline artwork', icon: 'target', run: () => this._commit('Outline', () => outlineOpaque(this.layer.data, this.doc.w, this.doc.h, hexToRgba(this.secondary), { outside: true })) },
      { label: 'Auto-shade', icon: 'shade', run: () => this._commit('Auto-shade', () => autoShade(this.layer.data, this.doc.w, this.doc.h, { angle: 315, strength: 0.16 })) },
      { label: 'Replace colour…', icon: 'palette', run: () => this._replaceColorFlow() },
      { label: 'Centre artwork', icon: 'move', run: () => this.centerLayer() },
      '-',
      { type: 'label', label: 'Canvas' },
      { label: this.refImage ? 'Replace reference image…' : 'Add reference image…', icon: 'image', run: () => this._loadReference() },
      this.refImage ? { label: 'Remove reference', icon: 'x', run: () => { this.refImage = null; this.ctxRef.clearRect(0, 0, this.doc.w, this.doc.h); this.refreshPanels(); } } : null,
      this.o.frameOf ? { label: this.showFrame ? 'Hide frame while drawing' : 'Show frame', icon: 'frame', run: () => { this.showFrame = !this.showFrame; this.redraw(); } } : null,
      '-',
      { label: 'Export PNG', icon: 'download', run: () => this.exportPNG() },
      { label: 'Copy', icon: 'copy', key: 'mod+C', run: () => this.copySelection() },
      { label: 'Paste', icon: 'file', key: 'mod+V', disabled: !this.clipboard, run: () => this.pasteClipboard() },
    ].filter(Boolean), anchor);
  }

  async _replaceColorFlow() {
    const from = await promptDialog({
      title: 'Replace colour',
      message: 'Every pixel close to the first colour becomes the second. Tolerance comes from the Fill tool.',
      label: 'Find', value: this.secondary, mono: true,
      validate: v => /^#?[0-9a-fA-F]{3,8}$/.test(v.trim()) ? null : 'Enter a hex colour like #7CB342',
      confirmLabel: 'Next',
    });
    if (!from) return;
    const to = await promptDialog({
      title: 'Replace colour', label: 'Replace with', value: this.primary, mono: true,
      validate: v => /^#?[0-9a-fA-F]{3,8}$/.test(v.trim()) ? null : 'Enter a hex colour',
      confirmLabel: 'Replace',
    });
    if (!to) return;
    let n = 0;
    this._commit('Replace colour', () => {
      n = replaceColor(this.layer.data, hexToRgba(from), hexToRgba(to), this.tolerance);
    }, 'palette');
    toast({ title: n ? `${plural(n, 'pixel')} replaced` : 'No pixels matched', kind: n ? 'ok' : 'warn', duration: 2200 });
  }

  async _loadReference() {
    const file = await pickFile({ accept: 'image/*' });
    if (!file) return;
    const { fileToImage, rasterize } = await import('../paint/imageimport.js');
    const img = await fileToImage(file);
    this.refImage = rasterize(img, this.doc.w, this.doc.h, { fit: 'contain', smooth: true });
    this.ctxRef.putImageData(this.refImage, 0, 0);
    this.cvRef.style.opacity = this.refOpacity;
    this.refreshPanels();
    toast({ title: 'Reference added', message: 'It sits under your artwork and never exports.', kind: 'ok' });
  }

  async exportPNG() {
    const c = document.createElement('canvas');
    c.width = this.doc.w; c.height = this.doc.h;
    c.getContext('2d').putImageData(flattenImageData(this.doc), 0, 0);
    downloadBlob(await canvasToBlob(c), `${this.o.filename || 'artwork'}.png`);
  }

  applyImageData(imageData, { asNewLayer = false, label = 'Import image' } = {}) {
    if (asNewLayer) {
      this._commitStructural(label, () => {
        const l = createLayer(this.doc.w, this.doc.h, 'Imported');
        l.data.set(imageData.data);
        this.doc.layers.splice(this.doc.active + 1, 0, l);
        this.doc.active++;
      }, 'image');
    } else {
      this._commit(label, () => this.layer.data.set(imageData.data), 'image');
    }
  }

  /* -------------------------------------------------------------- keyboard */
  _isTyping() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  /** True when some other modal is above this editor and should own the keys. */
  _blockedByOverlay() {
    if (document.querySelector('.cmdk-host')) return true;
    const overlays = $$('.overlay');
    if (!overlays.length) return false;
    const top = overlays[overlays.length - 1];
    return !top.contains(this.root);
  }

  _installKeys() {
    this._disposers.push(on(window, 'keydown', e => {
      if (!this.root?.isConnected) return;
      if (this._isTyping() || this._blockedByOverlay()) return;

      const mod = hasMod(e);
      const k = e.key.toLowerCase();

      if (this.place) {
        // While something is floating, the keyboard belongs to it.
        if (e.key === 'Escape') { e.preventDefault(); this.cancelPlace(); return; }
        if (e.key === 'Enter')  { e.preventDefault(); this.applyPlace(); return; }
        if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowLeft')  this.place.x -= step;
          if (e.key === 'ArrowRight') this.place.x += step;
          if (e.key === 'ArrowUp')    this.place.y -= step;
          if (e.key === 'ArrowDown')  this.place.y += step;
          this._placeRedraw();
          return;
        }
      }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? state.history.redo() : state.history.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); state.history.redo(); return; }
      if (mod && k === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (mod && k === 'd') { e.preventDefault(); this.deselect(); return; }
      if (mod && k === 'c') { e.preventDefault(); this.copySelection(); return; }
      if (mod && k === 'v') { e.preventDefault(); this.pasteClipboard(); return; }
      if (mod) return;

      const tool = TOOLS.find(t => t.key && t.key.toLowerCase() === k);
      if (tool) { e.preventDefault(); this.setTool(tool.id); return; }

      switch (e.key) {
        case '[': this.brushSize = clamp(this.brushSize - 1, 1, 16); this._renderToolOptions(); this._drawOverlay(); break;
        case ']': this.brushSize = clamp(this.brushSize + 1, 1, 16); this._renderToolOptions(); this._drawOverlay(); break;
        case 'x': this.swapColors(); break;
        case '0': this.fit(true); break;
        case '1': this.setZoom(1); break;
        case '+': case '=': this.zoomBy(1); break;
        case '-': case '_': this.zoomBy(-1); break;
        case 'Delete': case 'Backspace': this.clearLayer(); break;
        case 'Escape': this.deselect(); break;
        default: return;
      }
      e.preventDefault();
    }));
  }

  _unionMask(a, b) {
    const o = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] || b[i];
    return o;
  }
}
