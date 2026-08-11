# LiDAR Wall Engine

Khung dựng **tác phẩm tương tác chạm-tường**: Hokuyo LiDAR → LiDAR Bridge → OSC → visual → nhiều luồng NDI.

Mỗi phòng mới chỉ cần **một file JSON** (sinh từ preset của bridge) và **một visual**. Mọi thứ còn lại
— đọc chạm, hiệu chỉnh vị trí, cắt NDI theo từng tường, giữ fps, HUD, chẩn đoán — đã nằm trong engine.

```
tools/import-preset.js   preset của LiDAR Bridge  →  rooms/<phòng>.json
rooms/<phòng>.json       kích thước tường + chọn visual + tham số
visuals/<tên>/           thứ duy nhất phải viết mới cho mỗi tác phẩm
engine/                  phần không bao giờ phải sửa
```

## Dựng một phòng mới

```bash
npm install
node tools/import-preset.js "Very Final.json" --name my-room --ndi WALL
# → đo lại bề rộng tường bằng thước, sửa wcm/px trong rooms/my-room.json
ROOM=my-room npm start
```

Rồi trong app bấm **`k`** → mỗi tường hiện **4 dấu chữ thập**. Đặt tay lên từng dấu, **giữ ~1.2 giây**
(có thanh tiến trình chạy dưới dấu). Đủ 4 dấu là app tự khớp và **tự lưu**. Xong: chạm đúng chỗ.

## Chạy

```bash
npm start                              # full độ phân giải
DEMO=1 RENDER_SCALE=0.5 npm start      # preview + 6 bàn tay giả, không cần cảm biến
NDI_OFF=1 npm start                    # đo fps thuần
ROOM=x VISUAL=y npm start              # chọn phòng / visual
CALIB=1 npm start                      # mở thẳng vào chế độ hiệu chỉnh
```

Phím: `h` HUD · `k` hiệu chỉnh · `s` ép tính · `r` bắt lại · `c` xoá trường · kéo chuột = chạm giả.

## Viết một visual

```js
export default {
  name: 'my-visual',
  fields: { wave: true, trail: true },     // xin engine hai trường chạm
  defaults: { speed: 1.0 },                // ghi đè được từ rooms/*.json → params
  async init(ctx) {},
  hand(h, dt, ctx) {},                     // mỗi bàn tay, mỗi khung; h.fresh = vừa chạm
  update(dt, hands, ctx) {},
  render(ctx) {},                          // vẽ ra framebuffer mặc định
  quality(q, ctx) {}                       // q.post / q.sim / q.render, 0..1
};
```

Cần nhanh hơn thì chỉ viết **một fragment shader**:

```js
import { defineShaderVisual } from '../../engine/src/visual.js';
export default defineShaderVisual({
  name: 'ripples',
  frag: `void main() {
    float h = fieldSmooth(uWave, vUv).r + fieldSmooth(uTrail, vUv).a;
    fragColor = vec4(vec3(0.2, 0.6, 1.0) * (0.1 + h * 3.0), 1.0);
  }`
});
```

Shader nhận sẵn: `uWave`, `uTrail`, `uHands[8]`, `uHandCols[8]`, `uHandCount`, `uTime`, `uAspect`,
`uTexel`, `uSimTexel`, kèm `fieldSmooth()` và `wrapDX()`.

**Hệ toạ độ, một lần cho tất cả:** `x` là uv toàn cảnh 0..1 **quét hết mọi tường và cuộn vòng**;
`y` = 0 ở sàn, 1 ở trần; khoảng cách đo bằng **chiều cao tường** (nhân `room.aspect` cho trục x)
— đó là hệ duy nhất mà một hình tròn vẽ trên tường thật sự tròn.

`visuals/waves/` là bản mẫu đầy đủ: mặt nước giao thoa, vệt quẹt để lại sống núi, mực nước và
đường bờ, bọt vỗ bờ, hạt sáng, bong bóng, đàn cá biết tránh tay, san hô mọc khi giữ tay.

## Giữ fps

`output.fpsFloor` / `fpsCeiling` (mặc định 45–60). Tụt dưới sàn thì engine **bỏ bớt chi tiết theo thứ tự**:
hậu kỳ → mô phỏng → độ phân giải render (cuối cùng, vì nó hạ luôn thứ NDI gửi đi). Lấy lại chậm hơn
lúc bỏ, để không nhấp nháy qua lại giữa hai mức.

Toàn bộ context, bẫy đã mắc và cách chẩn đoán: **[HANDOFF.md](HANDOFF.md)**.
