param(
  [string]$TaskName = "XAUUSD-Phase7B-Core",
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$StartupScript = Join-Path $PSScriptRoot "start-phase7b-core-background-v19-local.ps1"
$OpsUrl = "http://127.0.0.1:$WebPort/phase7b-ops"

function Test-WebReady {
  try {
    $r = Invoke-WebRequest -Uri $OpsUrl -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (-not (Test-WebReady)) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskName $TaskName
  } elseif (Test-Path $StartupScript) {
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $StartupScript
    ) -WindowStyle Hidden | Out-Null
  } else {
    throw "Core task and startup script are both missing."
  }

  $ready = $false
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-WebReady) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    throw "XAUUSD core did not become ready. Check .runtime\phase7b-core-background-v19.log"
  }
}

Start-Process $OpsUrl
