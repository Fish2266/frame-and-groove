# Third-party material

Everything in this repository is either original work under the [MIT
licence](LICENSE) or one of the items below.

## Bundled code

**@audio/encode-ogg 1.2.2** — `vendor/ogg-encode.js`
MIT licence. libvorbis compiled to WebAssembly, used to encode the Ogg files a
music disc needs. Full licence text: `vendor/encode-ogg-LICENSE.txt`.

## Material derived from Minecraft

Frame & Groove reads a few things out of a Minecraft client to get its facts
right instead of guessing. What that produced, and what it is:

| Where | What it holds | What it is |
|---|---|---|
| `js/mob/models.js` | Box positions, sizes and UV offsets for seven entity models | Coordinates, transcribed from the client's compiled model classes |
| `assets/mobdata/world.json` | Biome, structure and tag identifiers, with the version each arrived in | Names and version numbers |
| `assets/itemdata/items.json` | The item ids that are drawn from a single flat sprite, with their English names | Names and ids |
| `js/core/versions.js` | `pack_format` numbers per release | Numbers |

Those four are identifiers, numbers and coordinates — the interface a data pack
has to match — rather than artwork, code or audio.

`assets/textures/` is different, and is stated plainly here rather than left to
be inferred: it is 2842 texture files from the Minecraft 26.2 client, unaltered.
They are used inside the app to show you what your own work will look like in
game — the block behind a painting, the jukebox under a disc, the vanilla mob
you start a variant from — and no part of the set is ever written into a pack
this tool exports. Copyright in them belongs to Mojang Synergies AB, not to
this project, and nothing here is offered under the MIT licence above except
the code.

## Not affiliated with Mojang or Microsoft

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG
OR MICROSOFT.

"Minecraft" is a trademark of Mojang Synergies AB. This project is an
unofficial fan tool and is not endorsed by, sponsored by or affiliated with
Mojang or Microsoft in any way. It is distributed free of charge.

Packs you build with it contain your own artwork and your own audio. The tool
claims no rights over anything you make.
