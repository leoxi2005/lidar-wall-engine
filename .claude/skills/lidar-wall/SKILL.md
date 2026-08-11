---
name: lidar-wall
description: Dựng hoặc sửa một tác phẩm tương tác chạm-tường chạy trên LiDAR Wall Engine (Hokuyo → LiDAR Bridge → OSC → visual → NDI). Dùng khi người dùng đưa preset JSON của LiDAR Bridge, xin một phòng tương tác mới, xin một visual mới cho phòng đã có, hoặc báo chạm bị lệch / tụt fps / NDI không ra.
---

# LiDAR Wall Engine — quy trình

Engine ở `~/lidar-wall-engine`. **Đọc `HANDOFF.md` trước khi sửa bất cứ thứ gì trong `engine/`** —
nó liệt kê 10 cái bẫy đã trả giá bằng hỏng thật, và gần như mọi lỗi mới sẽ là một trong số đó.

## Phòng mới

1. `node tools/import-preset.js "<preset>.json" --name <phòng> --ndi <TIỀN TỐ>`
2. **Nói người dùng đo lại bề rộng tường bằng thước** rồi sửa `wcm`/`px`. Số suy từ preset luôn lệch
   vài cm vì mép quad là ước lượng bằng mắt (tia laser vượt qua góc phòng).
3. `ROOM=<phòng> DEMO=1 RENDER_SCALE=0.4 npm start` → kiểm hình.
4. Cắm bridge → bấm `h`, `pkts` phải tăng và `touches/wall` phải khớp số người chạm.
5. Bấm `k` → hiệu chỉnh 4 dấu mỗi tường.

## Visual mới

Hỏi người dùng muốn gì rồi **dựng trang so sánh nhiều hướng trước khi viết vào engine**:
một file HTML chạy thẳng trên trình duyệt với 3–4 hướng, rê chuột giả làm tay, có nút xem 1 tường /
cả phòng. Sửa một file HTML rẻ hơn sửa cả app rất nhiều — bài học từ hai lần đoán sai hướng.

Chốt hướng rồi:
- visual thuần hàm của trường + vị trí tay → `defineShaderVisual`, chỉ viết fragment shader.
- visual có sự sống riêng (sinh vật, mọc, hạt) → module đầy đủ, xem `visuals/waves/`.

Toạ độ: `x` toàn cảnh 0..1 **cuộn vòng**, `y` 0 = sàn, khoảng cách tính bằng **chiều cao tường**.

## Chẩn đoán

| triệu chứng | nhìn vào đâu |
|:--|:--|
| chạm lệch vài cm | hiệu chỉnh (`k`). Lệch **đổi theo độ cao tay** = đúng bệnh warp quad, cần đủ 4 dấu |
| giữ tay không ăn | HANDOFF #6 #7 #9 — dọn dẹp theo khung, phiên theo tường, đừng đòi đứng yên |
| một tường im hoàn toàn | `oscPrefix` trong file phòng phải khớp preset. Bấm `h` xem `last:` |
| quẹt nhanh không để lại vệt | HANDOFF #3 — đắp theo quãng đường, đóng dấu dọc đoạn |
| có sẹo dọc ở mối nối | HANDOFF #1 — trường procedural chưa tuần hoàn |
| fps tụt | đọc dòng `[perf]`; **số NDI/giây mới quan trọng, không phải fps** |
| lưu hiệu chỉnh hỏng | HANDOFF #4 — phải ghi ra `userData`, không ghi vào asar |
| app đen màn hình | màn báo lỗi đỏ trong `index.html` sẽ in ra; nếu không thì kiểm import path |

## Nguyên tắc khi sửa engine

- Thêm bàn tay demo mới mỗi khi bịt được một lớp lỗi mới (`engine/src/demo.js`). Đừng bỏ vai nào.
- Kiểm bằng số khi kiểm được (mối nối, số NDI/giây) thay vì nhìn ảnh.
- Không tự chụp screenshot; dùng `SNAP_DIR` rồi cắt dải canvas — xem HANDOFF mục 8.
