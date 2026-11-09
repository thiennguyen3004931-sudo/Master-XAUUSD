# Phase 7C Desktop Control

Desktop Control giữ Bridge và Web tách khỏi executor giao dịch:

- Mở shortcut `XAUUSD AI MASTER` sẽ khởi động Scheduled Task Bridge/Web khi cần và mở `/phase7c-control-center`.
- Bot không tự ARM khi chỉ mở giao diện.
- Nút `BẬT BOT` kiểm tra MT5 DEMO, Algo Trading, zero XAUUSD position và lot đã lưu; khởi động ở `PAUSE`, chờ Trend/Sideway/Telegram/lot active cùng READY rồi mới chuyển `AUTO`.
- Telegram gửi panel khởi động ở `PAUSE`, sau đó gửi thông báo khi Web/API chuyển sang `AUTO`.
- Nút `DỪNG BOT` chuyển `PAUSE` trước; bị khóa khi còn vị thế XAUUSD để không bỏ lệnh đang được quản lý.
- Panel EA MT5 luôn read-only và giữ `ORDER PERMISSION = NONE`.

## Cài đặt trên Windows

Giữ Bot ở `PAUSE`, bảo đảm không có vị thế XAUUSD, rồi chạy PowerShell Administrator:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-phase7c-desktop-control-local.ps1
```

Script tạo shortcut Desktop, chuyển executor Scheduled Task sang manual button-only và cài/compile lại MT5 Decision Panel. Sau đó mở shortcut và bấm `BẬT BOT` trên Control Center.

## Safety contract

Desktop/Web lifecycle chỉ hoạt động qua localhost Windows. API từ chối tài khoản real/contest, MT5 offline, Algo Trading tắt, Telegram chưa cấu hình hoặc có vị thế XAUUSD khi clean-start. Nếu startup không đạt READY trong thời hạn, hệ thống giữ `PAUSE` và dừng executor.
