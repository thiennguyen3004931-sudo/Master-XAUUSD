# SECURITY.md — Chính sách bảo mật vận hành bot XAUUSD

## 0. Sự cố đang mở (xem AUDIT.md S-1, S-2)

- Token Telegram bot cũ **đã lộ công khai** → thu hồi bằng @BotFather (`/revoke`), tạo token mới, chỉ lưu trong `.env`.
- Số login/server LIVE, URL tunnel, chat ID nằm trong lịch sử git công khai → đổi mật khẩu MT5 (master + investor), bật 2FA cho client portal của broker, kiểm tra không còn tunnel nào chạy.

## 1. Quyền của "API key" trên MT5

MT5 không có API key kiểu sàn crypto; bot đăng nhập bằng **login + mật khẩu** của tài khoản giao dịch.

| Thông tin | Quyền | Bot cần? |
|---|---|---|
| Mật khẩu **master** (trading) | Đặt/sửa/đóng lệnh. **Không** rút tiền được (rút tiền chỉ qua client portal của broker). | Có (chỉ khi chạy live). Tốt nhất để terminal tự đăng nhập, **không** truyền mật khẩu cho bot. |
| Mật khẩu **investor** | Chỉ xem. | Dùng cho dashboard/giám sát chỉ-đọc. |
| Tài khoản **client portal** (nạp/rút) | Rút tiền, đổi thông tin. | **Không bao giờ** đưa cho bot hoặc lưu trên VPS. Bật 2FA, whitelist ví/ngân hàng rút tiền nếu broker hỗ trợ. |
| Token Telegram bot | Gửi tin nhắn / nhận lệnh `/kill`. | Tùy chọn. Bot Telegram riêng cho bot giao dịch, không dùng chung. |
| `MT5_API_KEY` (bridge Phase7C), `ZIQ_V6_CONTROL_TOKEN` (web V6) | Điều khiển bot cục bộ. | Có; ≥ 32 ký tự ngẫu nhiên. |

Nếu sau này chuyển sang sàn có API key: chỉ bật quyền **trade**, **tắt quyền withdraw/transfer**, bật **IP whitelist** chỉ IP tĩnh của VPS.

## 2. Mạng và IP whitelist

- Bridge, API V6 và web chỉ bind `127.0.0.1` (mặc định). **Không** mở cổng 3711/5717/8765 ra Internet; không bật `V6_ALLOW_LAN_WEB` trên VPS.
- Truy cập từ xa: RDP qua VPN/WireGuard hoặc RDP chỉ cho phép IP nhà bạn trong Windows Firewall / firewall của nhà cung cấp VPS. Đổi cổng RDP mặc định, bật Network Level Authentication, khóa tài khoản sau nhiều lần đăng nhập sai.
- Chỉ cho phép outbound tới server broker, `api.telegram.org`, GitHub (cập nhật), Windows Update.
- Không dùng tunnel công khai (Cloudflare/ngrok) cho bảng điều khiển.

## 3. Lưu secret trên VPS (Windows)

1. Tạo user Windows riêng (vd `xauusd-bot`), không phải Administrator, dùng để chạy MT5 + bot (Task Scheduler "Run whether user is logged on or not").
2. Secret chỉ nằm trong `.env` ở thư mục gốc repo (đã `.gitignore`) hoặc biến môi trường của user đó. Không bao giờ đặt trong code, `config/`, `.runtime/*.json` hay HTML.
3. Khóa quyền file `.env` chỉ cho user bot và Administrators:
   ```powershell
   icacls .env /inheritance:r /grant:r "xauusd-bot:(R,W)" "Administrators:F"
   ```
4. Đặt `ZIQ_TG_MASTER_SECRET` (≥ 32 ký tự ngẫu nhiên) để mã hóa token Telegram lưu trong `.runtime` không dùng khóa mặc định trong code.
5. Bật BitLocker cho ổ đĩa VPS nếu nhà cung cấp hỗ trợ.
6. Không để mật khẩu MT5 trong `.env` nếu terminal đã tự đăng nhập (`MT5_PASSWORD` để trống).
7. Log của guard (`.runtime/logs/v6-guard.jsonl`), heartbeat và cảnh báo đã che secret và số tài khoản. Khi gửi log cho người khác vẫn nên kiểm tra lại.

Tạo chuỗi ngẫu nhiên:
```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## 4. Xoay vòng secret

| Secret | Chu kỳ | Cách xoay |
|---|---|---|
| Token Telegram | Ngay khi nghi lộ; định kỳ 90 ngày | BotFather `/revoke` → cập nhật `TELEGRAM_BOT_TOKEN` trong `.env` → khởi động lại server và listener → gửi `/status` thử. |
| Mật khẩu MT5 master/investor | 90 ngày hoặc khi đổi VPS/người vận hành | Đổi trong terminal MT5 (Tools → Options → Server → Change) → đăng nhập lại terminal → chạy probe ở DRY_RUN để xác nhận kết nối. |
| `ZIQ_V6_CONTROL_TOKEN`, `MT5_API_KEY` | 90 ngày | Sinh chuỗi mới → cập nhật `.env`/`.runtime/v6-control-token.txt` → khởi động lại → ghép nối lại thiết bị. |
| `ZIQ_TG_MASTER_SECRET` | Khi xoay token Telegram | Đổi biến → nhập lại token Telegram trên giao diện (token cũ mã hóa bằng khóa cũ sẽ không đọc được nữa). |
| `XAUUSD_TELEGRAM_FLATTEN_PIN` | 90 ngày | Đổi trong `.env`, khởi động lại listener. |

## 5. Kiểm soát trong repo

- CI `go-live-hardening-ci.yml`: gitleaks quét cây làm việc và các commit mới của PR, pip-audit, pnpm audit (prod, mức high), `scripts/security/check-private-secrets.mjs --tracked`.
- `.gitignore` chặn `.env`, `.env.*`, `.runtime/`, `data/`, `config/news-blackout.json`.
- Trước khi commit: `gitleaks git . -c .gitleaks.toml --redact --log-opts="origin/main..HEAD"`.

## 6. Viết lại lịch sử git (không thể đảo ngược)

**Chủ repo đã chọn không viết lại lịch sử (DECISIONS D-009, 2026-11-25).** Token Telegram cũ và thông tin tài khoản cũ vẫn còn trong lịch sử public, nên thu hồi token và đổi mật khẩu MT5 (mục 1) là bắt buộc. Lệnh dưới đây chỉ để tham khảo nếu sau này đổi ý.

Chỉ làm **sau khi** đã thu hồi token. Lệnh đã chuẩn bị (chạy trên bản clone mirror mới, thông báo cho mọi người đang clone repo):

```bash
git clone --mirror https://github.com/<owner>/Master-XAUUSD.git && cd Master-XAUUSD.git
pip install git-filter-repo
git filter-repo --invert-paths --path .runtime/ --path-glob '*.runtime/telegram-config.json'
# Thay chuỗi nhạy cảm còn lại trong mọi phiên bản file (tạo file replacements.txt, mỗi dòng: CHUỖI_CŨ==>REDACTED)
git filter-repo --replace-text replacements.txt
git push --force --mirror
```

Sau đó yêu cầu GitHub Support xóa cache các view commit cũ, và mọi người clone lại. Lưu ý: bản fork/clone của người khác vẫn giữ dữ liệu cũ, nên thu hồi token và đổi mật khẩu vẫn là bước bắt buộc.

## 7. Báo cáo lỗ hổng

Gửi riêng cho chủ repo (không mở issue công khai) kèm mô tả và cách tái hiện.
