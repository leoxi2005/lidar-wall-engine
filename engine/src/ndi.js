// NDI out: read the finished frame back off the GPU and hand each wall's columns to its
// own sender.
//
// The two things in here that took real measurement to get right:
//
// 1. A RING of pixel-pack buffers, not one. With a single PBO the loop has to wait on its
//    fence before it can start the next readback, so a readback that needs two or three
//    frames to land throttles NDI to a fraction of the render rate. Four measured as the
//    sweet spot on the reference installation: three starved the senders, six captured
//    frames the encoder then refused.
// 2. DRAIN EVERY landed readback per frame, not one. A fence typically needs ~2 frames to
//    signal, so collecting once per frame caps NDI at half the render rate however big the
//    ring is.
//
// The "READ-usage buffer was written, then fenced, but written again before being read
// back" warning in the console is expected here — the ring deliberately writes ahead.

export class NdiOut {
  constructor(gl, room, api, opts = {}) {
    this.gl = gl;
    this.room = room;
    this.api = api;
    this.fps = opts.fps ?? 30;
    this.enabled = opts.enabled !== false;
    this.bgra = opts.bgra !== false;
    this.pboCount = opts.pbo ?? 4;

    this.running = false;
    this.error = null;
    this.stage = { n: 0, readback: 0, pack: 0, ipc: 0 };
    this.accum = 0;
  }

  async start(fbWidth, fbHeight) {
    const gl = this.gl;
    this.w = fbWidth; this.h = fbHeight;
    this.pixels = new Uint8Array(fbWidth * fbHeight * 4);
    this.crops = this.room.crops(fbWidth).map(c => ({ ...c, buf: new Uint8Array(c.w * fbHeight * 4) }));

    this.pbos = [];
    for (let i = 0; i < this.pboCount; i++) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, fbWidth * fbHeight * 4, gl.STREAM_READ);
      this.pbos.push({ buf, fence: null });
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.head = 0; this.tail = 0; this.inFlight = 0;

    if (!this.enabled) return;
    for (const c of this.crops) {
      const res = await this.api.start({ name: c.name, width: c.w, height: fbHeight, fps: this.fps, bgra: this.bgra });
      if (res.ok) this.running = true;
      else { this.error = res.error; console.warn('[ndi]', c.name, res.error); }
    }
    if (this.running) {
      console.log('[ndi] senders:', this.crops.map(c => `${c.name} ${c.w}x${fbHeight}`).join(', '));
    }
  }

  // Call at the end of a frame; it rate-limits itself to the NDI fps.
  capture(dt) {
    if (!this.running) return;
    this.accum += dt;
    const interval = 1 / this.fps;
    if (this.accum < interval) return;
    this.accum %= interval;

    const gl = this.gl;
    if (this.inFlight >= this.pboCount) return;    // ring full — the collector is behind
    const slot = this.pbos[this.head];
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.head = (this.head + 1) % this.pboCount;
    this.inFlight++;
  }

  // Call at the START of a frame, before drawing.
  collect() {
    if (!this.running) return;
    for (let i = 0; i < this.pboCount; i++) if (!this._collectOne()) return;
  }

  _collectOne() {
    const gl = this.gl;
    if (!this.inFlight) return false;
    const slot = this.pbos[this.tail];
    if (!slot.fence) return false;
    const status = gl.clientWaitSync(slot.fence, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return false;
    gl.deleteSync(slot.fence);
    slot.fence = null;
    this.tail = (this.tail + 1) % this.pboCount;
    this.inFlight--;

    const t0 = performance.now();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const t1 = performance.now();

    // Vertical flip (GL reads bottom-up, NDI wants top-down) AND the per-wall column slice
    // in ONE pass — a separate flip buffer would touch the whole frame twice for nothing.
    const srcRow = this.w * 4;
    let packMs = 0, ipcMs = 0;
    for (const c of this.crops) {
      const crow = c.w * 4, srcX = c.x0 * 4;
      const a = performance.now();
      for (let y = 0; y < this.h; y++) {
        const s = (this.h - 1 - y) * srcRow + srcX;
        c.buf.set(this.pixels.subarray(s, s + crow), y * crow);
      }
      const b = performance.now();
      this.api.frame({ name: c.name, width: c.w, height: this.h, fps: this.fps }, c.buf);
      packMs += b - a; ipcMs += performance.now() - b;
    }
    const st = this.stage;
    st.n++; st.readback += t1 - t0; st.pack += packMs; st.ipc += ipcMs;
    return true;
  }

  // Averages since the last call, then resets — the [perf] line owns this.
  drainTimings() {
    const st = this.stage;
    const k = st.n || 1;
    const out = st.n
      ? `  ms/frame: readback:${(st.readback / k).toFixed(1)} pack:${(st.pack / k).toFixed(1)} ipc:${(st.ipc / k).toFixed(1)}`
      : '';
    st.n = st.readback = st.pack = st.ipc = 0;
    return out;
  }

  describe(fbHeight) {
    if (!this.running) return 'OFF' + (this.error ? ` (${this.error})` : '');
    return `ON ${this.crops.length}×[${this.crops.map(c => `${c.w}x${fbHeight}`).join(' ')}]`;
  }
}
