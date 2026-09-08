/* ============================================================================
   Vanilla entity geometry.

   Minecraft does not ship entity models as data — they are built in Java with
   a fluent DSL (`CubeListBuilder.create().texOffs(u,v).addBox(...)`), so the
   only honest way to get them is to read the numbers back out of the compiled
   client. Every box below was recovered that way from the 26.2 client rather
   than eyeballed, because a single wrong UV offset shows up as a scrambled
   face on the model and is miserable to spot by hand.

   Coordinate system is Minecraft's own: X right, Y **down** from the part
   origin, Z forward. A cube's `from` is its corner in that space and `size` is
   its extent, both in the 1/16-block units the texture is measured in.
   `uv` is the top-left of the box's cross in the texture sheet; the six faces
   are laid out around it in the standard box unwrap (see uv.js).

   Parts form a tree: a child's pose is relative to its parent, which is what
   makes the wolf's ears move with its head.
   ========================================================================= */

const HALF_PI = 1.5707964;

/** Shared by every quadruped: `createBodyMesh(legHeight, …)` in the client. */
function quadruped(legHeight, { headUV = [0, 0], head = [-4, -4, -8, 8, 8, 8] } = {}) {
  return {
    head: {
      pose: [0, 18 - legHeight, -6],
      cubes: [{ uv: headUV, from: head.slice(0, 3), size: head.slice(3) }],
    },
    body: {
      pose: [0, 17 - legHeight, 2], rotation: [HALF_PI, 0, 0],
      cubes: [{ uv: [28, 8], from: [-5, -10, -7], size: [10, 16, 8] }],
    },
    right_hind_leg:  legPart(-3, 24 - legHeight,  7, legHeight, false),
    left_hind_leg:   legPart( 3, 24 - legHeight,  7, legHeight, true),
    right_front_leg: legPart(-3, 24 - legHeight, -5, legHeight, false),
    left_front_leg:  legPart( 3, 24 - legHeight, -5, legHeight, true),
  };
}

const legPart = (x, y, z, h, mirror) => ({
  pose: [x, y, z],
  cubes: [{ uv: [0, 16], from: [-2, 0, -2], size: [4, h, 4], mirror }],
});

/* ---- Cow ---------------------------------------------------------------- *
   The cow keeps its own legs (wider apart than the shared quadruped ones)
   and carries horns as named boxes on the head.                             */
const COW = {
  texture: [64, 64],
  parts: {
    head: {
      pose: [0, 4, -8],
      cubes: [
        { uv: [0, 0],  from: [-4, -4, -6], size: [8, 8, 6] },
        { uv: [1, 33], from: [-3, 1, -7],  size: [6, 3, 1], name: 'muzzle' },
        { uv: [22, 0], from: [-5, -5, -5], size: [1, 3, 1], name: 'right_horn' },
        { uv: [22, 0], from: [4, -5, -5],  size: [1, 3, 1], name: 'left_horn' },
      ],
    },
    body: {
      pose: [0, 5, 2], rotation: [HALF_PI, 0, 0],
      cubes: [
        { uv: [18, 4], from: [-6, -10, -7], size: [12, 18, 10] },
        { uv: [52, 0], from: [-2, 2, -8],   size: [4, 6, 1], name: 'udder' },
      ],
    },
    right_hind_leg:  legPart(-4, 12,  7, 12, false),
    left_hind_leg:   legPart( 4, 12,  7, 12, true),
    right_front_leg: legPart(-4, 12, -5, 12, false),
    left_front_leg:  legPart( 4, 12, -5, 12, true),
  },
};

/* ---- Pig ---------------------------------------------------------------- */
const PIG = {
  texture: [64, 64],
  parts: {
    ...quadruped(6),
    head: {
      pose: [0, 12, -6],
      cubes: [
        { uv: [0, 0],   from: [-4, -4, -8], size: [8, 8, 8] },
        { uv: [16, 16], from: [-2, 0, -9],  size: [4, 3, 1], name: 'snout' },
      ],
    },
  },
};

/* ---- Chicken ------------------------------------------------------------ */
const CHICKEN = {
  texture: [64, 32],
  parts: {
    head: {
      pose: [0, 15, -4],
      cubes: [{ uv: [0, 0], from: [-2, -6, -2], size: [4, 6, 3] }],
    },
    beak: {
      parent: 'head',
      cubes: [{ uv: [14, 0], from: [-2, -4, -4], size: [4, 2, 2] }],
    },
    red_thing: {
      parent: 'head',
      cubes: [{ uv: [14, 4], from: [-1, -2, -3], size: [2, 2, 2] }],
    },
    body: {
      pose: [0, 16, 0], rotation: [HALF_PI, 0, 0],
      cubes: [{ uv: [0, 9], from: [-3, -4, -3], size: [6, 8, 6] }],
    },
    right_leg: { pose: [-2, 19, 1], cubes: [{ uv: [26, 0], from: [-1, 0, -3], size: [3, 5, 3] }] },
    left_leg:  { pose: [1, 19, 1],  cubes: [{ uv: [26, 0], from: [-1, 0, -3], size: [3, 5, 3] }] },
    right_wing: { pose: [-4, 13, 0], cubes: [{ uv: [24, 13], from: [0, 0, -3],  size: [1, 4, 6] }] },
    left_wing:  { pose: [4, 13, 0],  cubes: [{ uv: [24, 13], from: [-1, 0, -3], size: [1, 4, 6] }] },
  },
};

/* ---- Wolf --------------------------------------------------------------- *
   `head` and `tail` are empty pivots; the visible boxes hang off them, which
   is how the client animates a head-tilt without shearing the ears.          */
const WOLF = {
  texture: [64, 32],
  parts: {
    head: { pose: [-1, 13.5, -7], cubes: [] },
    real_head: {
      parent: 'head',
      cubes: [
        { uv: [0, 0],   from: [-2, -3, -2],    size: [6, 6, 4] },
        { uv: [16, 14], from: [-2, -5, 0],     size: [2, 2, 1], name: 'right_ear' },
        { uv: [16, 14], from: [2, -5, 0],      size: [2, 2, 1], name: 'left_ear' },
        { uv: [0, 10],  from: [-0.5, -0.001, -5], size: [3, 3, 4], name: 'snout' },
      ],
    },
    body: {
      pose: [0, 14, 2], rotation: [HALF_PI, 0, 0],
      cubes: [{ uv: [18, 14], from: [-3, -2, -3], size: [6, 9, 6] }],
    },
    upper_body: {
      pose: [-1, 14, -3], rotation: [HALF_PI, 0, 0],
      cubes: [{ uv: [21, 0], from: [-3, -3, -3], size: [8, 6, 7] }],
    },
    /* The client builds one plain leg builder and one mirrored one, and hands
       the mirrored one to the *right* pair — the opposite of the cow. */
    right_hind_leg:  wolfLeg(-2.5, 16, 7, true),
    left_hind_leg:   wolfLeg(0.5, 16, 7, false),
    right_front_leg: wolfLeg(-2.5, 16, -4, true),
    left_front_leg:  wolfLeg(0.5, 16, -4, false),
    tail: { pose: [-1, 12, 8], rotation: [0.62831855, 0, 0], cubes: [] },
    real_tail: {
      parent: 'tail',
      cubes: [{ uv: [9, 18], from: [0, 0, -1], size: [2, 8, 2] }],
    },
  },
};

function wolfLeg(x, y, z, mirror) {
  return { pose: [x, y, z], cubes: [{ uv: [0, 18], from: [0, 0, -1], size: [2, 8, 2], mirror }] };
}

/* ---- Cat ---------------------------------------------------------------- *
   Every cat box carries its own texOffs rather than sharing the builder's,
   so each cube below names its own uv.                                       */
const CAT = {
  texture: [64, 32],
  inflate: -0.02,
  parts: {
    head: {
      pose: [0, 15, -9],
      cubes: [
        { uv: [0, 0],  from: [-2.5, -2, -3],     size: [5, 4, 5], name: 'main' },
        { uv: [0, 24], from: [-1.5, -0.001, -4], size: [3, 2, 2], name: 'nose' },
        { uv: [0, 10], from: [-2, -3, 0],        size: [1, 1, 2], name: 'ear1' },
        { uv: [6, 10], from: [1, -3, 0],         size: [1, 1, 2], name: 'ear2' },
      ],
    },
    body: {
      pose: [0, 12, -10], rotation: [HALF_PI, 0, 0],
      cubes: [{ uv: [20, 0], from: [-2, 3, -8], size: [4, 16, 6] }],
    },
    tail1: {
      pose: [0, 15, 8], rotation: [0.9, 0, 0],
      cubes: [{ uv: [0, 15], from: [-0.5, 0, 0], size: [1, 8, 1] }],
    },
    tail2: {
      pose: [0, 20, 14],
      cubes: [{ uv: [4, 15], from: [-0.5, 0, 0], size: [1, 8, 1] }],
    },
    left_hind_leg:  { pose: [1.1, 18, 5],    cubes: [{ uv: [8, 13], from: [-1, 0, 1], size: [2, 6, 2] }] },
    right_hind_leg: { pose: [-1.1, 18, 5],   cubes: [{ uv: [8, 13], from: [-1, 0, 1], size: [2, 6, 2] }] },
    left_front_leg: { pose: [1.2, 14.1, -5], cubes: [{ uv: [40, 0], from: [-1, 0, 0], size: [2, 10, 2] }] },
    right_front_leg:{ pose: [-1.2, 14.1, -5],cubes: [{ uv: [40, 0], from: [-1, 0, 0], size: [2, 10, 2] }] },
  },
};

/* ---- Frog --------------------------------------------------------------- *
   The frog is the odd one out: several of its parts are zero-height quads
   (tongue, hands, feet), which render as single flat faces.                  */
const FROG = {
  texture: [48, 48],
  parts: {
    body: {
      pose: [0, -2, 4],
      cubes: [
        { uv: [3, 1],   from: [-3.5, -2, -8], size: [7, 3, 9] },
        { uv: [23, 22], from: [-3.5, -1, -8], size: [7, 0, 9] },
      ],
    },
    head: {
      parent: 'body', pose: [0, -2, -1],
      cubes: [
        { uv: [23, 13], from: [-3.5, -1, -7], size: [7, 0, 9] },
        { uv: [0, 13],  from: [-3.5, -2, -7], size: [7, 3, 9] },
      ],
    },
    /* An empty pivot the client hangs both eyes from — it is offset, so the
       eyes sit slightly left and forward of the head's own origin. */
    eyes: { parent: 'head', pose: [-0.5, 0, 2], cubes: [] },
    right_eye: {
      parent: 'eyes', pose: [-1.5, -3, -6.5],
      cubes: [{ uv: [0, 0], from: [-1.5, -1, -1.5], size: [3, 2, 3] }],
    },
    left_eye: {
      parent: 'eyes', pose: [2.5, -3, -6.5],
      cubes: [{ uv: [0, 5], from: [-1.5, -1, -1.5], size: [3, 2, 3] }],
    },
    tongue: {
      parent: 'body', pose: [0, -1.01, 1],
      cubes: [{ uv: [17, 13], from: [-2, 0, -7.1], size: [4, 0, 7] }],
    },
    left_arm: {
      parent: 'body', pose: [4, -1, -6.5],
      cubes: [{ uv: [0, 32], from: [-1, 0, -1], size: [2, 3, 3] }],
    },
    left_hand: {
      parent: 'left_arm', pose: [0, 3, -1],
      cubes: [{ uv: [18, 40], from: [-4, 0.01, -4], size: [8, 0, 8] }],
    },
    right_arm: {
      parent: 'body', pose: [-4, -1, -6.5],
      cubes: [{ uv: [0, 38], from: [-1, 0, -1], size: [2, 3, 3] }],
    },
    right_hand: {
      parent: 'right_arm', pose: [0, 3, 0],
      cubes: [{ uv: [2, 40], from: [-4, 0.01, -5], size: [8, 0, 8] }],
    },
    left_leg: {
      pose: [3.5, -3, 4],
      cubes: [{ uv: [14, 25], from: [-1, 0, -2], size: [3, 3, 4] }],
    },
    left_foot: {
      parent: 'left_leg', pose: [2, 3, 0],
      cubes: [{ uv: [2, 32], from: [-4, 0.01, -4], size: [8, 0, 8] }],
    },
    right_leg: {
      pose: [-3.5, -3, 4],
      cubes: [{ uv: [0, 25], from: [-2, 0, -2], size: [3, 3, 4] }],
    },
    right_foot: {
      parent: 'right_leg', pose: [-2, 3, 0],
      cubes: [{ uv: [18, 32], from: [-4, 0.01, -4], size: [8, 0, 8] }],
    },
  },
};

/* ---- Zombie nautilus ----------------------------------------------------- *
   The newest of the variant mobs, and the only one on a 128x128 sheet. Its
   three mouth parts hang off the body so they open together.                */
const NAUTILUS = {
  texture: [128, 128],
  parts: {
    root: { pose: [0, 29, -6], cubes: [] },
    shell: {
      parent: 'root', pose: [0, -13, 5],
      cubes: [
        { uv: [0, 0],   from: [-7, -10, -7], size: [14, 10, 16] },
        { uv: [0, 26],  from: [-7, 0, -7],   size: [14, 8, 20] },
        { uv: [48, 26], from: [-7, 0, 6],    size: [14, 8, 0] },
      ],
    },
    body: {
      parent: 'root', pose: [0, -8.5, 12.3],
      cubes: [
        { uv: [0, 54], from: [-5, -4.51, -3], size: [10, 8, 14] },
        { uv: [0, 76], from: [-5, -4.51, 7],  size: [10, 8, 0] },
      ],
    },
    upper_mouth: {
      parent: 'body', pose: [0, -2.51, 7],
      cubes: [{ uv: [54, 54], from: [-5, -2, 0], size: [10, 4, 4], inflate: -0.001 }],
    },
    inner_mouth: {
      parent: 'body', pose: [0, -0.51, 7.5],
      cubes: [{ uv: [54, 70], from: [-3, -2, -0.5], size: [6, 4, 4] }],
    },
    lower_mouth: {
      parent: 'body', pose: [0, 1.49, 7],
      cubes: [{ uv: [54, 62], from: [-5, -1.98, 0], size: [10, 4, 4], inflate: -0.001 }],
    },
  },
};

/* ========================================================================= */
/* COLD AND WARM                                                              */
/* ========================================================================= */
/*
   Three of these mobs have more than one shape. A cold cow is not a repainted
   cow: it wears a fur layer half a pixel proud of its body and carries its
   horns as separate swept-back parts, and a warm cow trades horns for ears
   entirely. Which one you get is the `model` field on the variant, and the
   texture layout differs with it — the cold cow's muzzle sits at (9, 33) where
   the normal one's sits at (1, 33) — so previewing the normal mesh while the
   variant says "cold" shows the wrong patch of sheet on the wrong face.

   The client builds each of these by taking the base mesh and replacing a
   handful of parts, so that is what `withParts` does here rather than
   restating the whole animal three times.
*/

/** A model that is another model with some of its parts swapped out. */
function withParts(base, overrides) {
  return { ...base, parts: { ...base.parts, ...overrides } };
}

const COLD_COW = withParts(COW, {
  body: {
    pose: [0, 5, 2], rotation: [HALF_PI, 0, 0],
    cubes: [
      /* The fur is the same box grown by half a pixel, drawn from its own
         patch of sheet — that is the whole trick behind the shaggy look. */
      { uv: [20, 32], from: [-6, -10, -7], size: [12, 18, 10], name: 'fur', inflate: 0.5 },
      { uv: [18, 4],  from: [-6, -10, -7], size: [12, 18, 10] },
      { uv: [52, 0],  from: [-2, 2, -8],   size: [4, 6, 1], name: 'udder' },
    ],
  },
  head: {
    pose: [0, 4, -8],
    cubes: [
      { uv: [0, 0],  from: [-4, -4, -6], size: [8, 8, 6] },
      { uv: [9, 33], from: [-3, 1, -7],  size: [6, 3, 1], name: 'muzzle' },
    ],
  },
  /* 1.5708, not HALF_PI — the client rounds this one differently and the two
     differ by enough to shift the horn tips by a fraction of a pixel. */
  right_horn: {
    parent: 'head', pose: [-4.5, -2.5, -3.5], rotation: [1.5708, 0, 0],
    cubes: [{ uv: [0, 40], from: [-1.5, -4.5, -0.5], size: [2, 6, 2] }],
  },
  left_horn: {
    parent: 'head', pose: [5.5, -2.5, -5], rotation: [1.5708, 0, 0],
    cubes: [{ uv: [0, 32], from: [-1.5, -3, -0.5], size: [2, 6, 2] }],
  },
});

/* The warm cow has ears instead of horns — the replacement head simply does
   not carry the horn boxes the normal one does. */
const WARM_COW = withParts(COW, {
  head: {
    pose: [0, 4, -8],
    cubes: [
      { uv: [0, 0],  from: [-4, -4, -6], size: [8, 8, 6] },
      { uv: [1, 33], from: [-3, 1, -7],  size: [6, 3, 1], name: 'muzzle' },
      { uv: [27, 0], from: [-8, -3, -5], size: [4, 2, 2], name: 'right_ear' },
      { uv: [39, 0], from: [-8, -5, -5], size: [2, 2, 2], name: 'right_ear_tip' },
      { uv: [27, 0], from: [4, -3, -5],  size: [4, 2, 2], name: 'left_ear', mirror: true },
      { uv: [39, 0], from: [6, -5, -5],  size: [2, 2, 2], name: 'left_ear_tip', mirror: true },
    ],
  },
});

const COLD_PIG = withParts(PIG, {
  body: {
    pose: [0, 11, 2], rotation: [HALF_PI, 0, 0],
    cubes: [
      { uv: [28, 8],  from: [-5, -10, -7], size: [10, 16, 8] },
      { uv: [28, 32], from: [-5, -10, -7], size: [10, 16, 8], name: 'fur', inflate: 0.5 },
    ],
  },
});

const COLD_CHICKEN = withParts(CHICKEN, {
  body: {
    pose: [0, 16, 0], rotation: [HALF_PI, 0, 0],
    cubes: [
      { uv: [0, 9],  from: [-3, -4, -3], size: [6, 8, 6] },
      { uv: [38, 9], from: [0, 3, -1],   size: [0, 3, 5], name: 'tail' },
    ],
  },
  head: {
    pose: [0, 15, -4],
    cubes: [
      { uv: [0, 0],  from: [-2, -6, -2],      size: [4, 6, 3] },
      { uv: [44, 0], from: [-3, -7, -2.015],  size: [6, 3, 4], name: 'crest' },
    ],
  },
});

/**
 * The mesh for each named model a mob offers. "normal" is the base mesh and is
 * left out — vanilla omits `model` from the JSON for it too.
 */
export const MODEL_MESHES = {
  cow: { cold: COLD_COW, warm: WARM_COW },
  pig: { cold: COLD_PIG },
  chicken: { cold: COLD_CHICKEN },
};

/* ========================================================================= */
/* BABIES                                                                     */
/* ========================================================================= */
/*
   A baby is not the adult model scaled down. Since 1.21.5 each of these mobs
   ships a separate baby model with its own box layout *and* its own sheet
   size — a baby pig is 32x32 where the adult is 64x64, a baby chicken is a
   16x16 sheet — which is why `baby_asset_id` points at a different file rather
   than reusing the adult one. Painting a 64x64 image and calling it a baby pig
   texture produces a scrambled mob in game.

   Recovered from the 26.2 client the same way as the adults, then checked
   against the shipped baby sheets: every box's cross lands on drawn pixels.
   Mojang's own oddities are kept rather than tidied — the baby chicken really
   does put `right_wing` at +X while the adult puts it at -X.
*/

const BABY_COW = {
  texture: [64, 64],
  parts: {
    head: {
      pose: [0, 13.569, -5.1667],
      cubes: [
        { uv: [0, 18],  from: [-3, -4.569, -4.8333], size: [6, 6, 5] },
        { uv: [8, 29],  from: [3, -5.569, -3.8333],  size: [1, 2, 1], name: 'left_horn' },
        { uv: [4, 29],  from: [-4, -5.569, -3.8333], size: [1, 2, 1], name: 'right_horn', mirror: true },
        { uv: [12, 29], from: [-2, -1.569, -5.8333], size: [4, 3, 1], name: 'muzzle' },
      ],
    },
    /* Offset on X and drawn from -7, so the box still straddles the centre. */
    body: { pose: [3, 19, -5], cubes: [{ uv: [0, 0], from: [-7, -7, -1], size: [8, 6, 12] }] },
    right_front_leg: babyCowLeg(-2.5, -3.5, [22, 18]),
    left_front_leg:  babyCowLeg(2.5, -3.5, [34, 18]),
    right_hind_leg:  babyCowLeg(-2.5, 3.5, [22, 27]),
    left_hind_leg:   babyCowLeg(2.5, 3.5, [34, 27]),
  },
};

function babyCowLeg(x, z, uv) {
  return { pose: [x, 18, z], cubes: [{ uv, from: [-1.5, 0, -1.5], size: [3, 6, 3] }] };
}

const BABY_PIG = {
  texture: [32, 32],
  parts: {
    body: { pose: [0, 19, 0.5], cubes: [{ uv: [0, 0], from: [-3.5, -3, -4.5], size: [7, 6, 9] }] },
    head: {
      pose: [0, 19, -2],
      cubes: [
        { uv: [0, 15], from: [-3.5, -5, -5],      size: [7, 6, 6], inflate: 0.025 },
        { uv: [6, 27], from: [-1.5, -1.975, -6],  size: [3, 2, 1], name: 'snout', inflate: 0.015 },
      ],
    },
    left_front_leg:  babyPigLeg(2.5, -3, [0, 0]),
    right_front_leg: babyPigLeg(-2.5, -3, [23, 0]),
    left_hind_leg:   babyPigLeg(2.5, 4, [0, 4]),
    right_hind_leg:  babyPigLeg(-2.5, 4, [23, 4]),
  },
};

function babyPigLeg(x, z, uv) {
  return { pose: [x, 22, z], cubes: [{ uv, from: [-1, 0, -1], size: [2, 2, 2] }] };
}

/* The baby chicken is almost all flat quads — legs and wings are zero-thickness
   boxes, which cubeQuads() renders as the two real faces and drops the rest. */
const BABY_CHICKEN = {
  texture: [16, 16],
  parts: {
    body: {
      pose: [0, 20.25, -1.25],
      cubes: [
        { uv: [0, 0],  from: [-2, -2.25, -0.75], size: [4, 4, 4] },
        { uv: [10, 8], from: [-1, -0.25, -1.75], size: [2, 1, 1], name: 'beak' },
      ],
    },
    left_leg: {
      pose: [1, 22, 0.5],
      cubes: [
        { uv: [2, 2], from: [-0.5, 0, 0],  size: [1, 2, 0] },
        { uv: [0, 1], from: [-0.5, 2, -1], size: [1, 0, 1], name: 'foot' },
      ],
    },
    right_leg: {
      pose: [-1, 22, 0.5],
      cubes: [
        { uv: [0, 2], from: [-0.5, 0, 0],  size: [1, 2, 0] },
        { uv: [0, 0], from: [-0.5, 2, -1], size: [1, 0, 1], name: 'foot' },
      ],
    },
    /* Not a typo: vanilla puts the baby chicken's right wing on +X. */
    right_wing: { pose: [2, 20, 0],  cubes: [{ uv: [6, 8], from: [0, 0, -1],  size: [1, 0, 2] }] },
    left_wing:  { pose: [-2, 20, 0], cubes: [{ uv: [4, 8], from: [-1, 0, -1], size: [1, 0, 2] }] },
  },
};

const BABY_WOLF = {
  texture: [32, 32],
  parts: {
    head: {
      pose: [0, 18.25, -4],
      cubes: [
        { uv: [0, 12],  from: [-2.99, -3.25, -3], size: [6, 5, 5], inflate: 0.025 },
        { uv: [17, 12], from: [-1.5, -0.24, -5],  size: [3, 2, 2], name: 'snout' },
      ],
    },
    right_ear: { parent: 'head', pose: [-2, -4.25, -0.5], cubes: [{ uv: [0, 5], from: [-1, -1, -0.5], size: [2, 2, 1] }] },
    left_ear:  { parent: 'head', pose: [2, -4.25, -0.5],  cubes: [{ uv: [20, 5], from: [-1, -1, -0.5], size: [2, 2, 1] }] },
    body: { pose: [0, 19, 0], cubes: [{ uv: [0, 0], from: [-3, -2, -4], size: [6, 4, 8] }] },
    right_hind_leg:  babyWolfLeg(-1.5, 3, [0, 22]),
    left_hind_leg:   babyWolfLeg(1.5, 3, [8, 22]),
    right_front_leg: babyWolfLeg(-1.5, -3, [0, 0]),
    left_front_leg:  babyWolfLeg(1.5, -3, [20, 0]),
    tail: { pose: [0, 19, 3], rotation: [-0.5236, 0, 0], cubes: [] },
    tail_r1: {
      parent: 'tail', pose: [0, -0.6, 0.2], rotation: [-3.1, 0, 0],
      cubes: [{ uv: [22, 16], from: [-1, -5.7, -1], size: [2, 6, 2] }],
    },
  },
};

function babyWolfLeg(x, z, uv) {
  return { pose: [x, 21, z], cubes: [{ uv, from: [-1, 0, -1], size: [2, 3, 2] }] };
}

/* Cats and ocelots share one baby mesh; the collar layer is the only thing
   BabyCatModel adds on top, and that is not part of the variant texture. */
const BABY_CAT = {
  texture: [32, 32],
  parts: {
    head: {
      pose: [0, 20, -3.125],
      cubes: [
        { uv: [0, 0],  from: [-2.5, -3, -2.875], size: [5, 4, 4], name: 'main' },
        { uv: [18, 0], from: [-2, -4, -0.875],   size: [1, 1, 2], name: 'ear1' },
        { uv: [24, 0], from: [1, -4, -0.875],    size: [1, 1, 2], name: 'ear2' },
        { uv: [18, 3], from: [-1.5, -1, -3.875], size: [3, 2, 1], name: 'nose' },
      ],
    },
    body: { pose: [0, 20.5, 0.5], cubes: [{ uv: [0, 8], from: [-2, -1.5, -3.5], size: [4, 3, 7] }] },
    left_front_leg:  babyCatLeg(1, -1.5, [18, 18]),
    right_front_leg: babyCatLeg(-1, -1.5, [12, 18]),
    left_hind_leg:   babyCatLeg(1, 2.5, [18, 22]),
    right_hind_leg:  babyCatLeg(-1, 2.5, [12, 22]),
    tail1: {
      pose: [0, 19.107, 3.9151], rotation: [-0.567232, 0, 0],
      cubes: [{ uv: [0, 18], from: [-0.5, -0.107, 0.0849], size: [1, 1, 5] }],
    },
  },
};

function babyCatLeg(x, z, uv) {
  return { pose: [x, 22, z], cubes: [{ uv, from: [-0.5, 0, -1], size: [1, 2, 2] }] };
}

/** The baby mesh for a mob, or null when the mob has no baby form. */
export const BABY_MODELS = {
  cow: BABY_COW,
  pig: BABY_PIG,
  chicken: BABY_CHICKEN,
  wolf: BABY_WOLF,
  cat: BABY_CAT,
};

export const MOB_MODELS = {
  cow: COW,
  pig: PIG,
  chicken: CHICKEN,
  wolf: WOLF,
  cat: CAT,
  frog: FROG,
  zombie_nautilus: NAUTILUS,
};

/**
 * Flatten a model's part tree into draw order with absolute transforms
 * resolved. Returns [{ part, cube, offset:[x,y,z], rotation:[x,y,z] }].
 */
export function flattenModel(model) {
  const out = [];
  const parts = model.parts;
  const resolve = (name, seen = new Set()) => {
    const p = parts[name];
    if (!p || seen.has(name)) return { offset: [0, 0, 0], rotation: [0, 0, 0] };
    seen.add(name);
    const base = p.parent ? resolve(p.parent, seen) : { offset: [0, 0, 0], rotation: [0, 0, 0] };
    const pose = p.pose || [0, 0, 0];
    const rot = p.rotation || [0, 0, 0];
    return {
      offset: [base.offset[0] + pose[0], base.offset[1] + pose[1], base.offset[2] + pose[2]],
      rotation: [base.rotation[0] + rot[0], base.rotation[1] + rot[1], base.rotation[2] + rot[2]],
      pivot: base.offset,
    };
  };
  for (const [name, part] of Object.entries(parts)) {
    const t = resolve(name);
    for (const cube of part.cubes || []) {
      out.push({
        part: name,
        cube,
        offset: t.offset,
        rotation: t.rotation,
        pivot: t.pivot || [0, 0, 0],
        inflate: (cube.inflate || 0) + (model.inflate || 0),
      });
    }
  }
  return out;
}

/** Every cube in a model, for UV work that does not care about the tree. */
export const modelCubes = model =>
  Object.entries(model.parts).flatMap(([part, p]) =>
    (p.cubes || []).map(cube => ({ part, cube })));
