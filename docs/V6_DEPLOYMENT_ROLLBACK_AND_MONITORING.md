# MASTER-XAUUSD V6 — Hướng dẫn Triển khai, Bảo mật, Rollback & Giám sát (M5)

## 1. Bảo mật & Tách biệt Runtime (SEC-01)
- Tuyệt đối không lưu `password`, `token`, `otp`, `sessionToken` xuống `.runtime/active-mt5-account.json` hoặc `git`.
- Phân quyền API bắt buộc `x-v6-control-token`:
  - `ZIQ_V6_READONLY_TOKEN` (hoặc OTP role `READ_ONLY`): chỉ xem `GET /health`, `GET /api/v1/mt5/status`.
  - `ZIQ_V6_CONTROL_TOKEN` (hoặc OTP role `CONTROL`): mới được gọi `POST` điều khiển; hỗ trợ chống replay qua `x-v6-nonce` và `x-v6-timestamp` (`±300s`).
- Khởi động luôn ở trạng thái an toàn `PAUSE + DISARMED` (`liveArmed=false`, `autoBotState.enabled=false`, `positiveDcaConfig.enabled=false`).

## 2. Đóng gói, Backup & Rollback (SEC-02)
1. Sinh manifest và SHA-256 checksum trước khi triển khai:
   `node scripts/package-v6-release.mjs`
2. Backup thư mục `.runtime/` hiện hành trên máy Windows trước khi ghi đè mã nguồn.
3. Đối chiếu SHA-256 trên máy Windows sau khi giải nén; chạy kiểm tra read-only:
   `python scripts/verify-windows-mt5-readonly.py`
4. Nếu có bất kỳ sai lệch nào, khôi phục bản backup mã nguồn + `.runtime/` và kiểm tra `git checkout v6-snapshot-20261118` (hoặc tag release trước đó).

## 3. Giám sát & Khôi phục sau sự cố (SEC-03 & SEC-04)
- Theo dõi liên tục: kết nối MT5, độ tươi quote UTC, trạng thái `AUTO`/`ARM`, số vị thế đang mở, `pending_orders` (`orders_get`), `STATE_UNVERIFIED`, `reconcileFreezeDca`, `dcaUncertainFreeze`, lỗ ngày thực tế và `configIntegrityState`.
- Sau mất điện / crash / timeout: hệ thống không tự mở lại `AUTO` hoặc `ARM LIVE`; mọi lệnh `RECONCILIATION_PENDING` hoặc `uncertain` đều khóa gửi trùng tự động cho tới khi được đối soát.
