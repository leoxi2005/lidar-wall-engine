// The visual contract — the only file someone writing a new piece has to read.
//
// A visual is a plain object. Everything is optional except `render`:
//
//   {
//     name: 'waves',
//     fields: { wave: true, trail: true },   // ask the engine for the touch fields
//     defaults: { ... },                     // merged under room config's `params`
//     async init(ctx) {},                    // build programs, textures, particles
//     hand(h, dt, ctx) {},                   // per hand, per frame — h.fresh on first contact
//     update(dt, hands, ctx) {},             // everything else
//     render(ctx) {},                        // draw to the default framebuffer
//     quality(q, ctx) {},                    // q.post / q.sim / q.render, 0..1
//     key(k, ctx) {}                         // optional extra keyboard shortcuts
//   }
//
// ctx carries:
//   gl, blit, room, fields, params, time, dt, width, height, aspect,
//   colorFor(id)  — stable colour per person, so two hands never silently share one
//   quality       — the live quality object
//
// COORDINATES, ONCE, FOR EVERYTHING:
//   x is panorama uv: 0..1 across ALL walls, and it WRAPS in a closed room.
//   y is 0 at the floor, 1 at the ceiling.
//   Distances are in WALL HEIGHTS — the only unit where a circle drawn on the wall is
//   round. Multiply an x delta by room.aspect to get there, and use room.dx() so the
//   short way round a closed room is taken.

import { Program } from './gl.js';

const SHADER_VERT = /* glsl */`#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const SHADER_HEAD = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform float uAspect;      // panorama width / height
uniform vec2  uTexel;       // one output pixel
uniform vec2  uSimTexel;    // one field texel
uniform sampler2D uWave;    // R = surface height (if fields.wave)
uniform sampler2D uTrail;   // RGB = colour, A = deposited height (if fields.trail)
uniform vec4  uHands[8];    // xy = position, z = speed (wall-heights/s), w = 1 if live
uniform vec3  uHandCols[8];
uniform int   uHandCount;

// Shortest x distance in a room that wraps.
float wrapDX(float dx) { return dx - floor(dx + 0.5); }

// Four taps on the diagonals of one field texel. The fields run at a fraction of the
// output size and a plain bilinear read leaves C0 kinks — which anything taking a
// derivative (relief shading, contour extraction) turns into visible faceting.
vec4 fieldSmooth(sampler2D s, vec2 uv) {
  vec2 h = uSimTexel * 0.9;
  return 0.25 * (texture(s, uv + vec2( h.x,  h.y)) + texture(s, uv + vec2(-h.x,  h.y))
               + texture(s, uv + vec2( h.x, -h.y)) + texture(s, uv + vec2(-h.x, -h.y)));
}
`;

// Shader-only visuals: one fragment shader, no JS. Enough for anything that is a function
// of the fields and the hand positions; a visual that needs its own life (creatures,
// growth, particles) writes a full module instead.
export function defineShaderVisual(spec) {
  const handBuf = new Float32Array(32);
  const colBuf = new Float32Array(24);

  return {
    name: spec.name,
    fields: spec.fields ?? { wave: true, trail: true },
    defaults: spec.defaults ?? {},

    async init(ctx) {
      this.prog = new Program(ctx.gl, SHADER_VERT, SHADER_HEAD + spec.frag);
      if (spec.init) await spec.init.call(this, ctx);
    },

    hand(h, dt, ctx) { if (spec.hand) spec.hand.call(this, h, dt, ctx); },
    update(dt, hands, ctx) {
      this.hands = hands;
      if (spec.update) spec.update.call(this, dt, hands, ctx);
    },

    render(ctx) {
      const p = this.prog.use()
        .f('uTime', ctx.time)
        .f('uAspect', ctx.aspect)
        .v2('uTexel', 1 / ctx.width, 1 / ctx.height)
        .v2('uSimTexel', ctx.fields ? ctx.fields.texelX : 1, ctx.fields ? ctx.fields.texelY : 1);
      if (ctx.fields) {
        p.tex('uWave', ctx.fields.wave.read, 0);
        p.tex('uTrail', ctx.fields.trail.read, 1);
      }
      const hands = (this.hands || []).slice(0, 8);
      handBuf.fill(0); colBuf.fill(0);
      hands.forEach((h, i) => {
        handBuf[i * 4] = h.x; handBuf[i * 4 + 1] = h.y;
        handBuf[i * 4 + 2] = Math.hypot(h.vx * ctx.aspect, h.vy);
        handBuf[i * 4 + 3] = 1;
        const c = ctx.colorFor(h.id);
        colBuf[i * 3] = c[0]; colBuf[i * 3 + 1] = c[1]; colBuf[i * 3 + 2] = c[2];
      });
      p.v4v('uHands', handBuf).v3v('uHandCols', colBuf).i('uHandCount', hands.length);
      if (spec.uniforms) spec.uniforms.call(this, p, ctx);
      ctx.blit(null);
    },

    quality(q, ctx) { if (spec.quality) spec.quality.call(this, q, ctx); },
    key(k, ctx) { if (spec.key) spec.key.call(this, k, ctx); }
  };
}

// One colour per person. Deterministic from the id, so a hand keeps its colour for a whole
// stroke and two people never silently share one.
export const PALETTE = [
  [0.24, 0.86, 0.95],
  [0.45, 0.42, 1.00],
  [0.95, 0.35, 0.72],
  [1.00, 0.72, 0.32],
  [0.36, 0.68, 1.00],
  [0.34, 0.95, 0.68]
];

export function colorFor(id, palette = PALETTE) {
  return palette[Math.abs(Math.imul(id | 0, 2654435761)) % palette.length];
}
