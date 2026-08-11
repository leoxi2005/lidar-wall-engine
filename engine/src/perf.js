// Frame budget: hold the framerate inside a band by spending quality, not by dropping
// frames.
//
// An installation runs for hours in front of the public. Nobody is watching the console,
// and the number of people touching the wall changes the cost minute to minute. So the
// engine measures, and when it cannot keep the floor it gives up detail in a deliberate
// ORDER — cheapest-looking sacrifice first — instead of stuttering.
//
// The order matters and is not arbitrary:
//   1. post  — bloom/blur iterations. Softening a glow is the least visible loss.
//   2. sim   — wave sub-steps and field grid size. Ripples travel slightly slower and
//              softer; nobody can tell without a reference.
//   3. render— the output framebuffer itself. LAST, because it lowers what NDI sends and
//              therefore what the projector shows: a real, permanent loss of sharpness.
//
// Recovery is deliberately slower than degradation, and needs a sustained margin. A
// visual that oscillates between quality levels is far more distracting than one that
// simply stays a notch lower.

export class Perf {
  constructor(opts = {}) {
    this.floor = opts.floor ?? 45;          // never let it sit below this
    this.ceil = opts.ceil ?? 60;            // no point going faster than this
    this.auto = opts.auto !== false;
    this.dropAfter = opts.dropAfter ?? 1.5; // seconds under the floor before giving up detail
    this.riseAfter = opts.riseAfter ?? 6.0; // seconds of comfortable headroom before taking it back

    // 1.0 = everything. Each is consumed by whoever owns that cost.
    this.post = 1;
    this.sim = 1;
    this.render = 1;

    this.fps = 0;
    this._acc = 0; this._frames = 0;
    this._under = 0; this._over = 0;
    this.level = 0;                          // how many notches of quality are given up
    this.onChange = opts.onChange || (() => {});
  }

  // Ladder of what to give up, in order. Only `render` needs the visual to rebuild
  // anything, which is why it is last and coarse.
  static LADDER = [
    { post: 1.00, sim: 1.00, render: 1.00 },
    { post: 0.60, sim: 1.00, render: 1.00 },
    { post: 0.40, sim: 0.80, render: 1.00 },
    { post: 0.30, sim: 0.60, render: 1.00 },
    { post: 0.30, sim: 0.50, render: 0.80 },
    { post: 0.25, sim: 0.40, render: 0.65 }
  ];

  frame(dt) {
    this._acc += dt; this._frames++;
    if (this._acc >= 0.5) {
      this.fps = this._frames / this._acc;
      this._acc = 0; this._frames = 0;
    }
    if (!this.auto || !this.fps) return;

    if (this.fps < this.floor) {
      this._under += dt; this._over = 0;
      if (this._under >= this.dropAfter && this.level < Perf.LADDER.length - 1) {
        this._under = 0;
        this._set(this.level + 1, `fps ${this.fps.toFixed(0)} < ${this.floor}`);
      }
    } else if (this.fps > this.ceil - 3) {
      this._over += dt; this._under = 0;
      if (this._over >= this.riseAfter && this.level > 0) {
        this._over = 0;
        this._set(this.level - 1, `fps ${this.fps.toFixed(0)} có dư`);
      }
    } else {
      this._under = 0; this._over = 0;
    }
  }

  _set(level, why) {
    this.level = level;
    const q = Perf.LADDER[level];
    const renderChanged = q.render !== this.render;
    this.post = q.post; this.sim = q.sim; this.render = q.render;
    console.log(`[perf] chất lượng → mức ${level} (post ${q.post} sim ${q.sim} render ${q.render}) — ${why}`);
    this.onChange({ ...q, level, renderChanged });
  }

  describe() {
    return `fps:${this.fps.toFixed(0)}${this.level ? ` q${this.level}` : ''}`;
  }
}
