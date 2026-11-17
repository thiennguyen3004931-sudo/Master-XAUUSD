param(
  [string]$ProjectRoot = '',
  [string]$EnvFile = '',
  [switch]$ConfirmNotificationOnly
)

$ErrorActionPreference = 'Stop'
if (-not $ConfirmNotificationOnly) {
  throw 'Explicit -ConfirmNotificationOnly is required. This test sends Telegram messages only; it never sends broker orders.'
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if ([string]::IsNullOrWhiteSpace($EnvFile)) { $EnvFile = Join-Path $ProjectRoot '.env.phase7b-telegram' }
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Telegram env file not found: $EnvFile" }

function Read-DotEnv([string]$Path) {
  $map = @{}
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = ([string]$raw).Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -le 0) { continue }
    $key = $line.Substring(0, $eq).Trim().TrimStart([char]0xFEFF)
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$key] = $value
  }
  return $map
}

function First-Configured([hashtable]$Config, [string[]]$Names) {
  foreach ($name in $Names) {
    $value = [string]$Config[$name]
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value -notmatch 'REPLACE_WITH') { return $value }
  }
  return ''
}

function Send-TestMessage([string]$Token, [string]$ChatId, [string]$ThreadId, [string]$Text) {
  $uri = "https://api.telegram.org/bot$Token/sendMessage"
  $body = @{ chat_id = $ChatId; text = $Text; disable_web_page_preview = 'true' }
  if (-not [string]::IsNullOrWhiteSpace($ThreadId)) { $body.message_thread_id = $ThreadId }
  $result = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 15
  if (-not $result.ok) { throw 'Telegram sendMessage returned ok=false.' }
}

$config = Read-DotEnv -Path $EnvFile
$token = First-Configured $config @('ZIQ_TELEGRAM_TRADE_BOT_TOKEN', 'ZIQ_TELEGRAM_BOT_TOKEN')
$chatId = First-Configured $config @('ZIQ_TELEGRAM_TRADE_CHAT_ID', 'ZIQ_TELEGRAM_CHAT_ID')
$threadId = First-Configured $config @('ZIQ_TELEGRAM_TRADE_MESSAGE_THREAD_ID', 'ZIQ_TELEGRAM_MESSAGE_THREAD_ID')
$symbol = [string]$config['ZIQ_TELEGRAM_SYMBOL']
if ([string]::IsNullOrWhiteSpace($symbol)) { $symbol = 'XAUUSD' }
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Telegram trade/fallback bot token is missing/not configured.' }
if ([string]::IsNullOrWhiteSpace($chatId)) { throw 'Telegram trade/fallback chat ID is missing/not configured.' }

Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST=START'
Write-Host "PHASE7C_TELEGRAM_NOTIFICATION_TEST_SYMBOL=$symbol"
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_CHANNEL=TRADE_WITH_FALLBACK'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_TOKEN=CONFIGURED_NOT_PRINTED'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_CHAT_ID=CONFIGURED_NOT_PRINTED'

$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
$messages = @(
  "[TEST] SETUP_READY`n$symbol | TREND | BUY`nPattern: ENGULFING`nExpected entry: 4662.63 | SL: 4654.40`nTEST ONLY - NOT A REAL TRADE`n$stamp",
  "[TEST] ENTRY_FILLED`n$symbol | TREND | BUY | 0.12 lot`nEntry: 4662.63 | SL: 4654.40`nReason: valid Trend setup`nTEST ONLY - NOT A REAL TRADE`n$stamp",
  "[TEST] SL_TO_BE`n$symbol | favorable +6`nSL -> Entry / Break-even`nHold reason: trend remains valid`nTEST ONLY - NOT A REAL TRADE`n$stamp",
  "[TEST] PARTIAL_1_3`n$symbol | favorable +10`nSimulated partial close: 1/3`nRemaining position stays managed`nTEST ONLY - NOT A REAL TRADE`n$stamp",
  "[TEST] POSITION_CLOSED`n$symbol | TREND`nSimulated profit: +12.34 USD`nExit reason: TEST_NOTIFICATION_FLOW`nTEST ONLY - NOT A REAL TRADE`n$stamp"
)

$sent = 0
foreach ($message in $messages) {
  Send-TestMessage -Token $token -ChatId $chatId -ThreadId $threadId -Text $message
  $sent += 1
  Write-Host "PHASE7C_TELEGRAM_NOTIFICATION_TEST_SENT=$sent"
  Start-Sleep -Milliseconds 350
}

Write-Host "PHASE7C_TELEGRAM_NOTIFICATION_TEST_TOTAL=$sent"
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_BROKER_ORDER_SEND=False'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_POSITION_MUTATION=False'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_ACCOUNT_SWITCH=False'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_BOT_MODE_MUTATION=False'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST_LIVE_ARM_MUTATION=False'
Write-Host 'PHASE7C_TELEGRAM_NOTIFICATION_TEST=PASS'
