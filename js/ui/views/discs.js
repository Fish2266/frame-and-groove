/* ============================================================================
   Discs — audio in, sprite forged, jukebox entry out.
   ========================================================================= */

import { h, raw, clear, $$, drag, on, add, setChildren, observeResize } from '../../core/dom.js';
import { icon, iconSolid } from '../../core/icons.js';
import {
  slugifyId,
  clamp,
  formatTime,
  formatTimeMs,
  formatBytes,
  titleCase,
  copyText,
  debounce,
  rafBatch,
} from '../../core/util.js';
import {
  state,
  bus,
  markDirty,
  selectDisc,
  currentDisc,
  putAsset,
  getAsset,
} from '../../core/store.js';
import {
  createDisc,
  createAudio,
  audioClipLength,
  nextUniqueId,
  suggestDiscName,
  createPixelDoc,
  DISC_TEMPLATES,
} from '../../core/project.js';
import { DISC_BASE_ITEMS, RARITIES, MC_COLORS, getVersion, FEATURES } from '../../core/versions.js';
import {
  analyseAudio,
  decodeToBuffer,
  processBuffer,
  encodeOgg,
  computePeaks,
  Player,
  encoderStatus,
  loadEncoder,
  estimateOggBytes,
  QUALITY_STEPS,
} from '../../audio/engine.js';
import { openTrackGenerator } from '../trackgen.js';
import { getStyle } from '../../audio/compose.js';
import { Recorder, canRecord, toDb } from '../../audio/recorder.js';
import { discFaceCanvas, discSpriteData, DISC_PRESETS, presetPalette, paletteFromImageData } from '../../disc/sprite.js';
import {
  availableVanillaDiscs, hasVanillaDiscs, prettyDiscName, vanillaDiscCanvas,
  createVanillaSprite, baseHue, preloadVanillaDiscs,
} from '../../disc/vanilla.js';
import { availableChestTables, RARITY_WEIGHTS, createLootSettings } from '../../export/loot.js';
import { hasAssets } from '../../core/gameassets.js';
import { packReady } from '../../core/texturepack.js';
import { openGameLinkDialog } from '../gamelink.js';
import { discThumbCanvas, discPixelCanvas } from '../thumbs.js';
import { drawJukeboxScene } from '../pixelart.js';
import { PixelEditor } from '../editor.js';
import {
  iconButton,
  toast,
  contextMenu,
  confirmDialog,
  modal,
  field,
  textInput,
  selectInput,
  segmented,
  slider,
  switchRow,
  emptyState,
  note,
  codeBlock,
  badge,
  dropzone,
  progressBar,
  colorButton,
  checkbox,
  promptDialog,
  makeSortable,
} from '../kit.js';
import { giveCommand } from '../../export/packbuild.js';

export function buildDiscsView() {
  const list = h('.wk-sidebar-list');

  let filter = '';
  const filterRow = h('div', { hidden: true }, h('input.input.input-sm', {
    type: 'search', placeholder: 'Filter…',
    oninput: e => { filter = e.target.value.trim().toLowerCase(); renderList(); },
  }));
  const host = h('.grow', { style: 'display:flex;min-width:0;flex-direction:column' });
  let studio = null;

  const view = h('.view', { dataset: { view: 'discs' } },
    h('.workspace',
      h('.wk-sidebar',
        h('.wk-sidebar-head',
          h('.row.between.g-2',
            h('span.eyebrow', { text: 'Music discs' }),
            iconButton('plus', { tip: 'New disc', pos: 'left', cls: 'btn-sm', onClick: e => newMenu(e.currentTarget) }),
          ),
          filterRow,
        ),
        list,
        h('.wk-sidebar-foot',
          h('button.btn.btn-block.btn-sm', { onclick: e => newMenu(e.currentTarget) },
            raw(icon('plus', 13)), h('span', { text: 'New disc' }), raw(icon('chevDown', 11))),
        ),
      ),
      host,
    ),
  );

  /** New-disc routes, so the blank one is not the only option on offer. */
  function newMenu(anchor) {
    contextMenu([
      { label: 'Empty disc', icon: 'plus', run: () => addDisc() },
      { label: 'Generate a track\u2026', icon: 'sparkle', run: () => addDisc({ generate: true }) },
      canRecord() ? { label: 'Record now\u2026', icon: 'mic', run: () => addDisc({ record: true }) } : null,
    ].filter(Boolean), anchor);
  }

  function renderList() {
    clear(list);
    const p = state.project;
    if (!p) return;
    filterRow.hidden = p.discs.length < 7;
    if (filterRow.hidden) filter = '';
    if (!p.discs.length) {
      list.appendChild(h('.col.g-2.p-3.center', { style: 'text-align:center;color:var(--text-4)' },
        raw(icon('disc', 26)), h('.caption', { text: 'No discs yet.' })));
      return;
    }
    const shown = filter
      ? p.discs.filter(x => (x.name || '').toLowerCase().includes(filter) || x.id.includes(filter))
      : p.discs;
    if (!shown.length) {
      list.appendChild(h('.caption.muted.p-3', { style: 'text-align:center', text: `Nothing matches “${filter}”.` }));
      return;
    }

    for (const d of shown) {
      const len = audioClipLength(d.audio);
      list.appendChild(h('.list-row', {
        'aria-selected': String(d.key === state.selDisc),
        dataset: { index: p.discs.indexOf(d) },
        onclick: () => select(d.key),
        oncontextmenu: e => { e.preventDefault(); rowMenu(d, { x: e.clientX, y: e.clientY }); },
      },
        h('.disc-row-art', discThumbCanvas(d, 34)),
        h('.lr-main',
          h('.lr-title.truncate', { text: d.name || d.id }),
          h('.lr-sub.truncate', { text: len ? `${formatTime(len)} · ${d.id}` : d.id }),
        ),
        !d.audio?.encoded ? h('span', { style: 'color:var(--warn)', 'data-tip': 'No audio yet', 'data-tip-pos': 'left' }, raw(icon('warning', 13))) : null,
        h('.lr-actions', iconButton('more', { cls: 'btn-sm btn-ghost', onClick: e => { e.stopPropagation(); rowMenu(d, e.currentTarget); } })),
      ));
    }

    if (!filter) {
      makeSortable(list, {
        onReorder: (from, to) => {
          const [moved] = p.discs.splice(from, 1);
          p.discs.splice(to, 0, moved);
          markDirty('disc:reorder');
          renderList();
        },
      });
    }
  }

  function rowMenu(d, at) {
    contextMenu([
      { label: 'Rename…', icon: 'type', run: async () => {
          const v = await promptDialog({ title: 'Rename disc', label: 'Track name', value: d.name });
          if (v == null) return;
          d.name = v; d.descriptionText = v; markDirty(); renderList(); mountStudio();
        } },
      { label: 'Duplicate', icon: 'duplicate', run: () => duplicateDisc(d) },
      '-',
      { label: 'Copy /give command', icon: 'copy', run: async () => {
          await copyText(giveCommand(state.project, d, { includeSlash: true }));
          toast({ title: 'Command copied', kind: 'ok', duration: 1800 });
        } },
      '-',
      { label: 'Delete', icon: 'trash', destructive: true, run: () => deleteDisc(d) },
    ], at);
  }

  function select(key) { selectDisc(key); renderList(); mountStudio(); }

  function mountStudio() {
    studio?.destroy?.();
    studio = null;
    clear(host);
    const p = state.project;
    if (!p?.discs.length) {
      host.appendChild(h('.grow.center', emptyState({
        scene: 'jukebox',
        title: 'No discs yet',
        message: 'A disc is an Ogg Vorbis track, a jukebox entry that tells the game how long it runs, and a sprite. Record something or drop a file in and all three get written.',
        action: h('.row.g-2',
          h('button.btn.btn-lg.btn-primary', { onclick: () => addDisc() },
            raw(icon('plus', 15)), h('span', { text: 'New disc' })),
          h('button.btn.btn-lg', { onclick: () => addDisc({ generate: true }) },
            raw(icon('sparkle', 15)), h('span', { text: 'Generate a track' })),
          canRecord() ? h('button.btn.btn-lg', { onclick: () => addDisc({ record: true }) },
            raw(icon('mic', 15)), h('span', { text: 'Record' })) : null,
        ),
      })));
      return;
    }
    const d = currentDisc();
    if (!d) { select(p.discs[0].key); return; }
    studio = new DiscStudio(d, { onChange: () => renderList() });
    studio.mount(host);
  }

  function addDisc(opts = {}) {
    const p = state.project;
    const name = suggestDiscName(p);
    const d = createDisc(name);
    d.id = nextUniqueId(slugifyId(name), p.discs.map(x => x.id));
    d.sprite.colors = presetPalette(DISC_PRESETS[p.discs.length % DISC_PRESETS.length]);
    p.discs.push(d);
    markDirty('disc:add');
    select(d.key);
    if (opts.record) setTimeout(() => studio?.openRecorder(), 80);
    if (opts.generate) setTimeout(() => studio?.openGenerator(), 80);
  }

  function duplicateDisc(d) {
    const p = state.project;
    const copy = {
      ...d, key: `dsc_${Math.random().toString(36).slice(2, 10)}`,
      id: nextUniqueId(d.id + '_copy', p.discs.map(x => x.id)),
      name: d.name + ' copy',
      sprite: { ...d.sprite, colors: { ...d.sprite.colors }, doc: d.sprite.doc ? { ...d.sprite.doc, layers: d.sprite.doc.layers.map(l => ({ ...l, data: new Uint8ClampedArray(l.data) })) } : null },
      audio: d.audio ? { ...d.audio } : null,
    };
    p.discs.splice(p.discs.indexOf(d) + 1, 0, copy);
    markDirty(); select(copy.key);
    toast({ title: 'Disc duplicated', message: 'It shares the same audio file until you replace it.', kind: 'ok' });
  }

  async function deleteDisc(d) {
    const ok = await confirmDialog({
      title: `Delete “${d.name || d.id}”?`,
      message: 'The track, its sprite and its jukebox entry are removed from this pack.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const p = state.project;
    const i = p.discs.indexOf(d);
    p.discs.splice(i, 1);
    markDirty();
    selectDisc(p.discs[Math.min(i, p.discs.length - 1)]?.key || null);
    const { gcAssets } = await import('../../core/store.js');
    gcAssets().catch(() => {});
    renderList(); mountStudio();
  }

  view.refresh = () => { renderList(); mountStudio(); };
  view.addDisc = addDisc;
  view.destroy = () => studio?.destroy?.();
  bus.on('project:open', () => view.refresh());
  return view;
}

/* ========================================================================= */
/* DISC STUDIO                                                               */
/* ========================================================================= */

class DiscStudio {
  constructor(disc, opts = {}) {
    this.d = disc;
    this.o = opts;
    this.player = new Player();
    this.sourceBuffer = null;
    this.renderedBuffer = null;
    this.encoding = false;
    this.needsEncode = false;
    this._disposers = [];
    this._waveDisposers = [];
    this._rec = null;
  }

  destroy() {
    this.player.dispose();
    this._rec?.disarm?.();
    this._waveDisposers.forEach(f => f());
    this._disposers.forEach(f => f());
    this._sceneOff?.(); this._waveOff?.();
    this._disposers = []; this._waveDisposers = [];
    this.root?.remove();
  }

  mount(container) {
    this.root = h('.disc-layout',
      h('.disc-scroll',
        h('.col.g-5', { style: 'max-width:1180px' },
          this.hero = h('div'),
          h('.disc-cols',
            h('.col.g-5', this.audioCol = h('div'), this.metaCol = h('div'), this.lootCol = h('div')),
            h('.col.g-5', this.forgeCol = h('div'), this.previewCol = h('div')),
          ),
        ),
      ),
    );
    clear(container).appendChild(this.root);
    this.renderHero();
    this.renderAudio();
    this.renderMeta();
    this.renderLoot();
    this.renderForge();
    this.renderPreview();
    this.loadAudio();

    /* Space plays and pauses, the way it does in every other audio tool. */
    this._disposers.push(on(window, 'keydown', e => {
      if (!this.root?.isConnected) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('.overlay, .cmdk-host')) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); this.toggleLoop(); }
    }));

    /* An audio file dropped anywhere in the app lands on the open disc. */
    this._disposers.push(bus.on('drop:audio', file => {
      if (!this.root?.isConnected) return;
      this.ingestFile(file);
    }));
    return this;
  }

  toggleLoop() {
    this.player.loop = !this.player.loop;
    this.loopBtn?.classList.toggle('btn-primary', this.player.loop);
    toast({ title: this.player.loop ? 'Looping the trimmed region' : 'Loop off', kind: 'info', duration: 1400 });
  }

  /* ------------------------------------------------------------------ hero */
  renderHero() {
    const d = this.d;
    const vinylCanvas = h('canvas', { width: 264, height: 264 });
    this.vinyl = h('.vinyl', { dataset: { playing: 'false' } }, h('.v-spin', vinylCanvas));
    this.vinylCanvas = vinylCanvas;
    this.paintVinyl();

    this.playBtn = h('button.play-btn', {
      'aria-label': 'Play', disabled: true,
      onclick: () => this.togglePlay(),
    }, raw(iconSolid('play', 18)));

    this.timeEl = h('span.time-readout', { text: '0:00 / 0:00' });
    this.waveHost = h('.wave-shell', h('.wave-empty', { text: 'No audio loaded yet' }));
    this.rulerEl = h('.wave-ruler');
    this.loopBtn = iconButton('loop', {
      tip: 'Loop the trimmed region  L', cls: 'btn-ghost btn-sm',
      onClick: () => this.toggleLoop(),
    });

    this.heroTitle = h('span.hero-title.truncate', { text: d.name || d.id });
    this.heroArtist = h('span.dim', { text: d.artist ? `\u00B7 ${d.artist}` : '' });
    this.heroId = badge(`${state.project.namespace}:${d.id}`, 'disc');

    clear(this.hero).appendChild(h('.disc-hero',
      this.vinyl,
      h('.hero-main',
        h('.hero-title-row',
          this.heroTitle,
          this.heroArtist,
          h('.spacer'),
          this.heroId,
        ),
        h('.transport',
          this.playBtn,
          h('.col.g-1.grow', this.waveHost, this.rulerEl),
        ),
        h('.row.g-3',
          this.timeEl,
          this.loopBtn,
          h('.spacer'),
          this.statusChip = h('span.caption.muted'),
        ),
      ),
    ));
    this.installWaveInteraction();
  }

  /** Cheap in-place update — rebuilding the hero would wipe the waveform. */
  updateHeroText() {
    const d = this.d;
    if (!this.heroTitle) return;
    this.heroTitle.textContent = d.name || d.id;
    this.heroArtist.textContent = d.artist ? `\u00B7 ${d.artist}` : '';
    this.heroId.textContent = `${state.project.namespace}:${d.id}`;
  }

  /* The hero record is the shipping sprite, not a smooth stand-in: whatever
     mode the disc uses — hand-drawn pixels, a real vanilla texture, or a
     generated template — this is the art the pack writes. 16x16 at a whole
     16x keeps the grid square, so it is centred in the 264px canvas rather
     than stretched to a fractional scale. */
  paintVinyl = rafBatch(() => {
    if (!this.vinylCanvas) return;
    const g = this.vinylCanvas.getContext('2d');
    g.clearRect(0, 0, 264, 264);
    g.imageSmoothingEnabled = false;
    const c = discFaceCanvas(this.d, 16);
    g.drawImage(c, Math.round((264 - c.width) / 2), Math.round((264 - c.height) / 2));
  });

  /* ------------------------------------------------------------- waveform */
  installWaveInteraction() {
    this._disposers.push(drag(this.waveHost, {
      onStart: (c, e) => this.seekFromEvent(e),
      onMove: (c, e) => this.seekFromEvent(e),
    }));
  }

  seekFromEvent(e) {
    const a = this.d.audio;
    if (!a || !this.sourceBuffer) return;
    const r = this.waveHost.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * a.durationSec;
    const start = a.trimStart, end = a.trimEnd > 0 ? a.trimEnd : a.durationSec;
    this.player.seek(clamp(t - start, 0, Math.max(0, end - start)));
    this.updatePlayhead();
  }

  drawWave() {
    const a = this.d.audio;
    // Every redraw rebinds the trim handles, so drop the previous bindings
    // rather than stacking a new pair on top of them each time.
    this._waveDisposers.forEach(f => f());
    this._waveDisposers = [];
    clear(this.waveHost);
    if (!a?.peaks) {
      this.waveHost.appendChild(h('.wave-empty', { text: 'No audio loaded yet' }));
      return;
    }
    const cvs = h('canvas');
    this.waveCanvas = cvs;
    this.waveHost.appendChild(cvs);

    const start = a.trimStart, end = a.trimEnd > 0 ? a.trimEnd : a.durationSec;
    const p0 = (start / a.durationSec) * 100, p1 = (end / a.durationSec) * 100;
    add(this.waveHost,
      h('.w-mask', { style: `left:0;width:${p0}%` }),
      h('.w-mask', { style: `left:${p1}%;right:0` }),
      h('.w-region', { style: `left:${p0}%;width:${Math.max(0.5, p1 - p0)}%` }),
      this.handleA = h('.wave-handle', { style: `left:calc(${p0}% - 6px)` }),
      this.handleB = h('.wave-handle', { style: `left:calc(${p1}% - 6px)` }),
      this.playhead = h('.w-playhead', { style: 'left:0' }),
    );

    const dragHandle = (el, which) => this._waveDisposers.push(drag(el, {
      onStart: c => { c.cancel = false; },
      onMove: (c, e) => {
        const r = this.waveHost.getBoundingClientRect();
        const t = clamp((e.clientX - r.left) / r.width, 0, 1) * a.durationSec;
        if (which === 'a') a.trimStart = clamp(t, 0, (a.trimEnd > 0 ? a.trimEnd : a.durationSec) - 0.1);
        else a.trimEnd = clamp(t, a.trimStart + 0.1, a.durationSec);
        this.drawWave(); this.renderAudio(); this.scheduleRender();
      },
      onEnd: () => { markDirty(); this.scheduleEncode(); },
    }));
    dragHandle(this.handleA, 'a');
    dragHandle(this.handleB, 'b');

    this.paintWaveCanvas();
    this.updatePlayhead();
    this.drawRuler();
    // The waveform is drawn at a fixed pixel width; without this it stretches
    // as soon as the window changes.
    this._waveOff?.();
    this._waveOff = observeResize(this.waveHost, () => this.paintWaveCanvas());
  }

  /** A three-mark time ruler under the waveform — enough to orient, not clutter. */
  drawRuler() {
    const a = this.d.audio;
    if (!this.rulerEl) return;
    if (!a?.durationSec) { clear(this.rulerEl); return; }
    const start = a.trimStart, end = a.trimEnd > 0 ? a.trimEnd : a.durationSec;
    setChildren(this.rulerEl,
      h('span', { text: formatTime(0) }),
      h('span', { style: 'color:var(--disc-accent)', text: `${formatTime(start)} \u2192 ${formatTime(end)}` }),
      h('span', { text: formatTime(a.durationSec) }),
    );
  }

  paintWaveCanvas = rafBatch(() => {
    const cvs = this.waveCanvas;
    const a = this.d.audio;
    if (!cvs || !a?.peaks) return;
    const r = this.waveHost.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    cvs.width = W; cvs.height = H;
    const g = cvs.getContext('2d');
    g.clearRect(0, 0, W, H);

    const peaks = a.peaks, n = peaks.length / 2;
    const mid = H / 2;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--disc-accent').trim() || '#B084F5';

    /* Body */
    g.fillStyle = accent;
    g.globalAlpha = 0.85;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
      let mn = 1, mx = -1;
      for (let i = i0; i < i1 && i < n; i++) {
        if (peaks[i * 2] < mn) mn = peaks[i * 2];
        if (peaks[i * 2 + 1] > mx) mx = peaks[i * 2 + 1];
      }
      if (mx < mn) { mn = 0; mx = 0; }
      const y0 = mid - mx * mid * 0.92, y1 = mid - mn * mid * 0.92;
      g.fillRect(x, y0, 1, Math.max(1 * dpr, y1 - y0));
    }
    g.globalAlpha = 1;

    /* Centre line */
    g.fillStyle = 'rgba(255,255,255,.14)';
    g.fillRect(0, mid - 0.5 * dpr, W, Math.max(1, dpr));
  });

  updatePlayhead = rafBatch(() => {
    const a = this.d.audio;
    if (!this.playhead || !a) return;
    const t = a.trimStart + this.player.currentTime;
    this.playhead.style.left = clamp((t / a.durationSec) * 100, 0, 100) + '%';
    const len = audioClipLength(a);
    this.timeEl.innerHTML = '';
    this.timeEl.append(
      formatTimeMs(this.player.currentTime),
      h('span.t-sep', { text: '  /  ' }),
      formatTimeMs(len),
    );
  });

  /* ---------------------------------------------------------------- audio */
  async loadAudio() {
    const a = this.d.audio;
    if (!a?.assetId) { this.drawWave(); this.renderAudio(); return; }
    try {
      const rec = await getAsset(a.assetId);
      if (!rec) throw new Error('The source file is missing from storage.');
      this.sourceBuffer = await decodeToBuffer(rec.blob);
      if (!a.peaks) { a.peaks = computePeaks(this.sourceBuffer); markDirty(); }
      if (!a.durationSec) a.durationSec = this.sourceBuffer.duration;
      this.drawWave();
      this.renderRendered();
      this.playBtn.disabled = false;
      this.renderAudio();
    } catch (e) {
      console.warn(e);
      this.statusChip.textContent = 'Audio could not be decoded.';
      this.drawWave();
      this.renderAudio();
    }
  }

  renderRendered() {
    if (!this.sourceBuffer) return;
    const a = this.d.audio;
    this.renderedBuffer = processBuffer(this.sourceBuffer, a);
    const wasPlaying = this.player.playing;
    const at = this.player.currentTime;
    this.player.load(this.renderedBuffer);
    this.player.region = [0, this.renderedBuffer.duration];
    this.player.onTick = () => this.updatePlayhead();
    this.player.onEnd = () => { this.vinyl.dataset.playing = 'false'; this.playBtn.innerHTML = iconSolid('play', 18); this.updatePlayhead(); };
    if (wasPlaying) this.player.play(clamp(at, 0, this.renderedBuffer.duration - 0.05));
    this.updatePlayhead();
  }

  scheduleRender = debounce(() => { this.renderRendered(); }, 140);

  togglePlay() {
    if (!this.renderedBuffer) return;
    if (this.player.playing) {
      this.player.pause();
      this.vinyl.dataset.playing = 'false';
      this.playBtn.innerHTML = iconSolid('play', 18);
    } else {
      this.player.play();
      this.vinyl.dataset.playing = 'true';
      this.playBtn.innerHTML = iconSolid('pause', 18);
    }
  }

  renderAudio() {
    const d = this.d;
    const a = d.audio;
    const body = [];

    if (!a) {
      body.push(dropzone({
        label: 'Drop an audio file, or click to choose',
        hint: 'MP3, WAV, M4A, FLAC, Ogg — converted to Ogg Vorbis for you',
        accept: 'audio/*', iconName: 'music',
        onFiles: files => this.ingestFile(files[0]),
      }));
      body.push(h('.row.g-2.center',
        h('.divider.grow'), h('span.caption.muted', { text: 'or' }), h('.divider.grow')));
      body.push(h('.row.g-2',
        h('button.btn.btn-lg.grow', { onclick: () => this.openGenerator() },
          raw(icon('sparkle', 16)), h('span', { text: 'Generate a track' })),
        canRecord() ? h('button.btn.btn-lg.grow', { onclick: () => this.openRecorder() },
          raw(icon('mic', 16)), h('span', { text: 'Record' })) : null,
      ));
      body.push(h('.caption.muted', {
        text: canRecord()
          ? 'Generating writes a short piece from a seed, so you can fill a disc in seconds and swap it later.'
          : 'This browser has no microphone capture, but generating a track works everywhere.',
      }));
    } else {
      const len = audioClipLength(a);
      const est = a.encoded?.size || estimateOggBytes(len, a.mono ? 1 : a.channels, a.quality);

      body.push(h('.row.g-3.items-start',
        h('.col.g-1.grow',
          h('.row.g-2',
            raw(icon(a.generated ? 'sparkle' : 'file', 14)),
            h('span.strong.truncate', { text: a.sourceName || 'Recording' }),
            a.generated ? h('span.gen-chip', raw(icon('sparkle', 9)), 'generated') : null,
          ),
          h('.caption.muted', { text: `${formatTime(a.durationSec)} source · ${a.sampleRate.toLocaleString()} Hz · ${a.channels === 1 ? 'mono' : 'stereo'}${a.reimported ? ' · re-imported' : ''}` }),
        ),
        h('.row.g-1',
          iconButton('sparkle', { tip: a.generated ? 'Tweak the generated track' : 'Generate a track instead', cls: 'btn-sm', onClick: () => this.openGenerator() }),
          iconButton('upload', { tip: 'Replace with a file', cls: 'btn-sm', onClick: () => this.replaceAudio() }),
          canRecord() ? iconButton('mic', { tip: 'Record over it', cls: 'btn-sm', onClick: () => this.openRecorder() }) : null,
          iconButton('trash', { tip: 'Remove audio', cls: 'btn-sm btn-danger', onClick: () => this.removeAudio() }),
        ),
      ));

      body.push(h('.divider'));

      /* Trim */
      body.push(h('.row.g-3',
        h('.col.g-1.grow',
          h('.field-label', { text: 'Trim start' }),
          h('.mono.dim', { text: formatTimeMs(a.trimStart) }),
        ),
        h('.col.g-1.grow',
          h('.field-label', { text: 'Trim end' }),
          h('.mono.dim', { text: formatTimeMs(a.trimEnd > 0 ? a.trimEnd : a.durationSec) }),
        ),
        h('.col.g-1',
          h('.field-label', { text: 'Length' }),
          h('.mono.accented', { text: formatTimeMs(len) }),
        ),
        a.trimStart > 0 || a.trimEnd > 0
          ? h('button.btn.btn-sm.btn-ghost', { style: 'align-self:flex-end', onclick: () => { a.trimStart = 0; a.trimEnd = 0; this.afterAudioChange(); } }, 'Reset')
          : null,
      ));

      /* Levels */
      body.push(field('Gain', slider({
        min: 0, max: 250, value: Math.round(a.gain * 100),
        onInput: v => { a.gain = v / 100; this.scheduleRender(); },
        onChange: () => this.afterAudioChange(),
        format: v => v === 100 ? '0 dB' : `${(20 * Math.log10(v / 100)).toFixed(1)} dB`,
      })));

      body.push(h('.row.g-3',
        h('.grow', field('Fade in', slider({
          min: 0, max: 100, value: Math.round(a.fadeIn * 10),
          onInput: v => { a.fadeIn = v / 10; this.scheduleRender(); },
          onChange: () => this.afterAudioChange(),
          format: v => `${(v / 10).toFixed(1)}s`,
        }))),
        h('.grow', field('Fade out', slider({
          min: 0, max: 100, value: Math.round(a.fadeOut * 10),
          onInput: v => { a.fadeOut = v / 10; this.scheduleRender(); },
          onChange: () => this.afterAudioChange(),
          format: v => `${(v / 10).toFixed(1)}s`,
        }))),
      ));

      body.push(switchRow({
        title: 'Normalise', desc: 'Lift the loudest peak to just under full scale.',
        checked: a.normalize, onChange: v => { a.normalize = v; this.afterAudioChange(); },
      }));

      body.push(switchRow({
        title: 'Fold to mono',
        desc: 'Minecraft only positions mono sounds in 3D. Stereo plays flat across the world, ignoring where the jukebox is.',
        checked: a.mono, onChange: v => { a.mono = v; this.afterAudioChange(); },
      }));

      body.push(h('.divider'));

      /* Quality */
      body.push(field('Encoding quality', h('.col.g-2',
        segmented({
          options: QUALITY_STEPS.map(q => ({ value: q.q, label: q.label, hint: q.hint })),
          value: a.quality, block: true,
          onChange: v => { a.quality = +v; this.afterAudioChange(); },
        }),
        h('.row.between',
          h('span.caption.muted', { text: QUALITY_STEPS.find(q => q.q === a.quality)?.hint || '' }),
          h('span.caption.mono', { text: a.encoded ? formatBytes(a.encoded.size) : `~${formatBytes(est)}` }),
        ),
      )));

      this.encodeStatus = h('div');
      body.push(this.encodeStatus);
      this.paintEncodeStatus();
    }

    clear(this.audioCol).appendChild(
      h('.panel',
        h('.panel-head', h('h3', { text: 'Audio' }), h('.spacer'),
          a?.encoded ? badge('Ogg Vorbis', 'ok') : badge('Needs audio', 'warn')),
        h('.panel-body.col.g-4', ...body.filter(Boolean)),
      ),
    );
  }

  afterAudioChange() {
    markDirty();
    this.renderRendered();
    this.drawWave();
    this.renderAudio();
    this.scheduleEncode();
    this.o.onChange?.();
  }

  /* --------------------------------------------------------------- ingest */
  async ingestFile(file) {
    if (!file) return;
    const t = toast({ title: 'Reading audio…', message: file.name, kind: 'info', duration: 0 });
    try {
      const info = await analyseAudio(file);
      const assetId = await putAsset('audio', file, { name: file.name });
      this.d.audio = createAudio({
        assetId, sourceName: file.name, mime: file.type, size: file.size,
        durationSec: info.durationSec, sampleRate: info.sampleRate,
        channels: info.channels, peaks: info.peaks,
        mono: true, quality: 4,
      });
      this.sourceBuffer = info.buffer;
      markDirty();
      t.dismiss();
      this.drawWave();
      this.renderRendered();
      this.playBtn.disabled = false;
      this.renderAudio();
      this.o.onChange?.();
      await this.encodeNow();
    } catch (e) {
      t.dismiss();
      toast({ title: 'That audio could not be read', message: e.message, kind: 'error' });
    }
  }

  async replaceAudio() {
    const { pickFile } = await import('../../core/util.js');
    const f = await pickFile({ accept: 'audio/*' });
    if (f) await this.ingestFile(f);
  }

  async removeAudio() {
    const ok = await confirmDialog({
      title: 'Remove the audio?',
      message: 'The disc keeps its name and sprite, but will not export until you add a track.',
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    this.player.stop();
    this.d.audio = null;
    this.sourceBuffer = null; this.renderedBuffer = null;
    this.playBtn.disabled = true;
    markDirty();
    this.drawWave(); this.renderAudio(); this.o.onChange?.();
    const { gcAssets } = await import('../../core/store.js');
    gcAssets().catch(() => {});
  }

  /* --------------------------------------------------------------- encode */
  scheduleEncode = debounce(() => { this.encodeNow().catch(() => {}); }, 1100);

  paintEncodeStatus() {
    if (!this.encodeStatus) return;
    clear(this.encodeStatus);
    const a = this.d.audio;
    if (!a) return;
    if (this.encoding) {
      this.encodeProg = progressBar({ label: 'Encoding to Ogg Vorbis…' });
      this.encodeStatus.appendChild(this.encodeProg);
    } else if (a.encoded) {
      this.encodeStatus.appendChild(note(
        `Ready to ship: ${formatBytes(a.encoded.size)} of Ogg Vorbis, ${formatTime(audioClipLength(a))} long.`, 'ok'));
    } else if (encoderStatus.state === 'error') {
      this.encodeStatus.appendChild(h('.col.g-2',
        note(`The Ogg encoder is unavailable (${encoderStatus.error}). You can still drop in a file that is already .ogg.`, 'warn'),
        h('button.btn.btn-sm', { onclick: () => this.encodeNow() }, raw(icon('refresh', 13)), h('span', { text: 'Try again' })),
      ));
    } else {
      this.encodeStatus.appendChild(h('button.btn.btn-block', { onclick: () => this.encodeNow() },
        raw(icon('bolt', 14)), h('span', { text: 'Convert to Ogg Vorbis' })));
    }
  }

  async encodeNow() {
    const a = this.d.audio;
    if (!a || !this.sourceBuffer || this.encoding) return;
    this.encoding = true;
    this.paintEncodeStatus();
    try {
      await loadEncoder();
      const buf = processBuffer(this.sourceBuffer, a);
      const blob = await encodeOgg(buf, {
        quality: a.quality,
        onProgress: p => this.encodeProg?.set(p, `Encoding to Ogg Vorbis… ${Math.round(p * 100)}%`),
      });
      const assetId = await putAsset('audio', blob, { name: `${this.d.id}.ogg`, encoded: true });
      a.encoded = { assetId, size: blob.size };
      markDirty();
      const { gcAssets } = await import('../../core/store.js');
      gcAssets().catch(() => {});
      this.o.onChange?.();
    } catch (e) {
      console.error(e);
      toast({ title: 'Encoding failed', message: e.message, kind: 'error' });
    } finally {
      this.encoding = false;
      this.paintEncodeStatus();
      this.renderMeta();
    }
  }

  /* ------------------------------------------------------------ generator */
  openGenerator() {
    openTrackGenerator({
      initial: this.d.audio?.generated || null,
      onAccept: ({ buffer, blob, name, meta }) => this.ingestBuffer(buffer, blob, name, meta),
    });
  }

  /**
   * Take an already-decoded buffer straight in. Generated tracks arrive this
   * way, which skips a decode round-trip and keeps the exact samples we made.
   */
  async ingestBuffer(buffer, blob, name, generated) {
    const t = toast({ title: 'Rendering track\u2026', kind: 'info', duration: 0 });
    try {
      const label = generated ? `${getStyle(generated.style).name} \u00B7 seed ${generated.seed}` : (name || 'Generated');
      const assetId = await putAsset('audio', blob, { name: `${name || 'generated'}.wav` });
      this.d.audio = createAudio({
        assetId, sourceName: label, mime: 'audio/wav', size: blob.size,
        durationSec: buffer.duration, sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        peaks: computePeaks(buffer),
        mono: true, quality: 4, generated: generated || null,
      });
      if (name && (!this.d.name || /^Track \d+$/.test(this.d.name))) {
        this.d.name = name;
        this.d.descriptionText = name;
      }
      this.sourceBuffer = buffer;
      markDirty();
      t.dismiss();
      this.updateHeroText();
      this.drawWave();
      this.renderRendered();
      this.playBtn.disabled = false;
      this.renderAudio();
      this.renderPreview();
      this.o.onChange?.();
      await this.encodeNow();
    } catch (e) {
      t.dismiss();
      toast({ title: 'Could not use that track', message: e.message, kind: 'error' });
    }
  }

  /* ------------------------------------------------------------- recorder */
  openRecorder() {
    if (!canRecord()) {
      toast({ title: 'Recording is not available', message: 'This browser has no microphone capture.', kind: 'warn' });
      return;
    }
    openRecorderDialog(blob => this.ingestFile(new File([blob], `recording-${Date.now()}.webm`, { type: blob.type })));
  }

  /* ------------------------------------------------------------ metadata */
  renderMeta() {
    const d = this.d;
    const project = state.project;
    const v = getVersion(project.mcVersion);
    const canModel = v.features.includes(FEATURES.ITEM_MODEL);

    const nameInput = textInput({
      value: d.name, onInput: val => {
        d.name = val;
        if (!d.descriptionTouched) d.descriptionText = val;
        markDirty(); this.updateHeroText(); this.renderPreview(); this.o.onChange?.();
      },
    });
    const artistInput = textInput({
      value: d.artist, placeholder: 'Optional',
      onInput: val => { d.artist = val; markDirty(); this.renderPreview(); this.o.onChange?.(); },
    });
    const idInput = textInput({
      value: d.id, mono: true,
      onInput: val => {
        const clean = slugifyId(val, d.id);
        d.id = clean;
        if (idInput.value !== clean) idInput.value = clean;
        markDirty(); this.updateHeroText(); this.renderPreview(); this.renderLoot(); this.o.onChange?.();
      },
    });

    const comparator = h('.comparator');
    for (let i = 0; i < 15; i++) {
      comparator.appendChild(h('i', {
        dataset: { on: String(i < d.comparatorOutput) },
        style: `height:${28 + i * 1.6}%`,
        title: `Comparator output ${i + 1}`,
        onclick: () => { d.comparatorOutput = i + 1; markDirty(); this.renderMeta(); },
      }));
    }

    const colorRow = h('.row.g-1.wrap',
      ...MC_COLORS.map(c => h('button.swatch', {
        style: { background: c.hex, width: '17px', height: '17px' },
        title: titleCase(c.id),
        'aria-pressed': String(c.id === d.nameColor),
        onclick: e => {
          d.nameColor = c.id; markDirty(); this.renderPreview();
          $$('.swatch', e.currentTarget.parentElement).forEach(s => s.setAttribute('aria-pressed', String(s === e.currentTarget)));
        },
      })),
    );

    clear(this.metaCol).appendChild(h('.panel',
      h('.panel-head', h('h3', { text: 'Disc' })),
      h('.panel-body.col.g-4',
        field('Track name', nameInput),
        field('Artist', artistInput, 'Shown as “Artist - Track” while the disc plays.'),
        field('Resource id', idInput, `data/${project.namespace}/jukebox_song/${d.id}.json`),
        h('.divider'),
        field('Item this disc borrows', selectInput({
          options: DISC_BASE_ITEMS.map(b => ({ value: b.id, label: b.label })),
          value: d.baseItem,
          onChange: val => { d.baseItem = val; markDirty(); this.renderPreview(); },
        }), canModel
          ? 'The vanilla disc keeps working — your components only change what this copy looks like and plays.'
          : `${v.label} has no item_model component, so this disc will look like vanilla ${DISC_BASE_ITEMS.find(b => b.id === d.baseItem)?.label} in game.`),
        h('.row.g-3',
          h('.grow', field('Rarity', selectInput({
            options: RARITIES.map(r => ({ value: r.id, label: r.label })),
            value: d.rarity, onChange: val => { d.rarity = val; markDirty(); this.renderPreview(); },
          }))),
          h('.grow', field('Name colour', colorRow)),
        ),
        h('.divider'),
        field('Comparator output', h('.col.g-1', comparator,
          h('.row.between', h('span.caption.muted', { text: 'Signal a comparator reads from the jukebox' }),
            h('span.caption.mono', { text: String(d.comparatorOutput) }))),
        ),
        field('Hearing range', slider({
          min: 8, max: 128, step: 1, value: d.range,
          onInput: val => { d.range = val; },
          onChange: () => markDirty(),
          format: val => `${val} blocks`,
        }), 'Vanilla discs carry 64 blocks.'),
        switchRow({
          title: 'Enchantment shimmer', desc: 'Give the item the enchanted glint.',
          checked: d.glint, onChange: val => { d.glint = val; markDirty(); this.renderPreview(); },
        }),
        switchRow({
          title: 'Hide the song line in the tooltip',
          desc: 'Keeps the track name a surprise until it plays.',
          checked: !!d.hideSongTooltip,
          onChange: val => { d.hideSongTooltip = val; markDirty(); this.renderPreview(); },
        }),
      ),
    ));
  }

  /* ----------------------------------------------------------- obtaining */
  renderLoot() {
    const d = this.d;
    const loot = d.loot || (d.loot = createLootSettings());
    const project = state.project;
    const chests = availableChestTables();
    const body = [];

    body.push(h('.caption.muted', { text: 'Beyond the /give command, a disc can be something you find.' }));

    body.push(switchRow({
      title: 'Its own loot table',
      desc: `Writes data/${project.namespace}/loot_table/${d.id}.json. Nothing vanilla is touched — call it from a command block or your own map.`,
      checked: loot.standalone !== false,
      onChange: val => { loot.standalone = val; markDirty(); this.renderLoot(); this.o.onChange?.(); },
    }));

    if (loot.standalone !== false) {
      body.push(codeBlock(`/loot give @s loot ${project.namespace}:${d.id}`));
    }

    body.push(h('.divider'));

    body.push(switchRow({
      title: 'Dropped by creepers',
      desc: 'The vanilla way discs are found: a creeper killed by a skeleton drops one.',
      checked: !!loot.creeper,
      onChange: val => { loot.creeper = val; markDirty(); this.renderLoot(); this.o.onChange?.(); },
    }));

    const chestChips = h('.row.g-1.wrap');
    for (const c of chests) {
      const on = (loot.chests || []).includes(c.id);
      chestChips.appendChild(h('button.loot-chip', {
        'aria-pressed': String(on),
        title: c.vanillaDiscs ? 'Vanilla already puts discs here' : '',
        onclick: () => {
          loot.chests = on ? loot.chests.filter(x => x !== c.id) : [...(loot.chests || []), c.id];
          markDirty(); this.renderLoot(); this.o.onChange?.();
        },
      }, c.vanillaDiscs ? h('span.dot', { style: 'width:5px;height:5px' }) : null, h('span', { text: c.label })));
    }

    if (chests.length) {
      body.push(field('Found in chests', chestChips,
        'A dot marks somewhere vanilla already hides discs — the least surprising places to add one.'));
      if ((loot.chests || []).length) {
        body.push(field('How rare', segmented({
          options: RARITY_WEIGHTS.map(r => ({ value: r.id, label: r.label, hint: r.hint })),
          value: loot.rarity || 'uncommon', block: true,
          onChange: val => { loot.rarity = val; markDirty(); this.o.onChange?.(); },
        })));
      }
    }

    /* The honest caveat, stated where the choice is made. */
    if (!hasAssets() && (loot.creeper || (loot.chests || []).length)) {
      body.push(note('Creeper and chest loot rebuild a vanilla table, so they need the real one. Link your Minecraft and these will be built from it.', 'warn'));
      body.push(h('button.btn.btn-sm', { style: 'align-self:flex-start', onclick: () => openGameLinkDialog() },
        raw(icon('cube', 13)), h('span', { text: 'Link your Minecraft' })));
    } else if (loot.creeper || (loot.chests || []).length) {
      body.push(note('These replace the vanilla tables they add to — rebuilt from the real ones, so vanilla behaviour is intact, but another pack replacing the same table will conflict.', 'warn'));
    }

    clear(this.lootCol).appendChild(h('.panel',
      h('.panel-head', h('h3', { text: 'How you get it' })),
      h('.panel-body.col.g-4', ...body.filter(Boolean)),
    ));
  }

  /* ---------------------------------------------------------------- forge */
  renderForge() {
    const d = this.d;
    const sprite = d.sprite;

    const modeSeg = segmented({
      options: [
        { value: 'template', label: 'Design', icon: 'disc' },
        { value: 'vanilla', label: 'Vanilla', icon: 'cube' },
        { value: 'pixels', label: 'Pixel art', icon: 'pencil' },
      ],
      value: sprite.mode, block: true,
      onChange: val => {
        if (val === 'pixels' && !sprite.doc) {
          sprite.doc = createPixelDoc(16, 16, { layerName: 'Disc' });
          sprite.doc.layers[0].data.set(discSpriteData(sprite, 16));
        }
        if (val === 'vanilla' && !sprite.vanilla) sprite.vanilla = createVanillaSprite();
        sprite.mode = val;
        markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.();
      },
    });

    const body = [modeSeg];

    if (sprite.mode === 'template') {
      const grid = h('.template-grid');
      for (const t of DISC_TEMPLATES) {
        const cnv = h('canvas', { width: 16, height: 16 });
        cnv.getContext('2d').putImageData(
          new ImageData(discSpriteData({ ...sprite, template: t.id }, 16), 16, 16), 0, 0);
        grid.appendChild(h('button.template-opt', {
          'aria-pressed': String(sprite.template === t.id),
          title: t.name,
          onclick: () => { sprite.template = t.id; markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.(); },
        }, cnv, h('.to-name', { text: t.name })));
      }
      body.push(field('Label shape', grid));

      const presetRow = h('.row.g-1.wrap');
      for (const p of DISC_PRESETS) {
        presetRow.appendChild(h('button.btn.btn-sm.btn-ghost', {
          style: 'padding:0 7px;height:24px;font-size:11px;gap:5px',
          onclick: () => {
            Object.assign(sprite.colors, presetPalette(p));
            markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.();
          },
        }, h('span.dot', { style: { background: presetPalette(p).label, width: '8px', height: '8px' } }), p.name));
      }
      body.push(field('Palettes', presetRow));

      const parts = [
        ['label', 'Label'], ['labelLight', 'Label highlight'], ['labelShade', 'Label shadow'],
        ['body', 'Vinyl'], ['bodyLight', 'Vinyl sheen'], ['bodyShade', 'Vinyl edge'],
        ['center', 'Centre hole'], ['ringGloss', 'Grooves'],
      ];
      const colorList = h('.col', ...parts.map(([k, label]) => h('.part-row',
        colorButton({
          value: sprite.colors[k], label,
          onChange: val => { sprite.colors[k] = val; markDirty(); this.paintVinyl(); this.renderPreview(); this.o.onChange?.(); },
        }),
        h('.pr-name', { text: label }),
        h('.pr-hex', { text: (sprite.colors[k] || '').toUpperCase() }),
      )));
      body.push(field('Colours', colorList));

      body.push(h('.row.g-3.wrap',
        checkbox({ label: 'Grooves', checked: sprite.grooves !== false, onChange: val => { sprite.grooves = val; markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); } }),
        checkbox({ label: 'Sheen', checked: sprite.gloss !== false, onChange: val => { sprite.gloss = val; markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); } }),
        checkbox({ label: 'Outline', checked: sprite.outline !== false, onChange: val => { sprite.outline = val; markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); } }),
      ));

      if (state.project.paintings.length) {
        body.push(h('button.btn.btn-sm.btn-block', {
          onclick: () => this.paletteFromPainting(),
        }, raw(icon('palette', 13)), h('span', { text: 'Borrow colours from a painting' })));
      }
    } else if (sprite.mode === 'vanilla') {
      body.push(...this.vanillaForge(sprite));
    } else {
      body.push(note('Pixel mode gives you the full editor on the 16×16 sprite. The template stays saved, so you can switch back.', 'info'));
      body.push(h('button.btn.btn-block.btn-primary', {
        onclick: () => this.openSpriteEditor(),
      }, raw(icon('pencil', 14)), h('span', { text: 'Open sprite editor' })));
      body.push(h('button.btn.btn-block.btn-sm', {
        onclick: () => {
          this.d.sprite.doc.layers[this.d.sprite.doc.active].data.set(discSpriteData(this.d.sprite, 16));
          markDirty(); this.paintVinyl(); this.renderPreview(); this.renderForge();
        },
      }, raw(icon('refresh', 13)), h('span', { text: 'Reset to the template' })));
    }

    clear(this.forgeCol).appendChild(h('.panel',
      h('.panel-head', h('h3', { text: 'Sprite forge' }), h('.spacer'),
        iconButton('download', { tip: 'Export the 16×16 PNG', pos: 'left', onClick: () => this.exportSprite() })),
      h('.panel-body.col.g-4', ...body),
    ));
  }

  /** The Vanilla tab: real disc textures from a linked jar, recolourable. */
  vanillaForge(sprite) {
    const d0 = this.d;
    if (!packReady() || !hasVanillaDiscs()) {
      return [note('The bundled texture pack did not load, so the vanilla disc art is unavailable. Serving the app over http rather than opening the file directly usually fixes it.', 'warn')];
    }

    const v = sprite.vanilla || (sprite.vanilla = createVanillaSprite());
    const out = [];

    const grid = h('.template-grid');
    /* The tiles draw synchronously from decoded canvases, so anything not
       loaded yet paints blank. Warm them, then redraw once. */
    if (!this._vanillaWarmed) {
      preloadVanillaDiscs().then(() => {
        this._vanillaWarmed = true;
        if (this.d === d0 && this.d.sprite.mode === 'vanilla') {
          this.renderForge(); this.paintVinyl(); this.renderPreview();
        }
      });
    }
    for (const id of availableVanillaDiscs()) {
      const cnv = vanillaDiscCanvas({ ...v, base: id }, 2);
      grid.appendChild(h('button.template-opt', {
        'aria-pressed': String(v.base === id),
        title: prettyDiscName(id),
        onclick: () => {
          v.base = id;
          if (!v.recolor) v.hue = baseHue(id);
          markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.();
        },
      }, cnv, h('.to-name', { text: prettyDiscName(id) })));
    }
    out.push(field('Vanilla disc', grid));
    out.push(note('These are the bundled textures, pixel for pixel. Whichever you pick gets written into your resource pack exactly as it is — recolour it or take it into the pixel editor first if you want the disc to be yours.', 'info'));

    out.push(switchRow({
      title: 'Recolour the label',
      desc: 'Shifts only the coloured part. The vinyl body and its shading stay exactly vanilla.',
      checked: !!v.recolor,
      onChange: val => { v.recolor = val; markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.(); },
    }));

    if (v.recolor) {
      const hueBar = h('.hue-strip', { style: 'margin-bottom:2px' });
      out.push(field('Hue', h('.col.g-2', hueBar, slider({
        min: 0, max: 359, value: v.hue ?? 145,
        onInput: val => { v.hue = val; this.paintVinyl(); this.renderPreview(); },
        onChange: () => { markDirty(); this.renderForge(); this.o.onChange?.(); },
        format: val => `${val}\u00B0`,
      }))));
      out.push(h('.row.g-3',
        h('.grow', field('Saturation', slider({
          min: 20, max: 200, value: Math.round((v.sat ?? 1) * 100),
          onInput: val => { v.sat = val / 100; this.paintVinyl(); this.renderPreview(); },
          onChange: () => { markDirty(); this.o.onChange?.(); },
          format: val => `${val}%`,
        }))),
        h('.grow', field('Brightness', slider({
          min: 40, max: 160, value: Math.round((v.val ?? 1) * 100),
          onInput: val => { v.val = val / 100; this.paintVinyl(); this.renderPreview(); },
          onChange: () => { markDirty(); this.o.onChange?.(); },
          format: val => `${val}%`,
        }))),
      ));
    }

    out.push(h('button.btn.btn-sm.btn-block', {
      onclick: () => {
        if (!sprite.doc) sprite.doc = createPixelDoc(16, 16, { layerName: 'Disc' });
        sprite.doc.layers[sprite.doc.active].data.set(
          vanillaDiscCanvas(v, 1).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 16, 16).data);
        sprite.mode = 'pixels';
        markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.();
        toast({ title: 'Copied into the pixel editor', message: 'Edit it freely — the vanilla original is untouched.', kind: 'ok' });
      },
    }, raw(icon('pencil', 13)), h('span', { text: 'Open this in the pixel editor' })));

    return out;
  }

  async paletteFromPainting() {
    const paintings = state.project.paintings;
    if (!paintings.length) return;
    const { composePainting } = await import('../../paint/compose.js');
    const pick = paintings.length === 1 ? paintings[0] : await choosePainting(paintings);
    if (!pick) return;
    const { data } = composePainting(pick, { withFrame: false });
    Object.assign(this.d.sprite.colors, paletteFromImageData(data));
    markDirty(); this.paintVinyl(); this.renderForge(); this.renderPreview(); this.o.onChange?.();
    toast({ title: 'Palette borrowed', message: `Taken from “${pick.title || pick.id}”.`, kind: 'ok' });
  }

  openSpriteEditor() {
    const d = this.d;
    if (!d.sprite.doc) {
      d.sprite.doc = createPixelDoc(16, 16, { layerName: 'Disc' });
      d.sprite.doc.layers[0].data.set(discSpriteData(d.sprite, 16));
    }
    const host = h('div', { style: 'display:flex;min-height:0' });
    const m = modal({
      title: `Sprite — ${d.name || d.id}`,
      subtitle: 'Sixteen pixels square, exactly as it ships in the resource pack.',
      icon: 'pencil', width: 'xwide', flush: true,
      body: host,
      actions: [{ label: 'Done', primary: true }],
      onClose: () => { ed.destroy(); this.paintVinyl(); this.renderPreview(); this.o.onChange?.(); },
    });
    const ed = new PixelEditor({
      doc: d.sprite.doc,
      filename: d.id,
      onEdit: () => { this.paintVinyl(); this.renderPreview(); this.o.onChange?.(); },
    });
    ed.mount(host);
    void m;
  }

  async exportSprite() {
    const { canvasToBlob, downloadBlob } = await import('../../core/util.js');
    const cvs = discPixelCanvas(this.d, 1);
    downloadBlob(await canvasToBlob(cvs), `${this.d.id}.png`);
  }

  /* -------------------------------------------------------------- preview */
  renderPreview() {
    const d = this.d;
    const project = state.project;
    const rarity = RARITIES.find(r => r.id === d.rarity) || RARITIES[0];

    const zoomCanvas = discPixelCanvas(d, 8);
    const slotCanvas = discPixelCanvas(d, 4);

    const tooltip = h('.mc-tooltip',
      h('.mt-name', { style: `color:${MC_COLORS.find(c => c.id === d.nameColor)?.hex || rarity.color}` , text: d.name || titleCase(d.id) }),
      !d.hideSongTooltip ? h('.mt-line', { text: d.artist ? `${d.artist} - ${d.name}` : d.name }) : null,
      h('.mt-id', { text: `minecraft:${d.baseItem}` }),
    );

    /* A real isometric block scene, drawn with the bundled game textures.
       Painted after mount so the canvas has a measured width. */
    const jukebox = h('canvas.jukebox-scene');
    this._paintScene = () => {
      const box = jukebox.parentElement?.getBoundingClientRect();
      const w = Math.max(240, Math.round(box?.width || 300));
      drawJukeboxScene(jukebox, w, Math.round(w * 0.58), { disc: d });
    };
    requestAnimationFrame(() => this._paintScene());
    this._sceneOff?.();
    this._sceneOff = observeResize(jukebox, () => this._paintScene());

    clear(this.previewCol).appendChild(h('.panel',
      h('.panel-head', h('h3', { text: 'In game' })),
      h('.panel-body.col.g-4',
        h('.disc-preview-stack',
          h('.disc-zoom', zoomCanvas),
          h('.col.g-3.grow',
            h('.row.g-3.items-end',
              h('.slot-mock', slotCanvas),
              h('.col.g-1',
                h('.eyebrow', { text: 'Inventory' }),
                h('.caption.muted', { text: '16×16, drawn at 4×' }),
              ),
            ),
            tooltip,
          ),
        ),
        jukebox,
        codeBlock(giveCommand(project, d, { includeSlash: true }), { label: 'Give command' }),
        note(`Also available in game as /function ${project.namespace}:give_discs once the data pack is installed.`, 'info'),
        /* Worth saying plainly, because it is the first thing people look for
           and the reason is not obvious. */
        note('Custom discs cannot be added to the creative inventory. The creative tabs are built from a hardcoded list of item types inside the client, and this disc is a vanilla disc item wearing your sprite and song rather than a new item — only a mod can add one. The give command, the /function above and a loot table are the ways to hand it out. (Custom paintings are different: those the game does read from the registry, so they show up in creative on their own.)', 'info'),
      ),
    ));
  }
}

/* ---- Painting chooser --------------------------------------------------- */
function choosePainting(paintings) {
  return new Promise(resolve => {
    let picked = null;
    const m = modal({
      title: 'Borrow colours from…',
      icon: 'palette',
      body: h('.col.g-2',
        ...paintings.map(p => h('button.card.card-pad.card-interactive.row.g-3', {
          style: 'text-align:left;width:100%',
          onclick: () => { picked = p; resolve(p); m.close(); },
        },
          h('.lr-thumb.checker.checker-sm', { style: 'width:40px;height:40px' },
            (() => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; return c; })()),
          h('.col.g-1.grow', h('.strong', { text: p.title || p.id }), h('.caption', { text: `${p.w}×${p.h} blocks` })),
        )),
      ),
      actions: [{ label: 'Cancel' }],
      onClose: () => { if (!picked) resolve(null); },
    });
    /* Fill the thumbnails after mount. */
    queueMicrotask(async () => {
      const { paintingThumbCanvas } = await import('../thumbs.js');
      $$('.lr-thumb', m.el).forEach((slot, i) => {
        clear(slot).appendChild(paintingThumbCanvas(paintings[i], 40));
      });
    });
  });
}

/* ========================================================================= */
/* RECORDER DIALOG                                                           */
/* ========================================================================= */

export function openRecorderDialog(onDone) {
  const rec = new Recorder();
  let armed = false;
  let blob = null;

  const bars = h('.mic-bars');
  for (let i = 0; i < 24; i++) bars.appendChild(h('i'));
  const meterFill = h('.lm-fill');
  const meter = h('.level-meter', meterFill);
  const dbLabel = h('span.caption.mono', { text: '−∞ dB' });
  const timeLabel = h('span.title.mono', { text: '0:00' });
  const hint = h('.caption.muted', { text: 'Choose an input, then arm the microphone.' });

  const orb = h('button.rec-orb', {
    dataset: { armed: 'false' },
    'aria-label': 'Start recording',
    onclick: () => toggle(),
  }, raw(icon('mic', 26)));

  const deviceSel = h('select.select', { disabled: true });
  const statusRow = h('.row.g-3.items-center', orb, h('.col.g-2.grow', h('.row.between', timeLabel, dbLabel), meter, bars));

  const body = h('.col.g-4', hint, field('Input', deviceSel), statusRow);

  const m = modal({
    title: 'Record audio',
    subtitle: 'Captured at your device’s native rate, then converted to Ogg Vorbis for the pack.',
    icon: 'mic',
    body,
    dismissable: true,
    actions: [
      { label: 'Cancel', run: async () => { await rec.disarm(); } },
      {
        label: 'Use recording', primary: true, disabled: true, closeAfter: true,
        run: async () => {
          if (rec.state === 'recording') blob = await rec.stop();
          await rec.disarm();
          if (blob) onDone(blob);
          else return false;
        },
      },
    ],
    onClose: () => { rec.disarm(); },
  });

  const useBtn = m.el.querySelector('.modal-foot .btn-primary');

  rec.onLevel = (rms, peak, bandArr) => {
    meterFill.style.width = clamp(peak * 100, 0, 100) + '%';
    dbLabel.textContent = peak > 0.0002 ? `${toDb(peak).toFixed(1)} dB` : '−∞ dB';
    const kids = bars.children;
    for (let i = 0; i < kids.length; i++) kids[i].style.height = Math.max(6, bandArr[i] * 100) + '%';
  };
  rec.onTime = t => { timeLabel.textContent = formatTime(t); };
  rec.onState = s => {
    orb.dataset.armed = String(s === 'recording');
    orb.innerHTML = s === 'recording' ? icon('stop', 24) : icon('mic', 26);
    hint.textContent = s === 'recording' ? 'Recording — press again to stop.'
      : s === 'ready' ? 'Ready. Press the button to start.'
      : 'Choose an input, then arm the microphone.';
  };

  async function arm() {
    try {
      await rec.arm({ deviceId: deviceSel.value || null });
      armed = true;
      const devs = await rec.devices();
      clear(deviceSel);
      for (const d of devs) deviceSel.appendChild(h('option', { value: d.deviceId }, d.label || 'Microphone'));
      deviceSel.disabled = devs.length < 2;
      deviceSel.onchange = async () => { await rec.disarm(); await arm(); };
    } catch (e) {
      hint.textContent = '';
      body.prepend(note(`Microphone access was refused or unavailable. ${e.message}`, 'danger'));
    }
  }

  async function toggle() {
    if (!armed) { await arm(); return; }
    if (rec.state === 'recording') {
      blob = await rec.stop();
      timeLabel.textContent = formatTime(rec.elapsed);
      useBtn.disabled = !blob;
      hint.textContent = blob ? `Captured ${formatTime(rec.elapsed)}. Press again to re-record.` : 'Nothing was captured.';
    } else {
      blob = null; useBtn.disabled = true;
      rec.start();
    }
  }

  arm();
  return m;
}
