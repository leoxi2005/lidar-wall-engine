// OSC → hands.
//
// THE PROTOCOL (LiDAR Bridge, fusion mode, preset with format "slots" + normalize true):
//
//   /<prefix>/count      i   how many people are touching that wall
//   /<prefix>/pI/on      i   1
//   /<prefix>/pI/x       f   0..1 ALONG the wall (0 = left edge)
//   /<prefix>/pI/y       f   0..1 height, 0 = ceiling, 1 = floor   (bridge convention)
//   /<prefix>/pI/v       f   speed, m/s — MAGNITUDE ONLY, no direction
//   /<prefix>/pI/id      i   track id
//
// FOUR THINGS THAT WILL BITE ANYONE WHO REIMPLEMENTS THIS:
//
// 1. `pI` is a SLOT, not an identity. The bridge packs only the live tracks, so when
//    person A lifts their hand, person B silently slides from p1 into p0. Bind a stroke
//    to the slot and it teleports across the room. Identity is `/pI/id` — and `id` is the
//    LAST field of a slot in the bundle, which is why a slot is committed on receiving it.
// 2. `/pI/v` is a scalar. Anything directional (a wake, a swirl, a stroke) has to
//    differentiate position here; 30 Hz is plenty.
// 3. A track dies on a TIMEOUT, never on `/count`. One dropped UDP packet must not kill a
//    stroke somebody is in the middle of drawing.
// 4. A hand sliding along a wall does NOT keep one identity: the bridge drops and
//    re-acquires it, and crossing a corner hands it to a different sensor entirely — a
//    different id under a different prefix. Untreated, one continuous swipe arrives as
//    several strokes in several colours. See the ghost/stitch logic below.

export class Touch {
  constructor(room, cfg = {}) {
    this.room = room;
    this.byPrefix = new Map();
    for (const w of room.walls) this.byPrefix.set(w.oscPrefix, w);

    this.pointRe = new RegExp(cfg.pointRule ?? '^/([A-Za-z0-9_]+)/p(\\d+)/(on|x|y|v|id)$');
    this.countRe = new RegExp(cfg.countRule ?? '^/([A-Za-z0-9_]+)/count$');
    this.flipY = cfg.flipY !== false;
    this.timeout = cfg.trackTimeout ?? 0.5;
    this.stitchSeconds = cfg.stitchSeconds ?? 0.7;
    this.stitchRadius = cfg.stitchRadius ?? 0.30;   // wall-heights

    this.pending = new Map();      // "prefix:slot" → partial point
    this.counts = new Map();       // prefix → count
    this.tracks = new Map();       // "wallIndex:id" → hand
    this.ghosts = [];
    this.now = 0;
    this.packets = 0;
    this.lastAddress = '—';
  }

  handle(msg) {
    const addr = msg.address || '';

    const mc = addr.match(this.countRe);
    if (mc) {
      if (this.byPrefix.has(mc[1])) this.counts.set(mc[1], Number(msg.args?.[0] ?? 0));
      this.packets++; this.lastAddress = addr;
      return;
    }

    const m = addr.match(this.pointRe);
    if (!m) return;
    const wall = this.byPrefix.get(m[1]);
    if (!wall) return;

    const key = `${m[1]}:${m[2]}`;
    let p = this.pending.get(key);
    if (!p) { p = {}; this.pending.set(key, p); }
    p[m[3]] = Number(msg.args?.[0] ?? 0);
    this.packets++; this.lastAddress = addr;

    if (m[3] === 'id') { this._commit(wall, p); this.pending.delete(key); }
  }

  _commit(wall, p) {
    if (p.x == null || p.y == null || !Number.isFinite(p.id)) return;
    const raw = Math.min(1, Math.max(0, p.x));
    const rawIn = Math.min(1, Math.max(0, p.y));
    const rawY = this.flipY ? 1 - rawIn : rawIn;      // → 0 = floor, 1 = ceiling

    const { x, y } = this.room.place(wall, raw, rawY);
    const key = `${wall.index}:${p.id}`;

    let t = this.tracks.get(key);
    if (!t) {
      const g = this._stitch(x, y);
      t = {
        key, id: g ? g.id : p.id, wall: wall.index, wallRef: wall,
        x, y, raw, rawY, vx: 0, vy: 0, speed: 0,
        born: this.now, lastSeen: this.now,
        fresh: !g,                 // a stitched hand never re-announces itself
        stitched: !!g,
        prevX: g ? g.x : x, prevY: g ? g.y : y
      };
      this.tracks.set(key, t);
      return;
    }

    const dt = Math.max(1e-3, this.now - t.lastSeen);
    const dx = this.room.dx(x, t.x);
    const dy = y - t.y;
    // Half-and-half smoothing: raw 30 Hz deltas jitter enough to make anything
    // velocity-driven twitch, and heavier smoothing makes a fast swipe lag the hand.
    t.vx = t.vx * 0.5 + (dx / dt) * 0.5;
    t.vy = t.vy * 0.5 + (dy / dt) * 0.5;
    t.prevX = t.x; t.prevY = t.y;
    t.x = x; t.y = y; t.raw = raw; t.rawY = rawY;
    t.speed = p.v ?? 0;
    t.lastSeen = this.now;
    t.fresh = false;
    t.stitched = false;
  }

  // Was a hand just here? Then this "new" track is the same person: inherit the identity
  // so colour and stroke continue, and skip whatever the visual does on first contact.
  _stitch(x, y) {
    let best = null, bestD = this.stitchRadius;
    for (const g of this.ghosts) {
      const d = Math.hypot(this.room.dx(x, g.x) * this.room.aspect, y - g.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) this.ghosts = this.ghosts.filter(g => g !== best);
    return best;
  }

  // Returns the hands alive this frame.
  update(dt) {
    this.now += dt;
    for (const [key, t] of this.tracks) {
      if (this.now - t.lastSeen <= this.timeout) continue;
      this.ghosts.push({ x: t.x, y: t.y, id: t.id, t: this.now });
      this.tracks.delete(key);
    }
    if (this.ghosts.length) this.ghosts = this.ghosts.filter(g => this.now - g.t < this.stitchSeconds);
    return [...this.tracks.values()];
  }

  get active() { return this.tracks.size; }
  countsPerWall() { return this.room.walls.map(w => this.counts.get(w.oscPrefix) ?? 0); }
}
