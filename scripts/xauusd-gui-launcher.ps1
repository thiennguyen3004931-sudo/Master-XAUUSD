Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "SilentlyContinue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$LanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169\.254" } | Select-Object -First 1).IPAddress
if (-not $LanIp) { $LanIp = "127.0.0.1" }

$RuntimeDir = Join-Path $ProjectRoot ".runtime"
if (-not (Test-Path $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }
$TokenFile = Join-Path $RuntimeDir "v6-control-token.txt"
if (Test-Path $TokenFile) {
  $ControlToken = (Get-Content $TokenFile -Raw).Trim()
} else {
  $Bytes = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($Bytes)
  $ControlToken = "v6_" + [BitConverter]::ToString($Bytes).Replace("-", "").ToLower()
  Set-Content -Path $TokenFile -Value $ControlToken -Encoding UTF8
}
$env:ZIQ_V6_CONTROL_TOKEN = $ControlToken

$Form = New-Object System.Windows.Forms.Form
$Form.Text = "XAUUSD AI MASTER V6 — BẢNG ĐIỀU KHIỂN & KHỞI ĐỘNG 1 CHẠM (PAUSE & DISARMED)"
$Form.Size = New-Object System.Drawing.Size(760, 560)
$Form.StartPosition = "CenterScreen"
$Form.BackColor = [System.Drawing.Color]::FromArgb(8, 17, 31)
$Form.ForeColor = [System.Drawing.Color]::FromArgb(241, 245, 249)
$Form.FormBorderStyle = "FixedDialog"
$Form.MaximizeBox = $false

$FontTitle = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$FontSub = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Regular)
$FontBtn = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$FontMono = New-Object System.Drawing.Font("Consolas", 9.5, [System.Drawing.FontStyle]::Bold)

$LblHeader = New-Object System.Windows.Forms.Label
$LblHeader.Text = "AU | XAUUSD AI MASTER V6 — KHỞI ĐỘNG AN TOÀN (PAUSE & DISARMED)"
$LblHeader.Font = $FontTitle
$LblHeader.ForeColor = [System.Drawing.Color]::FromArgb(233, 185, 73)
$LblHeader.Location = New-Object System.Drawing.Point(22, 18)
$LblHeader.Size = New-Object System.Drawing.Size(700, 28)
$Form.Controls.Add($LblHeader)

$LblSub = New-Object System.Windows.Forms.Label
$LblSub.Text = "Bảo mật P0/P1 Fail-Closed: Mặc định PAUSE & DISARMED, yêu cầu ZIQ_V6_CONTROL_TOKEN cho mọi thao tác điều khiển."
$LblSub.Font = $FontSub
$LblSub.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$LblSub.Location = New-Object System.Drawing.Point(22, 46)
$LblSub.Size = New-Object System.Drawing.Size(700, 22)
$Form.Controls.Add($LblSub)

$StatusBox = New-Object System.Windows.Forms.TextBox
$StatusBox.Multiline = $true
$StatusBox.ReadOnly = $true
$StatusBox.Font = $FontMono
$StatusBox.BackColor = [System.Drawing.Color]::FromArgb(5, 11, 20)
$StatusBox.ForeColor = [System.Drawing.Color]::FromArgb(74, 222, 128)
$StatusBox.Location = New-Object System.Drawing.Point(22, 78)
$StatusBox.Size = New-Object System.Drawing.Size(700, 155)
$StatusBox.Text = @"
[HỆ THỐNG SẴN SÀNG - PAUSE & DISARMED] Thư mục gốc: $ProjectRoot
• Khóa điều khiển V6 (Đã copy): $ControlToken
• Link mở Web trên Laptop     : http://localhost:5717/
• Link mở Chế độ Backtest     : http://localhost:5717/backtest
• Link mở trên Điện thoại WiFi: http://${LanIp}:5717/phase7c-mobile
"@
$Form.Controls.Add($StatusBox)

function New-ActionButton($Text, $X, $Y, $W, $H, $BgR, $BgG, $BgB, $FgR, $FgG, $FgB) {
  $Btn = New-Object System.Windows.Forms.Button
  $Btn.Text = $Text
  $Btn.Font = $FontBtn
  $Btn.Location = New-Object System.Drawing.Point($X, $Y)
  $Btn.Size = New-Object System.Drawing.Size($W, $H)
  $Btn.BackColor = [System.Drawing.Color]::FromArgb($BgR, $BgG, $BgB)
  $Btn.ForeColor = [System.Drawing.Color]::FromArgb($FgR, $FgG, $FgB)
  $Btn.FlatStyle = "Flat"
  return $Btn
}

$BtnStartAll = New-ActionButton "🚀 1. KHỞI ĐỘNG TOÀN BỘ (BOT + MT5 + WEB :5717)" 22 250 340 52 233 185 73 5 9 17
$BtnStartAll.Add_Click({
  Set-Clipboard -Value $ControlToken -ErrorAction SilentlyContinue
  node "$ProjectRoot\scripts\xauusd-one-click-launcher.mjs" start
  $StatusBox.Text = "[ONLINE - PAUSE & DISARMED] Đã bật Máy chủ Web (:5717), Control API (:3711) và MT5 Bridge!`r`nKhóa ZIQ_V6_CONTROL_TOKEN (Đã copy vào Clipboard): $ControlToken"
  Start-Process "http://localhost:5717/"
})
$Form.Controls.Add($BtnStartAll)

$BtnWebOnly = New-ActionButton "🧪 2. BẬT WEB :5717 + BACKTEST (KHÔNG CẦN MT5)" 382 250 340 52 14 116 144 255 255 255
$BtnWebOnly.Add_Click({
  Set-Clipboard -Value $ControlToken -ErrorAction SilentlyContinue
  node "$ProjectRoot\scripts\xauusd-one-click-launcher.mjs" web-only
  $StatusBox.Text = "[ONLINE - PAUSE & DISARMED] Đã bật Máy chủ Web (:5717) và API Backtest (:3711)!`r`nKhóa ZIQ_V6_CONTROL_TOKEN (Đã copy vào Clipboard): $ControlToken"
  Start-Process "http://localhost:5717/"
})
$Form.Controls.Add($BtnWebOnly)

$BtnOpenWeb = New-ActionButton "💻 3. MỞ GIAO DIỆN WEB TRÊN LAPTOP (:5717)" 22 316 340 48 15 32 56 241 245 249
$BtnOpenWeb.Add_Click({
  Set-Clipboard -Value $ControlToken -ErrorAction SilentlyContinue
  Start-Process "http://localhost:5717/"
})
$Form.Controls.Add($BtnOpenWeb)

$BtnOpenBt = New-ActionButton "📊 4. MỞ TRUNG TÂM BACKTEST & ĐÁNH GIÁ BOT" 382 316 340 48 15 32 56 233 185 73
$BtnOpenBt.Add_Click({
  Set-Clipboard -Value $ControlToken -ErrorAction SilentlyContinue
  Start-Process "http://localhost:5717/backtest"
})
$Form.Controls.Add($BtnOpenBt)

$BtnEditEnv = New-ActionButton "⚙️ 5. TẠO & SỬA CẤU HÌNH MT5 (.ENV)" 22 378 340 48 15 32 56 241 245 249
$BtnEditEnv.Add_Click({
  node "$ProjectRoot\scripts\xauusd-one-click-launcher.mjs" init-env
  $DemoEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
  if (Test-Path $DemoEnv) { Start-Process notepad.exe $DemoEnv }
})
$Form.Controls.Add($BtnEditEnv)

$BtnGitPull = New-ActionButton "🔄 6. CẬP NHẬT CODE MỚI TỪ GITHUB (PULL)" 382 378 340 48 15 32 56 74 222 128
$BtnGitPull.Add_Click({
  Start-Process cmd.exe -ArgumentList "/c node scripts/xauusd-one-click-launcher.mjs git-sync & pause" -WorkingDirectory $ProjectRoot
})
$Form.Controls.Add($BtnGitPull)

$BtnStopAll = New-ActionButton "🛑 7. DỪNG AN TOÀN TOÀN BỘ BOT & WEB (STOP ALL)" 22 442 700 50 153 27 27 255 255 255
$BtnStopAll.Add_Click({
  node "$ProjectRoot\scripts\xauusd-one-click-launcher.mjs" stop
  $StatusBox.Text = "Đã dừng an toàn các tiến trình dịch vụ V6 đã đăng ký."
})
$Form.Controls.Add($BtnStopAll)

[void]$Form.ShowDialog()
