param(
  [string]$BridgeTask = "XAUUSD-Phase7B-Bridge",
  [string]$WebTask = "XAUUSD-Phase7B-Web",
  [int]$WebPort = 5717,
  [int]$ApiPort = 3711,
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $ProjectRoot ".runtime"
$LogPath = Join-Path $Runtime "phase7c-desktop-open.log"
$ControlCenterUrl = "http://127.0.0.1:$WebPort/phase7c-control-center"
$LifecycleUrl = "http://127.0.0.1:$ApiPort/api/v1/phase7c/lifecycle"
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

function Write-DesktopLog([string]$Message) {
  Add-Content -LiteralPath $LogPath -Value "[$([DateTimeOffset]::Now.ToString('o'))] $Message" -Encoding utf8
}

function Test-Url([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Read-Lifecycle {
  try {
    return Invoke-RestMethod -Uri $LifecycleUrl -Method Get -TimeoutSec 5
  } catch {
    return $null
  }
}

function Restart-Elevated {
  $arguments = @(
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $PSCommandPath),
    "-BridgeTask", ('"{0}"' -f $BridgeTask),
    "-WebTask", ('"{0}"' -f $WebTask),
    "-WebPort", [string]$WebPort,
    "-ApiPort", [string]$ApiPort,
    "-Elevated"
  )
  Write-DesktopLog "Scheduled Task access requires elevation; requesting UAC once."
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden | Out-Null
  exit 0
}

function Start-TaskIfNeeded([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$task.State -eq "Running") {
    Write-DesktopLog "$TaskName already running."
    return
  }
  try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-DesktopLog "$TaskName start requested."
  } catch {
    if (-not $Elevated) { Restart-Elevated }
    throw
  }
}

try {
  Write-DesktopLog "Desktop Control Center open requested."
  # Always inspect both tasks. The API may still answer while the Bridge task
  # is stopped, which previously opened a blank/offline Control Center.
  Start-TaskIfNeeded $BridgeTask
  Start-Sleep -Seconds 2
  Start-TaskIfNeeded $WebTask

  $webReady = $false
  $bridgeReady = $false
  $webDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $webDeadline) {
    $lifecycle = Read-Lifecycle
    if ($null -ne $lifecycle -and (Test-Url $ControlCenterUrl)) {
      $webReady = $true
      $bridgeReady = $lifecycle.bridge.reachable -eq $true
      break
    }
    Start-Sleep -Seconds 2
  }
  if (-not $webReady) {
    throw "Web Control Center did not become ready within 120 seconds. Check Scheduled Tasks and $LogPath"
  }
  # Give an open/restarting MT5 a short recovery window, but never hide the
  # Control Center for minutes merely because the operator intentionally kept
  # MT5 closed. The page remains useful and displays reconnecting state.
  $bridgeDeadline = (Get-Date).AddSeconds(20)
  while (-not $bridgeReady -and (Get-Date) -lt $bridgeDeadline) {
    Start-Sleep -Seconds 2
    $lifecycle = Read-Lifecycle
    $bridgeReady = $null -ne $lifecycle -and $lifecycle.bridge.reachable -eq $true
  }
  if ($bridgeReady) {
    Write-DesktopLog "MT5 Bridge is connected and Control Center is synchronized."
  } else {
    # Keep the UI usable while MT5 is closed. The Bridge health endpoint now
    # retries MetaTrader5.initialize automatically and the page keeps polling.
    Write-DesktopLog "MT5 Bridge is offline/reconnecting; Control Center will remain available."
  }

  Start-Process $ControlCenterUrl
  Write-DesktopLog "Control Center opened: $ControlCenterUrl"
  Write-Host "PHASE7C_DESKTOP_OPEN=PASS"
  Write-Host "PHASE7C_DESKTOP_CONTROL_CENTER=$ControlCenterUrl"
  Write-Host "PHASE7C_DESKTOP_BRIDGE_READY=$bridgeReady"
  Write-Host "PHASE7C_DESKTOP_BOT_AUTOSTART=FALSE"
  Write-Host "PHASE7C_DESKTOP_NEXT=CLICK_BAT_BOT"
} catch {
  $failureMessage = $_.Exception.Message
  Write-DesktopLog "ERROR: $failureMessage"
  try {
    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
    [System.Windows.MessageBox]::Show(
      "Không mở được XAUUSD AI MASTER.`n`n$failureMessage`n`nLog: $LogPath",
      "XAUUSD AI MASTER",
      "OK",
      "Error"
    ) | Out-Null
  } catch {}
  throw $failureMessage
}
