/* ============================================================================
   Track generator dialog — make a disc when you have no audio to hand.

   The point is not to replace real music; it is to remove the blank page. You
   pick a mood, roll a seed, and hear it immediately. Seeds are deterministic,
   so a track you like can be written down and made again exactly.
   ========================================================================= */

import { h, raw, clear } from '../core/dom.js';
import { icon, iconSolid } from '../core/icons.js';
import { formatTime, formatBytes, debounce, clamp, copyText } from '../core/util.js';
import { STYLES, getStyle, generateTrack, nameFor, randomSeed } from '../audio/compose.js';
import { Player, computePeaks, bufferToWav, estimateOggBytes } from '../audio/engine.js';
import { modal, toast, slider, field, iconButton } from './kit.js';

const PREVIEW_SECONDS = 16;

/**
 * @param {object} o { onAccept({ buffer, blob, meta, name }), initial }
 */
export function openTrackGenerator(o = {}) {
  let styleId = o.initial?.style || 'overworld';
  let seed = o.initial?.seed ?? randomSeed();
  let seconds = o.initial?.seconds ?? 45;
  let bpm = o.initial?.bpm || null;

  let previewBuffer = null;
  let building = false;
  const player = new Player();

  const styleGrid = h('.style-grid');
  const waveCanvas = h('canvas');
  const waveWrap = h('.gen-wave', waveCanvas, h('.gen-wave-head', { text: '' }));
  const titleEl = h('.title-sm', { text: '' });
  const metaEl = h('.caption.muted', { text: '' });
  const seedInput = h('input.input.input-mono', {
    value: String(seed),
    onchange: e => { seed = Math.abs(parseInt(e.target.value, 10) || 0) || randomSeed(); e.target.value = seed; rebuild(); },
  });

  const playBtn = h('button.play-btn', {
    'aria-label': 'Preview', disabled: true,
    onclick: () => togglePlay(),
  }, raw(iconSolid('play', 17)));

  function buildStyleGrid() {
    clear(styleGrid);
    for (const s of STYLES) {
      styleGrid.appendChild(h('button.style-card', {
        'aria-pressed': String(s.id === styleId),
        onclick: () => { styleId = s.id; buildStyleGrid(); rebuild(); },
      },
        h('.sc-icon', raw(icon(s.icon, 18))),
        h('.sc-name', { text: s.name }),
        h('.sc-hint', { text: s.hint }),
      ));
    }
  }

  function drawWave(buffer) {
    const r = waveWrap.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(1, Math.round((r.width || 480) * dpr));
    const H = Math.max(1, Math.round((r.height || 76) * dpr));
    waveCanvas.width = W; waveCanvas.height = H;
    const g = waveCanvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!buffer) return;
    const peaks = computePeaks(buffer, 1024);
    const n = peaks.length / 2, mid = H / 2;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--disc-accent').trim() || '#B084F5';
    g.fillStyle = accent;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
      let mn = 1, mx = -1;
      for (let i = i0; i < i1 && i < n; i++) {
        if (peaks[i * 2] < mn) mn = peaks[i * 2];
        if (peaks[i * 2 + 1] > mx) mx = peaks[i * 2 + 1];
      }
      if (mx < mn) { mn = 0; mx = 0; }
      g.globalAlpha = 0.9;
      g.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(dpr, (mx - mn) * mid * 0.9));
    }
    g.globalAlpha = 1;
  }

  const rebuild = debounce(() => {
    if (building) return;
    building = true;
    const wasPlaying = player.playing;
    player.stop();
    // A short preview keeps the loop tight; the full length is rendered on accept.
    try {
      previewBuffer = generateTrack({ style: styleId, seed, seconds: Math.min(PREVIEW_SECONDS, seconds), bpm });
      player.load(previewBuffer);
      player.region = [0, previewBuffer.duration];
      player.loop = true;
      player.onTick = t => {
        const pct = clamp(t / previewBuffer.duration, 0, 1) * 100;
        waveWrap.style.setProperty('--play', pct + '%');
      };
      playBtn.disabled = false;
      titleEl.textContent = nameFor(styleId, seed);
      const st = getStyle(styleId);
      metaEl.textContent = `${st.name} · seed ${seed} · ${formatTime(seconds)} · about ${formatBytes(estimateOggBytes(seconds, 1, 4))} once encoded`;
      drawWave(previewBuffer);
      if (wasPlaying) { player.play(0); setPlayIcon(true); }
    } catch (e) {
      toast({ title: 'Could not generate that track', message: e.message, kind: 'error' });
    } finally { building = false; }
  }, 120);

  function setPlayIcon(playing) {
    playBtn.innerHTML = iconSolid(playing ? 'pause' : 'play', 17);
    waveWrap.dataset.playing = String(playing);
  }
  function togglePlay() {
    if (!previewBuffer) return;
    if (player.playing) { player.pause(); setPlayIcon(false); }
    else { player.play(); setPlayIcon(true); }
  }

  buildStyleGrid();

  const body = h('.col.g-4',
    h('.caption.muted', { text: 'Every track is written from its seed, so the same seed always gives the same music. Preview loops the first few bars.' }),
    styleGrid,
    h('.gen-player',
      playBtn,
      h('.col.g-1.grow', titleEl, metaEl, waveWrap),
    ),
    h('.gen-controls',
      field('Length', slider({
        min: 8, max: 180, step: 1, value: seconds,
        onInput: v => { seconds = v; },
        onChange: () => rebuild(),
        format: v => formatTime(v),
      })),
      field('Tempo', slider({
        min: 0, max: 180, step: 2, value: bpm || 0,
        onInput: v => { bpm = v === 0 ? null : v; },
        onChange: () => rebuild(),
        format: v => v === 0 ? 'auto' : `${v} bpm`,
      })),
      field('Seed', h('.row.g-1',
        h('.grow', seedInput),
        iconButton('refresh', {
          tip: 'Roll a new seed', pos: 'left', cls: 'btn',
          onClick: () => { seed = randomSeed(); seedInput.value = seed; rebuild(); },
        }),
        iconButton('copy', {
          tip: 'Copy seed', pos: 'left', cls: 'btn',
          onClick: async () => { await copyText(String(seed)); toast({ title: 'Seed copied', kind: 'ok', duration: 1400 }); },
        }),
      )),
    ),
    h('.caption.muted', { text: 'Length is the finished disc. Tempo on auto lets the style pick. Write a seed down and you can make this exact track again.' }),
  );

  const m = modal({
    title: 'Generate a track',
    subtitle: 'A small synthesiser, so a disc can exist before you own a single audio file.',
    icon: 'sparkle', width: 'wide',
    body,
    actions: [
      { label: 'Cancel', run: () => player.dispose() },
      {
        label: 'Use this track', primary: true, async: true,
        run: async () => {
          player.stop();
          const full = generateTrack({ style: styleId, seed, seconds, bpm });
          const blob = bufferToWav(full);
          player.dispose();
          o.onAccept?.({
            buffer: full,
            blob,
            name: nameFor(styleId, seed),
            meta: { style: styleId, seed, seconds, bpm },
          });
        },
      },
    ],
    onClose: () => player.dispose(),
  });

  requestAnimationFrame(() => { rebuild(); rebuild.flush?.(); });
  return m;
}
