# FINAL PRODUCTION ACCEPTANCE — SOURCE, OFFLINE & READ-ONLY (MASTER-XAUUSD V6)

- **Phạm vi:** Nguồn mã, kiểm thử Unit/Integration offline, Mock Broker, Fault Injection & kiểm tra Read-Only (không tổ chức nghiệm thu DEMO theo chỉ đạo của chủ sở hữu).
- **Trạng thái tổng hợp:**
  - `SOURCE_READY`: **ĐẠT** (139/139 bài kiểm thử Python + 10/10 bài kiểm thử Node.js + `V6_READINESS_SOURCE_SAFETY_CONTRACT=PASS`, `test ! -e .runtime` sạch).
  - `OFFLINE_VERIFIED`: **ĐẠT** (đã kiểm chứng P0-01..P0-06, chiến lược M2 BUY/SELL, mô phỏng Backtest Equity/Margin/Stop-Out `BT-05` Issue #52, crash/restart/corrupted-config rollback).
  - `RUNTIME_VERIFIED`: **BLOCKED (CHỜ XÁC MINH TRÊN MÁY WINDOWS CÓ MT5)** — Môi trường sandbox Linux không có quyền truy cập host Windows và terminal MT5 thật (`scripts/verify-windows-mt5-readonly.py` trả `BLOCKED_NON_WINDOWS_HOST`).
  - `LIVE_BLOCKED`: **CÓ** (`V6_LIVE_AUTHORIZATION=NOT_GRANTED`).
- **Kết luận:** **NO-GO (Chưa đề xuất LIVE_CANDIDATE)** cho tới khi chủ sở hữu chạy `python scripts/verify-windows-mt5-readonly.py` trên máy Windows vận hành thật và xác nhận GitHub Actions CI xanh trên repository chính.
