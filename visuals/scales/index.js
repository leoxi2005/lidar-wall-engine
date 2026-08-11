// VẢY KIM LOẠI — tường phủ hàng vạn tấm kim loại nhỏ, mỗi tấm nghiêng một kiểu.
//
//   · đứng yên  = sóng nền chạy chậm qua mặt khảm, các dải sáng quét ngang
//   · quẹt tay  = sóng lật chạy đuổi theo tay, rồi tắt dần
//   · chạm vào  = khảm NỨT RA quanh bàn tay, có đèn phía sau bục qua khe, khép lại khi rút tay
//
// Hai mô phỏng chạy song song, cả hai đều là con lắc lò xo nối với 4 ô bên cạnh:
//   ĐỘ NGHIÊNG  quyết định vảy bắt được bao nhiêu ánh sáng  -> ra sóng sáng
//   VỊ TRÍ      quyết định vảy nằm ở đâu                    -> ra vết nứt
//
// Vì sao phải mô phỏng chứ không vẽ sẵn: sóng lan, tắt dần, giao thoa khi hai người cùng
// chạm đều là hệ quả của phương trình. Vẽ sẵn thì chỉ bắt chước được bề ngoài.

import { Program, createFBO, createDoubleFBO } from '../../engine/src/gl.js';
import * as S from './shaders.js';

const PALETTES = {
  'đồng': { tint: [1.00, 0.76, 0.36], lo: [0.013, 0.008, 0.004], hi: [0.046, 0.031, 0.015], rim: [1.00, 0.82, 0.50] },
  'bạc':  { tint: [0.74, 0.78, 0.84], lo: [0.008, 0.010, 0.015], hi: [0.033, 0.040, 0.053], rim: [0.62, 0.76, 1.00] },
  'lam':  { tint: [0.56, 0.74, 0.90], lo: [0.004, 0.008, 0.019], hi: [0.019, 0.036, 0.063], rim: [0.45, 0.90, 1.00] }
};

export default {
  name: 'scales',
  fields: false,          // visual này tự giữ trường của nó, không dùng trường sóng của engine

  defaults: {
    palette: 'đồng',
    tile: 26,             // cạnh mỗi vảy, tính bằng pixel ở độ phân giải đầy đủ
    // tay
    push: 3.21,           // lực hất vảy
    rad: 0.13,            // vùng ảnh hưởng của bàn tay (chiều-cao-tường)
    sep: 6.5,             // lực đẩy các vảy tách ra khỏi chỗ chạm
    sepK: 7.0,            // lò xo kéo các vảy khép lại
    sepD: 2.7,            // tắt dần của chuyển động tách
    // mặt khảm
    coup: 0.09,           // độ lan sóng sang vảy bên cạnh
    stiff: 9.0,           // lò xo kéo vảy về vị trí nghỉ
    damp: 1.35,           // tắt dần
    maxTilt: 0.50,        // chặn góc lật (xem ghi chú dưới)
    amb: 0.72,            // sóng nền khi phòng trống
    jit: 0.24,            // độ lệch ngẫu nhiên của từng vảy
    corr: 9.0,            // cỡ mảng: bao nhiêu vảy cùng nghiêng một hướng
    gap: 0.0,             // khe hở khi đứng yên
    bevel: 0.39,          // vát mép
    // ánh sáng
    sharp: 64,            // độ bóng
    key: 2.6,             // độ mạnh đèn chính
    sepGap: 1.12,         // khe mở ra bao nhiêu khi tách
    sepMax: 0.14,         // chặn độ mở khe
    glow: 2.2,            // đèn nằm sau lớp khảm, bục qua khe nứt
    move: 0.18,           // vảy đang lật thì tự sáng
    bloom: 0.13,          // quầng sáng
    exposure: 1.29,       // độ sáng tổng
    substeps: 2           // lò xo cứng cần bước nhỏ; tăng bước chứ ĐỪNG tăng dt
  },

  async init(ctx) {
    const { gl, params: P } = ctx;
    this.P = P;
    this.pTilt = new Program(gl, S.vert, S.tiltFrag);
    this.pDisp = new Program(gl, S.vert, S.dispFrag);
    this.pScene = new Program(gl, S.vert, S.sceneFrag);
    this.pBright = new Program(gl, S.vert, S.brightFrag);
    this.pBlur = new Program(gl, S.vert, S.blurFrag);
    this.pComp = new Program(gl, S.vert, S.compositeFrag);

    this.pal = PALETTES[String(P.palette).toLowerCase()] ?? PALETTES['đồng'];
    this.hands = [];
    this.handBuf = new Float32Array(32);

    this._grid(ctx);
    this._targets(ctx);
  },

  // Số vảy tính từ bề rộng ĐẦY ĐỦ của phòng, không phải từ cỡ khung hình đang render:
  // khi engine hạ độ phân giải để giữ fps thì tác phẩm phải giữ nguyên, chỉ nét đi một
  // chút, chứ không được đổi số vảy giữa buổi diễn.
  _grid(ctx) {
    const gl = ctx.gl, P = this.P;
    this.GW = Math.max(8, Math.round(ctx.room.width / P.tile));
    this.GH = Math.max(6, Math.round(this.GW / ctx.aspect));

    // Chu kỳ của nhiễu phải chia hết bề ngang, nếu không thì chỗ nối của phòng khép kín
    // hiện thành một vệt dọc.
    this.corrCells = Math.max(2, Math.round(this.GW / Math.max(1.5, P.corr)));
    while (this.GW % this.corrCells !== 0 && this.corrCells > 2) this.corrCells--;

    const wrapS = ctx.room.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    this.tilt = createDoubleFBO(gl, this.GW, this.GH, { wrapS });
    this.disp = createDoubleFBO(gl, this.GW, this.GH, { wrapS });
  },

  _targets(ctx) {
    const gl = ctx.gl;
    this.scene = createFBO(gl, ctx.width, ctx.height, { wrapS: ctx.room.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE });
    const bh = Math.max(16, Math.round(ctx.height / 4));
    this.bloomA = createFBO(gl, Math.round(bh * ctx.aspect), bh);
    this.bloomB = createFBO(gl, Math.round(bh * ctx.aspect), bh);
  },

  quality(q, ctx) {
    this.substeps = Math.max(1, Math.round(this.P.substeps * q.sim));
    if (q.renderChanged) this._targets(ctx);
  },

  hand(h, dt, ctx) {
    if (this.hands.length >= 8) return;
    // Vận tốc quy về đơn vị chiều-cao-tường: giữ nguyên theo uv thì cú quẹt ngang yếu đi
    // gần 10 lần so với cú quẹt dọc trên toàn cảnh 5 mặt tường.
    this.hands.push([h.x, h.y, h.vx * ctx.aspect, h.vy]);
  },

  update(dt, hands, ctx) {
    const { gl, blit, room } = ctx, P = this.P;
    const n = this.hands.length;
    this.handBuf.fill(0);
    for (let i = 0; i < n; i++) {
      const h = this.hands[i];
      this.handBuf[i * 4] = h[0]; this.handBuf[i * 4 + 1] = h[1];
      this.handBuf[i * 4 + 2] = h[2]; this.handBuf[i * 4 + 3] = h[3];
    }
    const wrap = room.wrap ? 1 : 0;
    const sub = Math.max(1, this.substeps ?? P.substeps);
    const step = Math.min(dt, 1 / 60) / sub;

    for (let i = 0; i < sub; i++) {
      this.pTilt.use()
        .tex('uState', this.tilt.read, 0)
        .v2('uTexel', this.tilt.texelX, this.tilt.texelY)
        .v4v('uHands', this.handBuf).i('uHandCount', n)
        .f('uDt', step).f('uAspect', ctx.aspect).f('uWrap', wrap).f('uRad', P.rad)
        .f('uStiff', P.stiff).f('uDamp', P.damp).f('uCoup', P.coup)
        .f('uAmb', P.amb).f('uTime', ctx.time).f('uPush', P.push).f('uMaxTilt', P.maxTilt);
      blit(this.tilt.write); this.tilt.swap();

      this.pDisp.use()
        .tex('uState', this.disp.read, 0)
        .v2('uTexel', this.disp.texelX, this.disp.texelY)
        .v4v('uHands', this.handBuf).i('uHandCount', n)
        .f('uDt', step).f('uAspect', ctx.aspect).f('uWrap', wrap).f('uRad', P.rad)
        .f('uK', P.sepK).f('uDamp', P.sepD).f('uCoup', P.coup * 0.5).f('uSep', P.sep);
      blit(this.disp.write); this.disp.swap();
    }
    this.hands.length = 0;
  },

  render(ctx) {
    const P = this.P, blit = ctx.blit, pal = this.pal;

    this.pScene.use()
      .tex('uTilt', this.tilt.read, 0).tex('uDisp', this.disp.read, 1)
      .v2('uGrid', this.GW, this.GH)
      .f('uAspect', ctx.aspect).f('uGap', P.gap).f('uBevel', P.bevel).f('uJit', P.jit)
      .f('uSharp', P.sharp).f('uKey', P.key).f('uExp', P.exposure)
      .f('uCorrCells', this.corrCells).f('uSepGap', P.sepGap).f('uSepMax', P.sepMax)
      .f('uGlow', P.glow).f('uMove', P.move)
      .v3('uTint', ...pal.tint).v3('uLo', ...pal.lo).v3('uHi', ...pal.hi).v3('uRim', ...pal.rim);
    blit(this.scene);

    this.pBright.use().tex('uSrc', this.scene, 0);
    blit(this.bloomA);
    this.pBlur.use().tex('uSrc', this.bloomA, 0).v2('uDir', this.bloomA.texelX, 0);
    blit(this.bloomB);
    this.pBlur.use().tex('uSrc', this.bloomB, 0).v2('uDir', 0, this.bloomA.texelY);
    blit(this.bloomA);

    this.pComp.use()
      .tex('uScene', this.scene, 0).tex('uBloom', this.bloomA, 1)
      .f('uBloomAmt', P.bloom);
    blit(null);
  }
};
