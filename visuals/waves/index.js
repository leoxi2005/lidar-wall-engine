// WAVES — the reference visual, and the one that shook out most of the engine's API.
//
// The room is one body of water seen from above, drawn as a contour map:
//   · touch      = a drop. The ring is a real wave, so several people interfere.
//   · hold still = concentric rings, and coral growing where the hand rests.
//   · swipe      = a wake, plus a deposited RIDGE that outlives the touch.
//   · a waterline turns the height field into land and sea, so a swipe visibly lifts an
//     island out of the water which then sinks again as the trail decays.
//
// The height field itself (wave + trail) belongs to the engine — this file owns the
// procedural swell, the way it is drawn, and everything alive on top of it.

import { Program, createFBO } from '../../engine/src/gl.js';
import * as S from './shaders.js';
import { Motes, Bubbles } from './motes.js';
import { Fish, Coral } from './life.js';

export default {
  name: 'waves',
  fields: { wave: true, trail: true },

  defaults: {
    // interaction
    dropAmp: 0.55, ringAmp: 0.22, ringInterval: 0.5,
    wakeAmp: 1.6, wakeMax: 0.12,
    trailInk: 0.25, trailDwell: 0.30, maxStamps: 14,
    bridgeDist: 1.3, bridgeInk: 0.55,
    // picture
    contours: 26, majorEvery: 5, baseAmp: 0.55, waveGain: 1.0, trailGain: 0.9,
    exposure: 1.25, bloomStrength: 0.50, bloomThreshold: 0.35, bloomIters: 4,
    lineCold: [0.16, 0.44, 0.78], lineHot: [0.72, 0.93, 1.00],
    lineGlow: 0.10, trailGlow: 0.08,
    relief: 0.69, ambient: 0.26, shade: 0.85, specular: 0.12,
    rampDeep: [0.002, 0.008, 0.024], rampMid: [0.022, 0.075, 0.175], rampHigh: [0.105, 0.250, 0.390],
    seaLevel: 0.0, seaDrift: 0.18, seaSpeed: 0.055,
    landColor: [0.13, 0.29, 0.35], coastGlow: 0.35, foam: 1.15,
    shoreCurrent: 0.30, shoreCurrentSpeed: 1.6, lightSpin: 0.020,
    grain: 0.010, vignette: 0.20, backgroundLevel: 0.028,
    // life
    motes: { count: 2600, size: 0.010, brightness: 0.85, drift: 0.010, damping: 1.4, reach: 0.55, pull: 0.55, swirl: 0.75, excite: 3.2 },
    bubbles: { max: 700, rate: 14, life: 3.0, rise: 0.16, wobble: 0.020, spread: 0.07, size: 0.016, brightness: 0.80 },
    fish: { count: 190, shoals: 7, size: 0.030, color: [0.62, 0.86, 1.0], brightness: 1.6, speed: 0.17, cohesion: 1.1, damping: 0.55, wander: 0.020, fearRadius: 0.85, fear: 0.55, burst: 2.2, calmSeconds: 2.5 },
    coral: { afterSeconds: 1.1, seedEvery: 0.5, stillSpeed: 0.10, maxTips: 80, tipLife: 2.2, speed: 0.10, wander: 2.6, branchChance: 1.5, ink: 0.65, thickness: 0.8 },
    idleAfter: 18, idleEvery: 4.5, idleStrength: 0.6
  },

  async init(ctx) {
    const { gl, params: P } = ctx;
    this.P = P;
    this.pContour = new Program(gl, S.baseVert, S.contourFrag);
    this.pPrefilter = new Program(gl, S.baseVert, S.bloomPrefilterFrag);
    this.pBlur = new Program(gl, S.baseVert, S.blurFrag);
    this.pComposite = new Program(gl, S.baseVert, S.compositeFrag);

    this.motes = new Motes(gl, { cfg: P.motes, aspect: ctx.aspect, height: ctx.height });
    this.bubbles = new Bubbles(gl, { cfg: P.bubbles, aspect: ctx.aspect, height: ctx.height });
    this.fish = new Fish(gl, { cfg: P.fish, aspect: ctx.aspect, height: ctx.height });
    this.coral = new Coral({ cfg: P.coral, aspect: ctx.aspect });

    this.state = new Map();          // per hand: last position, ring clock, dwell
    this.liveHands = [];
    this.idleT = 0; this.lastTouchT = 0;
    this.bloomIters = P.bloomIters;

    this._targets(ctx);
  },

  _targets(ctx) {
    const gl = ctx.gl;
    this.scene = createFBO(gl, ctx.width, ctx.height, { wrapS: ctx.room.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE });
    const bh = Math.max(16, Math.round(ctx.height / 4));
    this.bloomA = createFBO(gl, Math.round(bh * ctx.aspect), bh);
    this.bloomB = createFBO(gl, Math.round(bh * ctx.aspect), bh);
  },

  quality(q, ctx) {
    // Bloom iterations first — softening a glow is the least visible thing to lose.
    this.bloomIters = Math.max(1, Math.round(this.P.bloomIters * q.post * 1.6));
    if (q.renderChanged) this._targets(ctx);
  },

  // Everything a single hand does. `h.fresh` is true only on genuine first contact — a
  // hand the engine stitched back together after the bridge lost and re-acquired it is
  // NOT fresh, so a swipe across a corner does not splash twice.
  hand(h, dt, ctx) {
    const P = this.P, F = ctx.fields;
    const color = ctx.colorFor(h.id);
    this.liveHands.push({ x: h.x, y: h.y, color, wall: h.wall });

    let st = this.state.get(h.id);
    if (!st) { st = { x: h.x, y: h.y, ring: 0, dwell: 0 }; this.state.set(h.id, st); }

    if (h.fresh) {
      F.impulse(h.x, h.y, P.dropAmp, 1.0);
      F.deposit(h.x, h.y, color, P.trailInk, 1.2);
      st.x = h.x; st.y = h.y; st.ring = 0; st.dwell = 0;
      return;
    }

    const moved = F.stroke(st.x, st.y, h.x, h.y, color, P.trailInk, P.maxStamps);
    st.x = h.x; st.y = h.y;

    // A hand that stays put still sinks in, slowly, and only where it rests.
    F.deposit(h.x, h.y, color, P.trailDwell * dt, 1);

    // Wake is per DISTANCE, not per second: dragging across the room throws real wave, a
    // resting hand throws none, and neither depends on framerate.
    if (moved > 1e-4) F.impulse(h.x, h.y, Math.min(P.wakeAmp * moved, P.wakeMax), 0.8);

    // Rings on a rhythm while held — every frame would just be a permanent bulge.
    st.ring += dt;
    if (st.ring >= P.ringInterval) { st.ring = 0; F.impulse(h.x, h.y, P.ringAmp, 1.0); }

    // Coral rewards stopping, where the stroke rewards moving.
    const C = P.coral;
    if (moved > C.stillSpeed * dt) st.dwell = 0;
    else {
      st.dwell += dt;
      if (st.dwell >= C.afterSeconds) { st.dwell = C.afterSeconds - C.seedEvery; this.coral.seed(h.x, h.y, color); }
    }
  },

  update(dt, hands, ctx) {
    const P = this.P, F = ctx.fields;

    // Two people close together get their islands JOINED — the one moment the wall shows a
    // relationship between two visitors rather than two independent doodles.
    for (let i = 0; i < this.liveHands.length; i++) {
      for (let j = i + 1; j < this.liveHands.length; j++) {
        const a = this.liveHands[i], b = this.liveHands[j];
        const dx = ctx.room.dx(b.x, a.x), dy = b.y - a.y;
        const d = Math.hypot(dx * ctx.aspect, dy);
        if (d > P.bridgeDist || d < 1e-3) continue;
        const k = 1 - d / P.bridgeDist;
        const mix = [(a.color[0] + b.color[0]) / 2, (a.color[1] + b.color[1]) / 2, (a.color[2] + b.color[2]) / 2];
        const n = Math.min(10, Math.max(2, Math.ceil(d / (F.cfg.trailRadius * 0.7))));
        const amt = P.bridgeInk * k * k * dt / n;
        for (let s = 1; s < n; s++) F.deposit((a.x + dx * (s / n) + 1) % 1, a.y + dy * (s / n), mix, amt, 1);
      }
    }

    // An untouched surface still ripples, faintly. Every so often something drops on it —
    // enough movement across a dark room to say "this is alive, come and touch it".
    if (this.liveHands.length) { this.lastTouchT = ctx.time; this.idleT = 0; }
    else if (ctx.time - this.lastTouchT > P.idleAfter) {
      this.idleT += dt;
      if (this.idleT >= P.idleEvery) {
        this.idleT = 0;
        F.impulse(Math.random(), 0.25 + Math.random() * 0.5, P.dropAmp * P.idleStrength, 1.0);
      }
    }

    this.motes.update(dt, this.liveHands);
    this.bubbles.update(dt, this.liveHands);
    this.fish.update(dt, this.liveHands);
    this.coral.update(dt, (x, y, col, amt, rad) => F.deposit(x, y, col, amt, rad));

    // Drop state for hands that are gone, or the map grows all night.
    if (this.state.size > hands.length + 4) {
      const live = new Set(hands.map(h => h.id));
      for (const k of this.state.keys()) if (!live.has(k)) this.state.delete(k);
    }
    this.liveHands.length = 0;
  },

  render(ctx) {
    const P = this.P, F = ctx.fields, blit = ctx.blit;

    this.pContour.use()
      .v2('uTexel', 1 / ctx.width, 1 / ctx.height)
      .v2('uSimTexel', F.texelX, F.texelY)
      .tex('uWave', F.wave.read, 0)
      .tex('uTrail', F.trail.read, 1)
      .f('uTime', ctx.time).f('uAspect', ctx.aspect)
      .f('uContours', P.contours).f('uMajorEvery', P.majorEvery)
      .f('uBaseAmp', P.baseAmp).f('uWaveGain', P.waveGain).f('uTrailGain', P.trailGain)
      .v3('uCold', ...P.lineCold).v3('uHot', ...P.lineHot)
      .f('uGlow', P.lineGlow).f('uTrailGlow', P.trailGlow)
      .f('uRelief', P.relief * ctx.height)   // dFdx is per PIXEL; without this the relief
      .f('uAmbient', P.ambient)              // flattens as the render gets wider
      .f('uShade', P.shade).f('uSpec', P.specular)
      .v3('uDeep', ...P.rampDeep).v3('uMid', ...P.rampMid).v3('uHigh', ...P.rampHigh)
      .f('uSeaLevel', P.seaLevel).f('uSeaDrift', P.seaDrift).f('uSeaSpeed', P.seaSpeed)
      .v3('uLand', ...P.landColor).f('uCoast', P.coastGlow).f('uFoam', P.foam)
      .f('uCurrent', P.shoreCurrent).f('uCurrentSpeed', P.shoreCurrentSpeed)
      .f('uLightSpin', P.lightSpin);
    blit(this.scene);

    this.pPrefilter.use()
      .v2('uTexel', this.bloomA.texelX, this.bloomA.texelY)
      .tex('uTexture', this.scene, 0).f('uThreshold', P.bloomThreshold);
    blit(this.bloomA);
    for (let i = 0; i < this.bloomIters; i++) {
      const rad = 1 + i * 1.5;
      this.pBlur.use().v2('uTexel', this.bloomA.texelX, this.bloomA.texelY)
        .tex('uTexture', this.bloomA, 0).v2('uDir', this.bloomA.texelX * rad, 0);
      blit(this.bloomB);
      this.pBlur.use().tex('uTexture', this.bloomB, 0).v2('uDir', 0, this.bloomA.texelY * rad);
      blit(this.bloomA);
    }

    this.pComposite.use()
      .v2('uTexel', 1 / ctx.width, 1 / ctx.height)
      .tex('uScene', this.scene, 0).tex('uBloom', this.bloomA, 1)
      .f('uTime', ctx.time).f('uExposure', P.exposure)
      .f('uBloomStrength', P.bloomStrength).f('uGrain', P.grain)
      .f('uVignette', P.vignette).f('uBg', P.backgroundLevel);
    blit(null);

    // Additive, on top of the graded image — and therefore inside what NDI reads back.
    this.motes.draw();
    this.fish.draw();
    this.bubbles.draw();
  },

  key(k, ctx) {
    if (k === 'b') ctx.fields.impulse(Math.random(), 0.3 + Math.random() * 0.4, this.P.dropAmp, 1.0);
  }
};
