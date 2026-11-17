$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Wrapper = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-local.ps1"

if ($env:OS -ne "Windows_NT") {
  throw "Trade notifier child-ownership regression requires Windows."
}
if (-not (Test-Path -LiteralPath $Wrapper -PathType Leaf)) {
  throw "Missing trade notifier wrapper: $Wrapper"
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-trade-notifier-child-ownership-{0}" -f [guid]::NewGuid().ToString('N'))
$envFile = Join-Path $root "telegram.env"
$runtimeFile = Join-Path $root "trade-notifier-runtime.json"
$sinkFile = Join-Path $root "dry-run.jsonl"
$stdoutFile = Join-Path $root "wrapper.out.log"
$stderrFile = Join-Path $root "wrapper.err.log"
$wrapperProcess = $null
$nodePid = 0

New-Item -ItemType Directory -Path $root -Force | Out-Null
@(
  "ZIQ_TELEGRAM_BOT_TOKEN=synthetic-token-not-used",
  "ZIQ_TELEGRAM_CHAT_ID=synthetic-chat-not-used",
  "ZIQ_TELEGRAM_DRY_RUN=true",
  "ZIQ_TELEGRAM_DRY_RUN_SINK=$sinkFile",
  "ZIQ_TELEGRAM_SEND_STARTUP=false",
  "ZIQ_TELEGRAM_REPLAY_EXISTING=false",
  "ZIQ_TELEGRAM_MONITOR_API_URL=http://127.0.0.1:9"
) | Set-Content -LiteralPath $envFile -Encoding utf8

try {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $Wrapper),
    "-WorkDir", ('"{0}"' -f $root),
    "-EnvFile", ('"{0}"' -f $envFile),
    "-AccountMode", "LIVE",
    "-RuntimeFile", ('"{0}"' -f $runtimeFile),
    "-IntervalSeconds", "1"
  )

  $wrapperProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru

  $deadline = (Get-Date).AddSeconds(20)
  $snapshot = $null
  while ((Get-Date) -lt $deadline) {
    $wrapperProcess.Refresh()
    if ($wrapperProcess.HasExited) {
      $stderr = if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile -Raw } else { "" }
      throw "Trade notifier wrapper exited before reaching RUNNING. stderr=$stderr"
    }
    if (Test-Path -LiteralPath $runtimeFile) {
      try {
        $snapshot = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if ([string]$snapshot.status -eq "RUNNING" -and [int]$snapshot.wrapperPid -eq [int]$wrapperProcess.Id -and [int]$snapshot.pid -gt 0) {
          $candidatePid = [int]$snapshot.pid
          if ($null -ne (Get-Process -Id $candidatePid -ErrorAction SilentlyContinue)) {
            $nodePid = $candidatePid
            break
          }
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 200
  }

  if ($nodePid -le 0) {
    throw "Trade notifier wrapper did not establish a live persistent Node child before timeout."
  }

  Write-Host "PHASE7C_TRADE_NOTIFIER_CHILD_OWNERSHIP_WRAPPER_PID=$($wrapperProcess.Id)"
  Write-Host "PHASE7C_TRADE_NOTIFIER_CHILD_OWNERSHIP_NODE_PID=$nodePid"

  Stop-Process -Id $wrapperProcess.Id -Force -ErrorAction Stop
  try { $wrapperProcess.WaitForExit(5000) | Out-Null } catch {}

  $nodeDeadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $nodeDeadline -and $null -ne (Get-Process -Id $nodePid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 200
  }

  if ($null -ne (Get-Process -Id $nodePid -ErrorAction SilentlyContinue)) {
    throw "Persistent notifier Node child survived forced wrapper termination. wrapperPid=$($wrapperProcess.Id) nodePid=$nodePid"
  }

  Write-Host "PHASE7C_TRADE_NOTIFIER_CHILD_OWNERSHIP=PASS"
}
finally {
  if ($null -ne $wrapperProcess) {
    try {
      $wrapperProcess.Refresh()
      if (-not $wrapperProcess.HasExited) { Stop-Process -Id $wrapperProcess.Id -Force -ErrorAction SilentlyContinue }
    } catch {}
  }
  if ($nodePid -gt 0 -and $null -ne (Get-Process -Id $nodePid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $nodePid -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
