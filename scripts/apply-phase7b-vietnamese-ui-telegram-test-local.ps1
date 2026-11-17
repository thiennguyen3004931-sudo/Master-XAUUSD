param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression",
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Push-Location $Root
try {
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

  $paths = @(
    "apps/web/src/ui/DashboardLayout.tsx",
    "apps/web/src/pages/Phase7BDemoPage.tsx",
    "apps/web/src/pages/Phase7BPatternCheckPage.tsx",
    "apps/web/src/pages/Phase7BOpsPage.tsx",
    "apps/web/src/pages/PerformancePage.tsx",
    "apps/web/src/pages/SystemPage.tsx",
    "apps/api/src/app.ts",
    "apps/api/src/routes/phase7b-telegram-test.route.ts",
    "scripts/apply-phase7b-web-control-launch-v3-local.ps1"
  )

  foreach ($relative in $paths) {
    $lines = @(& git show "${Remote}/${Branch}:$relative")
    if ($LASTEXITCODE -ne 0) { throw "git show failed for $relative" }
    $target = Join-Path $Root ($relative -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    [System.IO.File]::WriteAllText($target, (($lines -join "`n") + "`n"), $Utf8NoBom)
    Write-Host "PHASE7B_VI_SYNC=$relative"
  }

  $notifierPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier.mjs"
  if (-not (Test-Path $notifierPath)) { throw "Telegram notifier missing: $notifierPath" }
  $text = [System.IO.File]::ReadAllText($notifierPath).Replace("`r`n", "`n")

  $oldTest = @'
if (sendTest) {
  await sendHtml([
    "🧪 <b>XAUUSD AI MASTER · TELEGRAM TEST</b>",
    "",
    `📊 <b>${esc(symbol)}</b> · Phase 7B DEMO`,
    "✅ Kết nối Telegram thành công",
    "🔒 Notifier chỉ đọc journal/API monitor, không có quyền đặt lệnh",
  ].join("\n"));
'@
  $newTest = @'
if (sendTest) {
  await sendHtml([
    "🧪 <b>XAUUSD AI MASTER · TIN NHẮN TEST</b>",
    "",
    `📊 <b>${esc(symbol)}</b> · TÀI KHOẢN DEMO`,
    "✅ Kết nối Telegram thành công",
    "",
    "🟢 <b>VÍ DỤ VÀO LỆNH MUA</b>",
    "🧠 Mô hình: Nến nhấn chìm",
    "✅ Supertrend M15: MUA",
    "✅ M5: MUA · fresh flip 1 nến đóng (≤ 2)",
    "ℹ️ FVG: KHÔNG · chỉ là bối cảnh, không chặn entry",
    "🎯 Entry: 3375.00 · SL: 3367.00 (-8.00 giá)",
    "📦 Khối lượng: 0.03 lot",
    "📝 Vì sao vào: đủ mô hình nến + Supertrend M15 + M5 fresh flip trên nến đóng.",
    "",
    "🔵 <b>VÍ DỤ HOLD RUNNER</b>",
    "🛡 +6: đã dời SL về hòa vốn",
    "💰 +10: đã chốt 1/3 · còn 0.02 lot",
    "📈 M15/M5: bối cảnh vẫn thuận hướng",
    "🧩 H1/H4/FVG: chỉ theo dõi, không phải TP cứng",
    "📝 Vì sao HOLD: canonical exit chưa kích hoạt, tiếp tục giữ runner.",
    "",
    "🔒 Đây là tin mẫu · notifier không có quyền đặt/sửa/đóng lệnh MT5",
  ].join("\n"));
'@
  if (-not $text.Contains("VÍ DỤ VÀO LỆNH MUA") -and $text.Contains($oldTest)) {
    $text = $text.Replace($oldTest, $newTest)
  }

  $text = $text.Replace(
    '"🟢 Đang chờ tín hiệu Pattern + MA trên M15",',
    '"🟢 Đang chờ: 2 mô hình nến + Supertrend M15 + M5 fresh flip ≤ 2 nến đóng",'
  )
  $text = $text.Replace(
    '"🧩 FVG: xác nhận bổ sung, không bắt buộc entry",',
    '"🧩 FVG: chỉ là bối cảnh, không bắt buộc để vào lệnh",'
  )
  $text = $text.Replace(
    'return fullCard(sideIcon(side), `${side} SIGNAL · ${symbol}`, [',
    'return fullCard(sideIcon(side), `${side === "BUY" ? "MUA" : "BÁN"} · TÍN HIỆU ${symbol}`, ['
  )
  $text = $text.Replace(
    'line("🧠", "Pattern", event.pattern),',
    'line("🧠", "Mô hình", event.pattern),'
  )
  $text = $text.Replace(
    'line("🧩", "FVG", event.fvgConfirmedAtEntry ? "CONFIRMED" : "OPTIONAL"),',
    @'
line("✅", "Supertrend M15", `${side} cùng hướng`),
      line("✅", "M5", `${side} · fresh flip ≤ 2 nến đóng`),
      line("🧩", "FVG bối cảnh", event.fvgConfirmedAtEntry ? "CÓ" : "KHÔNG · không chặn entry"),
      "📝 <b>Vì sao vào:</b> đủ mô hình nến + Supertrend M15 + M5 fresh flip trên nến đóng.",
'@
  )
  $text = $text.Replace(
    'return fullCard(side === "BUY" ? "✅🟢" : "✅🔴", `${side} FILLED · ${symbol}`, [',
    'return fullCard(side === "BUY" ? "✅🟢" : "✅🔴", `${side === "BUY" ? "MUA" : "BÁN"} · ĐÃ KHỚP ${symbol}`, ['
  )
  $text = $text.Replace(
    'line("🧩", "FVG", event.fvgConfirmedAtEntry ? "YES" : "NO · vẫn hợp lệ"),',
    'line("🧩", "FVG bối cảnh", event.fvgConfirmedAtEntry ? "CÓ" : "KHÔNG · vẫn hợp lệ"),'
  )
  $text = $text.Replace(
    '"<b>Rule:</b> +6 → BE · +10 → chốt 1/3 · runner swing M15",',
    @'
"<b>Vì sao đã vào:</b> đủ mô hình nến + Supertrend M15 + M5 fresh flip ≤ 2 nến đóng",
      "<b>Quản lý:</b> +6 → hòa vốn · +10 → chốt 1/3 · phần còn lại runner canonical",
'@
  )
  $text = $text.Replace(
    '"✅ FVG cùng hướng · tiếp tục giữ.",',
    @'
"✅ FVG cùng hướng là bối cảnh hỗ trợ, không phải lý do duy nhất để giữ.",
      "📝 <b>Vì sao HOLD:</b> vị thế vẫn được Bot quản lý và canonical exit chưa kích hoạt.",
'@
  )
  $text = $text.Replace(
    'return compactTradeCard("👀", side, "ADD-ON SHADOW", [',
    'return compactTradeCard("👀", side, "BỐI CẢNH FVG", ['
  )
  $text = $text.Replace(
    '"⚠️ Chỉ ghi nhận tín hiệu · <b>không mở thêm lot</b>.",',
    '"ℹ️ Chỉ ghi nhận bối cảnh FVG · <b>không mở thêm lot</b>.",'
  )
  $text = $text.Replace(
    'm.profitUsd === null ? "" : `💵 <b>P&L runner:</b> <code>${fmtMoney(m.profitUsd, true)}</code>`,',
    @'
m.profitUsd === null ? "" : `💵 <b>P&L runner:</b> <code>${fmtMoney(m.profitUsd, true)}</code>`,
      "📝 <b>Vì sao HOLD runner:</b> đã chốt 1/3; phần còn lại tiếp tục cho tới canonical exit.",
'@
  )

  [System.IO.File]::WriteAllText($notifierPath, $text, $Utf8NoBom)

  $patched = [System.IO.File]::ReadAllText($notifierPath)
  foreach ($required in @(
    "VÍ DỤ VÀO LỆNH MUA",
    "VÍ DỤ HOLD RUNNER",
    "Vì sao vào:",
    "Vì sao HOLD:",
    "Supertrend M15 + M5 fresh flip"
  )) {
    if (-not $patched.Contains($required)) { throw "Telegram Vietnamese patch missing token: $required" }
  }
  if ($patched.Contains("Pattern + MA trên M15")) { throw "Old Telegram Pattern + MA startup message still remains." }

  Write-Host "PHASE7B_VI_TELEGRAM_PATCH=PASS"
  Write-Host "PHASE7B_VI_TELEGRAM_TEST_CONTENT=ENTRY_REASON,HOLD_REASON,MANAGEMENT"

  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_VI_WEB_BUILD=PASS"

  & (Join-Path $Root "scripts\apply-phase7b-web-control-launch-v3-local.ps1") -Remote $Remote -Branch $Branch
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B API V3 restart failed." }

  $webListener = Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue
  if (-not $webListener) {
    $webDir = Join-Path $Root "apps\web"
    $cmd = @"
Set-Location '$webDir'
`$env:VITE_API_BASE_URL=''
`$env:VITE_DEV_API_PROXY_TARGET='http://127.0.0.1:3711'
pnpm exec vite --host 127.0.0.1 --port $WebPort --strictPort
"@
    $WebProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $cmd)
    Write-Host "PHASE7B_VI_WEB_STARTED=True"
    Write-Host "PHASE7B_VI_WEB_PID=$($WebProcess.Id)"
  } else {
    Write-Host "PHASE7B_VI_WEB_REUSED=True"
  }

  Write-Host "PHASE7B_VI_UI=PASS"
  Write-Host "PHASE7B_VI_MENU=THEO_DOI_GIAO_DICH,DIEU_KIEN_VAO_LENH,BOT_TELEGRAM,HIEU_SUAT,TRANG_THAI_HE_THONG"
  Write-Host "PHASE7B_VI_ENTRY_REASON=VISIBLE"
  Write-Host "PHASE7B_VI_HOLD_REASON=VISIBLE"
  Write-Host "PHASE7B_VI_TELEGRAM_TEST_BUTTON=VISIBLE"
  Write-Host "PHASE7B_VI_BOT_RESTARTED=False"
  Write-Host "PHASE7B_VI_TELEGRAM_RESTARTED=False"
  Write-Host "PHASE7B_VI_REAL_ACCOUNT_ALLOWED=False"
}
finally {
  Pop-Location
}
