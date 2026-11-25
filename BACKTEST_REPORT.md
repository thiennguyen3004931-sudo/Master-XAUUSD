# BACKTEST_REPORT.md

> **Kết luận ngắn (cập nhật 2026-11-25):** Đã chạy engine backtest của bot trên **6 tháng dữ liệu M5 thật** (XAUUSD, 26/03/2026 → 25/09/2026, 35.954 nến, mục 2b). **Kết quả âm ở mọi chế độ** (PF 0.61–0.85 kể cả khi gần như không phí; AUTO_REGIME PF 0.79, win rate 22.6%, expectancy −0.09R). Theo dữ liệu này, chiến lược V6 **chưa có lợi thế** trong giai đoạn đó. Không đổi logic chiến lược (quy tắc dự án), chỉ báo cáo. Phần dữ liệu tổng hợp (mục 2) chỉ chứng minh phần tính chi phí hoạt động đúng.

## 1. Phương pháp

- Engine: `run_historical_backtest_on_mt5()` trong `scripts/mt5-direct-probe.py`, dùng cùng `evaluate_entry()` và `evaluate_position_management_step()` với chạy live; không look-ahead, không tự đóng lệnh sau N nến, lệnh còn mở cuối kỳ tách riêng; Win / BE / Loss tách riêng.
- Runner offline: `scripts/v6_offline_backtest.py` (mới) nạp nến M5 từ CSV hoặc sinh dữ liệu tổng hợp, gộp thành M15/H1/H4 theo UTC.
- Chế độ: `AUTO_REGIME`, minConfidence 85, lot cố định 0.02, vốn 4.000 USD, 100 USD/1.00 giá/lot.
- Chi phí (mặc định của runner, thận trọng hơn mặc định cũ của engine):

| Chi phí | Giá trị | Ghi chú |
|---|---|---|
| Spread | 0.25 USD/oz (25 point) | Bid/Ask tách riêng cho BUY/SELL |
| Commission | 0.07 USD/oz khứ hồi (≈ 7 USD/lot) | |
| Slippage | 0.10 USD/oz khứ hồi | |
| Swap | 0 | Đặt `--swap` theo broker nếu giữ lệnh qua đêm |

- Độ phân giải: OHLC M5 (không có tick trong nến; nến mơ hồ chạm cả SL và TP được tính SL).

## 2. Kết quả trên dữ liệu tổng hợp (90 ngày, ~18.000 nến M5 mỗi seed)

| Seed | Số lệnh | Thắng / BE / Thua | Win rate | Profit factor | Expectancy (R) | Lãi ròng (giá) | Lãi ròng (USD, 0.02 lot) | Max DD | Chuỗi thua dài nhất |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 158 | 59 / 12 / 87 | 37.3% | 1.32 | 0.067 | +63.85 | +127.70 | 1.37% | 6 |
| 2 | 191 | 70 / 20 / 101 | 36.7% | 1.14 | 0.041 | +40.60 | +81.20 | 2.66% | 17 |
| 3 | 155 | 56 / 11 / 88 | 36.1% | 1.27 | 0.068 | +57.79 | +115.58 | 2.80% | 9 |
| 4 | 177 | 87 / 14 / 76 | 49.2% | 2.66 | 0.284 | +302.39 | +604.78 | 1.64% | 12 |
| 5 | 185 | 89 / 19 / 77 | 48.1% | 2.23 | 0.202 | +222.09 | +444.18 | 2.20% | 7 |

Ổn định theo thời gian (PF từng phần ba của giai đoạn): seed 1: 0.84 / 1.73 / 1.42; seed 2: 1.77 / 0.92 / 1.10; seed 3: 2.20 / 1.24 / 0.80; seed 4: 3.29 / 1.78 / 3.16; seed 5: 2.80 / 0.84 / 3.79. PF dao động mạnh giữa các giai đoạn (có giai đoạn < 1).

### Độ nhạy chi phí (seed 1)

| Kịch bản | Số lệnh | PF | Lãi ròng (USD) | Max DD |
|---|---|---|---|---|
| Gần như không phí (spread 0.05, không commission/slippage) | 152 | 1.94 | +308.08 | 1.21% |
| Chi phí thực tế (bảng trên) | 158 | 1.32 | +127.70 | 1.37% |

Chi phí giao dịch ăn **≈ 59%** lợi nhuận gộp ở kịch bản này. Với chiến lược SL 6–8 USD/oz, spread và trượt giá là yếu tố quyết định; chỉ nên chạy live ở broker có spread vàng trung bình ≤ 0.25 USD.

### Diễn giải

- Dữ liệu tổng hợp có các đoạn xu hướng kéo dài nên chiến lược theo xu hướng tự nhiên "thắng" trên đó. Các con số này **không** dự báo được kết quả thật.
- Điều kiểm chứng được: chi phí luôn làm kết quả xấu đi (có test `test_synthetic_backtest_reports_required_metrics_with_costs`), báo cáo có đủ lợi nhuận, max drawdown, win rate, profit factor, số lệnh, và engine chạy được ngoài MT5 (CI chạy smoke test mỗi PR).
- Báo cáo `Bao_Cao_Backtest_Va_Danh_Gia_Bot_XAUUSD_V6_3.xlsx` có sẵn trong repo (48 lệnh AUTO_REGIME, PF 2.68, "Thắng + BE" 77.1%, DD 3.15%) không ghi nguồn dữ liệu/khoảng thời gian và gộp BE vào tỷ lệ thắng, nên không dùng làm bằng chứng. 48 lệnh là quá ít để kết luận.

## 2b. Kết quả trên dữ liệu THẬT (6 tháng M5)

- Nguồn: mẫu miễn phí `XAUUSD_5m.csv` của getdata.finance (repo GitHub `getdata-finance/xauusd-5m-ohlcv-metals-historical-data`, giấy phép MIT), 35.954 nến M5, giờ UTC, 2026-03-26 → 2026-09-25. Đây không phải dữ liệu từ broker của bạn: spread/giờ máy chủ có thể khác, nên vẫn nên chạy lại bằng dữ liệu MT5 của bạn (mục 4).
- Cấu hình: như mục 1 (lot 0.02, vốn 4.000 USD, minConfidence 85).

| Chế độ | Chi phí | Số lệnh | Win rate | PF | Expectancy (R) | Lãi ròng (USD) | Max DD |
|---|---|---|---|---|---|---|---|
| AUTO_REGIME | gần như không phí (spread 0.05) | 173 | 22.5% | 0.85 | −0.064 | −147.40 | 9.35% |
| AUTO_REGIME | thực tế (0.25 / 0.07 / 0.10) | 164 | 22.6% | 0.79 | −0.094 | −208.30 | 9.34% |
| AUTO_REGIME | stress (0.40 / 0.07 / 0.20) | 162 | 22.2% | 0.70 | −0.140 | −310.10 | 10.75% |
| BOT_1_TREND | thực tế | 116 | 23.3% | 0.80 | −0.091 | −126.30 | 7.11% |
| BOT_2_SIDEWAY | thực tế | 156 | 23.1% | 0.80 | −0.094 | −186.82 | 8.41% |
| BOT_3_SWEEP | thực tế | 43 | 16.3% | 0.61 | −0.207 | −111.06 | 4.01% |

Chia 3 giai đoạn (AUTO_REGIME, chi phí thực tế): PF 0.66 (03–05/2026), 0.38 (05–07/2026), 1.36 (07–09/2026). Chuỗi thua dài nhất 10.

Đánh giá theo tiêu chí mục 4: **không đạt** (PF < 1.3, có giai đoạn PF < 0.9). Lệnh tái tạo:

```bash
python scripts/v6_offline_backtest.py --csv XAUUSD_5m.csv --mode AUTO_REGIME --spread 0.25 --commission 0.07 --slippage 0.10 --out bt_real.json
```

## 3. Ảnh hưởng của thay đổi quản trị rủi ro tới backtest

Nhánh này **không** đổi logic tín hiệu, điểm vào, SL hay TP. Trần cứng 1%/lệnh chỉ thay đổi **khối lượng** (lot bị giảm khi vượt trần), nên các chỉ số tính bằng giá (netPts, PF, win rate, số lệnh) không đổi; lãi/lỗ USD và DD% co lại tương ứng với lot. Bộ lọc tin/thanh khoản/spread có thể **bỏ bớt** lệnh khi chạy live; backtest hiện chưa mô phỏng bộ lọc lịch tin (không có lịch tin lịch sử).

## 4. Cách chạy lại trên dữ liệu MT5 của bạn (khuyến nghị trước khi live)

Trên máy Windows có MT5 (chỉ đọc, không đặt lệnh):

```powershell
python scripts\v6_export_mt5_history.py --symbol XAUUSD.G --days 365 --broker-utc-offset 2 --out data\xauusd_m5.csv
python scripts\v6_offline_backtest.py --csv data\xauusd_m5.csv --mode AUTO_REGIME --spread 0.25 --commission 0.07 --slippage 0.10 --swap 0.0 --out data\bt_auto.json
python scripts\v6_offline_backtest.py --csv data\xauusd_m5.csv --mode AUTO_REGIME --spread 0.40 --commission 0.07 --slippage 0.20 --out data\bt_auto_stress.json
```

Đề xuất tiêu chí chấp nhận (tự đặt ra, bạn có thể điều chỉnh):

| Tiêu chí | Ngưỡng |
|---|---|
| Số lệnh | ≥ 200 trên ≥ 12 tháng |
| Profit factor sau chi phí | ≥ 1.3 ở chi phí thực tế, ≥ 1.1 ở kịch bản stress |
| PF từng phần ba giai đoạn | không phần nào < 0.9 |
| Max drawdown (ở 1% rủi ro/lệnh) | ≤ 10% |
| Chuỗi thua dài nhất | ≤ 12 |
| Kết quả demo (GO_LIVE_CHECKLIST) | cùng chiều với backtest |

## 5. Paper/demo

Không chạy được demo trong môi trường làm việc (không có Windows/MT5). Toàn bộ đường đặt lệnh đã được kiểm thử với broker giả lập (491 test Python V6 + 49 test bridge). Kế hoạch demo nằm trong GO_LIVE_CHECKLIST.md.
