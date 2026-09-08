/* ============================================================================
   Frame & Groove — entry point.
   ========================================================================= */

import { $, h, raw, on } from './core/dom.js';
import { sleep } from './core/util.js';
import { icon } from './core/icons.js';
import {
  state,
  bus,
  loadPrefs,
  refreshLibrary,
  applyPrefs,
  setRoute,
  setThumbnailRenderer,
  openProject,
  saveProject,
} from './core/store.js';
import { Prefs, openDB } from './core/db.js';
import { renderProjectThumb } from './ui/thumbs.js';
import { installTextures } from './ui/textures.js';
import { loadCachedAssets } from './core/gameassets.js';
import { loadTexturePack, preloadCore, packReady } from './core/texturepack.js';
import { installFavicon, drawMark } from './ui/brandmark.js';
import { buildShell } from './ui/shell.js';
import { buildLibraryView } from './ui/views/library.js';
import { buildPackView } from './ui/views/pack.js';
import { buildPaintingsView } from './ui/views/paintings.js';
import { buildDiscsView } from './ui/views/discs.js';
import { buildMobsView } from './ui/views/mobs.js';
import { buildSpritesView } from './ui/views/sprites.js';
import { buildExportView } from './ui/views/exportview.js';
import { toast } from './ui/kit.js';
import { installSfx } from './ui/sfx.js';
import { installTooltips } from './ui/tooltip.js';
import { loadEncoder, encoderStatus } from './audio/engine.js';

const BOOT_BLOCKS = 12;

async function boot() {
  const startedAt = performance.now();
  const bootEl = $('#boot');
  const bootTag = $('#boot-tag');
  const bootBar = $('#boot-bar');

  /* Draw the mark straight away — it is the first thing anyone sees, and it
     needs no storage, no assets and no network. */
  const markEl = $('#boot-mark');
  if (markEl) drawMark(markEl, 128);

  const blocks = [];
  if (bootBar) {
    for (let i = 0; i < BOOT_BLOCKS; i++) {
      const b = document.createElement('i');
      bootBar.appendChild(b);
      blocks.push(b);
    }
  }

  let filled = 0;
  /** Say what is happening and light the next blocks. */
  const say = (text, progress) => {
    if (bootTag) bootTag.textContent = text;
    if (progress == null) return;
    const target = Math.round(progress * BOOT_BLOCKS);
    for (; filled < target; filled++) blocks[filled]?.setAttribute('data-on', 'true');
  };

  try {
    say('Opening storage', 0.1);
    await openDB();

    say('Reading your preferences', 0.22);
    await loadPrefs();
    applyPrefs();

    // Textures must be decoded before the first paint: previews draw
    // synchronously, and a block that is not ready yet falls back to a
    // generated stand-in that would then pop when the real one arrives.
    say('Loading textures', 0.38);
    await loadTexturePack();
    if (packReady()) await preloadCore();
    installTextures();
    installFavicon();

    // Optional, and only for pack formats and vanilla loot tables.
    loadCachedAssets().catch(() => {});

    say('Counting your packs', 0.5);
    setThumbnailRenderer(renderProjectThumb);
    await refreshLibrary();

    say('Assembling the studio', 0.66);
    const views = {
      library: buildLibraryView(),
      pack: buildPackView(),
      paintings: buildPaintingsView(),
      discs: buildDiscsView(),
      mobs: buildMobsView(),
      sprites: buildSpritesView(),
      export: buildExportView(),
    };

    /* Palette commands that need a view instance. */
    bus.on('cmd:new-painting', () => views.paintings.addPainting?.());
    bus.on('cmd:new-disc', () => views.discs.addDisc?.());
    bus.on('cmd:new-mob', () => views.mobs.openNewMenu?.());
    bus.on('cmd:new-sprite', () => views.sprites.openNewSprite?.());

    const app = buildShell(views);
    document.body.insertBefore(app, bootEl);

    // One delegated listener for the whole interface; silent until the first
    // real gesture, because browsers require it and it would be rude anyway.
    installSfx();
    installTooltips();

    /* Reopen whatever was last open, so a refresh does not lose your place. */
    say('Opening where you left off', 0.85);
    const last = await Prefs.get('lastProject', null);
    if (last) {
      try {
        await openProject(last);
        setRoute(await Prefs.get('lastRoute', 'pack'));
      } catch { setRoute('library'); }
    } else {
      setRoute('library');
    }

    bus.on('route', r => { if (r !== 'library') Prefs.set('lastRoute', r); });

    state.ready = true;
    say('Ready', 1);
    // The bar exists to be read. On a warm load everything above finishes in
    // well under a frame, so hold the finished state briefly rather than
    // flashing a full bar for one frame and vanishing.
    const held = Math.max(0, 420 - (performance.now() - startedAt));
    if (held) await sleep(held);
    requestAnimationFrame(() => {
      bootEl.dataset.done = 'true';
      // Drop the splash out of the document once it has faded — a full-screen
      // fixed layer left behind costs the compositor for the whole session.
      // Driven by the transition itself, with a timer only as a safety net for
      // the case where the tab is backgrounded and never animates.
      const drop = () => bootEl.remove();
      bootEl.addEventListener('transitionend', drop, { once: true });
      setTimeout(drop, 1200);
    });

    /* Warm the Ogg encoder in the background so the first conversion is instant. */
    const warm = () => loadEncoder().catch(() => {});
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 2500);

    /* Save on the way out and whenever the tab is hidden. */
    on(document, 'visibilitychange', () => {
      if (document.hidden && state.projectDirty) saveProject({ silent: true }).catch(() => {});
    });
    on(window, 'pagehide', () => { if (state.projectDirty) saveProject({ silent: true }).catch(() => {}); });

    console.info('%cFrame & Groove', 'font-weight:700;font-size:13px', '— ready.', encoderStatus.state);
  } catch (e) {
    console.error(e);
    bootEl.innerHTML = '';
    bootEl.appendChild(h('.col.g-4.center.boot-error',
      h('span', { style: 'color:var(--danger)' }, raw(icon('alert', 34))),
      h('h1.title', { text: 'Frame & Groove could not start' }),
      h('p.body', { text: e.message }),
      h('p.caption.muted', { text: 'This usually means the browser is blocking local storage, or the page was opened directly from the file system. Serve the folder over http and it will work.' }),
      h('button.btn.btn-lg.btn-primary', { onclick: () => location.reload() }, 'Try again'),
    ));
  }
}

/* Report anything that escapes, rather than failing silently. */
on(window, 'error', e => {
  if (!state.ready) return;
  console.error(e.error || e.message);
});
on(window, 'unhandledrejection', e => {
  if (!state.ready) return;
  console.error('Unhandled:', e.reason);
  const msg = e.reason?.message || String(e.reason || '');
  if (msg && !/aborted|cancell?ed/i.test(msg)) {
    toast({ title: 'Something went wrong', message: msg.slice(0, 160), kind: 'error' });
  }
});

boot();
