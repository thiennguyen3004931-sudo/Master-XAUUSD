# GO_LIVE_CHECKLIST.md — Các bước BẠN tự làm để bật live

Làm tuần tự. Không bỏ bước. Mỗi bước có tiêu chí "xong khi".

## A. Dọn sự cố bảo mật (bắt buộc, làm trước tiên)

- [ ] A1. @BotFather → `/revoke` token bot cũ; tạo token mới. *Xong khi:* token cũ báo `401 Unauthorized`.
- [ ] A2. Đổi mật khẩu master + investor của tài khoản MT5 LIVE cũ; bật 2FA client portal broker; kiểm tra lịch sử đăng nhập lạ. Cân nhắc dùng tài khoản LIVE **mới** cho bot.
- [ ] A3. Đảm bảo không còn tunnel công khai nào tới bảng điều khiển.
- [ ] A4. Quyết định có viết lại lịch sử git không (SECURITY.md §6, DECISIONS D-009). Cân nhắc chuyển repo sang **private**.
- [ ] A5. Review và merge PR `hardening/go-live` sau khi CI xanh.

## B. Chuẩn bị VPS

- [ ] B1. Cài đặt theo RUNBOOK §1 (user riêng, firewall, RDP giới hạn IP, đồng bộ giờ).
- [ ] B2. Tạo `.env` (chỉ trên VPS), khóa quyền file (SECURITY.md §3). Giữ `XAUUSD_DRY_RUN=true`.
- [ ] B3. Đặt `V6_BROKER_UTC_OFFSET_HOURS`, `ZIQ_TG_MASTER_SECRET`, `ZIQ_V6_CONTROL_TOKEN`, `TELEGRAM_BOT_TOKEN` (mới), `TELEGRAM_CHAT_ID`, `XAUUSD_TELEGRAM_FLATTEN_PIN`.
- [ ] B4. Tạo `config/news-blackout.json` cho 2–4 tuần tới; đặt nhắc việc cập nhật hằng tuần.
- [ ] B5. `python -m unittest discover -s tests -p "test_v6_*.py"` → `OK`.
- [ ] B6. Bật task health check + Telegram listener; gửi `/status` và nhận trả lời.

## C. Backtest dữ liệu thật

- [ ] C1. Xuất ≥ 12 tháng M5 từ MT5 và chạy backtest (BACKTEST_REPORT §4), cả kịch bản chi phí thực tế và stress.
- [ ] C2. Kết quả đạt tiêu chí BACKTEST_REPORT §4. *Nếu không đạt: dừng ở đây.*

## D. Quyết định về latch emergency-stop (AUDIT B-1, DECISIONS D-011)

- [ ] D1. Hiện tại main chặn **mọi lệnh mới** bằng latch quarantine. Quyết định cơ chế release bạn chấp nhận (và nhờ thực hiện trong một PR riêng), nếu không bot chỉ quản lý lệnh mở tay.

## E. DRY_RUN trên tài khoản DEMO (≥ 3 ngày giao dịch)

- [ ] E1. Đăng nhập terminal bằng tài khoản **DEMO**, `XAUUSD_DRY_RUN=true`, bật Auto trên web.
- [ ] E2. Mỗi ngày đọc `.runtime\logs\v6-guard.jsonl`: các tín hiệu xuất hiện, lý do bị chặn hợp lý (tin, rollover, spread…), không có lỗi lặp lại.
- [ ] E3. Thử kill switch: `on` → web báo chặn; `off`; thử `/kill` từ Telegram.

## F. Chạy DEMO thật (≥ 20 ngày giao dịch hoặc ≥ 30 lệnh)

- [ ] F1. `XAUUSD_DRY_RUN=false` (vẫn DEMO). `XAUUSD_SIZING_MODE=RISK_PERCENT`, `XAUUSD_RISK_PER_TRADE_PCT=0.5` trong 1 tuần đầu.
- [ ] F2. Kiểm tra mỗi lệnh: có SL trên broker, lot ≤ mức 1%, cảnh báo Telegram khi khớp lệnh.
- [ ] F3. Diễn tập: tắt mạng 2 phút → bot tự kết nối lại, không gửi trùng; khởi động lại VPS khi có lệnh mở → state đồng bộ, SL giữ nguyên; `--flatten --confirm-flatten` đóng hết vị thế demo.
- [ ] F4. Cố ý chạm giới hạn: đặt tạm `XAUUSD_MAX_DAILY_LOSS_PCT=0.5` trên demo → xác nhận bot ngừng vào lệnh + có cảnh báo; trả lại 3.0.
- [ ] F5. So sánh kết quả demo với backtest cùng giai đoạn (win rate, PF, trượt giá thực tế). Chênh lệch lớn ⇒ dừng, tìm nguyên nhân.

## G. Bật LIVE với khối lượng nhỏ nhất

- [ ] G1. Nạp số vốn bạn chấp nhận mất. Đăng nhập terminal bằng tài khoản LIVE; `MT5_PASSWORD` để trống nếu terminal tự đăng nhập.
- [ ] G2. Đặt trong `.env`: `XAUUSD_DRY_RUN=false`, `XAUUSD_LIVE=true`, `XAUUSD_CONFIRM_LIVE=yes`, `XAUUSD_RISK_PER_TRADE_PCT=0.25`, `XAUUSD_MAX_OPEN_POSITIONS=1`, `XAUUSD_MAX_TOTAL_VOLUME_LOTS=0.01`, `XAUUSD_MAX_DAILY_LOSS_PCT=1.5`, `XAUUSD_MAX_WEEKLY_LOSS_PCT=3`.
- [ ] G3. Trên web: kết nối tài khoản LIVE (về PAUSE + DISARMED) → ARM LIVE riêng → bật Auto. Theo dõi trực tiếp 1–2 lệnh đầu.
- [ ] G4. Sau mỗi tuần không có sự cố và kết quả cùng chiều với demo, tăng **một** tham số một bậc: 0.01 → 0.02 lot; rủi ro 0.25% → 0.5% → 0.75% → 1.0%; 1 → 2 → 3 vị thế. Không bao giờ vượt trần cứng (1% / 1.5% / 3% / 6%).
- [ ] G5. Dừng ngay (kill switch) và quay lại bước F nếu: drawdown > 5%, 2 sự cố kỹ thuật trong 1 tuần, hoặc slippage trung bình > 0.20 USD.

## H. Vận hành liên tục

- [ ] Hằng tuần: cập nhật lịch tin, đọc log, đối chiếu với backtest.
- [ ] 90 ngày: xoay vòng secret (SECURITY.md §4).
- [ ] Ghi nhật ký mọi thay đổi cấu hình (ngày, giá trị cũ → mới, lý do).
