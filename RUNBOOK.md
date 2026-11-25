# RUNBOOK.md — Vận hành bot XAUUSD V6 trên Windows VPS

Runtime được hướng dẫn: **V6** (`CHAY_NHANH_1_CHAM.bat` → `scripts/xauusd-standalone-server.mjs` → `scripts/mt5-direct-probe.py`). Không chạy đồng thời stack Phase7C (bridge FastAPI) trên cùng tài khoản.

## 1. Cài đặt

Yêu cầu: Windows Server 2019+/Windows 10+, ≥ 2 vCPU, 4 GB RAM, IP tĩnh, đồng hồ đồng bộ NTP.

1. Tạo user Windows riêng `xauusd-bot` (xem SECURITY.md §3). Cấu hình firewall/RDP theo SECURITY.md §2.
2. Cài **MetaTrader 5** của broker, đăng nhập tài khoản (**DEMO trước**), bật *Tools → Options → Expert Advisors → Allow algorithmic trading*, thêm `XAUUSD.G` (hoặc mã vàng của broker) vào Market Watch.
3. Cài **Python 3.11 64-bit** (tick "Add to PATH") và **Node.js 22 LTS**.
4. Lấy mã nguồn đúng phiên bản (tag/commit đã duyệt):
   ```powershell
   git clone https://github.com/<owner>/Master-XAUUSD.git C:\xauusd
   cd C:\xauusd
   git checkout <commit-đã-duyệt>
   python -m pip install MetaTrader5==5.0.5735
   ```
5. Đồng bộ giờ: `w32tm /resync`. Xác định offset giờ server broker so với UTC (thường +2 mùa đông, +3 mùa hè ở broker châu Âu: so sánh giờ trong cửa sổ Market Watch với giờ UTC).
6. Tạo `.env` ở `C:\xauusd\.env` từ `.env.example` (chỉ tên biến). Tối thiểu:
   ```ini
   XAUUSD_DRY_RUN=true
   V6_BROKER_UTC_OFFSET_HOURS=2
   TELEGRAM_BOT_TOKEN=<token MỚI>
   TELEGRAM_CHAT_ID=<chat id của bạn>
   ZIQ_TG_MASTER_SECRET=<chuỗi ngẫu nhiên>
   ```
   Lưu ý: server Node **không tự đọc `.env`**; guard Python đọc `.env` cho các biến `XAUUSD_*`/`TELEGRAM_*`. Biến của server (`ZIQ_*`, `V6_BROKER_UTC_OFFSET_HOURS`) hãy đặt thành biến môi trường của user `xauusd-bot` (*System Properties → Environment Variables*) hoặc trong file `.bat` khởi động riêng của bạn.
7. Tạo lịch tin: `copy config\news-blackout.example.json config\news-blackout.json`, điền các mốc NFP/CPI/FOMC/PCE… của 1–4 tuần tới **theo giờ UTC** (nguồn: bls.gov, federalreserve.gov), đặt `validUntil`. Cập nhật mỗi tuần. Hết hạn ⇒ bot tự chặn lệnh mới.
8. Kiểm tra offline: `python -m unittest discover -s tests -p "test_v6_*.py"` phải `OK`.

## 2. Khởi động / dừng

| Việc | Lệnh |
|---|---|
| Khởi động | Chạy `CHAY_NHANH_1_CHAM.bat` (mở web `http://localhost:5717/`). Hệ thống khởi động ở **PAUSE + DISARMED**; guard ở **DRY_RUN**. |
| Kiểm tra chế độ | Trên web/API, payload probe có `goLiveGuard: {dryRun, liveConfirmed, killSwitchActive}`; hoặc `python scripts\v6_kill_switch.py status`. |
| Dừng mềm (chặn lệnh mới, vẫn quản lý SL) | `python scripts\v6_kill_switch.py on --reason "dung"` |
| Dừng hẳn tiến trình | Đóng cửa sổ console, hoặc: `Get-NetTCPConnection -LocalPort 5717,3711 -State Listen \| % { Stop-Process -Id $_.OwningProcess -Force }` |
| Chạy như dịch vụ | Task Scheduler: tác vụ "At startup", user `xauusd-bot`, action `C:\xauusd\CHAY_NHANH_1_CHAM.bat`, "Restart on failure every 1 minute". (Hoặc NSSM: `nssm install xauusd-v6 C:\Program Files\nodejs\node.exe C:\xauusd\scripts\xauusd-standalone-server.mjs`.) MT5 terminal phải chạy trong cùng phiên user. |
| Health check | Task Scheduler mỗi 5 phút: `python C:\xauusd\scripts\v6_healthcheck.py --max-age 600 --alert` (exit 1 = heartbeat cũ ⇒ cảnh báo Telegram). Heartbeat chỉ được ghi khi có chu kỳ probe (bot đang chạy). Trường `warnings` liệt kê cấu hình yếu (VD `TELEGRAM_VAULT_KEY_DEFAULT`) nhưng không đổi exit code. |
| Lệnh Telegram (tùy chọn) | Task "At startup": `python C:\xauusd\scripts\v6_telegram_kill_listener.py` → `/status`, `/kill`, `/kill_flatten <PIN>`, `/resume <PIN>` (PIN = `XAUUSD_TELEGRAM_FLATTEN_PIN`; không đặt PIN ⇒ flatten/resume qua Telegram bị tắt). |

## 3. Đọc log

| File | Nội dung |
|---|---|
| `.runtime\logs\v6-guard.jsonl` | Mỗi dòng 1 JSON: `ENTRY_BLOCKED_BY_GO_LIVE_GUARD`, `ACTION_BLOCKED_BY_EXECUTION_MODE`, `ACTION_RESULT`, `WEEKLY_LOSS_GATE_BLOCK`, `KILL_SWITCH_*`, `MT5_CONNECT_FAILED`. Đã che secret và số tài khoản. |
| `.runtime\v6-heartbeat.json` | Thời điểm chu kỳ cuối, chế độ, kill switch. |
| `.runtime\v6-daily-risk-state.json` | Mốc vốn đầu ngày, lỗ ngày, cờ chạm trần (bền qua restart). |
| `.runtime\v6-uncertain-entry-state.json` | Lệnh "đang bay"/không chắc chắn ⇒ bot đóng băng lệnh mới cho tới khi đối soát. |
| Console của server | Log của server Node và notifier Telegram. |
| MT5 → tab *Journal* / *Experts* | Phản hồi của broker. |

Xem nhanh 20 sự kiện chặn gần nhất:
```powershell
Get-Content .runtime\logs\v6-guard.jsonl -Tail 20
```

## 4. Xử lý sự cố

| Triệu chứng / status | Nguyên nhân | Cách xử lý |
|---|---|---|
| `DRY_RUN_NO_BROKER_MUTATION` | Đang DRY_RUN (mặc định). | Chủ ý. Muốn chạy demo thật: `XAUUSD_DRY_RUN=false` (GO_LIVE_CHECKLIST). |
| `BLOCKED_LIVE_NOT_CONFIRMED` | Tài khoản REAL nhưng thiếu `XAUUSD_LIVE=true` hoặc `XAUUSD_CONFIRM_LIVE=yes`. | Chỉ bật khi đã qua checklist. |
| `BLOCKED_EMERGENCY_STOP_LATCH` | Đã bấm Emergency Stop trên web (latch `OPERATOR_EMERGENCY_STOP` và/hoặc `.runtime\v6-stop-intent.flag`), hoặc latch hỏng/sai tài khoản. | Đối chiếu vị thế trên MT5, rồi chạy `python scripts\v6_emergency_stop_release.py status/release ...` (mục 5b). Latch hỏng/sai tài khoản: kiểm tra file rồi chuyển sang chỗ khác bằng tay. |
| `BLOCKED_NEWS_CALENDAR_UNAVAILABLE` / `_EXPIRED` | Thiếu/hết hạn `config/news-blackout.json`. | Cập nhật lịch tin. |
| `BLOCKED_NEWS_BLACKOUT` / `BLOCKED_LOW_LIQUIDITY` | Đang trong cửa sổ tin / rollover / cuối tuần. | Chờ. |
| Lệnh bị broker từ chối `REQUOTE`/`PRICE_CHANGED` liên tục | Deviation quá chặt khi thị trường chạy nhanh. | Tăng `XAUUSD_ENTRY_DEVIATION_POINTS` (tối đa 100) hoặc `XAUUSD_CLOSE_DEVIATION_POINTS` (tối đa 300); khởi động lại. |
| Cảnh báo `SLIPPAGE_HIGH` | Giá khớp lệch giá yêu cầu quá `XAUUSD_MAX_SLIPPAGE_USD`. | Xem log `v6-guard.jsonl`; nếu lặp lại, giảm `XAUUSD_ENTRY_DEVIATION_POINTS`, tránh giờ tin, hoặc đổi broker/server. |
| `BLOCKED_SPREAD_TOO_WIDE` | Spread > `XAUUSD_MAX_SPREAD_USD` (0.50) hoặc > `maxSpreadPoints`. | Chờ; kiểm tra broker. |
| `BLOCKED_RISK_PER_TRADE` | Lot tối thiểu vẫn vượt 1% với SL hiện tại (vốn nhỏ) hoặc FIXED_LOT quá lớn. | Giảm lot / tăng vốn / dùng `RISK_PERCENT`. |
| `BLOCKED_PORTFOLIO_RISK_LIMIT`, `BLOCKED_MAX_OPEN_POSITIONS`, `BLOCKED_MAX_TOTAL_VOLUME` | Chạm giới hạn danh mục. | Chủ ý. |
| `BLOCKED_DAILY_LOSS_LIMIT` / `BLOCKED_WEEKLY_LOSS_LIMIT` | Chạm lỗ ngày 3% / tuần 6% (có cảnh báo Telegram). | Tự mở lại ngày/tuần sau. Không xóa file state để "reset". |
| `BLOCKED_*_HISTORY_UNVERIFIED`, `BLOCKED_BROKER_UTC_OFFSET_UNVERIFIED` | Không đọc được lịch sử deal hoặc chưa đặt `V6_BROKER_UTC_OFFSET_HOURS`. | Đặt offset, kiểm tra terminal đã tải lịch sử (tab History → All history). |
| `BLOCKED_CLOCK_SKEW` | Đồng hồ máy chậm hơn server broker > 5s. | `w32tm /resync`; kiểm tra offset. |
| `BLOCKED_UNCERTAIN_PREVIOUS_ENTRY` / `RECONCILIATION_PENDING` | Lệnh trước có thể đã tới broker nhưng mất phản hồi. | Kiểm tra vị thế/lệnh chờ trong MT5; chỉ xóa mục tương ứng trong `.runtime\v6-uncertain-entry-state.json` **sau khi** xác minh. Không gửi lại lệnh thủ công trùng. |
| `MT5_TERMINAL_OR_LOGIN_FAILED` (cảnh báo `MT5_CONNECT_FAILED`) | Terminal đóng/mất mạng. Probe đã thử lại 3 lần có backoff. | Mở lại terminal, kiểm tra mạng; chu kỳ sau tự kết nối lại. |
| Heartbeat cũ | Server Node dừng hoặc treo. | Khởi động lại task; xem console. |

## 5. Kill switch

1. Chặn lệnh mới ngay: `python scripts\v6_kill_switch.py on --reason "<lý do>"` (hoặc tạo file `.runtime\KILL_SWITCH`, hoặc `XAUUSD_KILL_SWITCH=1`, hoặc Telegram `/kill`). Quản lý SL/BE của lệnh đang mở vẫn hoạt động (khi không DRY_RUN).
2. Đóng toàn bộ vị thế vàng: `python scripts\v6_kill_switch.py on --flatten --confirm-flatten --broker-symbol XAUUSD.G` (hoặc Telegram `/kill_flatten <PIN>`). Kết quả `KILL_SWITCH_FLATTENED` hoặc `KILL_SWITCH_FLATTEN_INCOMPLETE` (còn vị thế ⇒ đóng tay trong MT5). Flatten **không** hủy lệnh chờ (V6 chỉ dùng lệnh market) — kiểm tra tab Trade.
   Kết quả liệt kê `remainingGoldPendingOrders` / `pendingOrderTickets`: bot chỉ dùng lệnh market nên không tự hủy lệnh chờ. Nếu có lệnh chờ vàng (đặt tay), xóa chúng trong terminal MT5. Không đọc được sổ lệnh (`pendingOrdersVerified=false`) cũng tính là chưa xong.
3. Phương án cuối: tắt nút *Algo Trading* trên MT5 hoặc đóng terminal (SL đã nằm trên server broker).
4. Mở lại: `python scripts\v6_kill_switch.py off` (không tự gỡ latch emergency-stop riêng của V6).

## 5b. Gỡ Emergency Stop của web (D-011)

Nút Emergency Stop trên web ghi latch và cờ stop-intent; cả hai chặn lệnh mới cho tới khi bạn gỡ trên máy chạy bot:

```powershell
python scripts\v6_emergency_stop_release.py status  --login <LOGIN> --server <SERVER>
python scripts\v6_emergency_stop_release.py release --login <LOGIN> --server <SERVER> --operator "<tên bạn>" --reason "đã đối chiếu vị thế" --confirm
```

Lệnh `release` từ chối nếu còn lệnh uncertain bị đóng băng cho tài khoản (đối chiếu trên MT5 trước), nếu latch thuộc tài khoản khác, hoặc nếu latch hỏng. Mỗi lần gỡ ghi sự kiện `EMERGENCY_STOP_RELEASED` vào `v6-guard.jsonl`. Mở khóa này **không** bật live: vẫn cần `XAUUSD_DRY_RUN=false`, `XAUUSD_LIVE=true` và `XAUUSD_CONFIRM_LIVE=yes`.

## 6. Rollback

1. Bật kill switch (mục 5.1), chờ không còn lệnh "in-flight".
2. Dừng tiến trình (mục 2).
3. `git fetch && git checkout <commit/tag trước>`; giữ nguyên `.runtime\` và `.env` (state lỗ ngày, vị thế, ARM).
4. `python -m unittest discover -s tests -p "test_v6_*.py"`.
5. Khởi động lại ở DRY_RUN, kiểm tra heartbeat + log, rồi mới đổi lại chế độ trước đó.
6. Ghi lại sự cố (thời điểm, status, quyết định) vào nhật ký vận hành.

## 7. Bảo trì định kỳ

- Hằng tuần: cập nhật lịch tin; xem `v6-guard.jsonl` các lệnh bị chặn; so sánh kết quả demo/live với backtest.
- Hằng tháng: `git pull` bản đã duyệt + chạy test; Windows Update ngoài giờ giao dịch (cuối tuần), bật kill switch trước khi khởi động lại.
- 90 ngày: xoay vòng secret (SECURITY.md §4).
