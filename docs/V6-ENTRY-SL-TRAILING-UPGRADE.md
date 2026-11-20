# XAUUSD AI MASTER V6 — Tài liệu Kỹ thuật & Vận hành Chính thức

## 1. Lõi Thực Thi Chính Thức
- **Đường thực thi duy nhất (V6 Standalone):** `scripts/xauusd-standalone-server.mjs` -> `scripts/mt5-direct-probe.py` -> `scripts/xauusd_v6_trade_rules.py`.
- Không sử dụng Risk Engine cũ (`packages/risk-engine`) để ghi đè `FIXED_LOT` của V6.

## 2. Bảo mật & Kiểm soát LIVE (P0)
- **Bind mặc định:** API chỉ lắng nghe `127.0.0.1` (`V6_API_HOST`); Web chỉ mở LAN khi đặt `V6_ALLOW_LAN_WEB=true`; Cloudflare Tunnel tắt mặc định (chỉ mở khi có thao tác `POST /api/v1/network/tunnel` tường minh).
- **Xác thực:** OTP 6 chữ số dùng một lần (`POST /api/v1/auth-pair`) cấp session token; không miễn xác thực cho IP nội bộ; payload truyền sang Python qua `--stdin` (không truyền mật khẩu qua CLI).
- **Kiểm soát LIVE:** Khởi động mặc định ở `PAUSE + DISARMED`, `AUTO = OFF`, `DCA = OFF`. `strictAccountMode: true` bắt buộc khớp Account Login, Server (theo `EXPLICIT_SERVER_ALIAS_MAP`), Trade Mode (DEMO/LIVE) và Symbol. Emergency Stop (`POST /api/v1/mt5/emergency-stop`) khóa mở lệnh mới nhưng vẫn giữ bảo vệ SL cho vị thế đang mở.

## 3. Fixed Lot & Cảnh Báo Rủi Ro
- **Chế độ mặc định:** `FIXED_LOT` do người dùng cấu hình (không tự động nhân/giảm theo Balance, Equity hay khoảng cách SL).
- **Ngưỡng cảnh báo (không chặn theo riêng tỷ lệ %):** tỷ lệ rủi ro trên lệnh, tổng danh mục và drawdown có thể sinh cảnh báo nhưng không phải tất cả đều là cổng từ chối lệnh. **Khác biệt quan trọng:** kiểm tra lỗ ngày đã có cổng chặn lệnh mới dựa trên lịch sử broker/giới hạn dự kiến; free margin không hợp lệ hoặc không đủ cũng chặn lệnh. Không suy diễn mọi tỷ lệ phần trăm hiển thị là hard cap.
- **Điều kiện vẫn chặn mở lệnh:** Thiếu Free Margin, Fixed Lot không hợp lệ theo broker, thiếu SL/TP hợp lệ, chưa ARM LIVE, sai tài khoản/server/mode, tick/dữ liệu cũ hoặc không đồng bộ UTC, `WAIT_PULLBACK`, tín hiệu xung đột hoặc PAUSE/Emergency Stop.
- **DCA dương:** Mặc định tắt; chỉ bật khi người dùng cho phép và vị thế đã đạt BE + đi thuận chiều; hỗ trợ `FIXED_DCA_LOT` (không martingale, không DCA âm).


### 3.1 Kiểm tra đúng nguồn phân bổ Lot trước LIVE (Issue #76)

- V6 Standalone gửi lệnh qua `scripts/xauusd-standalone-server.mjs` và dùng `getCanonicalFixedLot()` cho nhánh Auto. Mã Python hiện báo `sizingMode = FIXED_LOT`; các ngưỡng tỷ lệ trên lệnh/danh mục là **cảnh báo** ở gateway này. Không mô tả đây là phân bổ Lot tự động theo Equity.
- Bộ so sánh `apps/api/src/services/phase7c-auto-lot.service.ts` có `mode = AUTO_LOT_SHADOW_BACKTEST` và `liveUnlockAvailable = false`. Thiết lập Auto Lot trong màn hình thử nghiệm không chứng minh V6 đang giao dịch bằng Auto Lot.
- Kết quả status V6 có thêm `executionSizing` (chỉ đọc): `executionFamily`, `orderSizingMode`, `configuredLot`, `automaticCapitalSizingActiveOnV6`, `riskPolicy`, `verificationScope`. Khi cấu hình Lot lỗi/chưa xác minh, `configuredLot = null`. Trường này **không xác nhận** phiên bản đang triển khai trên Windows, broker lot step, lệnh thực tế hoặc cho phép LIVE.
- Việc đưa Auto Lot thật vào V6 cần một thay đổi riêng, được đánh giá chính sách rủi ro và kiểm thử ngoại tuyến trước. Không bật bằng cách sửa cờ hiển thị và không tự thay đổi `BOT_MODE`, ARM, lệnh MT5 hay cấu hình địa phương.

## 4. Chọn Bot, SL/TP & Quản lý Vị thế Thống nhất
- **Trạng thái thị trường:** `TREND_UP`, `TREND_DOWN`, `RANGE`, `TRANSITION`, `UNKNOWN` (cập nhật theo nến M15 đóng mới).
- **SL ban đầu:** Cấu trúc M5 `6–8` giá (`1 giá = 1 USD/oz`). Vượt `8` giá -> `WAIT_PULLBACK` (thời hạn hiệu lực `60 phút`).
- **TP:** Trước cản đối diện H1/H4 gần nhất (kể cả sát entry `<= 0.50` giá; R:R ròng `>= 1.6` Trend/Sweep, `>= 1.25` Sideway; dự phòng `2.2R` khi open-air). Không tự đổi TP sau khi vào lệnh.
- **Quản lý vị thế (`evaluate_position_management_step`):** Dùng chung cho LIVE/DEMO/Backtest. Dời SL theo cấu trúc M5 cả trước và sau BE; kéo BE tại `1R` ban đầu (bù chi phí); khóa cực trị `10` giá khi M15 chạy nhanh; SL chỉ dời theo hướng bảo vệ, không tự đóng lệnh khi đổi regime hay đảo chiều.

## 5. Backtest & Giao diện
- Backtest dùng `FIXED_LOT`, tính P/L theo `trade_contract_size` / tick value và ghi realized P/L theo thời điểm đóng lệnh (`exitTs`).
- Khi mất kết nối MT5, giao diện trả `DATA_UNAVAILABLE / WAITING_FOR_MT5` (không sinh giá hoặc SL/TP giả định).
