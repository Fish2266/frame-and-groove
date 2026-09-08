/* ============================================================================
   Image import dialog — live preview with a real before/after comparison.
   ========================================================================= */

import { h, raw, clear, add } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { debounce } from '../core/util.js';
import { modal, toast, slider, segmented, field, checkbox, dropzone } from './kit.js';
import { convert, fileToImage, rasterize, FIT_MODES, DITHER_MODES } from '../paint/imageimport.js';
import { PALETTES, PALETTE_IDS } from '../paint/palettes.js';

const DEFAULTS = {
  fit: 'contain', smooth: true,
  brightness: 0, contrast: 0, saturation: 1, gamma: 1,
  paletteMode: 'auto', colorCount: 16, paletteId: 'overworld',
  dither: 'floyd', ditherStrength: 0.9,
  removeBg: false, bgTolerance: 24,
  hardAlpha: true, alphaThreshold: 128,
  zoom: 1, offsetX: 0, offsetY: 0, rotate: 0,
  asNewLayer: false,
};

let remembered = { ...DEFAULTS };

export async function openImportDialog(editor, presetFile = null) {
  let img = null;
  let opts = { ...remembered };
  let showOriginal = false;
  let derived = null;

  const previewCanvas = h('canvas');
  const previewWrap = h('.import-preview.checker', previewCanvas);
  const paletteStrip = h('.harmony-strip', { style: 'margin-top:6px' });
  const statLine = h('.caption.muted');

  const controls = h('.col.g-3', { style: 'max-height:420px;overflow-y:auto;padding-right:4px' });

  const render = debounce(() => {
    if (!img) return;
    const W = editor.doc.w, H = editor.doc.h;
    previewCanvas.width = W; previewCanvas.height = H;
    const g = previewCanvas.getContext('2d');
    g.imageSmoothingEnabled = false;

    if (showOriginal) {
      g.putImageData(rasterize(img, W, H, { fit: opts.fit, smooth: true, zoom: opts.zoom, offsetX: opts.offsetX, offsetY: opts.offsetY, rotate: opts.rotate }), 0, 0);
      statLine.textContent = `Source ${img.width}×${img.height}`;
    } else {
      const { imageData, palette } = convert(img, W, H, {
        ...opts,
        paletteColors: opts.paletteMode === 'fixed' ? PALETTES[opts.paletteId].colors : null,
      });
      g.putImageData(imageData, 0, 0);
      derived = palette;
      clear(paletteStrip);
      for (const c of (palette || []).slice(0, 32)) {
        paletteStrip.appendChild(h('i', { style: { background: `rgb(${c[0]},${c[1]},${c[2]})` } }));
      }
      statLine.textContent = `${W}×${H} · ${palette ? palette.length + ' colours' : 'full colour'}`;
    }
    const scale = Math.min(340 / W, 340 / H, 12);
    previewCanvas.style.width = Math.round(W * scale) + 'px';
    previewCanvas.style.height = Math.round(H * scale) + 'px';
  }, 90);

  function buildControls() {
    clear(controls);
    const row = (label, ctl) => h('.col.g-1', h('.field-label', { text: label }), ctl);

    add(controls,
      row('Framing', segmented({
        options: FIT_MODES.map(f => ({ value: f.id, label: f.label, hint: f.hint })),
        value: opts.fit, block: true, onChange: v => { opts.fit = v; render(); },
      })),
      row('Zoom', slider({
        min: 50, max: 400, value: opts.zoom * 100,
        onInput: v => { opts.zoom = v / 100; render(); }, format: v => `${Math.round(v)}%`,
      })),
      h('.row.g-2',
        h('.grow', row('Nudge X', slider({ min: -64, max: 64, value: opts.offsetX, onInput: v => { opts.offsetX = v; render(); }, format: v => `${v}` }))),
        h('.grow', row('Nudge Y', slider({ min: -64, max: 64, value: opts.offsetY, onInput: v => { opts.offsetY = v; render(); }, format: v => `${v}` }))),
      ),
      h('.divider'),
      row('Brightness', slider({ min: -60, max: 60, value: opts.brightness * 100, onInput: v => { opts.brightness = v / 100; render(); }, format: v => `${v > 0 ? '+' : ''}${v}` })),
      row('Contrast', slider({ min: -60, max: 90, value: opts.contrast * 100, onInput: v => { opts.contrast = v / 100; render(); }, format: v => `${v > 0 ? '+' : ''}${v}` })),
      row('Saturation', slider({ min: 0, max: 250, value: opts.saturation * 100, onInput: v => { opts.saturation = v / 100; render(); }, format: v => `${v}%` })),
      h('.divider'),
      row('Colours', segmented({
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'fixed', label: 'Palette' },
          { value: 'none', label: 'Full' },
        ],
        value: opts.paletteMode, block: true,
        onChange: v => { opts.paletteMode = v; buildControls(); render(); },
      })),
      opts.paletteMode === 'auto' ? row('How many', slider({
        min: 2, max: 64, value: opts.colorCount,
        onInput: v => { opts.colorCount = v; render(); }, format: v => `${v}`,
      })) : null,
      opts.paletteMode === 'fixed' ? row('Which palette', h('select.select', {
        onchange: e => { opts.paletteId = e.target.value; render(); },
      }, ...PALETTE_IDS.map(id => h('option', { value: id, selected: id === opts.paletteId }, PALETTES[id].name)))) : null,
      opts.paletteMode !== 'none' ? row('Dither', segmented({
        options: DITHER_MODES.map(d => ({ value: d.id, label: d.label, hint: d.hint })),
        value: opts.dither, block: true, onChange: v => { opts.dither = v; render(); },
      })) : null,
      opts.paletteMode !== 'none' && opts.dither !== 'none' ? row('Dither amount', slider({
        min: 10, max: 100, value: opts.ditherStrength * 100,
        onInput: v => { opts.ditherStrength = v / 100; render(); }, format: v => `${v}%`,
      })) : null,
      h('.divider'),
      checkbox({ label: 'Knock out flat background', checked: opts.removeBg, onChange: v => { opts.removeBg = v; buildControls(); render(); } }),
      opts.removeBg ? row('Background tolerance', slider({
        min: 2, max: 90, value: opts.bgTolerance, onInput: v => { opts.bgTolerance = v; render(); }, format: v => `${v}`,
      })) : null,
      checkbox({ label: 'Hard edges (no semi-transparent pixels)', checked: opts.hardAlpha, onChange: v => { opts.hardAlpha = v; render(); } }),
      h('.divider'),
      checkbox({ label: 'Bring in as a new layer', checked: opts.asNewLayer, onChange: v => { opts.asNewLayer = v; } }),
      h('button.btn.btn-sm.btn-ghost', {
        style: 'align-self:flex-start',
        onclick: () => { opts = { ...DEFAULTS, asNewLayer: opts.asNewLayer }; buildControls(); render(); },
      }, raw(icon('refresh', 13)), h('span', { text: 'Reset adjustments' })),
    );
  }

  const dz = dropzone({
    label: 'Drop an image, or click to choose',
    hint: 'PNG, JPG, GIF, WebP — anything the browser can open',
    accept: 'image/*', iconName: 'image',
    onFiles: async files => { await load(files[0]); },
  });

  const body = h('.col.g-4',
    h('.import-layout',
      h('.col.g-2',
        previewWrap,
        h('.row.between.g-2', statLine, paletteStrip),
      ),
      controls,
    ),
  );

  const stage = h('.col.g-4', dz);

  const m = modal({
    title: 'Import image',
    subtitle: `Converted to ${editor.doc.w}×${editor.doc.h} pixels — the exact size this artwork ships at.`,
    icon: 'image',
    width: 'wide',
    body: stage,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Place artwork', primary: true, disabled: true,
        run: () => {
          if (!img) return false;
          const { imageData } = convert(img, editor.doc.w, editor.doc.h, {
            ...opts, paletteColors: opts.paletteMode === 'fixed' ? PALETTES[opts.paletteId].colors : null,
          });
          editor.applyImageData(imageData, { asNewLayer: opts.asNewLayer });
          remembered = { ...opts };
          toast({ title: 'Artwork placed', message: opts.asNewLayer ? 'Added as a new layer.' : 'Replaced the active layer.', kind: 'ok' });
        },
      },
    ],
  });

  const placeBtn = m.el.querySelector('.modal-foot .btn-primary');

  async function load(file) {
    if (!file) return;
    try {
      img = await fileToImage(file);
      clear(stage);
      add(stage,
        h('.row.between.g-2',
          h('.row.g-2', raw(icon('image', 15)), h('span.body-sm.truncate', { text: file.name || 'Image' }),
            h('span.badge', { text: `${img.width}×${img.height}` })),
          h('.segmented',
            h('button', { 'aria-pressed': 'false', onclick: e => { showOriginal = true; sync(e); render(); }, text: 'Source' }),
            h('button', { 'aria-pressed': 'true', onclick: e => { showOriginal = false; sync(e); render(); }, text: 'Result' }),
          ),
        ),
        body,
        h('button.btn.btn-sm.btn-ghost', { style: 'align-self:flex-start', onclick: () => { clear(stage); stage.append(dz); img = null; placeBtn.disabled = true; } },
          raw(icon('arrowLeft', 13)), h('span', { text: 'Choose a different image' })),
      );
      function sync(e) {
        [...e.currentTarget.parentElement.children].forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      }
      buildControls();
      placeBtn.disabled = false;
      render();
    } catch (e) {
      toast({ title: 'Could not read that image', message: e.message, kind: 'error' });
    }
  }

  if (presetFile) await load(presetFile);
  return m;
}
