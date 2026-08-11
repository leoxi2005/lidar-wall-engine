// Touch fields — the two things almost every "swipe on a wall" visual needs, provided by
// the engine so no visual has to build them again.
//
//   wave   a real 2D wave equation. Ripples travel, reflect off floor and ceiling, run
//          right round a closed room, and interfere with each other. Simulating rather
//          than drawing analytic rings is what makes two people's waves add up on their
//          own, and lets a wave outlive the hand that made it.
//   trail  a slowly-decaying deposit along every hand's path, with that hand's colour.
//
// A visual asks for what it wants (ctx.fields) and reads them as textures. Anything that
// deposits goes through here too, so it all lands on the same decay and the same grid.
//
// NO BACKTICKS IN THE GLSL BELOW — it lives inside JS template literals, and one stray
// backtick in a comment closes the string and kills the app at load with a syntax error
// pointing at the comment rather than the shader.

import { Program, createFBO, createDoubleFBO } from './gl.js';

const MAX_STAMPS = 16;   // must match MAXPTS in the trail shader

const VERT = /* glsl */`#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
uniform vec2 uTexel;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 fragColor;
`;

// u_next = 2u - u_prev + k·∇²u, damped. R holds u, G holds the previous u, so one texture
// carries both time levels and the whole simulation is a single ping-pong.
//
// k is the Courant number squared: above ~0.5 this explodes. Ripple SPEED therefore comes
// from running more sub-steps per frame, never from raising k.
const WAVE_STEP = HEAD + /* glsl */`
uniform sampler2D uWave;
uniform float uK;
uniform float uDamp;
void main() {
  vec2 c = texture(uWave, vUv).rg;
  float lap = texture(uWave, vL).r + texture(uWave, vR).r
            + texture(uWave, vT).r + texture(uWave, vB).r - 4.0 * c.r;
  fragColor = vec4((2.0 * c.r - c.g + uK * lap) * uDamp, c.r, 0.0, 1.0);
}`;

// A drop displaces the surface at BOTH time levels: equal u and u_prev means zero initial
// velocity, which is what makes the ring expand symmetrically. Adding to u alone launches
// it lopsided.
const WAVE_SPLAT = HEAD + /* glsl */`
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec2 uPoint;
uniform float uRadius;
uniform float uAmp;
void main() {
  vec2 p = vUv - uPoint;
  p.x -= round(p.x);
  p.x *= uAspect;
  float g = exp(-dot(p, p) / uRadius) * uAmp;
  vec2 c = texture(uTarget, vUv).rg;
  fragColor = vec4(c.r + g, c.g + g, 0.0, 1.0);
}`;

const TRAIL_SPLAT = HEAD + /* glsl */`
#define MAXPTS 16
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec4 uPts[MAXPTS];      // xy = centre, z = amount, w = radius squared
uniform vec3 uCols[MAXPTS];
uniform int uCount;
uniform float uCap;
void main() {
  vec4 prev = texture(uTarget, vUv);
  vec3 col = prev.rgb;
  float a = prev.a;
  // Up to 16 stamps per pass. Every pass is a full-screen draw over the trail target, and
  // a stroke lays down a dozen stamps per frame while growth effects can want dozens more
  // — one pass each is unaffordable at full resolution.
  for (int i = 0; i < MAXPTS; i++) {
    if (i >= uCount) break;
    vec2 p = vUv - uPts[i].xy;
    p.x -= round(p.x);
    p.x *= uAspect;
    float g = exp(-dot(p, p) / uPts[i].w) * uPts[i].z;
    // A carries HEIGHT, RGB carries a pure colour. Clamping colour per channel — the
    // obvious version — bleaches every trail towards white as the strong channels hit the
    // cap first, so height is capped and the colour is blended by how much of the total
    // deposit is new.
    float newA = min(a + g, uCap);
    col = mix(col, uCols[i], clamp(g / max(newA, 1e-4), 0.0, 1.0));
    a = newA;
  }
  fragColor = vec4(col, a);
}`;

const DECAY = HEAD + /* glsl */`
uniform sampler2D uTexture;
uniform float uDecay;
void main() { fragColor = texture(uTexture, vUv) * uDecay; }`;

export class Fields {
  constructor(gl, blit, room, cfg = {}) {
    this.gl = gl; this.blit = blit; this.room = room;
    this.aspect = room.aspect;

    this.cfg = {
      simHeight: 320,
      substeps: 3,
      k: 0.42,
      damping: 0.9993,
      impulseRadius: 0.030,
      trailRadius: 0.045,
      trailHold: 3.0,
      trailCap: 1.0,
      ...cfg
    };

    this.pWaveStep = new Program(gl, VERT, WAVE_STEP);
    this.pWaveSplat = new Program(gl, VERT, WAVE_SPLAT);
    this.pTrailSplat = new Program(gl, VERT, TRAIL_SPLAT);
    this.pDecay = new Program(gl, VERT, DECAY);

    this.qPts = new Float32Array(MAX_STAMPS * 4);
    this.qCols = new Float32Array(MAX_STAMPS * 3);
    this.queued = 0;
    this.time = 0;
    this.resize(1);
  }

  // Called by the engine when quality changes: the grids shrink, the visual keeps working.
  resize(scale) {
    const gl = this.gl;
    const h = Math.max(64, Math.round(this.cfg.simHeight * scale));
    if (h === this.simH) return;
    this.simH = h;
    this.simW = Math.round(h * this.aspect);
    const wrapS = this.room.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    this.wave = createDoubleFBO(gl, this.simW, this.simH, { wrapS });
    // Full sim resolution, not a fraction: a coastline or any hard threshold cut from the
    // trail turns texel structure into visible stair-steps along the edge of whatever a
    // hand just drew.
    this.trail = createDoubleFBO(gl, this.simW, this.simH, { wrapS });
  }

  get texelX() { return 1 / this.simW; }
  get texelY() { return 1 / this.simH; }

  // A drop on the surface. x, y in panorama uv (y: 0 = floor).
  impulse(x, y, amp, radiusMul = 1) {
    const r = this.cfg.impulseRadius * radiusMul;
    this.pWaveSplat.use()
      .v2('uTexel', this.texelX, this.texelY)
      .tex('uTarget', this.wave.read, 0)
      .f('uAspect', this.aspect)
      .v2('uPoint', x, y)
      .f('uRadius', r * r)
      .f('uAmp', amp);
    this.blit(this.wave.write);
    this.wave.swap();
  }

  // Queued; flushed 16 at a time, and always before the decay pass.
  deposit(x, y, color, amount, radiusMul = 1) {
    if (!(amount > 0)) return;
    const r = this.cfg.trailRadius * radiusMul;
    const i = this.queued;
    this.qPts[i * 4] = x; this.qPts[i * 4 + 1] = y;
    this.qPts[i * 4 + 2] = amount; this.qPts[i * 4 + 3] = r * r;
    this.qCols[i * 3] = color[0]; this.qCols[i * 3 + 1] = color[1]; this.qCols[i * 3 + 2] = color[2];
    if (++this.queued === MAX_STAMPS) this.flush();
  }

  flush() {
    if (!this.queued) return;
    this.pTrailSplat.use()
      .v2('uTexel', this.texelX, this.texelY)
      .tex('uTarget', this.trail.read, 0)
      .f('uAspect', this.aspect)
      .f('uCap', this.cfg.trailCap)
      .i('uCount', this.queued)
      .v4v('uPts', this.qPts)
      .v3v('uCols', this.qCols);
    this.blit(this.trail.write);
    this.trail.swap();
    this.queued = 0;
  }

  // Lay material along a segment, proportional to DISTANCE.
  //
  // This one signature encodes a bug that cost a site visit: deposit by TIME and a hand
  // that lingers builds a mountain while a hand that sweeps past leaves nothing, because
  // it spends almost no time anywhere. And stamping only at the head leaves a dotted line,
  // because at 30 Hz a hand at 2 m/s jumps further than the stamp radius.
  stroke(fromX, fromY, toX, toY, color, inkPerStep, maxStamps = 14) {
    const dx = this.room.dx(toX, fromX);
    const dy = toY - fromY;
    const dist = Math.hypot(dx * this.aspect, dy);
    const step = this.cfg.trailRadius * 0.5;
    const n = Math.min(maxStamps, Math.max(1, Math.ceil(dist / step)));
    const per = inkPerStep * (dist / step) / n;
    if (!(per > 1e-4)) return dist;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      this.deposit((fromX + dx * f + 1) % 1, fromY + dy * f, color, per, 1);
    }
    return dist;
  }

  step(dt, substepsOverride) {
    // Anything queued this frame must land BEFORE the decay pass, or it is written onto an
    // already-decayed buffer and lost on the swap.
    this.flush();
    this.time += dt;
    const c = this.cfg;
    const steps = substepsOverride ?? c.substeps;
    for (let i = 0; i < steps; i++) {
      this.pWaveStep.use()
        .v2('uTexel', this.texelX, this.texelY)
        .tex('uWave', this.wave.read, 0)
        .f('uK', Math.min(0.48, c.k))
        .f('uDamp', c.damping);
      this.blit(this.wave.write);
      this.wave.swap();
    }
    this.pDecay.use()
      .v2('uTexel', this.texelX, this.texelY)
      .tex('uTexture', this.trail.read, 0)
      .f('uDecay', Math.exp(-dt / Math.max(0.1, c.trailHold)));
    this.blit(this.trail.write);
    this.trail.swap();
  }

  clear() {
    const gl = this.gl;
    for (const t of [this.wave.read, this.wave.write, this.trail.read, this.trail.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
