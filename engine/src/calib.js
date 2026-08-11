// Touch calibration — the step that decides whether the installation feels precise or
// "nearly right and very annoying".
//
// WHY IT IS NEEDED AT ALL. The bridge's continuous u,v comes from its warp quad, and the
// left/right edges of that quad are guessed: the laser fan overshoots the room's corners,
// so the baseline never sees where a wall actually ends. Zone triggering (the older way of
// using the bridge) tests world metres and never touches u,v, so the error can sit there
// invisibly for as long as nobody builds anything positional.
//
// WHY FOUR POINTS AND NOT TWO. A quad is a PERSPECTIVE map, so its error mixes the axes:
// the horizontal error depends on how high the hand is. Fitting scale+offset on x alone
// cannot remove that — calibrate at one height and it returns at another. Measured on
// site: 3-4 cm left after a 1D fit. Four points at the corners of a rectangle fit a 2D
// affine (6 numbers) and take it out.
//
// WHY HOLD-TO-CAPTURE AND NOT A KEYPRESS. The hand is on a wall; the keyboard is across
// the room. A one-person calibration has to be doable with hands only.
//
// NO BACKTICKS IN THE GLSL BELOW.

import { Program } from './gl.js';

// The four points every wall is fitted from. Corners of a generous rectangle: 30% and 70%
// of a 2.4 m wall is 72 cm and 168 cm, both easy to reach, and far enough apart that the
// fit can separate horizontal error from the part that depends on height.
export const MARKS = [
  { fx: 0.25, fy: 0.30, col: [0.10, 1.00, 0.30] },
  { fx: 0.75, fy: 0.30, col: [1.00, 0.45, 0.02] },
  { fx: 0.25, fy: 0.70, col: [0.30, 0.60, 1.00] },
  { fx: 0.75, fy: 0.70, col: [1.00, 0.20, 0.60] }
];

const VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  layout(location=1) in vec3 aTint;
  out vec3 vTint;
  void main() { vTint = aTint; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;
const FS = `#version 300 es
  precision highp float;
  in vec3 vTint; out vec4 o;
  void main() { o = vec4(vTint, 1.0); }`;
// Marks are drawn additively, so over a bright scene a green mark reads as yellow and an
// orange one as pink — useless when the instruction is "stand on the GREEN one". Dimming
// the scene first is what makes the marks the only thing in the room and their colours true.
const DIM_VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
const DIM_FS = `#version 300 es
  precision highp float;
  uniform float uAlpha; out vec4 o;
  void main() { o = vec4(0.0, 0.0, 0.0, uAlpha); }`;

const FLOATS = 5;   // x, y, r, g, b

export class Calibrator {
  constructor(gl, room, opts = {}) {
    this.gl = gl;
    this.room = room;
    this.on = false;
    this.save = opts.save || (async () => ({ ok: false, error: 'no save hook' }));
    this.msg = 'chưa hiệu chỉnh';

    this.hold = opts.hold ?? 1.2;         // seconds inside a mark before it is taken
    this.near = opts.near ?? 0.15;        // radius that counts, in wall-heights (~36 cm)
    this.decay = opts.decay ?? 2.5;       // how fast progress drains once the hand leaves
    this.dimAlpha = opts.dimAlpha ?? 0.82;

    // Captured marks PER WALL, and hold progress keyed by MARK ("wall:mark") — not by
    // track id. Both were single-session/track-keyed once, and both failed the same way on
    // site: a hand re-acquired by the bridge restarted its timer, and anybody touching a
    // different wall wiped the session. In a room with five people that is the normal
    // condition, and from the floor it just looks like holding does nothing.
    this.captures = new Map();
    this.holds = new Map();
    this.flash = 0;

    const sh = (t, src) => {
      const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error('calib: ' + gl.getShaderInfoLog(x));
      return x;
    };
    const link = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('calib link: ' + gl.getProgramInfoLog(p));
      return p;
    };
    this.prog = link(VS, FS);
    this.dimProg = link(DIM_VS, DIM_FS);

    this.cap = 4096;
    this.data = new Float32Array(this.cap * FLOATS);
    this.count = 0;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    // Offset 8, not 12. Copying a particle layer's offsets (which carry a size float
    // between position and tint) makes every colour read one slot late: green marks come
    // out yellow, and it looks like a blending problem rather than a layout one.
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, FLOATS * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, FLOATS * 4, 8);
    gl.bindVertexArray(null);

    this.dimVao = gl.createVertexArray();
    gl.bindVertexArray(this.dimVao);
    const dv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, dv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  toggle() {
    this.on = !this.on;
    this.msg = this.on
      ? 'ĐANG HIỆU CHỈNH — đặt tay lên từng dấu chữ thập, giữ ~1.2 giây'
      : 'chưa hiệu chỉnh';
    return this.on;
  }

  reset() { this.captures.clear(); this.holds.clear(); this.msg = 'đã xoá các dấu đang bắt'; }

  _taken(wall) {
    let a = this.captures.get(wall);
    if (!a) { a = new Array(MARKS.length).fill(null); this.captures.set(wall, a); }
    return a;
  }

  update(dt, hands) {
    this.flash = Math.max(0, this.flash - dt);
    if (!this.on) return;

    const touched = new Set();
    for (const h of hands) {
      const w = this.room.walls[h.wall];
      if (!w) continue;
      const fx = (h.x - w.u0) / w.uw;
      let best = -1, bestD = this.near;
      for (let i = 0; i < MARKS.length; i++) {
        // Both axes in wall-heights, so "near" means the same physical distance sideways
        // as it does vertically.
        const d = Math.hypot((fx - MARKS[i].fx) * w.widthWH, h.y - MARKS[i].fy);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) continue;

      const key = `${h.wall}:${best}`;
      touched.add(key);
      let st = this.holds.get(key);
      if (!st) { st = { held: 0, sx: 0, sy: 0, n: 0, done: false }; this.holds.set(key, st); }
      if (st.done) continue;

      st.held = Math.min(this.hold, st.held + dt);
      st.sx += h.raw; st.sy += h.rawY; st.n++;
      if (st.held < this.hold) continue;

      st.done = true;
      const taken = this._taken(h.wall);
      // Averaged over the whole hold, not sampled once: on a 5.6 m wall a thousandth of
      // the width is half a centimetre, so one instantaneous reading carries the sensor's
      // jitter straight into the fit.
      taken[best] = { raw: st.sx / st.n, rawY: st.sy / st.n };
      this.flash = 1.0;
      const done = taken.filter(Boolean).length;
      this.msg = `tường ${h.wall + 1}: đã bắt ${done}/${MARKS.length} dấu`;
      if (done === MARKS.length) this.apply(h.wall);
    }

    for (const [key, st] of this.holds) {
      if (touched.has(key) || st.done) continue;
      st.held -= dt * this.decay;
      if (st.held <= 0) this.holds.delete(key);
    }
  }

  // Least squares through 3x3 normal equations, per axis.
  static _solve3(M, rhs) {
    const a = [M[0].slice(), M[1].slice(), M[2].slice()];
    const b = rhs.slice();
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-12) return null;
      if (piv !== c) { const t = a[piv]; a[piv] = a[c]; a[c] = t; const tb = b[piv]; b[piv] = b[c]; b[c] = tb; }
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 3; k++) a[r][k] -= f * a[c][k];
        b[r] -= f * b[c];
      }
    }
    return [b[0] / a[0][0], b[1] / a[1][1], b[2] / a[2][2]];
  }

  apply(wallIdx) {
    if (wallIdx == null || wallIdx < 0) { this.msg = 'chưa có tường nào đang bắt dấu'; return; }
    const taken = this._taken(wallIdx);
    const pts = [];
    for (let i = 0; i < MARKS.length; i++) {
      if (taken[i]) pts.push({ ...taken[i], tx: MARKS[i].fx, ty: MARKS[i].fy });
    }
    if (pts.length < 3) { this.msg = `tường ${wallIdx + 1}: cần ít nhất 3 dấu (đang có ${pts.length})`; return; }

    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const rx = [0, 0, 0], ry = [0, 0, 0];
    for (const p of pts) {
      const v = [1, p.raw, p.rawY];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += v[i] * v[j];
        rx[i] += v[i] * p.tx;
        ry[i] += v[i] * p.ty;
      }
    }
    const ax = Calibrator._solve3(M, rx), ay = Calibrator._solve3(M, ry);
    if (!ax || !ay) { this.msg = 'các dấu quá gần nhau — đứng đúng 4 dấu chữ thập'; return; }

    const wall = this.room.walls[wallIdx];
    wall.uAffine = [ax[0], ax[1], ax[2], ay[0], ay[1], ay[2]];
    console.log(`[calib] wall ${wallIdx + 1} uAffine=[${wall.uAffine.map(v => v.toFixed(5)).join(', ')}]`);

    this.save({ walls: this.room.walls.map(w => ({ uAffine: w.uAffine ?? null })) }).then((r) => {
      this.msg = r?.ok
        ? `✅ tường ${wallIdx + 1}: hiệu chỉnh 2 chiều (${pts.length} dấu) — ĐÃ LƯU`
        : `áp dụng rồi nhưng LƯU HỎNG: ${r?.error}`;
    });

    this.flash = 2.0;
    this.captures.delete(wallIdx);
    for (const k of [...this.holds.keys()]) if (k.startsWith(`${wallIdx}:`)) this.holds.delete(k);
  }

  applyBest() {
    let bw = -1, bn = 0;
    for (const [w, t] of this.captures) { const n = t.filter(Boolean).length; if (n > bn) { bn = n; bw = w; } }
    this.apply(bw);
  }

  status() {
    return this.room.walls.map((w, i) => {
      const t = this.captures.get(i);
      const n = t ? t.filter(Boolean).length : 0;
      const state = w.uAffine ? '2D✓' : (w.uScale !== 1 || w.uOffset !== 0 ? '1D' : '—');
      return `W${i + 1}:${state}${n ? `(${n}/4)` : ''}`;
    }).join(' ');
  }

  // ------------------------------------------------------------------ drawing

  _line(x0, y0, x1, y1, r, g, b) {
    if (this.count + 2 > this.cap) return;
    const d = this.data;
    let o = this.count * FLOATS;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = r; d[o + 3] = g; d[o + 4] = b;
    o += FLOATS;
    d[o] = x1; d[o + 1] = y1; d[o + 2] = r; d[o + 3] = g; d[o + 4] = b;
    this.count += 2;
  }
  _vbar(x, y0, y1, r, g, b, wUv) {
    for (let i = 0; i < 5; i++) {
      const xx = ((x + (i - 2) * wUv / 5) + 1) % 1;
      this._line(xx, y0, xx, y1, r, g, b);
    }
  }
  _hbar(x0, x1, y, r, g, b, tUv) {
    for (let i = 0; i < 5; i++) {
      const yy = y + (i - 2) * tUv / 5;
      this._line((x0 + 1) % 1, yy, (x1 + 1) % 1, yy, r, g, b);
    }
  }
  // A cross marks a POINT, which is what a 2D fit needs. Two vertical lines could only
  // ever pin down horizontal error — and standing high or low on them changes nothing,
  // which is exactly the information the fit is missing.
  _cross(x, y, r, g, b, wUv, size) {
    this._vbar(x, y - size, y + size, r, g, b, wUv);
    this._hbar(x - size / this.room.aspect, x + size / this.room.aspect, y, r, g, b, wUv);
  }

  build(hands, fbWidth) {
    this.count = 0;
    if (!this.on) return;
    const wUv = 6 / fbWidth;

    for (const w of this.room.walls) {
      this._vbar(w.u0, 0.0, 1.0, 0.10, 0.16, 0.22, wUv);
      const taken = this.captures.get(w.index);
      for (let i = 0; i < MARKS.length; i++) {
        const m = MARKS[i];
        const got = taken && taken[i];
        const st = this.holds.get(`${w.index}:${i}`);
        const p = st ? Math.max(0, Math.min(1, st.held / this.hold)) : 0;
        const lift = got ? 1 : 0.55 + 0.45 * p;
        const col = got ? [1, 1, 1] : m.col;
        const cx = w.u0 + m.fx * w.uw;
        this._cross(cx, m.fy, col[0] * lift, col[1] * lift, col[2] * lift, wUv * (got ? 3 : 2), 0.11);

        // A FILLING BAR under the mark. Without it there is no way to tell whether the app
        // has noticed the hand, how long is left, or why nothing is happening — which is
        // how this failed on site: people held, saw nothing, and gave up.
        if (p > 0 && !got) {
          const half = 0.075 / this.room.aspect;
          const y = m.fy - 0.155;
          this._hbar(cx - half, cx + half, y, 0.18, 0.22, 0.28, wUv * 1.2);
          this._hbar(cx - half, cx - half + 2 * half * p, y, 1, 1, 1, wUv * 1.2);
        }
      }
    }

    // Where the app believes each hand is — a CROSSHAIR, not a bare vertical line, so the
    // person at the wall can see it track them in both axes.
    for (const h of hands) {
      this._vbar(h.x, 0, 1, 0.55, 0.60, 0.70, wUv);
      this._hbar(h.x - 0.10 / this.room.aspect, h.x + 0.10 / this.room.aspect, h.y, 1, 1, 1, wUv * 2);
      this._vbar(h.x, h.y - 0.10, h.y + 0.10, 1, 1, 1, wUv * 2);
    }

    if (this.flash > 0) {
      const k = Math.min(1, this.flash) * 0.8;
      for (let i = 0; i < 40; i++) this._vbar(i / 40, 0, 1, k, k, k, wUv);
    }
  }

  draw() {
    const gl = this.gl;
    if (!this.on || !this.count) return;

    gl.useProgram(this.dimProg);
    gl.uniform1f(gl.getUniformLocation(this.dimProg, 'uAlpha'), this.dimAlpha);
    gl.bindVertexArray(this.dimVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.count * FLOATS));
    gl.useProgram(this.prog);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.LINES, 0, this.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
