param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$EnvFile = ".env.phase7b-telegram",
  [decimal]$FixedVolume = 0.03,
  [int]$StartupTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
if (-not [System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile = Join-Path $ProjectRoot $EnvFile
}
if (-not (Test-Path $EnvFile)) { exit 0 }

$values = @{}
foreach ($raw in Get-Content $EnvFile) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  $values[$name] = $value
}

$token = [string]$values["ZIQ_TELEGRAM_BOT_TOKEN"]
$chatId = [string]$values["ZIQ_TELEGRAM_CHAT_ID"]
if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($chatId)) { exit 0 }

$demoDir = if ((Split-Path -Leaf $WorkDir) -eq "phase7b-demo-forward") { $WorkDir } else { Join-Path $WorkDir "phase7b-demo-forward" }
$runtimePath = Join-Path $demoDir "phase7b-demo-runtime.json"
$statePath = Join-Path $demoDir "phase7b-demo-state.json"

function Send-TelegramHtml {
  param([Parameter(Mandatory = $true)] [string]$Html)
  $payload = @{
    chat_id = $chatId
    text = $Html
    parse_mode = "HTML"
    link_preview_options = @{ is_disabled = $true }
  }
  try {
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" -Method Post -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 6 -Compress) -TimeoutSec 8 | Out-Null
  } catch {
    Write-Warning "Phase 7B bot-status Telegram message could not be sent."
  }
}

function Read-Runtime {
  if (-not (Test-Path $runtimePath)) { return $null }
  try { return Get-Content $runtimePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-RuntimeAlive {
  param($Runtime)
  if ($null -eq $Runtime -or -not $Runtime.armed -or $Runtime.status -ne "RUNNING" -or $null -eq $Runtime.pid) { return $false }
  try {
    Get-Process -Id ([int]$Runtime.pid) -ErrorAction Stop | Out-Null
    return $true
  } catch { return $false }
}

$deadline = (Get-Date).AddSeconds([Math]::Max(15, $StartupTimeoutSeconds))
$stableSince = $null
$onlineRuntime = $null
while ((Get-Date) -lt $deadline) {
  $runtime = Read-Runtime
  if (Test-RuntimeAlive $runtime) {
    if ($null -eq $stableSince) { $stableSince = Get-Date }
    if (((Get-Date) - $stableSince).TotalSeconds -ge 5) {
      $onlineRuntime = $runtime
      break
    }
  } else {
    $stableSince = $null
  }
  Start-Sleep -Seconds 1
}

if ($null -eq $onlineRuntime) {
  Send-TelegramHtml "⚠️ <b>XAUUSD AI MASTER · BOT START WARNING</b>`n<code>PHASE 7B · DEMO ONLY</code>`n`n🔴 Bot chưa đạt trạng thái RUNNING ổn định sau $StartupTimeoutSeconds giây.`n🧭 Kiểm tra MT5, Bridge và trang Hệ thống."
  exit 0
}

$account = "—"
if (Test-Path $statePath) {
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    if ($null -ne $state.accountLogin) { $account = [string]$state.accountLogin }
  } catch {}
}

Send-TelegramHtml "🤖 <b>XAUUSD AI MASTER · BOT ONLINE</b>`n<code>PHASE 7B · DEMO ONLY</code>`n`n🟢 <b>Bot:</b> <code>ARMED / RUNNING</code>`n📊 <b>Symbol:</b> <code>XAUUSD</code>`n👤 <b>DEMO account:</b> <code>$account</code>`n📦 <b>Volume:</b> <code>$FixedVolume</code>`n🧠 <b>Entry:</b> <code>Pattern + MA20/50/200</code>`n📐 <b>Engulf tolerance:</b> <code>0.10 giá</code>`n🧩 <b>FVG:</b> <code>Optional tại entry</code>`n`n✅ Đang chờ tín hiệu M15."

# Keep watching the exact bot process. If it exits during the session, send one alert.
$trackedPid = [int]$onlineRuntime.pid
while ($true) {
  Start-Sleep -Seconds 5
  try {
    Get-Process -Id $trackedPid -ErrorAction Stop | Out-Null
  } catch {
    Send-TelegramHtml "🔴 <b>XAUUSD AI MASTER · BOT OFFLINE</b>`n<code>PHASE 7B · DEMO ONLY</code>`n`n⚠️ Tiến trình bot PID <code>$trackedPid</code> đã dừng.`n🧭 Kiểm tra trang Bot & Telegram / Hệ thống."
    break
  }
}
