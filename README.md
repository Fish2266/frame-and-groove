# Frame & Groove

A studio for custom Minecraft **paintings**, **music discs**, **mob variants**
and **renamed item textures** that runs entirely in the browser. Draw the art,
record or generate the audio, and export the matching data pack and resource
pack — no build step, no account, nothing leaves your machine.

Go to https://fish2266.github.io/frame-and-groove/ to use the tool. 

---
# How to run it locally

```bash
python3 -m http.server 8722 --directory .
```

Then open <http://localhost:8722>. Any static server works; it must be served
over `http://` rather than opened as a `file://` path, because the app is built
from ES modules.

---

## The thing worth knowing first

**A custom painting or disc is always two packs.** The data pack registers it
with the game; the resource pack carries the PNG and the Ogg audio. Install only
one and nothing appears. Frame & Groove always writes both and always presents
them together, because the single most common way to lose an afternoon here is
to forget the other half.

What lands in each:

```
<namespace>_datapack.zip                      <namespace>_resourcepack.zip
├── pack.mcmeta                               ├── pack.mcmeta
├── pack.png                                  ├── pack.png
├── data/<ns>/painting_variant/*.json         ├── assets/<ns>/textures/painting/*.png
├── data/<ns>/jukebox_song/*.json             ├── assets/<ns>/sounds.json
├── data/minecraft/tags/                      ├── assets/<ns>/sounds/music/*.ogg
│   └── painting_variant/placeable.json       ├── assets/<ns>/items/*.json
├── data/<ns>/function/give_*.mcfunction      ├── assets/<ns>/models/item/*.json
└── .frame-and-groove/project.json            ├── assets/<ns>/textures/item/*.png
    (the editable project, so the zip         ├── assets/<ns>/textures/entity/…
     reopens here losslessly)                 ├── assets/minecraft/items/*.json
                                              │   (only the items a renamed
                                              │    sprite sits on)
                                              └── assets/<ns>/lang/en_us.json
```

## Discs that do not replace anything

The trick that makes this possible without overwriting a vanilla disc is the
`minecraft:item_model` component, added in **1.21.4**. A stock disc item carries
two overrides — your sprite and your song — while the disc it borrows from keeps
working exactly as before:

```mcfunction
give @s minecraft:music_disc_13[minecraft:item_model="mypack:my_song",minecraft:jukebox_playable={song:"mypack:my_song"},minecraft:item_name='{"text":"My Song","color":"aqua","italic":false}',minecraft:rarity="rare"] 1
```

The app writes that line for you and keeps the syntax correct per version —
`jukebox_playable` becomes a bare id and text components become SNBT from 1.21.5
onward, and the generated commands follow.

Paintings became data-driven in **1.21.2**, which is the first version where a
new one can exist without replacing vanilla art.

## Items that change when you name them

Call a stone sword **Flame** in an anvil and it wears your texture. Every other
stone sword in the world keeps the vanilla one.

An item's appearance comes from `assets/<ns>/items/<item>.json`, and that file
can branch on a data component. `minecraft:custom_name` is the component an
anvil writes, so the branch reads:

```json
{
  "model": {
    "type": "minecraft:select",
    "property": "minecraft:component",
    "component": "minecraft:custom_name",
    "cases": [
      { "when": "Flame",
        "model": { "type": "minecraft:model", "model": "mypack:item/flame" } }
    ],
    "fallback": { "type": "minecraft:model",
                  "model": "minecraft:item/stone_sword" }
  }
}
```

Three things about that are worth stating, because they are what makes it work
rather than nearly work:

- **The match is exact.** `AnvilMenu` sets `custom_name` to
  `Component.literal(name)` — no style, trimmed, capped at 50 characters — and
  the case value is decoded with the component's own codec and compared with
  `equals()`. So a bare `"Flame"` matches, `"flame"` does not, and a trailing
  space matches nothing at all because an anvil will not let anyone type one.
  The editor enforces the same 50 characters and warns about the rest.
- **The branch lives on the vanilla item**, so the file goes in the `minecraft`
  namespace and every sprite you build on the same base item shares one file.
  The app merges them; a resource pack loaded above yours that touches the same
  item will still win.
- **The fallback has to be the vanilla model**, or the pack quietly retextures
  every stone sword instead of only the named ones. It is written for you.

Only items drawn from a single flat sprite are offered — 510 of them, read out
of the client's own assets: everything whose `items/<id>.json` is a plain model
pointing at an `item/generated` or `item/handheld` model with one `layer0`
texture. A block item is a cube with six faces and a bow has four models and a
predicate, so neither can be redrawn from one picture. Sprites can be drawn at
1×, 2×, 4× or 8× the vanilla 16 × 16, and nothing has to be declared for it.

`minecraft:component` as a select property was read out of the 26.2 client's own
`SelectItemModelProperties`. Whether an earlier release already had it is not
something this app can honestly claim, so the feature is granted from **26.1**
on and no further back — a pack that silently does nothing in game is worse than
one that says up front it needs a newer target.

## Version support



| Target | Data | Resource | Paintings | Disc sprites | Mob variants | Renamed items |
|---|---|---|---|---|---|---|
| 1.21 – 1.21.1 | 48 | 34 | replace only | replace only | wolf only | — |
| 1.21.2 – 1.21.3 | 57 | 42 | ✅ | replace only | wolf only | — |
| 1.21.4 | 61 | 46 | ✅ | ✅ | wolf only | — |
| 1.21.5 | 71 | 55 | ✅ | ✅ | ✅ | — |
| 1.21.6 | 80 | 63 | ✅ | ✅ | ✅ | — |
| 1.21.7 – 1.21.8 | 81 | 64 | ✅ | ✅ | ✅ | — |
| 1.21.9 – 1.21.10 | 88 | 69 | ✅ | ✅ | ✅ | — |
| 1.21.11 | 94.1 | 75 | ✅ | ✅ | ✅ | — |
| 26.1 – 26.1.2 | 101.1 | 84 | ✅ | ✅ | ✅ + sounds | ✅ |
| **26.2** | 107.1 | 88 | ✅ | ✅ | ✅ + sounds | ✅ |

Two things changed along the way and the app handles both:

- **Year-based names.** The release after 1.21.11 is 26.1, then 26.2.
- **A new `pack.mcmeta` shape.** From 1.21.9, `min_format` / `max_format`
  replace `pack_format`, and formats gained a minor number. Each is either an
  integer or a `[major, minor]` pair. Targets before 1.21.9 still get the old
  `pack_format` + `supported_formats` form.

**Nothing here can go stale**, because the numbers do not have to come from
this table at all. Link a Minecraft jar (Pack Settings → Game data) and the app
reads `version.json` out of it:

```json
"pack_version": { "resource_major": 88, "resource_minor": 0,
                  "data_major": 107,   "data_minor": 1 }
```

That target appears in the version list as *"26.2 — from your game"* and is the
exact set of numbers your copy accepts, snapshots included. Failing that,
**Pack Settings → Advanced** takes both numbers by hand and shows you the
resulting `pack.mcmeta` as you type.

---

## What is in it

**Pixel editor** — layers with blend modes and opacity, pencil / eraser / fill /
line / rectangle / ellipse / gradient / shade / magic wand / move, mirror
drawing on either axis, selections, pixel and block grids, a reference image
underlay, undo history you can scrub, and nine Minecraft-native palettes.

**Image import** — two ways in, because they answer different questions.
*Fit to the canvas* box-filters a photo down so it keeps its detail at 32 pixels
wide, then quantises it with median-cut or a fixed palette and Floyd–Steinberg,
Atkinson or ordered dithering, with a live before/after. *Place by hand* — or
just dropping a PNG onto the canvas — floats it over the artwork instead: drag
it, resize it from any of eight handles (corners hold the shape, Shift frees
it), flip it, fade it, and snap it to an exact rectangle. Nothing touches the
document until you press Place, and then it is one undo step.

**Frames** — eleven procedural borders that redraw for the painting's size, so a
1×1 gets a 1px frame and a 4×4 gets 3px without any stretching.

**Disc sprite forge** — three ways to make the 16×16:
*Design* gives eight parametric label templates over a vinyl body, recoloured
from a single hue or borrowed from one of your paintings. *Vanilla* starts from
a real disc texture — all 21 of them, pixel for pixel — with an optional label
recolour that leaves the vinyl body and its shading exactly as they were.
*Pixel art* drops the whole editor onto the sprite.

Every preview is the sprite the pack actually writes. The record in the header,
the thumbnails in the sidebar, the disc hovering over the jukebox and the PNG in
the zip all come out of one renderer, so none of them can drift from the others
— switch to a vanilla texture and the header shows that texture, pixel for pixel,
not a smooth stand-in.

**Mob variants** — a green cow that only turns up in lush caves, a wolf with
its own three coats. Seven mobs can carry variants, because seven is what the
game has registries for: cow, pig, chicken, frog, wolf, cat and zombie
nautilus. This is not a general reskin-any-mob system and no data pack can make
it one — a creeper has no `creeper_variant` registry to write into. Each variant
writes one JSON into its mob's registry (`data/<ns>/cow_variant/…`) plus its
textures, and replaces nothing.

*The 3D editor* draws the real entity model — every box recovered from the
client's own compiled model classes rather than copied off a wiki, so the UVs
line up with the textures the game ships. The model and the flat sheet are the
same document seen twice: paint on either and the other updates, sharing one
undo history. Clicking the model resolves to an exact texel through a picking
pass, so a stroke lands on the pixel you aimed at, and the texel under the
cursor is ringed on the model so you can see which one that is before you
commit. Face guides outline which patch of the sheet is which face, and
hovering a part lights it in both views. Parts can be switched off one at a
time — the only sane way to paint the inside of a leg — which also takes them
out of the picker so clicks fall through to what is behind. Hiding is a view
setting; the export always writes the whole sheet.

*Cold and warm are their own shape too.* A cold cow is not a repainted cow: it
wears a fur layer half a pixel proud of its body and carries swept-back horns as
separate parts, a warm cow trades horns for ears, and a cold pig and a cold
chicken each grow a layer of their own. Their sheets are laid out differently to
match — the cold cow's muzzle sits at (9, 33) where the normal one's sits at
(1, 33) — so picking the model changes the mesh the preview draws and the face
guides that go with it, not just the label in the JSON.

*Resolution is yours to pick.* The game samples an entity texture by normalised
coordinate, so any whole multiple of the model's own sheet works with nothing
declared anywhere: at 4× a cow is a 256 × 256 document and its face goes from
8 × 8 pixels to 32 × 32. That is the difference between a suggestion of a face
and an actual photograph of one, and **Place image** puts a picture on exactly
one face: drop a PNG onto the flat sheet, or press the button, and it arrives
floating — drag it, resize it, or snap it to any face on the model from a list
that names every one. It lands on the current layer with everything around it
untouched. Scaling up
duplicates pixels and scaling back down averages exactly those blocks, so up and
back is byte-for-byte the art you started with.

*Babies are their own mob.* Since 1.21.5 each of these has a separate baby
model on a separate, usually smaller sheet — a calf pig is 32 × 32 where the
adult is 64 × 64, a chick is 16 × 16 — which is why the registry has a
`baby_asset_id` at all rather than reusing the adult texture. The editor
switches model and canvas size together, and starts each age from that age's
own vanilla texture.

*Spawning* is the whole point of the registry: biome, structure or moon
brightness, each with a priority, exactly as vanilla writes its own. Biomes and
tags come from the game's real vocabulary — 66 biomes, 68 tags, 34 structures —
and `#tags` cover a whole group at once the way vanilla does it.

*Sounds* — from 26.1 a variant can carry its own sound set, with the exact
field list each mob expects (a cow wants four, a cat wants nine, and most split
into adult and baby). Each field takes either the id of a sound that already
exists, or a clip of your own: record from the microphone or drop in a file,
and the app stores it, re-encodes it to Ogg Vorbis and writes the `.ogg`, the
`sounds.json` entry and the id in the registry entry so all three agree.

**Loot tables** — a disc can be found rather than given. Its own table
(`/loot give`, nothing vanilla touched), creeper drops the way vanilla does it,
or structure chests with a rarity weight. The last two have to rewrite a vanilla
table, so they are built from the real one out of your linked jar and the app
says plainly where the conflict risk is.

**Audio** — record from the microphone, drop in MP3/WAV/M4A/FLAC/Ogg, or
generate a track from a seed. Trim, gain, fades, normalise, mono fold, then
Ogg Vorbis encoding with a real quality control.

**Track generator** — six styles, deterministic from a seed, rendered
sample-by-sample. Write the seed down and you get the same music back.

**Pack icon** — until you draw one, `pack.png` is a contact sheet of what is
actually in the pack: every painting, disc, mob head and renamed sprite, tiled
on one 64 × 64 square and interleaved by kind so eleven paintings and one mob
still shows the mob. One thing fills the square; a dozen tile it. Drawing your
own replaces it, and clearing yours brings it back.

**Round trip** — every exported pack carries its own project data, so dropping
the zip back in reopens it with layers and settings intact. Packs made anywhere
else are reverse-engineered from their registry JSON, PNGs and audio.

---

## 26.2 and 26.3

Verified against the real clients rather than a changelog. **26.2** is the
default target and its numbers come straight from its own `version.json`
(`data [107, 1]`, `resource [88, 0]`); every file the app writes — variant
JSON, `painting_variant`, `jukebox_song`, the singular `loot_table` and
`function` folders, the `items/` definition plus its `models/item/` model —
matches what that client ships.

**26.3** is listed as a snapshot target with `data [116, 0]` /
`resource [96, 0]`, read out of 26.3-snapshot-8. Diffing that snapshot against
26.2 turned up nothing the exporter has to change: all thirteen variant
registries are still there, all fifty vanilla variant files are byte-identical,
and every entity model's geometry is unchanged, so the UVs still line up. What
26.3 does add is content — one biome (`dappled_forest`), eighteen abandoned-camp
structures and thirty-one new tags — and those are in the pickers, marked with
the version that introduced them and greyed out for packs targeting anything
older. A spawn rule that names one is called out rather than silently never
matching.

Snapshot numbers can still move before release, so the safest target for a
build newer than this list is **link your game jar** (Pack settings → Minecraft
version): the app reads `pack_version` out of the jar and derives the feature
set from the numbers themselves, so a client this app has never heard of still
gets the right `pack.mcmeta` and the right registries.

---

## What needs which version

Mob variants are the one feature with a hard floor that is not 1.21: the
`cow_variant`, `pig_variant`, `chicken_variant`, `frog_variant` and
`cat_variant` registries arrived in **1.21.5**, `wolf_variant` back in
**1.20.5**, `zombie_nautilus_variant` in **1.21.11**, and the per-variant sound
registries in **26.1** (the wolf's existed earlier but was restructured, so
26.1 is the floor for the shape written here). The app checks
each mob against the pack's target and says so rather than writing a file the
game will ignore.

Renamed item textures have a floor too: **26.1**, for the reason given above —
that is the oldest client whose select properties this app has actually read.
Everything else works from 1.21.2 (paintings) or 1.21.4 (disc sprites).

---

## Two details that cost people time

**Mono matters.** Minecraft only applies 3D positional audio to mono sounds. A
stereo disc plays flat across the whole world and ignores where the jukebox is.
The app folds to mono by default and warns if you turn it off.

**`asset_id` has no `textures/` in it.** Vanilla's own cow reads
`"asset_id": "minecraft:entity/cow/cow_temperate"`, which the game expands to
`assets/minecraft/textures/entity/cow/cow_temperate.png`. Both wiki pages I
checked while building this said otherwise; the game's own data pack settles
it. Write the longer form and the mob renders as the missing-texture chequer.

**Variants need a world reload.** `/reload` alone does not pick them up — leave
the world and come back.

**A custom disc cannot appear in the creative inventory.** The creative tabs are
built from a hardcoded list of item *types* inside the client; a custom disc is
a vanilla disc item wearing your sprite and your song, not a new item, so there
is nothing for a tab to list and no data pack can add one. The give command, the
generated `give_discs` function and a loot table are the ways to hand one out.
Custom paintings are the opposite case — the game does build those creative
entries from the `painting_variant` registry, so they turn up on their own.

**Ogg Vorbis only.** Nothing else loads. Conversion happens in-app via
`@audio/encode-ogg` (MIT, libvorbis compiled to WebAssembly), vendored in
`vendor/` so it works offline from the first launch.

---

## Layout

```
index.html
css/      tokens · base · components · app · editor · disc
js/
  core/     util dom icons versions db project store texturepack gameassets
  paint/    render frames tools palettes imageimport compose
  disc/     sprite vanilla
  mob/      models uv registry render3d export
  sprite/   items export
  audio/    engine recorder compose
  export/   zip packbuild importer loot
  ui/       kit editor shell cmdk textures pixelart brandmark trackgen
            samplepack gamelink thumbs importdialog tooltip
  ui/views/ library pack paintings discs mobs sprites exportview
assets/textures/   the bundled texture set (previews and starting points)
assets/mobdata/    biome, tag and structure names read from the game
assets/itemdata/   the 510 items that are one flat sprite, read from the game
vendor/   ogg-encode.js (@audio/encode-ogg@1.2.2, MIT)
```

No framework, no bundler, no runtime dependencies beyond the vendored encoder.
The zip writer is built on the platform's own `CompressionStream('deflate-raw')`.
Blocks, discs, paintings and mobs in the previews come from the bundled texture
set, composited the way the game's own models composite them — a grass block's
side is the side texture with the biome-tinted overlay over it, not a dirt tile;
the empty-state chest is cut out of the real chest entity sheet rather than
drawn from planks and a painted-on latch. The sample pack is still generated at
runtime.

## Storage

Projects live in IndexedDB in your browser. Browsers can evict site data under
pressure — **Pack Settings → Storage** has a button to request persistent
storage, and exporting is always the real backup.

## Keyboard

`⌘K` command palette · `⌘S` save · `⌘1–7` sections · `?` full shortcut sheet.
In the editor: `B E G I L R O N S M W V H` for tools, `[` `]` brush size,
`X` swap colours, `0` fit, `1` 100%, `Space`-drag to pan, `Alt` for a temporary
eyedropper, right-drag to draw with the secondary colour.

## Putting it online

The whole thing is static files with no build step, so GitHub Pages serves it
as-is:

1. Push this folder to a public repository.
2. **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder
   `/ (root)`.
3. It appears at `https://<user>.github.io/<repo>/` a minute later.

No workflow file and no configuration are needed. Three things are already
handled and worth not undoing:

- **`.nojekyll`** stops GitHub from running the files through Jekyll, which
  would slow the build to a crawl on the asset folder and hide anything whose
  name begins with an underscore.
- **Every path is relative**, so the site works from a subdirectory. Nothing
  starts with `/`.
- **Nothing needs special headers.** No service worker, no `SharedArrayBuffer`,
  no cross-origin isolation — the Ogg encoder is plain WebAssembly inside one
  JavaScript file. Pages gives you HTTPS, which is what the microphone needs.

GitHub Pages is case-sensitive where macOS is not, so a wrong-case filename
works locally and 404s in production. Every reference in the repository —
imports, fetches, the 2842 manifest entries and the 510 item textures — has
been checked to match its file exactly.

The repository is 13 MB, of which 11 MB is the texture set, but a cold visit
does not pull that: the manifest is read up front and individual textures are
fetched only when something needs to draw one. A first load is 103 requests and
about 1.6 MB, and 40 of those requests are textures totalling 8 KB. The text
assets are 1540 KB raw and 498 KB gzipped, which is what Pages actually sends.
Against a 100 GB/month soft limit that is roughly a hundred thousand visits, so
bandwidth is not something to plan around.

Two GitHub details rather than app details: the repository has to be **public**
for Pages on the free tier, and the first deploy can take a few minutes even
though later ones are quick.

## Licence and legal

- **[LICENSE](LICENSE)** — MIT, covering everything in this repository that is
  mine. It is the permissive default, and its no-warranty clause is the part
  that matters: it says plainly that the tool comes with no guarantees and that
  you are not liable for what someone does with it.
- **[THIRD-PARTY.md](THIRD-PARTY.md)** — the vendored Ogg encoder (MIT, licence
  text kept in `vendor/`), and exactly what is derived from Minecraft and in
  what form.
- **The unofficial notice.** Mojang asks that fan projects say clearly that they
  are not official. It is under the pack grid, in Preferences, and in
  `THIRD-PARTY.md`:

  > NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH
  > MOJANG OR MICROSOFT.

- **Privacy.** There is nothing to disclose because nothing is collected: no
  accounts, no analytics, no cookies, no servers, no network requests beyond
  the files the page itself is made of. Projects live in your browser's
  IndexedDB. The microphone is read only while you hold the record button, and
  what it captures goes into your project and nowhere else. That is the whole
  policy, and it is said in Preferences too.

- **Keep it free.** The moment a fan tool charges money the calculation changes
  completely. This one does not.

## Credits

Your packs are yours.

- The texture set under `assets/textures/` is laid out the way a resource pack
  is (`block/…`, `item/…`, `painting/…`, `entity/<mob>/…`) and keyed to 26.2. It
  drives every preview and every "start from", and never reaches an exported
  pack on its own. What it is and where it came from is set out in
  [THIRD-PARTY.md](THIRD-PARTY.md).
- Entity geometry, the biome/structure lists and the list of items that are a
  single flat sprite are read from your own installed Minecraft client at build
  time — numbers and names only, no assets.
- **@audio/encode-ogg@1.2.2** (MIT) in `vendor/` — libvorbis compiled to
  WebAssembly. Licence text is in `vendor/encode-ogg-LICENSE.txt`.
- Minecraft is a trademark of Mojang Studios. This is an unofficial tool.
  Linking a game jar reads a few files from your own installation and keeps them
  on your machine.
