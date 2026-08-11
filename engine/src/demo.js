// DEMO=1 — synthetic hands, so a visual can be built and a room can be smoke-tested with
// no sensors connected at all.
//
// The cast is chosen from bugs that got through testing on the reference installation.
// Every one of these covers a class of failure that a "typical" drifting hand does not:
//
//   drifters      the ordinary case
//   sweeper       moves FAST. A time-based trail deposit looks perfect with slow hands and
//                 leaves nothing at all under a real swipe — that bug shipped, because
//                 every demo hand drifted at a middling speed.
//   stiller       barely moves. Covers dwell-driven behaviour (growth, hold-to-trigger),
//                 which a moving hand never reaches.
//   calibBot      parks on each calibration mark in turn, so the capture → fit → save
//                 chain runs every time DEMO does, instead of being first attempted by a
//                 person standing in a room 10 m from the keyboard.

import { MARKS } from './calib.js';

export function makeDemoHands(room, enabled) {
  if (!enabled) return { update() {} };

  const w = room.walls[Math.min(1, room.walls.length - 1)];
  const cast = [
    { id: 901, cx: 0.12, cy: 0.55, ax: 0.055, ay: 0.15, sx: 0.42, sy: 0.71, ph: 0.0 },
    { id: 902, cx: 0.45, cy: 0.48, ax: 0.090, ay: 0.20, sx: 0.31, sy: 0.53, ph: 2.1 },
    { id: 903, cx: 0.82, cy: 0.60, ax: 0.070, ay: 0.14, sx: 0.55, sy: 0.37, ph: 4.3 },
    { id: 904, cx: 0.62, cy: 0.50, ax: 0.120, ay: 0.05, sx: 0.72, sy: 0.29, ph: 1.1 },  // sweeper ~2 m/s
    { id: 905, cx: 0.28, cy: 0.42, ax: 0.004, ay: 0.008, sx: 0.20, sy: 0.13, ph: 3.0 }, // stiller
    { id: 906, bot: true }
  ];
  for (const h of cast) { h.x = 0; h.y = 0; h.first = true; }
  let botDone = false;

  return {
    stopBot() { botDone = true; },
    update(dt, t, hands) {
      for (const h of cast) {
        let x, y;
        if (h.bot) {
          if (botDone) continue;
          const m = MARKS[Math.floor(t / 4) % MARKS.length];
          x = w.u0 + m.fx * w.uw;
          y = m.fy;
        } else {
          x = (h.cx + h.ax * Math.sin(t * h.sx + h.ph) + 1) % 1;
          y = h.cy + h.ay * Math.sin(t * h.sy + h.ph * 1.7);
        }
        const wall = room.wallAt(x);
        const dx = h.first ? 0 : room.dx(x, h.x);
        const dy = h.first ? 0 : y - h.y;
        hands.push({
          id: h.id, key: `demo${h.id}`,
          x, y,
          vx: dx / dt, vy: dy / dt,
          wall: wall.index,
          raw: (x - wall.u0) / wall.uw,
          rawY: y,
          fresh: h.first,
          demo: true
        });
        h.first = false;
        h.x = x; h.y = y;
      }
    }
  };
}
