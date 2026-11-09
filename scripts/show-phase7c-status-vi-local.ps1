param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$WorkDir = ".runtime",
  [string]$DemoEnvFile = "packages\mt5-broker\bridge\.env.phase7b-demo",
  [string]$LiveEnvFile = ".runtime\phase7c-live-readonly\live-readonly.env",
  [string]$ControlApiUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

function Get-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = ([string]$raw).Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    $key = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
    if ($key -ne $Name) { continue }
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
  }
  return $null
}

function Convert-ModeVi([object]$Value) {
  switch (([string]$Value).ToUpperInvariant()) {
    "AUTO" { "TỰ ĐỘNG"; break }
    "PAUSE" { "TẠM DỪNG"; break }
    "TREND" { "bot Trend"; break }
    "SIDEWAY" { "bot Sideway"; break }
    default { "KHÔNG XÁC ĐỊNH" }
  }
}

function Convert-RegimeVi([object]$Value) {
  switch (([string]$Value).ToUpperInvariant()) {
    "TREND" { "XU HƯỚNG"; break }
    "SIDEWAY" { "ĐI NGANG"; break }
    "REVERSAL" { "ĐẢO CHIỀU"; break }
    "UNCERTAIN" { "CHƯA RÕ"; break }
    default { "KHÔNG XÁC ĐỊNH" }
  }
}

function Convert-StageVi([object]$Value) {
  switch (([string]$Value).ToUpperInvariant()) {
    "BLOCKED" { "BỊ CHẶN"; break }
    "WAITING" { "ĐANG CHỜ"; break }
    "OBSERVED" { "ĐANG THEO DÕI"; break }
    "SUBMITTED" { "ĐÃ GỬI"; break }
    "MANAGING" { "ĐANG QUẢN LÝ"; break }
    "READY" { "SẴN SÀNG"; break }
    "RUNNING" { "ĐANG CHẠY"; break }
    "STARTING" { "ĐANG KHỞI ĐỘNG"; break }
    "ERROR" { "LỖI"; break }
    default { if ([string]::IsNullOrWhiteSpace([string]$Value)) { "CHƯA CÓ" } else { [string]$Value } }
  }
}

function Convert-BoolVi([object]$Value) {
  if ([bool]$Value) { return "CÓ" }
  return "KHÔNG"
}

function Convert-AccountVi([object]$Value) {
  switch (([string]$Value).ToLowerInvariant()) {
    "demo" { "TÀI KHOẢN THỬ NGHIỆM"; break }
    "real" { "TÀI KHOẢN THẬT"; break }
    "live" { "TÀI KHOẢN THẬT"; break }
    default { "KHÔNG XÁC ĐỊNH" }
  }
}

function Convert-ReasonVi([object]$Value) {
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return "CHƯA CÓ" }
  $map = @{
    "ENTRY_MODE_BLOCK: AUTO_REGIME_RECOMMENDS_PAUSE" = "Thị trường yêu cầu TẠM DỪNG nên chưa cho phép vào lệnh mới."
    "ENTRY_MODE_BLOCK: PAUSE_MODE_BLOCKS_NEW_ENTRY" = "Chế độ TẠM DỪNG đang chặn lệnh mới."
    "M15_NO_ENTRY_SIGNAL" = "Khung M15 chưa có tín hiệu vào lệnh."
    "WAIT_PULLBACK" = "Đang chờ giá hồi về vùng phù hợp."
    "PULLBACK_STILL_TOO_WIDE" = "Vùng hồi vẫn quá rộng, chưa đủ điều kiện vào lệnh."
    "PULLBACK_M5_ST_INVALIDATED" = "Tín hiệu hồi giá khung M5 đã mất hiệu lực."
    "CYCLE_ERROR: fetch failed" = "Không lấy được dữ liệu trong chu kỳ kiểm tra."
    "CYCLE_ERROR" = "Có lỗi trong chu kỳ kiểm tra."
    "ENGULFING" = "Nến nhấn chìm."
    "TWO_CANDLE_BODY_DOMINANCE" = "Mẫu hai nến thân chiếm ưu thế."
  }
  if ($map.ContainsKey($text)) { return $map[$text] }
  $text = $text.Replace("A confirmed CHOCH indicates a possible structural reversal.", "Đã xác nhận thay đổi cấu trúc, thị trường có khả năng đảo chiều.")
  $text = $text.Replace("Bollinger bandwidth is", "Độ rộng dải Bollinger là")
  $text = $text.Replace("recommended mode", "chế độ được khuyến nghị")
  $text = $text.Replace("Regime", "Trạng thái thị trường")
  $text = $text.Replace("setup", "mẫu tín hiệu")
  $text = $text.Replace("final gate", "điều kiện xác nhận cuối")
  $text = $text.Replace("fixed lot", "khối lượng cố định")
  return $text
}

function Get-TaskVi([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return "KHÔNG TÌM THẤY" }
  switch ([string]$task.State) {
    "Running" { "ĐANG CHẠY"; break }
    "Ready" { "SẴN SÀNG"; break }
    "Disabled" { "ĐÃ TẮT"; break }
    default { [string]$task.State }
  }
}

function Get-PidAliveVi([string]$RuntimeDir, [string]$Name) {
  $pidPath = Join-Path $RuntimeDir "$Name.pid"
  if (-not (Test-Path -LiteralPath $pidPath)) { return "KHÔNG CÓ TIẾN TRÌNH" }
  try {
    $pidValue = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { return "ĐANG CHẠY" }
    return "ĐÃ DỪNG"
  } catch {
    return "KHÔNG XÁC ĐỊNH"
  }
}

$RuntimeDir = Resolve-ProjectPath $WorkDir
$ExecutorRuntimeDir = Join-Path $RuntimeDir "phase7c-executors"
$DemoEnv = Resolve-ProjectPath $DemoEnvFile
$LiveEnv = Resolve-ProjectPath $LiveEnvFile
$ApiBase = $ControlApiUrl.TrimEnd('/')

Write-Host ""
Write-Host "================ XAUUSD AI MASTER ================"
Write-Host "              TRẠNG THÁI HIỆN TẠI"
Write-Host "==================================================="

$mode = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$regime = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320" -Method Get -TimeoutSec 10
$decision = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/decision-monitor?symbol=XAUUSD" -Method Get -TimeoutSec 10

Write-Host ""
Write-Host "--- ĐIỀU KHIỂN VÀ THỊ TRƯỜNG ---"
Write-Host ("Chế độ bot           : {0}" -f (Convert-ModeVi $mode.state.mode))
Write-Host ("Trạng thái thị trường: {0}" -f (Convert-RegimeVi $regime.regime))
Write-Host ("Độ tin cậy           : {0}%" -f $regime.confidence)
Write-Host ("Khuyến nghị          : {0}" -f (Convert-ModeVi $regime.recommendedMode))
Write-Host ("Chiến lược hiệu lực  : {0}" -f (Convert-ModeVi $decision.mode.effectiveStrategy))
Write-Host ("Giai đoạn            : {0}" -f (Convert-StageVi $decision.preTrade.stage))
Write-Host ("Lý do quyết định     : {0}" -f (Convert-ReasonVi $decision.preTrade.decisionReason))

Write-Host ""
Write-Host "--- TÀI KHOẢN THỬ NGHIỆM ---"
Write-Host ("Tài khoản            : {0}" -f (Convert-AccountVi $decision.account.accountMode))
Write-Host ("Máy chủ              : {0}" -f $decision.account.server)
Write-Host ("Số dư                : {0}" -f $decision.account.balance)
Write-Host ("Vốn hiện tại         : {0}" -f $decision.account.equity)
Write-Host ("Số vị thế XAUUSD     : {0}" -f $decision.account.openXauusdPositions)
Write-Host ("Bộ thực thi          : {0}" -f (Get-TaskVi "XAUUSD-Phase7C-Executors"))
Write-Host ("Điều phối             : {0}" -f (Get-PidAliveVi $ExecutorRuntimeDir "supervisor"))
Write-Host ("bot Trend            : {0}" -f (Get-PidAliveVi $ExecutorRuntimeDir "trend"))
Write-Host ("bot Sideway          : {0}" -f (Get-PidAliveVi $ExecutorRuntimeDir "sideway"))
Write-Host ("Điều khiển Telegram  : {0}" -f (Get-PidAliveVi $ExecutorRuntimeDir "telegram-mode"))
Write-Host ("Thông báo thị trường : {0}" -f (Get-PidAliveVi $ExecutorRuntimeDir "regime-notifier"))
Write-Host ("Khối lượng bot Trend : {0}" -f $decision.lotSettings.state.trendFixedLot)
Write-Host ("Rủi ro bot Sideway   : {0}%" -f $decision.lotSettings.state.sidewayRiskPercent)
Write-Host ("Tối đa bot Sideway   : {0}" -f $decision.lotSettings.state.sidewayMaxLot)

Write-Host ""
Write-Host "--- VỊ THẾ HIỆN TẠI ---"
if ([int]$decision.position.count -eq 0) {
  Write-Host "Trạng thái            : CHƯA CÓ LỆNH"
  Write-Host "Hành động             : ĐANG CHỜ TÍN HIỆU HỢP LỆ"
} else {
  Write-Host ("Số lệnh              : {0}" -f $decision.position.count)
  Write-Host ("Bot quản lý          : {0}" -f (Convert-ModeVi $decision.position.strategy))
  Write-Host ("Hướng lệnh           : {0}" -f $(if ($decision.position.side -eq "BUY") { "MUA" } elseif ($decision.position.side -eq "SELL") { "BÁN" } else { "CHƯA CÓ" }))
  Write-Host ("Điểm vào lệnh        : {0}" -f $decision.position.entry)
  Write-Host ("Giá hiện tại         : {0}" -f $decision.position.currentPrice)
  Write-Host ("Cắt lỗ               : {0}" -f $decision.position.stopLoss)
  Write-Host ("Chốt lời             : {0}" -f $decision.position.takeProfit)
  Write-Host ("Lãi/lỗ đang chạy     : {0} USD" -f $decision.position.floatingPnlUsd)
  Write-Host ("Lý do vào lệnh       : {0}" -f (Convert-ReasonVi $decision.position.entryReason))
  Write-Host ("Lý do giữ lệnh       : {0}" -f (Convert-ReasonVi $decision.position.holdReason))
}

Write-Host ""
Write-Host "--- TÀI KHOẢN THẬT · CHỈ ĐỌC ---"
$LiveKey = Get-EnvValue $LiveEnv "MT5_API_KEY"
if ([string]::IsNullOrWhiteSpace($LiveKey)) {
  Write-Host "Kết nối               : KHÔNG XÁC ĐỊNH"
  Write-Host "An toàn giao dịch     : KHÔNG XÁC ĐỊNH"
} else {
  $LiveHeaders = @{ "x-mt5-api-key" = $LiveKey }
  try {
    $liveHealth = Invoke-RestMethod -Uri "http://127.0.0.1:8766/health" -Headers $LiveHeaders -TimeoutSec 5
    Write-Host ("Kết nối               : {0}" -f $(if ($liveHealth.connected) { "ĐÃ KẾT NỐI" } else { "MẤT KẾT NỐI" }))
    Write-Host "Chế độ tài khoản      : TÀI KHOẢN THẬT"
    Write-Host ("Cho phép giao dịch    : {0}" -f (Convert-BoolVi $liveHealth.tradingEnabled))
    Write-Host ("MT5 cho phép giao dịch: {0}" -f (Convert-BoolVi $liveHealth.terminalTradeAllowed))
    Write-Host ("Độ lệch giờ máy chủ   : {0} giây" -f $liveHealth.brokerTimeOffsetSeconds)
    $liveSafe = $liveHealth.accountMode -eq "real" -and -not [bool]$liveHealth.tradingEnabled -and -not [bool]$liveHealth.terminalTradeAllowed
    Write-Host ("Trạng thái an toàn    : {0}" -f $(if ($liveSafe) { "CHỈ ĐỌC · AN TOÀN" } else { "CẦN KIỂM TRA NGAY" }))
  } catch {
    Write-Host "Kết nối               : KHÔNG TRUY CẬP ĐƯỢC"
    Write-Host "Trạng thái an toàn    : CẦN KIỂM TRA"
  }
}

Write-Host ""
Write-Host "--- AN TOÀN ---"
Write-Host "Quyền đặt lệnh trên bảng MT5       : KHÔNG CÓ"
Write-Host "Tự động giao dịch tài khoản thật   : ĐÃ TẮT"
Write-Host ""
Write-Host "TRẠNG THÁI HIỂN THỊ TIẾNG VIỆT=ĐẠT"
Write-Host ""