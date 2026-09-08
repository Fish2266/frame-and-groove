/* ============================================================================
   A small WebGL viewer for boxy entity models.

   Two things make this more than a spinning preview:

   * The texture is uploaded with NEAREST filtering and no mipmaps, so a 64x32
     sheet shows the same hard pixel edges the game draws.
   * Picking renders a second pass where each fragment's colour *is* its texel
     coordinate. Reading one pixel back turns a click into an exact texture
     pixel, which is what lets you paint on the model itself and have it land
     on the right pixel of the sheet — no ray/triangle maths, no drift.
   ========================================================================= */

import { cubeQuads } from './uv.js';
import { flattenModel } from './models.js';

/* Both stages declare precision the same way, because a uniform used in both
   has to agree or the program refuses to link. highp matters here: the picking
   pass turns a UV into a texel index, and at 512 pixels across a sheet mediump
   is only good to about half a pixel — enough to paint the wrong one. */
const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const VERT = PRECISION + `
attribute vec3 aPos;
attribute vec2 aUV;
attribute float aLight;
attribute float aId;
uniform mat4 uProj, uView;
uniform vec2 uTexSize;
varying vec2 vUV;
varying float vLight;
varying float vId;
void main() {
  gl_Position = uProj * uView * vec4(aPos, 1.0);
  vUV = aUV / uTexSize;
  vLight = aLight;
  vId = aId;
}`;

const FRAG = PRECISION + `
uniform sampler2D uTex;
uniform vec2 uTexSize;
/* The sheet the artwork is actually stored at. Equal to uTexSize at 1x, and a
   whole multiple of it when the variant is painted at a higher resolution —
   the model's UVs never change, only how many texels sit under them. */
uniform vec2 uDocSize;
uniform float uPickMode;
uniform vec3 uHighlight;
uniform float uHighlightId;
uniform vec2 uHoverTexel;
varying vec2 vUV;
varying float vLight;
varying float vId;
void main() {
  vec2 tp = vUV * uDocSize;
  vec2 texel = floor(tp);
  if (uPickMode > 0.5) {
    /* Colour *is* the texel coordinate, so one readPixels resolves a click.
       A byte per axis only reaches 255, which a 512-pixel sheet blows past, so
       the low byte of each axis goes in red and green and their high nibbles
       share blue. Alpha is the hit flag. */
    vec2 lo = mod(texel, 256.0);
    vec2 hi = floor(texel / 256.0);
    gl_FragColor = vec4(lo.x / 255.0, lo.y / 255.0,
                        (hi.x * 16.0 + hi.y) / 255.0, 1.0);
    return;
  }
  vec4 c = texture2D(uTex, vUV);
  if (c.a < 0.02) discard;
  vec3 rgb = c.rgb * vLight;
  if (uHighlightId >= 0.0 && abs(vId - uHighlightId) < 0.5) {
    rgb = mix(rgb, uHighlight, 0.28);
  }
  /* The pixel under the cursor gets a ring drawn inside its own edges, so you
     can see exactly which texel a click will land on. A texel that appears on
     more than one face — mirrored legs share theirs — lights up on all of
     them, which is the truth: painting it changes every one. */
  if (uHoverTexel.x >= 0.0 &&
      abs(texel.x - uHoverTexel.x) < 0.5 && abs(texel.y - uHoverTexel.y) < 0.5) {
    vec2 f = fract(tp);
    float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    rgb = edge < 0.16 ? mix(vec3(1.0), rgb, 0.12) : mix(rgb, vec3(1.0), 0.22);
  }
  gl_FragColor = vec4(rgb, c.a);
}`;

/* ---- tiny matrix helpers ------------------------------------------------- */
const perspective = (fov, aspect, near, far) => {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
};

function lookAt(eye, target, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = v => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
          -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

function rotateXY(pos, pitch, yaw) {
  const [x, y, z] = pos;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

/**
 * Build the vertex buffers for a model.
 * Part rotations are baked in here: nothing animates, so there is no reason to
 * pay for a matrix per part every frame.
 */
function buildMesh(model) {
  const pos = [], uv = [], light = [], ids = [];
  const parts = [];
  const flat = flattenModel(model);
  let id = 0;

  for (const item of flat) {
    const start = pos.length / 3;
    const quads = cubeQuads(item.cube, item.inflate);
    const [rx, ry, rz] = item.rotation;
    const rotate = p => {
      let [x, y, z] = p;
      if (rx) { const c = Math.cos(rx), s = Math.sin(rx); [y, z] = [y * c - z * s, y * s + z * c]; }
      if (ry) { const c = Math.cos(ry), s = Math.sin(ry); [x, z] = [x * c + z * s, -x * s + z * c]; }
      if (rz) { const c = Math.cos(rz), s = Math.sin(rz); [x, y] = [x * c - y * s, x * s + y * c]; }
      return [x + item.offset[0], y + item.offset[1], z + item.offset[2]];
    };
    for (const q of quads) {
      const p = q.pos.map(rotate);
      // two triangles per quad
      for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
        for (const i of [a, b, c]) {
          pos.push(p[i][0], p[i][1], p[i][2]);
          uv.push(q.uvs[i][0], q.uvs[i][1]);
          light.push(q.light);
          ids.push(id);
        }
      }
    }
    parts.push({ id, part: item.part, cube: item.cube, start, count: pos.length / 3 - start });
    id++;
  }
  return { pos, uv, light, ids, parts };
}

function bounds(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  }
  return { lo, hi };
}

export function createViewer(canvas, { model, background = [0, 0, 0, 0], keepBuffer = false } = {}) {
  /* `keepBuffer` is for off-screen use — drawImage()ing the canvas into a 2D
     context needs the drawing buffer to survive past the draw call. */
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, preserveDrawingBuffer: keepBuffer });
  if (!gl) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const loc = n => gl.getAttribLocation(prog, n);
  const uni = n => gl.getUniformLocation(prog, n);
  const A = { pos: loc('aPos'), uv: loc('aUV'), light: loc('aLight'), id: loc('aId') };
  const U = {
    proj: uni('uProj'), view: uni('uView'), tex: uni('uTex'), texSize: uni('uTexSize'),
    pick: uni('uPickMode'), highlight: uni('uHighlight'), highlightId: uni('uHighlightId'),
    hover: uni('uHoverTexel'), docSize: uni('uDocSize'),
  };

  const buffers = { pos: gl.createBuffer(), uv: gl.createBuffer(), light: gl.createBuffer(), id: gl.createBuffer() };
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  /* Offscreen target for the picking pass. */
  const fb = gl.createFramebuffer();
  const pickTex = gl.createTexture();
  const pickDepth = gl.createRenderbuffer();
  let pickSize = [0, 0];

  const FOV = 0.72;
  /* Model space has -Z as the mob's front, so this yaw puts the face toward
     the camera at a three-quarter angle rather than showing you its tail. */
  const HOME = { yaw: Math.PI - 0.6, pitch: -0.24 };
  const state = {
    yaw: HOME.yaw, pitch: HOME.pitch, zoom: 1, distance: 1, target: [0, 0, 0],
    texSize: model.texture.slice(), docSize: model.texture.slice(),
    count: 0, parts: [], highlightId: -1,
    highlightColor: [0.44, 0.34, 0.88],
    hoverTexel: null,
    hidden: new Set(),        // part names the user has toggled off
  };

  function upload(m) {
    const mesh = buildMesh(m);
    const put = (buf, arr, size, attr) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attr);
      gl.vertexAttribPointer(attr, size, gl.FLOAT, false, 0, 0);
    };
    put(buffers.pos, mesh.pos, 3, A.pos);
    put(buffers.uv, mesh.uv, 2, A.uv);
    put(buffers.light, mesh.light, 1, A.light);
    put(buffers.id, mesh.ids, 1, A.id);
    state.count = mesh.pos.length / 3;
    state.parts = mesh.parts;
    /* texSize is the model's own sheet, which is what the UVs are measured in.
       docSize belongs to setTexture — swapping the mesh does not change what
       resolution the artwork is painted at. */
    state.texSize = m.texture.slice();

    const b = bounds(mesh.pos);
    state.target = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
    /* The true circumradius of the vertices, not of the bounding box: a boxy
       model rarely reaches its own box corners, and the difference is the gap
       between a model that fills the pane and one that floats in it. Because
       this is a real bound, no orbit angle can push geometry off-screen. */
    let r2 = 1;
    for (let i = 0; i < mesh.pos.length; i += 3) {
      const dx = mesh.pos[i] - state.target[0];
      const dy = mesh.pos[i + 1] - state.target[1];
      const dz = mesh.pos[i + 2] - state.target[2];
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    state.radius = Math.sqrt(r2);
  }
  upload(model);

  function setTexture(source) {
    if (source && source.width && source.height) state.docSize = [source.width, source.height];
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (source instanceof ImageData) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0,
                    gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(source.data.buffer));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return [w, h];
  }

  /**
   * Distance at which the model's bounding sphere just fits. A tall narrow
   * pane is limited by its width, not its height, so both are checked —
   * otherwise the model is cropped whenever the pane is not landscape.
   */
  function fitDistance(w, h) {
    const aspect = w / h;
    const halfV = FOV / 2;
    const halfH = Math.atan(aspect * Math.tan(halfV));
    return state.radius / Math.sin(Math.max(0.05, Math.min(halfV, halfH))) * 1.02;
  }

  function camera(w, h) {
    state.distance = fitDistance(w, h) * state.zoom;
    const eye = rotateXY([0, 0, state.distance], state.pitch, state.yaw);
    // Model space has Y growing downward, so the camera's up vector is -Y.
    return {
      proj: perspective(FOV, w / h, 0.1, 4000),
      view: lookAt([eye[0] + state.target[0], eye[1] + state.target[1], eye[2] + state.target[2]],
                   state.target, [0, -1, 0]),
    };
  }

  function draw(pickMode = false, fixed = null) {
    const [w, h] = fixed || resize();
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(...(pickMode ? [0, 0, 0, 0] : background));
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { proj, view } = camera(w, h);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(U.proj, false, new Float32Array(proj));
    gl.uniformMatrix4fv(U.view, false, new Float32Array(view));
    gl.uniform2f(U.texSize, state.texSize[0], state.texSize[1]);
    gl.uniform2f(U.docSize, state.docSize[0], state.docSize[1]);
    gl.uniform1f(U.pick, pickMode ? 1 : 0);
    gl.uniform3fv(U.highlight, new Float32Array(state.highlightColor));
    gl.uniform1f(U.highlightId, pickMode ? -1 : state.highlightId);
    const hov = pickMode ? null : state.hoverTexel;
    gl.uniform2f(U.hover, hov ? hov.x : -1, hov ? hov.y : -1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(U.tex, 0);
    if (!state.hidden.size) {
      gl.drawArrays(gl.TRIANGLES, 0, state.count);
    } else {
      /* Hidden parts are skipped in both passes, so a part you have turned off
         is also out of the way of the picker — which is the whole point of
         turning it off. Runs merge first: a dozen draw calls become two or
         three for the usual case of hiding one limb. */
      let run = null;
      for (const p of state.parts) {
        if (state.hidden.has(p.part)) { if (run) { gl.drawArrays(gl.TRIANGLES, run[0], run[1]); run = null; } continue; }
        if (run && run[0] + run[1] === p.start) run[1] += p.count;
        else { if (run) gl.drawArrays(gl.TRIANGLES, run[0], run[1]); run = [p.start, p.count]; }
      }
      if (run) gl.drawArrays(gl.TRIANGLES, run[0], run[1]);
    }
  }

  /** Client coords → the texture pixel under the cursor, or null. */
  function pickTexel(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round((clientX - r.left) * dpr);
    const py = Math.round((r.bottom - clientY) * dpr);   // GL origin is bottom-left
    const [w, h] = [canvas.width, canvas.height];
    if (px < 0 || py < 0 || px >= w || py >= h) return null;

    if (pickSize[0] !== w || pickSize[1] !== h) {
      gl.bindTexture(gl.TEXTURE_2D, pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      pickSize = [w, h];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
    let hit = null;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      draw(true);
      const out = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      if (out[3] > 128) {
        hit = { x: out[0] + (out[2] >> 4) * 256, y: out[1] + (out[2] & 15) * 256 };
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return hit;
  }

  return {
    gl,
    draw: () => draw(false),
    /**
     * Draw once at an explicit pixel size. The canvas may be detached, so the
     * usual clientWidth-based sizing has nothing to measure — thumbnails come
     * through here. Needs `keepBuffer` if the result is to be drawImage()d.
     */
    renderAt(w, h) {
      canvas.width = Math.max(1, w | 0);
      canvas.height = Math.max(1, h | 0);
      draw(false, [canvas.width, canvas.height]);
      return canvas;
    },
    setTexture,
    setModel: m => upload(m),
    pickTexel,
    get state() { return state; },
    orbit(dx, dy) {
      state.yaw += dx;
      state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch + dy));
    },
    zoom(f) { state.zoom = Math.max(0.25, Math.min(3, state.zoom * f)); },
    reset() { state.yaw = HOME.yaw; state.pitch = HOME.pitch; state.zoom = 1; },
    setView({ yaw, pitch, zoom } = {}) {
      if (yaw != null) state.yaw = yaw;
      if (pitch != null) state.pitch = pitch;
      if (zoom != null) state.zoom = zoom;
    },
    highlight(partName) {
      const p = state.parts.find(p => p.part === partName);
      state.highlightId = p ? p.id : -1;
    },
    /** The texel to ring, or null. Returns true when it changed. */
    hoverTexel(t) {
      const a = state.hoverTexel;
      if (a === t || (a && t && a.x === t.x && a.y === t.y)) return false;
      state.hoverTexel = t ? { x: t.x, y: t.y } : null;
      return true;
    },
    /** Every part name in the mesh, in draw order and without repeats. */
    partNames() {
      const seen = new Set();
      return state.parts.map(p => p.part).filter(n => !seen.has(n) && seen.add(n));
    },
    setHidden(names) { state.hidden = new Set(names || []); },
    dispose() {
      for (const b of Object.values(buffers)) gl.deleteBuffer(b);
      gl.deleteTexture(texture); gl.deleteTexture(pickTex);
      gl.deleteRenderbuffer(pickDepth); gl.deleteFramebuffer(fb);
      gl.deleteProgram(prog);
    },
  };
}
