/* ============================================================================
   Renamed sprites — teach one item to look different when it is called
   something in particular.

   The trick the whole view is built on: an item's model definition can branch
   on a component, and `minecraft:custom_name` is the component an anvil
   writes. So a pack can say "a stone sword named Flame uses this texture" and
   leave every other stone sword in the world completely alone. That is the
   difference between this and a plain retexture, and it is why the name field
   matters more than anything else on the screen — the match is exact, and a
   name nobody types is a texture nobody sees.
   ========================================================================= */

import { h, raw, clear, add } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { state, bindLive, markDirty, scheduleSave } from '../../core/store.js';
import {
  createNamedSprite, nextUniqueId, docRescale,
  SPRITE_SCALES, SPRITE_BASE, spritePixelSize,
} from '../../core/project.js';
import { slugifyId, copyText, debounce } from '../../core/util.js';
import { getVersion, FEATURES } from '../../core/versions.js';
import { loadItems, allItems, itemById, searchItems, itemTextureName } from '../../sprite/items.js';
import { giveSpriteCommand, flattenSprite, spriteIsBlank } from '../../sprite/export.js';
import { textureURL, loadTexturePack } from '../../core/texturepack.js';
import { PixelEditor } from '../editor.js';
import { spriteThumbCanvas } from '../thumbs.js';
import {
  section, field, textInput, textArea, segmented, iconButton, note,
  emptyState, toastOk, toastWarn, toastInfo, codeBlock, contextMenu,
  confirmDialog, idInput, modal,
} from '../kit.js';
import { sfx } from '../sfx.js';

const F = FEATURES;

export function buildSpritesView() {
  const list = h('.wk-sidebar-list');
  const host = h('.grow', { style: 'display:flex;min-width:0' });
  let panelInstance = null;

  const view = h('.view', { dataset: { view: 'sprites' } },
    h('.workspace',
      h('.wk-sidebar',
        h('.wk-sidebar-head',
          h('.row.between.g-2',
            h('span.eyebrow', { text: 'Renamed sprites' }),
            iconButton('plus', { tip: 'New sprite', pos: 'left', cls: 'btn-sm', onClick: () => openNewSprite(select) }),
          ),
        ),
        list,
        h('.wk-sidebar-foot',
          h('button.btn.btn-block.btn-sm', { onclick: () => openNewSprite(select) },
            raw(icon('plus', 13)), h('span', { text: 'New sprite' })),
        ),
      ),
      host,
    ),
  );

  const sprites = () => state.project?.sprites || [];
  const current = () => sprites().find(s => s.key === state.selSprite) || null;

  function select(key) {
    state.selSprite = key;
    renderList();
    renderDetail();
  }

  function renderList() {
    clear(list);
    const p = state.project;
    if (!p) return;
    if (!sprites().length) {
      list.appendChild(h('.col.g-2.p-3.center', { style: 'text-align:center;color:var(--text-4)' },
        raw(icon('sparkle', 24)),
        h('.caption', { text: 'No sprites yet.' })));
      return;
    }
    for (const sprite of sprites()) {
      const item = itemById(sprite.baseItem);
      const row = h('.list-row', {
        'aria-selected': String(sprite.key === state.selSprite),
        onclick: () => select(sprite.key),
        oncontextmenu: e => { e.preventDefault(); rowMenu(sprite, { x: e.clientX, y: e.clientY }); },
      },
        h('.lr-thumb.checker.checker-sm', spriteThumbCanvas(sprite, 34)),
        h('.lr-main',
          h('.lr-title.truncate', { text: sprite.matchName || '(no name)' }),
          h('.lr-sub.truncate', { text: item?.name || sprite.baseItem || 'no item' }),
        ),
        h('.lr-actions',
          iconButton('more', { cls: 'btn-sm btn-ghost', onClick: e => { e.stopPropagation(); rowMenu(sprite, e.currentTarget); } })),
      );
      list.appendChild(row);
    }
  }

  function rowMenu(sprite, anchor) {
    const p = state.project;
    contextMenu([
      { label: 'Duplicate', icon: 'copy', run: () => {
        const copy = structuredClone(sprite);
        copy.key = createNamedSprite(sprite.baseItem).key;
        copy.matchName = `${sprite.matchName} 2`;
        copy.id = nextUniqueId(`${sprite.id}_2`, p.sprites.map(s => s.id));
        p.sprites.splice(p.sprites.indexOf(sprite) + 1, 0, copy);
        markDirty('sprite duplicated'); scheduleSave(); select(copy.key);
      } },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, run: async () => {
        const ok = await confirmDialog({
          title: `Delete “${sprite.matchName || sprite.id}”?`,
          message: 'The artwork goes with it.',
          confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        p.sprites.splice(p.sprites.indexOf(sprite), 1);
        if (state.selSprite === sprite.key) state.selSprite = p.sprites[0]?.key || null;
        markDirty('sprite deleted'); scheduleSave(); sfx('remove');
        renderList(); renderDetail();
      } },
    ], anchor);
  }

  function renderDetail() {
    panelInstance?.destroy?.();
    panelInstance = null;
    const p = state.project;
    if (!p) return;
    const v = getVersion(p.mcVersion);
    const supported = v.features.includes(F.COMPONENT_SELECT);
    if (!sprites().length) {
      clear(host).appendChild(h('.grow.center',
        emptyState({
          scene: 'chest', iconName: 'sparkle',
          title: 'Name it, and it changes',
          message: supported
            ? 'Pick any flat item, draw it again, and give it a name. Call one that in an anvil and it wears your texture — every other one in the world is untouched.'
            : `Picking a texture by an item's name needs 26.1 or newer. Change the target in Pack settings.`,
          action: supported
            ? h('button.btn.btn-primary', { onclick: () => openNewSprite(select) },
                raw(icon('plus', 13)), h('span', { text: 'New sprite' }))
            : null,
        })));
      return;
    }
    const sprite = current() || sprites()[0];
    state.selSprite = sprite.key;
    panelInstance = new SpriteEditor(sprite, { onChange: renderList });
    panelInstance.mount(host);
  }

  view.refresh = () => { loadItems().then(() => { renderList(); renderDetail(); }); };
  view.openNewSprite = () => openNewSprite(select);
  bindLive(view, 'project', () => view.refresh());
  bindLive(view, 'select:sprite', () => { renderList(); renderDetail(); });
  return view;
}

/* ========================================================================= */
/* Picking the item                                                          */
/* ========================================================================= */

/**
 * The new-sprite dialog. Both halves matter, so both are on screen at once:
 * which item, and what it has to be called. Nothing is created until there is
 * an answer to each.
 */
export async function openNewSprite(onCreated) {
  const project = state.project;
  if (!project) return;
  await Promise.all([loadItems(), loadTexturePack()]);

  let picked = null;
  let name = '';

  const grid = h('.spr-grid');
  const search = textInput({
    placeholder: 'Search 500-odd items — sword, apple, egg…',
    onInput: debounce(v => renderGrid(v), 120),
  });
  const nameInput = textInput({
    placeholder: 'Flame',
    onInput: v => { name = v; sync(); },
  });
  const chosen = h('.spr-chosen');

  function renderGrid(query = '') {
    const results = searchItems(query, { limit: 240 });
    clear(grid);
    if (!results.length) {
      grid.appendChild(h('.caption.muted', { text: 'Nothing matches that.' }));
      return;
    }
    for (const item of results) {
      const url = textureURL(itemTextureName(item));
      grid.appendChild(h('button.spr-cell', {
        'aria-pressed': String(picked?.id === item.id),
        'data-tip': `${item.name}  ·  ${item.id}`,
        onclick: () => { picked = item; renderGrid(query); syncChosen(); sync(); },
      },
        url ? h('img', { src: url, alt: item.name, loading: 'lazy' }) : h('.spr-cell-blank'),
      ));
    }
  }

  function syncChosen() {
    clear(chosen);
    if (!picked) {
      chosen.appendChild(h('.caption.muted', { text: 'No item picked yet.' }));
      return;
    }
    const url = textureURL(itemTextureName(picked));
    add(chosen,
      url ? h('img', { src: url, alt: picked.name }) : null,
      h('.col.g-0',
        h('strong.body-sm', { text: picked.name }),
        h('span.caption.muted', { text: `minecraft:${picked.id}${picked.hand ? ' · held like a tool' : ''}` }),
      ),
    );
  }

  const m = modal({
    title: 'New renamed sprite',
    subtitle: 'Pick the item it stands on, then the name that summons it.',
    icon: 'sparkle', width: 'wide',
    body: h('.col.g-3',
      h('.spr-pick',
        h('.col.g-2', field('Item', search), grid),
        h('.col.g-3',
          field('Called', nameInput,
            'Exactly as it will be typed into an anvil — capitals and all.'),
          chosen,
          note('Only items drawn from one flat sprite are here. A block item is a cube with six faces and a chest is a whole model, so neither can be redrawn from a single picture.', 'info'),
        ),
      ),
    ),
    actions: [
      { label: 'Cancel' },
      { label: 'Create', primary: true, disabled: true, run: () => create() },
    ],
  });

  const createBtn = m.el.querySelector('.modal-foot .btn-primary');
  const sync = () => { createBtn.disabled = !(picked && name.trim()); };

  async function create() {
    const sprite = createNamedSprite(picked.id, name.trim());
    sprite.id = nextUniqueId(slugifyId(`${picked.id}_${name}`, 'sprite'),
      (project.sprites || []).map(s => s.id));
    /* Seeded before it is added to the project, so the editor that opens on
       the next line already has the vanilla art in it rather than flashing a
       blank canvas and filling in a moment later. */
    await seedFromVanilla(sprite, picked);
    project.sprites = project.sprites || [];
    project.sprites.push(sprite);
    markDirty('sprite added');
    scheduleSave();
    sfx('place');
    onCreated?.(sprite.key);
  }

  renderGrid('');
  syncChosen();
  return m;
}

/** Start from the item's own texture, so it opens looking like something. */
async function seedFromVanilla(sprite, item) {
  await loadTexturePack();
  const url = textureURL(itemTextureName(item));
  if (!url) return;
  const img = await new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
  if (!img) return;
  const doc = sprite.doc;
  const c = document.createElement('canvas');
  c.width = doc.w; c.height = doc.h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  // A 16-pixel sprite blown up to a 4x canvas stays hard blocks, not mush.
  g.drawImage(img, 0, 0, img.width, Math.min(img.height, img.width), 0, 0, doc.w, doc.h);
  doc.layers[0].data.set(g.getImageData(0, 0, doc.w, doc.h).data);
  sprite.base = item.id;
}

/* ========================================================================= */
/* The editor                                                                */
/* ========================================================================= */

class SpriteEditor {
  constructor(sprite, { onChange } = {}) {
    this.s = sprite;
    this.onChange = onChange;
  }

  get item() { return itemById(this.s.baseItem); }
  get doc() { return this.s.doc; }
  get scale() { return Math.max(1, this.s.scale || 1); }

  mount(container) {
    this.root = h('.spr-layout');
    this.stage = h('.spr-stage');
    this.side = h('.mob-side');
    this.root.append(this.stage, this.side);
    clear(container).appendChild(this.root);
    this.editor = new PixelEditor({
      doc: this.doc,
      compact: true,
      placeOptions: () => ({
        snaps: [{ label: 'The whole sprite', rect: { x: 0, y: 0, w: this.doc.w, h: this.doc.h } }],
      }),
      onEdit: () => {
        markDirty('sprite texture'); scheduleSave();
        this.onChange?.();
        this.paintPreview();
      },
    });
    this.editor.mount(this.stage);
    this.renderSide();
    return this;
  }

  destroy() {
    this.editor?.destroy();
    this.editor = null;
    this.root?.remove();
  }

  /* ---------------------------------------------------------------- side */
  renderSide() {
    if (!this.side) return;
    clear(this.side);
    add(this.side,
      this.identitySection(),
      this.artworkSection(),
      this.previewSection(),
      this.outputSection(),
    );
    if (this.editor?.panels) this.side.appendChild(this.editor.panels);
    this.paintPreview();
  }

  identitySection() {
    const s = this.s, project = state.project;
    const item = this.item;
    return section('Sprite', [
      field('Called', textInput({
        value: s.matchName,
        placeholder: 'Flame',
        maxlength: 50,
        onInput: val => {
          s.matchName = val;
          this.onChange?.();
          this.paintPreview();
          markDirty('sprite renamed'); scheduleSave();
        },
      }), 'The exact name. An anvil trims the ends and stops at 50 characters, so this does too.'),
      field('On', h('button.btn.btn-sm.btn-block', {
        onclick: () => this.changeItem(),
      },
        h('span.truncate', { text: item ? `${item.name}` : (s.baseItem || 'Pick an item') }),
        raw(icon('chevDown', 11)),
      ), item?.hand
        ? 'Held like a tool, so the model is tilted in hand — your art hangs the same way.'
        : 'Drawn flat, in the inventory and in hand.'),
      field('Id', idInput({
        prefix: `${project.namespace}:`,
        value: s.id,
        onChange: val => {
          s.id = nextUniqueId(slugifyId(val) || 'sprite',
            project.sprites.filter(x => x !== s).map(x => x.id));
          this.renderSide();
          markDirty('sprite id'); scheduleSave();
        },
      }), 'The file name inside the pack. Nobody sees it in game.'),
      field('Notes', textArea({
        value: s.notes || '', rows: 2, placeholder: 'Anything you want to remember…',
        onInput: val => { s.notes = val; scheduleSave(); },
      })),
    ], { key: 'spr-identity' });
  }

  artworkSection() {
    const px = spritePixelSize(this.s);
    return section('Artwork', [
      field('Resolution', segmented({
        options: SPRITE_SCALES.map(n => ({
          value: n, label: `${n}×`,
          tip: `${SPRITE_BASE * n} × ${SPRITE_BASE * n} pixels`,
        })),
        value: this.scale, block: true,
        onChange: n => this.setScale(n),
      }), this.scale === 1
        ? 'Vanilla item sprites are 16 × 16. Raise this to draw finer detail than the game normally carries.'
        : `${px} × ${px} pixels — ${this.scale}× what vanilla ships, and nothing has to be declared for it.`),
      h('.row.g-2',
        h('button.btn.btn-sm.grow', {
          'data-tip': 'Load the vanilla texture for this item',
          onclick: () => this.startFromVanilla(),
        }, raw(icon('image', 13)), h('span', { text: 'Start from…' })),
        h('button.btn.btn-sm.grow', {
          'data-tip': 'Drag and resize a picture onto the sprite — or drop a file straight on it',
          onclick: () => this.placeImage(),
        }, raw(icon('upload', 13)), h('span', { text: 'Place image' })),
      ),
      this.s.base
        ? h('.caption.muted', { text: `Started from ${this.s.base.replace(/_/g, ' ')}.` })
        : null,
    ], { key: 'spr-art' });
  }

  /**
   * What it looks like in a slot, with the name under it. Renamed items show
   * their name in italics in game, which is worth seeing here: it is the one
   * visual clue that the item is carrying a custom name at all.
   */
  previewSection() {
    this.previewCanvas = h('canvas.spr-preview-art', { width: 64, height: 64 });
    this.previewName = h('.spr-preview-name');
    return section('In the game', [
      h('.spr-preview',
        h('.spr-slot', this.previewCanvas),
        this.previewName,
      ),
      note('The italics are the game’s, not ours — anything renamed shows up that way.', 'info'),
    ], { key: 'spr-preview' });
  }

  paintPreview() {
    if (!this.previewCanvas) return;
    const g = this.previewCanvas.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    g.imageSmoothingEnabled = false;
    const doc = this.doc;
    const src = document.createElement('canvas');
    src.width = doc.w; src.height = doc.h;
    src.getContext('2d').putImageData(new ImageData(flattenSprite(doc), doc.w, doc.h), 0, 0);
    g.drawImage(src, 0, 0, 64, 64);
    if (this.previewName) this.previewName.textContent = this.s.matchName || '(unnamed)';
  }

  outputSection() {
    const project = state.project;
    const v = getVersion(project.mcVersion);
    const ns = project.namespace;
    const s = this.s;
    const modern = v.features.includes(F.JUKEBOX_PLAIN_ID);
    const cmd = giveSpriteCommand(s, { player: '@s', includeSlash: true, modern });
    const item = this.item;
    return section('What ships', [
      h('.caption.muted', { text: 'Three files, and one of them is shared.' }),
      codeBlock([
        `assets/${ns}/textures/item/${s.id}.png`,
        `assets/${ns}/models/item/${s.id}.json`,
        `assets/minecraft/items/${s.baseItem}.json`,
      ].join('\n')),
      note(`That last one is the vanilla ${item?.name || s.baseItem} definition, rewritten to check the name first and fall back to the vanilla model. Every sprite you build on this item shares it, and another resource pack loaded above yours that touches the same item will win.`, 'info'),
      h('.divider'),
      h('.caption.muted', { text: 'Or skip the anvil:' }),
      codeBlock(cmd),
      h('button.btn.btn-sm.btn-block', {
        onclick: () => { copyText(cmd); toastOk('Copied', 'Paste it into the chat box.'); },
      }, raw(icon('copy', 13)), h('span', { text: 'Copy the give command' })),
      !v.features.includes(F.COMPONENT_SELECT)
        ? note(`${v.label} cannot pick a model from an item's name — this sprite will not be written. Target 26.1 or newer in Pack settings.`, 'error')
        : null,
      spriteIsBlank(this.doc)
        ? note('This sprite is still blank, so the item would turn invisible when named.', 'warn')
        : null,
    ], { key: 'spr-output', open: false });
  }

  /* ------------------------------------------------------------- actions */
  async changeItem() {
    await loadItems();
    const items = allItems();
    if (!items.length) { toastWarn('No item list', 'assets/itemdata/items.json did not load.'); return; }
    const grid = h('.spr-grid');
    const m = modal({
      title: 'Which item?',
      subtitle: 'Only the ones drawn from a single flat sprite.',
      width: 'wide',
      body: h('.col.g-2',
        field('Search', textInput({
          placeholder: 'sword, apple, egg…',
          onInput: debounce(q => render(q), 120),
        })),
        grid,
      ),
    });
    const render = (q = '') => {
      clear(grid);
      for (const item of searchItems(q, { limit: 240 })) {
        const url = textureURL(itemTextureName(item));
        grid.appendChild(h('button.spr-cell', {
          'aria-pressed': String(item.id === this.s.baseItem),
          'data-tip': `${item.name}  ·  ${item.id}`,
          onclick: () => {
            this.s.baseItem = item.id;
            markDirty('sprite item'); scheduleSave();
            this.renderSide(); this.onChange?.();
            m.close();
            toastOk('Item changed', `Now sitting on ${item.name.toLowerCase()}.`);
          },
        }, url ? h('img', { src: url, alt: item.name, loading: 'lazy' }) : h('.spr-cell-blank')));
      }
    };
    render('');
  }

  async startFromVanilla() {
    const item = this.item;
    if (!item) return;
    await loadTexturePack();
    const url = textureURL(itemTextureName(item));
    if (!url) { toastWarn('No bundled texture', `Nothing under ${itemTextureName(item)}.`); return; }
    const img = new Image();
    img.onload = () => {
      const doc = this.doc;
      const c = document.createElement('canvas');
      c.width = doc.w; c.height = doc.h;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, img.width, Math.min(img.height, img.width), 0, 0, doc.w, doc.h);
      const data = g.getImageData(0, 0, doc.w, doc.h).data;
      if (!this.editor?.replaceLayerData(data, `start from ${item.id}`)) {
        doc.layers[Math.max(0, doc.active)].data.set(data);
      }
      this.s.base = item.id;
      markDirty('sprite base'); scheduleSave();
      this.renderSide(); this.onChange?.();
      toastOk('Texture loaded', `Started from the vanilla ${item.name.toLowerCase()}.`);
    };
    img.onerror = () => toastWarn('Could not load', 'That texture failed to decode.');
    img.src = url;
  }

  placeImage() {
    if (!this.editor) return;
    this.editor.placeFromFile({
      snaps: [{ label: 'The whole sprite', rect: { x: 0, y: 0, w: this.doc.w, h: this.doc.h } }],
    }).then(started => {
      if (started) {
        toastInfo('Drag it into place',
          'Corners resize, Shift frees the shape, arrows nudge. Enter places it, Escape drops it.');
      }
    });
  }

  async setScale(n) {
    const from = this.scale;
    if (n === from) return;
    if (n < from) {
      const ok = await confirmDialog({
        title: `Drop to ${n}×?`,
        message: `Detail finer than ${n === 1 ? 'a vanilla pixel' : `1/${n} of a vanilla pixel`} cannot survive the trip down, and going back up will not bring it back.`,
        confirmLabel: 'Reduce', danger: true,
      });
      if (!ok) return;
    }
    this.s.scale = n;
    const px = SPRITE_BASE * n;
    docRescale(this.doc, px, px, { average: true });
    this.editor?.resized();
    markDirty('sprite resolution'); scheduleSave();
    this.renderSide(); this.onChange?.();
    toastOk(`Now drawing at ${n}×`, `${px} × ${px} pixels.`);
  }
}
