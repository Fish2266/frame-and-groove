/* ============================================================================
   Box UV unwrapping — the one place that decides which texture pixels land on
   which face of which cube.

   Minecraft unwraps every box the same way. Given a box `texOffs` at (u, v)
   and a size of (w, h, d) pixels, the six faces are laid out as a cross:

              u   u+d      u+d+w    u+2d+w   u+2d+2w
          v   +----+--------+--------+
              |    |   up   |  down  |
        v+d   +----+--------+--------+--------+
              |east| north  |  west  | south  |
      v+d+h   +----+--------+--------+--------+

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
    east:  rect(u, v + d, d, h),
    north: rect(u + d, v + d, w, h),
    west:  rect(u + d + w, v + d, d, h),
    south: rect(u + d + w + d, v + d, w, h),
  };
  if (cube.mirror) {
    // A mirrored box swaps its two side faces; the client does the same, which
    // is why a left leg reuses the right leg's texture without looking wrong.
    const e = faces.east; faces.east = faces.west; faces.west = e;
  }
  return faces;
}

/* Unit-cube corners, indexed so each face lists its four in winding order.
   Y runs downward, matching Minecraft's model space. */
const CORNERS = {
  //        0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0) 4:(0,0,1) 5:(1,0,1) 6:(1,1,1) 7:(0,1,1)
  east:  [5, 1, 2, 6],   // +X
  west:  [0, 4, 7, 3],   // -X
  up:    [0, 1, 5, 4],   // -Y (top, because Y grows downward)
  down:  [7, 6, 2, 3],   // +Y
  north: [1, 0, 3, 2],   // -Z
  south: [4, 5, 6, 7],   // +Z
};

const UNIT = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

/**
 * Expand one cube into six textured quads in model space.
 * `inflate` grows the box evenly on all sides, matching CubeDeformation.
 */
export function cubeQuads(cube, inflate = 0) {
  const [fx, fy, fz] = cube.from;
  const [sx, sy, sz] = cube.size;
  const lo = [fx - inflate, fy - inflate, fz - inflate];
  const hi = [fx + sx + inflate, fy + sy + inflate, fz + sz + inflate];
  const uv = boxUV(cube);
  const out = [];
  for (const face of FACES) {
    const r = uv[face];
    // A zero-size box (the frog's tongue and feet) still has two real faces;
    // the four degenerate ones are dropped rather than drawn as slivers.
    if (r.w <= 0 || r.h <= 0) continue;
    const idx = CORNERS[face];
    const pos = idx.map(i => {
      const c = UNIT[i];
      return [c[0] ? hi[0] : lo[0], c[1] ? hi[1] : lo[1], c[2] ? hi[2] : lo[2]];
    });
    // UVs run in the same winding as the corners: top-left, top-right,
    // bottom-right, bottom-left of the face rectangle.
    let uvs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    if (face === 'up' || face === 'down') {
      uvs = [[r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w, r.y], [r.x, r.y]];
    }
    if (cube.mirror && (face === 'north' || face === 'south' || face === 'up' || face === 'down')) {
      uvs = [uvs[1], uvs[0], uvs[3], uvs[2]];
    }
    out.push({ face, pos, uvs, light: FACE_LIGHT[face] });
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
