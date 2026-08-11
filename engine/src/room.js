// The room: how physical walls map to one continuous panorama, and how a touch reported
// by the bridge lands on it.
//
// Everything else in the engine asks the room questions instead of doing geometry of its
// own, so a room with three walls, or one with a different aspect, needs no code changes.

export class Room {
  constructor(cfg) {
    const src = cfg.walls || [];
    if (!src.length) throw new Error('room: config has no walls');

    // Uniform pixels-per-centimetre across the whole room. Deriving it rather than
    // trusting per-wall px means the NDI crops land on exact pixel boundaries and no wall
    // is silently stretched relative to its neighbour.
    this.height = cfg.height ?? 1080;
    const hcm = src[0].hcm ?? 240;
    this.pxPerCm = this.height / hcm;

    let acc = 0;
    this.walls = src.map((w, i) => {
      const px = w.px ?? Math.round(w.wcm * this.pxPerCm);
      const wall = {
        index: i,
        name: w.name ?? `wall${i + 1}`,
        oscPrefix: w.oscPrefix ?? `tuong${i + 1}`,
        ndiName: w.ndiName ?? `WALL-${i + 1}`,
        wcm: w.wcm,
        hcm: w.hcm ?? hcm,
        px,
        x0: acc,
        // Correction fitted by the calibration step. uAffine (2D) wins when present;
        // uScale/uOffset is the older 1D form kept so existing rooms keep working.
        uAffine: Array.isArray(w.uAffine) && w.uAffine.length === 6 ? w.uAffine.slice() : null,
        uScale: w.uScale ?? 1,
        uOffset: w.uOffset ?? 0
      };
      acc += px;
      return wall;
    });

    this.width = acc;
    this.aspect = this.width / this.height;
    // Perimeter in "wall heights" — the unit every distance in the engine is measured in,
    // because it is the only one where a circle drawn on the wall is round.
    for (const w of this.walls) {
      w.u0 = w.x0 / this.width;
      w.uw = w.px / this.width;
      w.widthWH = (w.wcm ?? w.px / this.pxPerCm) / (w.hcm);
    }

    if (cfg.wrap === false) this.wrap = false;
    else this.wrap = true;   // closed room: the right edge of the last wall meets the first
  }

  get metresPerWallHeight() { return (this.walls[0].hcm ?? 240) / 100; }

  // Shortest signed distance in x, honouring a closed room.
  dx(a, b) {
    let d = a - b;
    if (this.wrap) d -= Math.round(d);
    return d;
  }

  wallAt(u) {
    for (const w of this.walls) {
      const f = (u - w.u0) / w.uw;
      if (f >= 0 && f < 1) return w;
    }
    return this.walls[0];
  }

  // Bridge coordinates (0..1 along a wall, 0..1 height with 0 = floor) → panorama uv,
  // through that wall's fitted correction.
  place(wall, raw, rawY) {
    let fx, fy;
    const A = wall.uAffine;
    if (A) {
      fx = A[0] + A[1] * raw + A[2] * rawY;
      fy = A[3] + A[4] * raw + A[5] * rawY;
    } else {
      fx = (raw - wall.uOffset) * wall.uScale;
      fy = rawY;
    }
    fx = Math.min(1.2, Math.max(-0.2, fx));
    fy = Math.min(1.2, Math.max(-0.2, fy));
    return { x: wall.u0 + fx * wall.uw, y: fy, fx };
  }

  // Column ranges to slice out of a framebuffer of the given width. Even boundaries: NDI
  // wants an even width per stream and it keeps the crops off half pixels.
  crops(fbWidth) {
    const out = [];
    let acc = 0;
    this.walls.forEach((w, i) => {
      const last = i === this.walls.length - 1;
      let bnd = last ? fbWidth : Math.round(((w.x0 + w.px) / this.width) * fbWidth);
      bnd -= bnd % 2;
      out.push({ wall: w, x0: acc, w: Math.max(2, bnd - acc), name: w.ndiName });
      acc = bnd;
    });
    return out;
  }

  describe() {
    return `${this.width}x${this.height} · ${this.walls.length} walls ` +
      `[${this.walls.map(w => w.px).join('/')}] · ${this.pxPerCm.toFixed(2)} px/cm` +
      (this.wrap ? ' · wrap' : '');
  }
}
