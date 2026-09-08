/* ============================================================================
   Start from a vanilla painting.

   Every painting the bundled set carries, at every size the game uses. They
   are the best possible reference for what a painting has to do at sixteen
   pixels per block — so rather than leaving them as decoration, this lets you
   open one as a starting canvas and paint over it.
   ========================================================================= */

import { h, raw, clear, add } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { titleCase, plural } from '../core/util.js';
import { vanillaPaintings, textureURL, decodeTexture, packReady } from '../core/texturepack.js';
import { modal, note, toast } from './kit.js';

/**
 * Pick a vanilla painting.
 * @param {(pick:{id,name,w,h, imageData}) => void} onPick
 */
export function openVanillaPaintingPicker(onPick) {
  if (!packReady()) {
    toast({ title: 'The texture pack did not load', message: 'Serve the folder over http rather than opening the file directly.', kind: 'error' });
    return null;
  }
  const all = vanillaPaintings();
  const grid = h('.vp-grid');
  const count = h('.caption.muted');
  let query = '';
  let sizeFilter = 'all';

  const sizes = [...new Set(all.map(p => `${p.w}x${p.h}`))]
    .sort((a, b) => {
      const [aw, ah] = a.split('x').map(Number), [bw, bh] = b.split('x').map(Number);
      return (aw * ah) - (bw * bh) || aw - bw;
    });

  const render = () => {
    clear(grid);
    const shown = all.filter(p =>
      (sizeFilter === 'all' || `${p.w}x${p.h}` === sizeFilter) &&
      (!query || p.id.includes(query.toLowerCase())));
    count.textContent = `${shown.length} of ${plural(all.length, 'painting')}`;

    if (!shown.length) {
      grid.appendChild(h('.caption.muted', { style: 'grid-column:1/-1;padding:24px;text-align:center', text: 'Nothing matches.' }));
      return;
    }
    for (const p of shown) {
      const url = textureURL(p.name);
      // Show every painting at a consistent pixels-per-block so the size
      // differences are the point rather than being normalised away.
      const unit = 22;
      grid.appendChild(h('button.vp-tile', {
        title: `${titleCase(p.id)} · ${p.w}×${p.h} blocks`,
        onclick: () => choose(p),
      },
        h('.vp-art', h('img', {
          src: url, alt: p.id, loading: 'lazy',
          style: { width: `${p.w * unit}px`, height: `${p.h * unit}px` },
        })),
        h('.vp-name', { text: titleCase(p.id) }),
        h('.vp-size', { text: `${p.w}×${p.h}` }),
      ));
    }
  };

  async function choose(p) {
    const canvas = await decodeTexture(p.name);
    if (!canvas) { toast({ title: 'Could not read that painting', kind: 'error' }); return; }
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = g.getImageData(0, 0, canvas.width, canvas.height);
    m.close();
    onPick({ ...p, imageData });
  }

  const sizeChips = h('.row.g-1.wrap',
    h('button.loot-chip', { 'aria-pressed': 'true', onclick: e => setSize('all', e) }, 'All'),
    ...sizes.map(sz => h('button.loot-chip', { 'aria-pressed': 'false', onclick: e => setSize(sz, e) }, sz)),
  );
  const setSize = (sz, e) => {
    sizeFilter = sz;
    [...sizeChips.children].forEach(c => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
    render();
  };

  const m = modal({
    title: 'Start from a vanilla painting',
    subtitle: 'Open one as a canvas and paint over it — or just study how it uses its sixteen pixels.',
    icon: 'frame', width: 'xwide',
    body: h('.col.g-3',
      h('.row.g-2',
        h('.grow', h('input.input', {
          type: 'search', placeholder: 'Search paintings…', 'data-autofocus': '',
          oninput: e => { query = e.target.value.trim(); render(); },
        })),
        count,
      ),
      sizeChips,
      h('.vp-scroll', grid),
      note('Whatever you pick lands on your canvas as a starting point, not as a finished painting. Paint over it before you publish — a pack of untouched reference art is not much of a pack.', 'info'),
    ),
    actions: [{ label: 'Cancel' }],
  });
  render();
  return m;
}
