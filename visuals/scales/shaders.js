// Shaders cho VẢY KIM LOẠI.
//
// GLSL ES có một danh sách từ khoá dành riêng dài bất ngờ và trình dịch báo lỗi ở đúng
// dòng nhưng KHÔNG nói vì sao. Bản dựng này đã mất thời gian vì hai chữ như vậy:
// `half` và `patch`. Đặt tên biến ngắn ở đây thì tra lại danh sách trước.

export const vert = /* glsl */`#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Phần dùng chung của hai mô phỏng: đọc tay, và cộng lực từ tối đa 8 bàn tay.
//
// Khoảng cách luôn quy về ĐƠN VỊ CHIỀU-CAO-TƯỜNG (nhân x với tỉ lệ khung) — đây là hệ
// duy nhất mà một vòng tròn vẽ trên tường đọc ra hình tròn. Để nguyên theo uv thì vùng
// ảnh hưởng của bàn tay bị kéo bẹt gần 10 lần trên toàn cảnh 5 mặt tường.
const SIM_HEAD = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uState;
uniform vec2  uTexel;
uniform vec4  uHands[8];     // xy = vị trí, zw = vận tốc (chiều-cao-tường / giây)
uniform int   uHandCount;
uniform float uDt, uAspect, uWrap, uRad;

// Đường ngắn nhất theo bề ngang trong phòng khép kín: mép phải toàn cảnh chạm mép trái.
float wrapDX(float dx) { return dx - floor(dx + 0.5) * uWrap; }

vec2 lap4(vec2 c) {
  return texture(uState, vUv + vec2(uTexel.x, 0.0)).xy
       + texture(uState, vUv - vec2(uTexel.x, 0.0)).xy
       + texture(uState, vUv + vec2(0.0, uTexel.y)).xy
       + texture(uState, vUv - vec2(0.0, uTexel.y)).xy - 4.0 * c;
}
`;

// ---------------------------------------------------------------- 1. độ nghiêng
//
// Mỗi vảy là một con lắc lò xo, NỐI với 4 vảy bên cạnh. Sóng lật lan ra từ chỗ chạm là
// hệ quả của cái nối đó, không phải một đường sóng vẽ sẵn.
export const tiltFrag = SIM_HEAD + /* glsl */`
uniform float uStiff, uDamp, uCoup, uAmb, uTime, uPush, uMaxTilt;

void main() {
  vec4 s = texture(uState, vUv);
  vec2 t = s.xy, v = s.zw;

  vec2 f = -uStiff * t + uCoup * lap4(t) * 60.0 - uDamp * v;

  // Sóng nền: tường vẫn sống khi phòng trống. Tần số theo x phải là SỐ NGUYÊN chu kỳ,
  // nếu không thì chỗ nối giữa mặt tường cuối và mặt tường đầu hiện một đường gãy.
  float w1 = sin(6.2831853 * 6.0 * vUv.x + vUv.y * 3.4 - uTime * 0.33);
  float w2 = sin(6.2831853 * 3.0 * vUv.x - vUv.y * 7.2 + uTime * 0.21);
  f += vec2(w1, w2) * uAmb;

  for (int i = 0; i < 8; i++) {
    if (i >= uHandCount) break;
    vec2 d = vec2(wrapDX(vUv.x - uHands[i].x) * uAspect, vUv.y - uHands[i].y);
    float w = exp(-dot(d, d) / (uRad * uRad));
    // hất theo HƯỚNG ĐI của tay -> dải sáng chạy đuổi theo tay
    f += (uHands[i].zw * 10.0 + normalize(d + 1e-5) * 0.9) * uPush * w;
  }

  v += f * uDt;
  t += v * uDt;
  // Lật quá xa thì mặt vảy quay khỏi MỌI nguồn sáng và vùng chạm thành mảng đen.
  t = clamp(t, -uMaxTilt, uMaxTilt);
  fragColor = vec4(t, v);
}`;

// ---------------------------------------------------------------- 2. vị trí
//
// Tay đẩy các vảy RA XA chỗ chạm, lò xo kéo khép lại. Chỉ có trường này thôi thì cả mảng
// trượt đi chứ không tách; phần tách nằm ở ĐỘ GIÃN, tính trong shader dựng hình.
export const dispFrag = SIM_HEAD + /* glsl */`
uniform float uK, uDamp, uCoup, uSep;

void main() {
  vec4 s = texture(uState, vUv);
  vec2 d = s.xy, v = s.zw;

  vec2 f = -uK * d + uCoup * lap4(d) * 60.0 - uDamp * v;

  for (int i = 0; i < 8; i++) {
    if (i >= uHandCount) break;
    vec2 q = vec2(wrapDX(vUv.x - uHands[i].x) * uAspect, vUv.y - uHands[i].y);
    float w = exp(-dot(q, q) / (uRad * uRad));
    f += normalize(q + 1e-5) * uSep * w;
  }

  v += f * uDt;
  d += v * uDt;
  fragColor = vec4(clamp(d, -3.0, 3.0), v);
}`;

// ---------------------------------------------------------------- 3. dựng hình
export const sceneFrag = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTilt, uDisp;
uniform vec2  uGrid;
uniform float uAspect, uGap, uBevel, uJit, uSharp, uKey, uExp;
uniform float uCorrCells, uSepGap, uSepMax, uGlow, uMove;
uniform vec3  uTint, uLo, uHi, uRim;

float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Băm TUẦN HOÀN theo bề ngang. Không có mod này thì ô cuối cùng và ô đầu tiên nhận hai
// giá trị ngẫu nhiên khác nhau và chỗ nối của phòng khép kín hiện thành một vệt dọc.
float hp(vec2 i) { return h1(vec2(mod(i.x, uGrid.x), i.y)); }

vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

// Nhiễu TRƠN, cũng tuần hoàn theo bề ngang: các vảy cạnh nhau nghiêng gần giống nhau nên
// kết thành mảng lớn. Dùng nhiễu trắng (mỗi vảy một kiểu) thì đọc ra vải kim sa.
float vnP(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 i0 = vec2(mod(i.x, per), i.y);
  vec2 i1 = vec2(mod(i.x + 1.0, per), i.y);
  float a = h1(i0), b = h1(i1);
  float c = h1(i0 + vec2(0.0, 1.0)), d = h1(i1 + vec2(0.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Phòng TỐI với 3 nguồn sáng nhỏ. Nền phải gần đen — để nền sáng đều thì vảy nào cũng
// sáng và cả tường đọc ra gạch men chứ không ra kim loại.
// Ba đèn soi được CẢ HAI CHIỀU (abs chứ không phải max): vảy lật ngược lại vẫn còn bắt
// được sáng thay vì rơi vào vùng chết.
vec3 env(vec3 r) {
  vec3 L1 = normalize(vec3(-0.34, 0.58, 0.74));
  vec3 L2 = normalize(vec3( 0.76, -0.22, 0.61));
  vec3 L3 = normalize(vec3( 0.10, 0.92, 0.38));
  vec3 c = mix(uLo, uHi, clamp(r.y * 0.5 + 0.5, 0.0, 1.0));
  c += vec3(pow(abs(dot(r, L1)), uSharp)) * uKey;
  c += uRim * pow(abs(dot(r, L2)), uSharp * 0.7) * uKey * 0.55;
  c += uRim * pow(abs(dot(r, L3)), uSharp * 2.2) * uKey * 0.30;
  return c;
}

void main() {
  vec2 dsp = texture(uDisp, vUv).xy;
  vec2 gw = vUv * uGrid - dsp;

  // Hàng so le: lưới thẳng tăm tắp đọc ra lưới mắt cáo chứ không ra khảm.
  float rowOff = h1(vec2(floor(gw.y) * 7.13, 3.7));
  vec2 g  = vec2(gw.x + rowOff * 0.5, gw.y);
  vec2 id = floor(g);
  vec2 f  = fract(g) - 0.5;

  float r1 = hp(id), r2 = hp(id + 17.3), r3 = hp(id + 91.7);

  // ĐỘ GIÃN của trường vị trí = các vảy đang rời xa nhau bao nhiêu -> khe mở ra bấy nhiêu.
  // Cho giãn nhiều quá thì vảy teo lại còn vài phần trăm và kim loại bị thay bằng một
  // mảng màu phẳng — tức là đổi lỗ đen thành lỗ trắng.
  vec2 ex = vec2(1.0 / uGrid.x, 0.0), ey = vec2(0.0, 1.0 / uGrid.y);
  float dv = (texture(uDisp, vUv + ex).x - texture(uDisp, vUv - ex).x) * 0.5
           + (texture(uDisp, vUv + ey).y - texture(uDisp, vUv - ey).y) * 0.5;
  float sep = clamp(dv * uSepGap, 0.0, uSepMax);

  float ang = (r1 - 0.5) * 0.38;
  vec2  q   = rot(f, ang);
  float hw  = max(0.5 - uGap * 0.5 - r2 * 0.10 - sep, 0.11);
  float e   = max(abs(q.x), abs(q.y));

  // Khe hở: gần như đen, nhưng khi bị tách thì có đèn phía SAU lớp khảm bục qua vết nứt.
  // Không có đèn đó thì vết nứt lộ ra phòng tối và chỗ chạm đọc ra một cái lỗ.
  if (e > hw) {
    fragColor = vec4(uLo * 0.12 + mix(uRim, uTint, 0.75) * uGlow * (sep * 0.55 + sep * sep * 3.2), 1.0);
    return;
  }

  vec4 stv = texture(uTilt, (id + 0.5) / uGrid);
  float mv = length(stv.zw);          // vảy này đang lật nhanh cỡ nào

  vec2 g2 = id * (uCorrCells / uGrid.x);
  vec2 rest = (vec2(vnP(g2, uCorrCells), vnP(g2 + 37.7, uCorrCells)) - 0.5) * uJit * 1.30
            + (vec2(r2, r3) - 0.5) * uJit * 0.22;
  vec2 tilt = stv.xy + rest;

  vec3 n = normalize(vec3(-tilt, 1.0));

  // Vát mép là thứ làm nó ra KIM LOẠI: cạnh tấm hớt sáng nên mắt đọc được bề dày. Bỏ đi
  // thì chỉ còn những ô màu phẳng.
  float bw  = 0.16;
  float bev = smoothstep(hw - bw, hw, e);
  vec2  o2  = (abs(q.x) > abs(q.y)) ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y));
  n = normalize(n + vec3(rot(o2, -ang) * bev * uBevel, 0.0));

  vec3 view = normalize(vec3((vUv - 0.5) * vec2(uAspect, 1.0) * 0.9, 1.6));
  vec3 c = env(reflect(-view, n)) * uTint;

  c += uTint * pow(1.0 - max(dot(n, view), 0.0), 5.0) * 0.06;  // fresnel: mép nhìn xiên sáng hơn
  c *= mix(0.40, 1.0, 1.0 - bev * 0.70);                       // chân vát mép tối -> có bề dày
  c *= mix(0.80, 1.16, r3);                                    // mỗi tấm bóng/xỉn khác nhau
  c += uTint * uMove * mv;                                     // đang lật thì tự sáng

  fragColor = vec4(c * uExp, 1.0);
}`;

export const brightFrag = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uSrc;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  fragColor = vec4(c * smoothstep(0.55, 1.25, max(c.r, max(c.g, c.b))), 1.0);
}`;

export const blurFrag = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uSrc; uniform vec2 uDir;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.227;
  c += (texture(uSrc, vUv + uDir * 1.385).rgb + texture(uSrc, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture(uSrc, vUv + uDir * 3.231).rgb + texture(uSrc, vUv - uDir * 3.231).rgb) * 0.070;
  fragColor = vec4(c, 1.0);
}`;

// Nén theo ĐỘ CHÓI, không nén từng kênh: nén từng kênh thì vùng sáng bị kéo về R=G=B và
// lõi nóng cháy trắng, mất sạch màu kim loại.
export const compositeFrag = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uScene, uBloom;
uniform float uBloomAmt;
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomAmt;
  float L = max(c.r, max(c.g, c.b));
  c *= (L > 1e-4) ? (L / (1.0 + L)) / L : 0.0;
  fragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;
