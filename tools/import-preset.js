#!/usr/bin/env node
// Turn a LiDAR Bridge preset into a room file.
//
//   node tools/import-preset.js "Very Final.json" --name my-room --visual waves
//
// What it can take from the preset, and what it cannot:
//
//   ✔ how many surfaces there are, and each one's OSC prefix — the app must listen for
//     exactly those, and mistyping one means a whole wall silently never responds.
//   ✔ a first estimate of each wall's width and height, from the warp quad's corners
//     (they are in world metres).
//   ✘ the TRUE wall widths. The quad's left/right edges are eyeballed: the laser fan
//     overshoots the room's corners, so the baseline never sees where a wall ends. That
//     is the same guess that shows up later as touches landing a few centimetres off.
//
// So the numbers below are a starting point to be checked with a tape measure, and the
// remaining error is taken out by the in-app calibration (press `k`).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
if (!src) {
  console.error('cách dùng: node tools/import-preset.js <preset.json> [--name my-room] [--visual waves] [--ndi WALL]');
  process.exit(1);
}
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const preset = JSON.parse(fs.readFileSync(src, 'utf8'));
const surfaces = Array.isArray(preset.surfaces) && preset.surfaces.length
  ? preset.surfaces
  : [{ name: 'wall1', oscPrefix: (preset.out?.prefix ?? 'lidar'), warp: preset.warp }];

const ndiPrefix = opt('ndi', 'WALL');
const roomName = opt('name', path.basename(src).replace(/\.json$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase());

function extent(corners) {
  if (!Array.isArray(corners) || corners.length < 3) return null;
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  return {
    wcm: Math.round((Math.max(...xs) - Math.min(...xs)) * 100),
    hcm: Math.round((Math.max(...ys) - Math.min(...ys)) * 100)
  };
}

const walls = surfaces.map((s, i) => {
  const e = extent(s.warp?.corners) || {};
  return {
    name: s.name ?? `wall${i + 1}`,
    oscPrefix: (s.oscPrefix ?? `wall${i + 1}`).replace(/^\/+/, ''),
    ndiName: `${ndiPrefix}-${i + 1}`,
    // CHECK THESE WITH A TAPE MEASURE — see the note at the top of this file.
    wcm: e.wcm ?? 300,
    hcm: e.hcm ?? 240
  };
});

// One uniform pixels-per-centimetre for the whole room, taken from the height. Uniform is
// what makes every NDI crop land on a true pixel boundary, so no wall is silently
// stretched relative to its neighbour.
const hcm = walls[0].hcm;
const height = Number(opt('height', 1080));
const pxPerCm = height / hcm;
for (const w of walls) w.px = Math.round(w.wcm * pxPerCm);

const room = {
  name: roomName,
  visual: opt('visual', 'waves'),
  room: { height, wrap: opt('wrap', 'true') !== 'false', walls },
  output: { fps: 30, renderScale: 1, maxFps: 60, fpsFloor: 45, fpsCeiling: 60, autoQuality: true, kiosk: false },
  ndi: { enabled: true, pbo: 4 },
  osc: { port: Number(preset.out?.port ?? 7000), flipY: true, trackTimeout: 0.5, stitchSeconds: 0.7, stitchRadius: 0.3 },
  fields: { simHeight: 320, substeps: 3, trailHold: 3.0 },
  params: {}
};

const outPath = path.join(__dirname, '..', 'rooms', `${roomName}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(room, null, 2) + '\n');

const total = walls.reduce((a, w) => a + w.px, 0);
console.log(`✅ rooms/${roomName}.json`);
console.log(`   ${walls.length} mặt · ${total}x${height} · ${pxPerCm.toFixed(2)} px/cm · wrap=${room.room.wrap}`);
for (const w of walls) console.log(`   ${w.oscPrefix.padEnd(10)} ${String(w.wcm).padStart(4)}x${w.hcm} cm → ${String(w.px).padStart(5)} px → NDI "${w.ndiName}"`);
if (preset.out && preset.out.normalize === false) {
  console.warn('   ⚠️ preset đang để normalize=false — bridge sẽ gửi mét thô, app cần u,v chuẩn hoá. Bật lại trong bridge.');
}
if (preset.out && preset.out.format !== 'slots') {
  console.warn(`   ⚠️ preset đang để format="${preset.out.format}" — app cần "slots" mới có /pN/x,y,v,id.`);
}
console.log('   → đo lại bề rộng bằng thước rồi sửa wcm/px, sau đó chạy app và bấm k để hiệu chỉnh.');
