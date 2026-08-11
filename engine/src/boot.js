// Engine entry point: build the room, wire the plumbing, load the visual, run the loop.
//
// Everything a room-specific piece needs is decided by data (rooms/<name>.json) and one
// visual module. Nothing in here knows about any particular installation.

import { createGL, makeBlitter } from './gl.js';
import { Room } from './room.js';
import { Touch } from './touch.js';
import { Fields } from './fields.js';
import { Calibrator } from './calib.js';
import { NdiOut } from './ndi.js';
import { Perf } from './perf.js';
import { colorFor, PALETTE } from './visual.js';
import { makeDemoHands } from './demo.js';

const cfg = await window.api.getConfig();
document.getElementById('boot')?.remove();

const room = new Room(cfg.room ?? cfg);
const out = cfg.output ?? {};
const scaleEnv = typeof process !== 'undefined' ? parseFloat(process.env?.RENDER_SCALE || '') : NaN;
const baseScale = Number.isFinite(scaleEnv) ? scaleEnv : (out.renderScale ?? 1);

const canvas = document.getElementById('gl');
const gl = createGL(canvas);
const blit = makeBlitter(gl);

let fbW = 0, fbH = 0;
function sizeFramebuffer(qRender) {
  const s = baseScale * qRender;
  // Even dimensions: NDI wants an even width per stream, and the crop maths never lands
  // on a half pixel.
  fbW = Math.max(2, Math.round(room.width * s) & ~1);
  fbH = Math.max(2, Math.round(room.height * s) & ~1);
  canvas.width = fbW; canvas.height = fbH;
  canvas.style.aspectRatio = `${room.width} / ${room.height}`;
}
sizeFramebuffer(1);

// ---------------------------------------------------------------- services

const perf = new Perf({
  floor: out.fpsFloor ?? 45,
  ceil: out.fpsCeiling ?? 60,
  auto: out.autoQuality !== false,
  onChange: (q) => {
    if (fields) fields.resize(q.sim);
    if (visual?.quality) visual.quality(q, ctx);
    if (q.renderChanged) console.warn('[perf] hạ độ phân giải render — NDI cũng nhỏ theo');
  }
});

const touch = new Touch(room, cfg.osc ?? {});
window.api.onOsc((msg) => touch.handle(msg));

const ndi = new NdiOut(gl, room, window.api.ndi, {
  fps: out.fps ?? 30,
  enabled: (cfg.ndi?.enabled ?? true) && process.env?.NDI_OFF !== '1',
  bgra: cfg.ndi?.bgra !== false,
  pbo: cfg.ndi?.pbo ?? 4
});

// Walls live under `room` in a room file, so the calibration writes there — the overlay
// merge in main.js knows to recurse into it.
const calib = new Calibrator(gl, room, {
  save: (partial) => window.api.saveConfig({ room: partial })
});
calib.on = typeof process !== 'undefined' && process.env?.CALIB === '1';

// ---------------------------------------------------------------- visual

const visualName = (typeof process !== 'undefined' && process.env?.VISUAL) || cfg.visual || 'waves';
let visual = null;
try {
  const mod = await import(`../../visuals/${visualName}/index.js`);
  visual = mod.default ?? mod.visual;
  if (!visual) throw new Error('module không export default');
} catch (err) {
  throw new Error(`không nạp được visual "${visualName}": ${err.message}`);
}

let fields = null;
if (visual.fields) fields = new Fields(gl, blit, room, { ...(cfg.fields ?? {}) });

const params = { ...(visual.defaults ?? {}), ...(cfg.params ?? {}) };
const palette = cfg.palette ?? PALETTE;

const ctx = {
  gl, blit, room, params, fields, perf,
  width: fbW, height: fbH, aspect: room.aspect,
  time: 0, dt: 0,
  colorFor: (id) => colorFor(id, palette),
  quality: perf
};

await visual.init?.(ctx);
await ndi.start(fbW, fbH);

// ---------------------------------------------------------------- input extras

const demo = makeDemoHands(room, typeof process !== 'undefined' && process.env?.DEMO === '1');

// Mouse drag = one fake hand, so a visual can be developed with no sensors at all. It goes
// through the SAME path as a real hand: what happens here is what the wall does.
let mouse = null;
canvas.addEventListener('pointerdown', (e) => {
  mouse = { id: (Math.random() * 1e6) | 0, ...uvOf(e), vx: 0, vy: 0, fresh: true, wall: 0, raw: 0, rawY: 0 };
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!mouse) return;
  const p = uvOf(e);
  mouse.vx = room.dx(p.x, mouse.x) * 60;
  mouse.vy = (p.y - mouse.y) * 60;
  mouse.x = p.x; mouse.y = p.y;
  const w = room.wallAt(p.x);
  mouse.wall = w.index; mouse.raw = (p.x - w.u0) / w.uw; mouse.rawY = p.y;
});
window.addEventListener('pointerup', () => { mouse = null; });
function uvOf(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'h') hudOn = !hudOn, hudEl.classList.toggle('off', !hudOn);
  else if (k === 'k') calib.toggle();
  else if (k === 'r' && calib.on) calib.reset();
  else if (k === 's' && calib.on) calib.applyBest();
  else if (k === 'c') fields?.clear();
  else visual.key?.(k, ctx);
});

// ---------------------------------------------------------------- HUD

const hudEl = document.getElementById('hud');
let hudOn = true;
setInterval(() => {
  if (!hudOn) return;
  hudEl.textContent =
    `${(cfg.name ?? 'ROOM').toUpperCase()} · ${visualName}   ${room.describe()}   render:${fbW}x${fbH}  ${perf.describe()}\n` +
    `NDI ${ndi.describe(fbH)}\n` +
    `OSC :${cfg.osc?.port ?? '—'}  pkts:${touch.packets}  last:${touch.lastAddress}\n` +
    `touches/wall: ${touch.countsPerWall().join(' ')}   tracked:${touch.active}\n` +
    `calib ${calib.on ? 'ON' : 'off'}  ${calib.status()}\n` +
    `        ${calib.msg}\n` +
    `[h]=hud  [k]=hiệu chỉnh  [s]=ép tính  [r]=bắt lại  [c]=xoá trường  ·  kéo chuột = chạm giả`;
}, 250);

// The only place fps and NDI drops surface on a show machine, where the app is on a
// projector nobody can read and DevTools is not open.
setInterval(async () => {
  let drops = '';
  try {
    const st = await window.api.ndi.status();
    drops = (st.senders || []).map(s => `${s.name}=${s.frames}/${s.dropped}`).join(' ');
  } catch (_) { /* NDI off */ }
  console.log(`[perf] fps:${perf.fps.toFixed(1)} q${perf.level}  render:${fbW}x${fbH}  ` +
    `touches:${touch.active}  ndi: ${drops || 'off'}${ndi.drainTimings()}`);
}, 5000);

// ---------------------------------------------------------------- loop

const maxFps = out.maxFps ?? 60;
const minFrame = 1 / maxFps - 0.0015;
let last = performance.now() / 1000, lastFrame = 0, clock = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  if (now - lastFrame < minFrame) return;
  lastFrame = now;

  // Clamped: after a stall (window drag, GC) a huge dt would push the wave solver past its
  // stability limit and detonate the field into white noise.
  const dt = Math.min(Math.max(now - last, 1 / 240), 1 / 20);
  last = now;
  clock += dt;
  ctx.time = clock; ctx.dt = dt;

  perf.frame(dt);
  ndi.collect();

  const hands = touch.update(dt);
  if (mouse) hands.push(mouse);
  demo.update(dt, clock, hands);

  for (const h of hands) {
    visual.hand?.(h, dt, ctx);
    h.fresh = false;
  }
  visual.update?.(dt, hands, ctx);
  calib.update(dt, hands);

  if (fields) fields.step(dt, Math.max(1, Math.round((fields.cfg.substeps ?? 3) * perf.sim)));
  visual.render(ctx);

  calib.build(hands, fbW);
  calib.draw();

  ndi.capture(dt);
}
frame();

console.log(`[engine] ${cfg.name ?? 'room'} · visual "${visualName}" · ${room.describe()} · render ${fbW}x${fbH}`);
