/* ============================================================================
   Box UV unwrapping — the one place that decides which texture pixels land on
   which face of which cube.

   Minecraft unwraps every box the same way. Given a box `texOffs` at (u, v)
   and a size of (w, h, d) pixels, the six faces are laid out as a cross:

              u   u+d      u+d+w    u+2d+w   u+2d+2w
          v   +----+--------+--------+
              |    |   up   |  down  |
        v+d   +----+--------+--------+--------+
              |west| north  |  east  | south  |
      v+d+h   +----+--------+--------+--------+

   West is -X, the mob's own right side — the side its right legs are on. The
   strip runs west, north, east, south: all the way round the box, with each
   face read left to right as it is seen from outside.

   Both the 3D view and the flat projection view read from here, so a face can
   never mean one thing in one view and something else in the other.
   ========================================================================= */

/** Face order is fixed; the renderer and the picker both rely on the indices. */
export const FACES = ['east', 'west', 'up', 'down', 'north', 'south'];

/** Minecraft's own directional shading, so the preview reads like the game. */
export const FACE_LIGHT = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };

/**
 * The texture rectangle for each face of one cube, in pixels.
 * @returns {{[face:string]: {x:number, y:number, w:number, h:number}}}
 */
export function boxUV(cube) {
  const [u, v] = cube.uv;
  const [w, h, d] = cube.size.map(n => Math.round(Math.abs(n)));
  const rect = (x, y, rw, rh) => ({ x, y, w: rw, h: rh });
  const faces = {
    up:    rect(u + d, v, w, d),
    down:  rect(u + d + w, v, w, d),
    west:  rect(u, v + d, d, h),
    north: rect(u + d, v + d, w, h),
    east:  rect(u + d + w, v + d, d, h),
    south: rect(u + d + w + d, v + d, w, h),
  };
  if (cube.mirror) {
    // A mirrored box swaps its two side faces; the client does the same, which
    // is why a left leg reuses the right leg's texture without looking wrong.
    const e = faces.east; faces.east = faces.west; faces.west = e;
  }
  return faces;
}

/**
 * Expand one cube into six textured quads in model space.
 * `inflate` grows the box evenly on all sides, matching CubeDeformation.
 *
 * The corners, the order they go round each face, and the texture corner each
 * one takes are copied from the client's ModelPart.Cube rather than derived.
 * Deriving them had put the west strip on the east side and hung every front
 * and back face the wrong way round — invisible on a symmetric cow, but a
 * spot painted on its right cheek went into the game on its left.
 */
export function cubeQuads(cube, inflate = 0) {
  const [fx, fy, fz] = cube.from;
  const [sx, sy, sz] = cube.size;
  let x0 = fx - inflate, x1 = fx + sx + inflate;
  const y0 = fy - inflate, y1 = fy + sy + inflate;
  const z0 = fz - inflate, z1 = fz + sz + inflate;
  // mirror() swaps the box's two x extents; the faces below then land on the
  // opposite sides with their pixels flipped, exactly as the client does it.
  if (cube.mirror) [x0, x1] = [x1, x0];

  // The client's eight corners, named as it names them. Y runs downward.
  const v7 = [x0, y0, z0], v = [x1, y0, z0], v1 = [x1, y1, z0], v2 = [x0, y1, z0];
  const v3 = [x0, y0, z1], v4 = [x1, y0, z1], v5 = [x1, y1, z1], v6 = [x0, y1, z1];

  // The unmirrored layout: mirroring is done with the corners, not the atlas.
  const uv = boxUV({ ...cube, mirror: false });
  // Polygon(verts, u1, v1, u2, v2) gives its corners (u2,v1) (u1,v1) (u1,v2)
  // (u2,v2). Every face runs from its top edge except the underside.
  const topFirst = r => [[r.x + r.w, r.y], [r.x, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
  const bottomFirst = r => [[r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y], [r.x + r.w, r.y]];

  const faces = {
    up:    { pos: [v4, v3, v7, v],  uvs: topFirst(uv.up) },      // -Y, the top
    down:  { pos: [v1, v2, v6, v5], uvs: bottomFirst(uv.down) }, // +Y, the underside
    west:  { pos: [v7, v3, v6, v2], uvs: topFirst(uv.west) },    // -X
    north: { pos: [v, v7, v2, v1],  uvs: topFirst(uv.north) },   // -Z, the front
    east:  { pos: [v4, v, v1, v5],  uvs: topFirst(uv.east) },    // +X
    south: { pos: [v3, v4, v5, v6], uvs: topFirst(uv.south) },   // +Z
  };

  const out = [];
  for (const face of FACES) {
    const r = uv[face];
    // A zero-size box (the frog's tongue and feet) still has two real faces;
    // the four degenerate ones are dropped rather than drawn as slivers.
    if (r.w <= 0 || r.h <= 0) continue;
    let { pos, uvs } = faces[face];
    let side = face;
    if (cube.mirror) {
      // Swapping x turned the face inside out; reversing its corners turns it
      // back, and the two side strips have traded places.
      pos = [...pos].reverse();
      uvs = [...uvs].reverse();
      side = face === 'west' ? 'east' : face === 'east' ? 'west' : face;
    }
    out.push({ face: side, pos, uvs, light: FACE_LIGHT[side] });
  }
  return out;
}

/**
 * Every face rectangle in a model, tagged with the part and cube it belongs
 * to. The flat projection view draws its outlines straight from this.
 */
export function modelUVRegions(model) {
  const regions = [];
  for (const [partName, part] of Object.entries(model.parts)) {
    for (const cube of part.cubes || []) {
      const uv = boxUV(cube);
      for (const face of FACES) {
        const r = uv[face];
        if (r.w <= 0 || r.h <= 0) continue;
        regions.push({ part: partName, cube, face, ...r });
      }
    }
  }
  return regions;
}

/** Which region a texture pixel falls inside, or null. Later wins, matching draw order. */
export function regionAt(regions, x, y) {
  let hit = null;
  for (const r of regions) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) hit = r;
  }
  return hit;
}

/**
 * Fraction of the texture that no face maps to. A high number usually means
 * the texture and the model disagree — worth telling the user about.
 */
export function coverage(model, [tw, th]) {
  const seen = new Uint8Array(tw * th);
  for (const r of modelUVRegions(model)) {
    for (let y = r.y; y < Math.min(th, r.y + r.h); y++) {
      for (let x = r.x; x < Math.min(tw, r.x + r.w); x++) seen[y * tw + x] = 1;
    }
  }
  let used = 0;
  for (let i = 0; i < seen.length; i++) used += seen[i];
  return { used, total: tw * th, fraction: used / (tw * th) };
}
