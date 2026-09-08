/* ============================================================================
   Link your game — optional, and narrower than it sounds.

   Textures are bundled and need no setup. This dialog is only for the two
   things a texture pack cannot provide:
     • the exact pack format numbers your copy of the game accepts, and
     • the real vanilla loot tables, needed to put a disc in creeper drops or
       a chest without guessing at what is already in those tables.
   ========================================================================= */

import { h, raw, clear, add } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { formatBytes, relTime, plural, pickFile } from '../core/util.js';
import {
  linkJar, unlinkAssets, assetMeta, hasAssets, listGameData, JAR_PATHS,
} from '../core/gameassets.js';
import { packMeta, packReady } from '../core/texturepack.js';
import { formatLabel } from '../core/versions.js';
import { bindLive } from '../core/store.js';
import { modal, toast, note, badge, progressBar, dropzone, codeBlock, confirmDialog } from './kit.js';

const PLATFORM = (navigator.platform || '').toLowerCase();
const OS = PLATFORM.includes('mac') ? 'mac' : PLATFORM.includes('win') ? 'win' : 'linux';
const OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' }[OS];

export function openGameLinkDialog() {
  const stage = h('.col.g-4');
  const m = modal({
    title: 'Link your Minecraft',
    subtitle: 'Optional. Textures are already bundled — this is for pack format numbers and vanilla loot tables.',
    icon: 'cube', width: 'wide',
    body: stage,
    actions: [{ label: 'Done', primary: true }],
  });
  render();

  function render() {
    clear(stage);
    const meta = assetMeta();
    if (hasAssets() && meta) { add(stage, linkedPanel(meta)); return; }

    add(stage,
      note('Nothing here affects how the app looks — the textures you see are bundled and already loaded.', 'info'),
      h('.col.g-2',
        h('.eyebrow', { text: 'What linking adds' }),
        benefit('package', 'Pack formats straight from the game',
          'A jar states the exact numbers it accepts in its own version.json, so you can target a snapshot this app has never heard of.'),
        benefit('tag', 'Creeper and chest loot',
          'Adding a disc to a vanilla loot table means rewriting that table. Starting from the real one is the only way to do it without guessing.'),
      ),
      dropzone({
        label: 'Drop a Minecraft client .jar, or click to choose',
        hint: 'Your versions folder has one per installed version',
        accept: '.jar,application/java-archive', iconName: 'cube',
        onFiles: files => run(files[0]),
      }),
      h('.col.g-2',
        h('.eyebrow', { text: `Where it is on ${OS_LABEL}` }),
        codeBlock(JAR_PATHS[OS]),
        h('.caption.muted', { text: 'Pick the .jar, not the .json beside it. Only a handful of small files are read, and nothing is uploaded.' }),
      ),
    );
  }

  function benefit(iconName, title, desc) {
    return h('.row.g-3.items-start', { style: 'padding:6px 0' },
      h('span', { style: 'color:var(--accent);flex:none;margin-top:1px' }, raw(icon(iconName, 15))),
      h('.col.g-1', h('.strong', { text: title }), h('.caption', { text: desc })),
    );
  }

  function linkedPanel(meta) {
    const chests = listGameData('loot_table/chests').length;
    return h('.col.g-4',
      note(`Linked to ${meta.version}.`, 'ok'),
      h('.card.card-pad.col.g-3',
        h('.row.between.g-2',
          h('.col.g-1',
            h('.row.g-2', raw(icon('cube', 15)), h('span.strong', { text: meta.version })),
            h('.caption.muted', { text: `${meta.name} · ${plural(chests, 'chest table')} · linked ${relTime(meta.at)}` }),
          ),
          meta.stable === false ? badge('snapshot', 'warn') : badge('release', 'accent'),
        ),
        meta.packVersion ? h('.row.g-3',
          h('.version-card.grow', h('.col',
            h('.vc-num', { text: formatLabel(meta.packVersion.data) }),
            h('.vc-lbl', { text: 'Data pack format' }))),
          h('.version-card.grow', h('.col',
            h('.vc-num', { text: formatLabel(meta.packVersion.resource) }),
            h('.vc-lbl', { text: 'Resource pack format' }))),
        ) : note('This jar had no version.json, so only the loot tables were taken from it.', 'warn'),
        meta.packVersion ? h('.caption.muted', {
          text: 'Straight from version.json — the exact numbers this copy of the game accepts. Choose “from your game” as a pack’s target to use them.',
        }) : null,
      ),
      h('.row.g-2',
        h('button.btn', { onclick: async () => { const f = await pickFile({ accept: '.jar' }); if (f) run(f); } },
          raw(icon('refresh', 14)), h('span', { text: 'Link a different version' })),
        h('button.btn.btn-danger', {
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Unlink?',
              message: 'You lose the exact pack formats and the creeper / chest loot options. Textures and everything else are unaffected.',
              confirmLabel: 'Unlink', danger: true,
            });
            if (!ok) return;
            await unlinkAssets();
            toast({ title: 'Unlinked', kind: 'ok' });
            render();
          },
        }, raw(icon('trash', 14)), h('span', { text: 'Unlink' })),
      ),
    );
  }

  async function run(file) {
    if (!file) return;
    clear(stage);
    const prog = progressBar({ label: 'Reading…' });
    add(stage,
      h('.row.g-2', raw(icon('cube', 16)), h('span.strong.truncate', { text: file.name }),
        h('span.caption.muted', { text: formatBytes(file.size) })),
      prog,
    );
    try {
      const meta = await linkJar(file, (msg, pct) => prog.set(pct, msg));
      toast({
        title: `Linked ${meta.version}`,
        message: meta.packVersion
          ? `Pack formats ${formatLabel(meta.packVersion.data)} / ${formatLabel(meta.packVersion.resource)}.`
          : 'Loot tables read.',
        kind: 'ok',
      });
      render();
    } catch (e) {
      console.error(e);
      clear(stage);
      add(stage, note(e.message, 'danger'), h('button.btn', { onclick: render, text: 'Try another file' }));
    }
  }

  return m;
}

/** Status row for Preferences and Pack Settings. */
export function gameLinkRow() {
  const row = h('.engine-row');
  const paint = () => {
    const meta = assetMeta();
    clear(row);
    add(row,
      h('span.engine-dot', { dataset: { on: String(hasAssets()) } }),
      h('.col.g-1.grow',
        h('.strong', { text: hasAssets() ? `Game data from ${meta.version}` : 'No game linked' }),
        h('.caption.muted', {
          text: hasAssets()
            ? 'Exact pack formats and real vanilla loot tables.'
            : 'Optional — adds exact pack formats and creeper / chest loot.',
        }),
      ),
      h('button.btn.btn-sm', { onclick: () => openGameLinkDialog() },
        raw(icon(hasAssets() ? 'sliders' : 'cube', 13)),
        h('span', { text: hasAssets() ? 'Manage' : 'Link' })),
    );
  };
  paint();
  // The row is rebuilt on every Pack Settings render, so it cannot own a
  // permanent subscription — this one retires with the node.
  bindLive(row, 'assets:changed', paint);
  return row;
}

/** Where the textures come from, said plainly. */
export function texturePackRow() {
  const meta = packMeta();
  return h('.engine-row',
    h('span.engine-dot', { dataset: { on: String(packReady()) } }),
    h('.col.g-1.grow',
      h('.strong', { text: packReady() ? `Textures: ${meta.source}` : 'Textures unavailable' }),
      h('.caption.muted', {
        text: packReady()
          ? `${plural(meta.count, 'texture')}, bundled with the app. Previews and starting points only — never written into an exported pack.`
          : 'The bundled pack did not load. Serve the folder over http rather than opening the file directly.',
      }),
    ),
  );
}
