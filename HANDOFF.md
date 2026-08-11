# HANDOFF — LiDAR Wall Engine

> Mở **session Claude Code MỚI** ở `~/lidar-wall-engine`, cho đọc file này. Đủ context để làm tiếp.

---

## 1. Engine này giải quyết việc gì

Chuỗi luôn giống nhau ở mọi phòng tương tác chạm-tường:

```
Hokuyo LiDAR → LiDAR Bridge (preset .json) → OSC → [ĐỌC CHẠM] → [VISUAL] → [CẮT NDI] → MadMapper
                                                         ↑
                                                 [HIỆU CHỈNH VỊ TRÍ]
```

Ba khối trong ngoặc **không đổi giữa các phòng** — chúng nằm trong `engine/`. Chỉ `[VISUAL]` là mới.

Xuất phát từ app `~/wall-touch` (phòng pentagon Bali, 5 tường 10350×1080). Engine là bản rút gọn
tổng quát của nó, và **mọi bẫy dưới đây đều đã trả giá bằng một lần hỏng thật**.

## 2. Cấu trúc

| chỗ | việc |
|:--|:--|
| `engine/main.js` | Electron main: chọn phòng, nạp config + **lớp phủ ở userData**, OSC, NDI, watchdog |
| `engine/src/boot.js` | dựng mọi thứ, nạp visual, vòng lặp chính |
| `engine/src/room.js` | hình học phòng: tường → toàn cảnh, vùng cắt NDI, áp hiệu chỉnh |
| `engine/src/touch.js` | OSC → bàn tay (theo `id`, nối nét, hết hạn) |
| `engine/src/fields.js` | trường sóng (phương trình sóng 2D thật) + trường vệt |
| `engine/src/calib.js` | 4 dấu chữ thập, giữ tay, khớp affine 2 chiều, lưu |
| `engine/src/ndi.js` | PBO ring + cắt cột + N sender |
| `engine/src/perf.js` | ngân sách khung hình, tự hạ chất lượng theo thứ tự |
| `engine/src/visual.js` | hợp đồng của visual + `defineShaderVisual` |
| `engine/src/demo.js` | bàn tay giả (xem mục 5, cast được chọn theo lỗi từng lọt lưới) |
| `visuals/waves/` | bản mẫu đầy đủ |
| `rooms/*.json` | mỗi phòng một file |
| `tools/import-preset.js` | preset bridge → file phòng |

## 3. 🔑 Giao thức bridge — và HAI bẫy chết người

Bridge ở chế độ fusion (preset `format: "slots"`, `normalize: true`, 30 Hz) gửi mỗi mặt một bundle:

```
/<prefix>/count    i     /<prefix>/pI/x   f  0..1 dọc tường
/<prefix>/pI/on    i     /<prefix>/pI/y   f  0..1 cao, 0 = TRẦN
/<prefix>/pI/v     f     /<prefix>/pI/id  i  track id
```

1. **`pI` là SỐ Ô, không phải danh tính.** Bridge chỉ đóng gói track đang sống, nên người A nhấc tay
   là người B tụt từ `p1` xuống `p0`. Bám nét theo ô là vệt nhảy ngang phòng. Danh tính là `/pI/id`,
   và `id` là **trường CUỐI** của mỗi ô — nên chỉ "chốt" một ô khi nhận được nó.
2. **`/pI/v` là số vô hướng.** Muốn có hướng thì phải tự vi phân vị trí (30 Hz thừa đủ).

Thêm: track chết theo **thời gian chờ**, không theo `/count` — rớt một gói UDP không được giết một
nét đang vẽ. Và **bàn tay trượt không giữ nguyên một id**: bridge mất dấu rồi bắt lại, qua góc phòng
là sang hẳn sensor khác → `touch.js` giữ "ghost" 0.7 s và **nối nét** nếu tay mới xuất hiện trong
bán kính 0.30 chiều-cao-tường.

## 4. ⚠️ MƯỜI BẪY ĐÃ TRẢ GIÁ

1. **Phòng nối vòng kín.** `uv.x = 1` chính là `uv.x = 0`. Texture mô phỏng để `REPEAT`; mọi khoảng
   cách x đi qua `room.dx()`; và **trường procedural phải TUẦN HOÀN** — tần số x là bội nguyên của
   `TAU/aspect`, noise tile trên chu kỳ nguyên (octave nhân đúng `2.0`). Hằng số tuỳ hứng ở đây =
   **một vết sẹo dọc đúng chỗ khách đi qua**. Kiểm bằng số: so cột đầu với cột cuối, đối chiếu phân
   bố chênh lệch giữa các cột kề nhau.
2. **KHÔNG dấu backtick trong file GLSL.** Shader nằm trong template literal JS; một backtick trong
   *comment* cũng đóng chuỗi → `SyntaxError` trỏ vào comment, không trỏ vào shader.
3. **Đắp vệt theo THỜI GIAN là sai — phải theo QUÃNG ĐƯỜNG.** Tay đứng yên xây núi còn tay quẹt
   lướt qua không để lại gì. Và phải **đóng dấu DỌC đoạn** giữa 2 mẫu: ở 30 Hz, tay 2 m/s nhảy xa
   hơn bán kính dấu → nét đứt quãng. (`fields.stroke()` đã đúng.)
4. **Ghi vào `app.asar` là không bao giờ được.** Bản đóng gói để file phòng trong archive chỉ đọc →
   `ENOENT`. Mọi thứ app ghi ra `app.getPath('userData')`, coi là **lớp phủ** lên file gốc.
5. **Hiệu chỉnh 1 chiều không đủ.** Warp quad là phép **phối cảnh** nên sai số **trộn x với y**:
   lệch ngang phụ thuộc **độ cao tay**. 2 điểm trên một đường ngang không khử được → **4 dấu**,
   khớp affine 2 chiều. Đo tại hiện trường: còn 3–4 cm sau khi chỉnh 1 chiều.
6. **Dọn dẹp phải theo "key nào xuất hiện trong khung này"**, không theo "key nào có trong map của
   tracker" — nếu không, mọi bàn tay không-từ-OSC (DEMO, chuột) bị xoá trạng thái mỗi khung.
7. **Phiên hiệu chỉnh phải TÁCH THEO TƯỜNG.** Một phiên chung thì ai chạm tường khác là xoá sạch
   dấu đã bắt. Phòng 5 người → đó là trạng thái bình thường, và từ dưới sàn nó trông y hệt "giữ tay
   mà không ăn".
8. **Người đứng ở tường không nhìn thấy HUD.** Mọi phản hồi khi hiệu chỉnh phải **vẽ vào canvas**
   (thanh tiến trình dưới dấu, chữ thập bám theo tay), vì chỉ canvas mới đi qua NDI ra tường.
9. **Đừng đòi tay đứng yên từng khung.** Bàn tay áp lên tường vẫn rung; ngưỡng 21 cm/s bị nhiễu cảm
   biến vượt liên tục → bộ đếm reset mãi. Chỉ cần **ở trong bán kính của dấu**.
10. **Mỗi dấu đắp là một lượt vẽ toàn màn hình.** Gộp 16 dấu một lượt (`fields.deposit` xếp hàng),
    và **flush trước khâu decay**, không thì dấu bị ghi lên buffer đã phân rã rồi mất khi swap.

Phụ: cảnh báo `READ-usage buffer ... discarded the shadow copy` là **bình thường** — PBO ring cố ý
ghi trước khi đọc xong.

## 5. DEMO=1 — dàn diễn viên được chọn theo lỗi

`engine/src/demo.js` không phải "vài bàn tay cho vui". Mỗi vai bịt một lớp lỗi:

| vai | bịt cái gì |
|:--|:--|
| 3 tay trôi | trường hợp thường |
| **sweeper** (~2 m/s) | bẫy #3 — bug đắp-theo-thời-gian **đã lọt ra hiện trường** vì mọi tay demo đều trôi chậm |
| **stiller** | hành vi theo thời gian giữ (san hô, giữ-để-kích hoạt) |
| **calibBot** | chạy đủ chuỗi bắt → khớp → lưu mỗi lần DEMO chạy, thay vì để người thật thử đầu tiên |

Thêm vai mới khi bịt được một lớp lỗi mới. Đừng bỏ vai nào.

## 6. Đo hiệu năng

Dòng `[perf]` mỗi 5 giây. **Con số quan trọng không phải `fps`** mà là `DOOR-WALL-1=` tăng bao nhiêu
sau mỗi 5 giây chia 5 → số hình NDI **thật sự** tới MadMapper mỗi giây.

Đã đo (M4 Max, visual `waves`, full 10350×1080, NDI bật): **59 fps render, 30 NDI/s, 0 drop**
(`readback 0.8 · pack 2.8 · ipc 9.3 ms`). Máy show RTX 5080: 41 fps với 6 người chạm + 44 nhánh san hô.

Env: `NDI_OFF` `NDI_IPC` `NDI_PBO` `NDI_RGBA` `RENDER_SCALE` `KIOSK` `SNAP_DIR`/`SNAP_AT` `ROOM`
`VISUAL` `DEMO` `CALIB`.

## 6b. Mang một visual từ trang preview sang engine

Trang `tools/preview/*.html` chạy trên khung ~2.4:1, engine chạy trên toàn cảnh **9.58:1**. Bốn
thứ đổi nghĩa khi sang, và cả bốn đều im lặng — không lỗi, chỉ là nhìn khác:

1. **Bước sóng bị kéo dài.** Giữ nguyên số chu kỳ trên toàn cảnh rộng gấp 4 thì các dải sáng nằm
   cách nhau gấp đôi, cả tường đọc ra tối và phẳng. Quy đổi theo **chiều-cao-tường**, rồi làm tròn
   về số nguyên chu kỳ.
2. **Số chu kỳ theo x phải NGUYÊN**, băm theo ô phải `mod` bề ngang, nhiễu trơn phải có chu kỳ chia
   hết bề ngang. Thiếu bất kỳ cái nào thì chỗ nối giữa mặt tường cuối và mặt tường đầu hiện thành
   một vệt dọc — chỉ thấy khi phòng khép kín, không thấy trên trang preview.
3. **Vận tốc tay đổi đơn vị.** Preview tính theo uv nên cú quẹt ngang đã tự bị chia cho tỉ lệ khung;
   engine trả về uv/giây rồi visual quy sang chiều-cao-tường (đều theo mọi hướng). Bê nguyên hệ số
   thì cú quẹt ngang mạnh gấp 2.4 lần so với bản đã duyệt.
4. **Cỡ hạt/ô phải tính theo bề rộng ĐẦY ĐỦ của phòng**, không theo cỡ khung đang render. Tính theo
   khung render thì lúc engine hạ độ phân giải để giữ fps, tác phẩm đổi luôn giữa buổi diễn.

## 7. Còn nợ

1. `node_modules` đang symlink sang `~/wall-touch`. Máy mới thì `npm install`; nếu binary Electron
   giải nén hỏng (thiếu `Frameworks`) thì chép `node_modules/electron/dist` + `path.txt` từ một cài
   đặt đang chạy được. **`package-lock.json` phải sinh khi KHÔNG có symlink đó** — nếu không, đường
   dẫn trong lock trỏ ra `../wall-touch/node_modules` và `npm ci` trên CI cài trượt.
2. `room.js` mới lo **tường đứng**. Sàn/trần (đa giác, chiếu từ trên) sẽ cần một loại mặt khác.
3. Hiệu chỉnh của app này lưu riêng (`~/…/lidar-wall-engine/room-<phòng>.json`), không dùng chung
   với app `wall-touch` — máy show phải bấm `k` hiệu chỉnh lại một lần.

## 8. Quy tắc tiết kiệm credit

Không tự chụp screenshot. Muốn xem thì
`mkdir -p $SNAP_DIR && SNAP_DIR=… SNAP_AT=9000 DEMO=1 RENDER_SCALE=0.35 npm start`, cắt dải canvas
ra khỏi ảnh cửa sổ (nằm giữa, cao đúng `W*roomH/roomW`), downscale, **chỉ đưa 1 ảnh khi cần quyết
định**. Gộp nhiều chỉnh vào 1 lần rồi mới render. `zsh` không có `timeout` → chạy nền rồi
`pkill -f "node_modules/electron"`.
