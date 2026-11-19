param(
  [int]$ApiPort = 3711,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bridgeEnv = Join-Path $repoRoot "packages/mt5-broker/bridge/.env.phase7b-demo"
$apiDir = Join-Path $repoRoot "apps/api"
$apiEnv = Join-Path $apiDir ".env"

if (-not (Test-Path $bridgeEnv)) { throw "Active Phase 7B demo bridge env not found: $bridgeEnv" }
if (-not (Test-Path $apiDir)) { throw "API directory not found: $apiDir" }

$keyLine = Get-Content $bridgeEnv | Where-Object { $_ -match '^\s*MT5_API_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw "MT5_API_KEY not found in .env.phase7b-demo" }
$bridgeKey = ($keyLine -split '=', 2)[1].Trim()
if ([string]::IsNullOrWhiteSpace($bridgeKey)) { throw "MT5_API_KEY in .env.phase7b-demo is empty" }

Write-Host "PHASE7_API_AUTH_RECOVERY=START"
Write-Host "PHASE7_ACTIVE_BRIDGE_ENV=.env.phase7b-demo"
Write-Host "PHASE7_ACTIVE_KEY_LENGTH=$($bridgeKey.Length)"

try {
  $null = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$BridgePort/health" `
    -Headers @{ "X-MT5-API-Key" = $bridgeKey } `
    -Method Get `
    -TimeoutSec 15 `
    -ErrorAction Stop
  Write-Host "PHASE7_DIRECT_BRIDGE_AUTH=PASS"
} catch {
  Write-Host "PHASE7_DIRECT_BRIDGE_AUTH=FAIL"
  throw
}

if (-not (Test-Path $apiEnv)) {
  New-Item -ItemType File -Path $apiEnv -Force | Out-Null
}

$raw = [System.IO.File]::ReadAllText($apiEnv)
function Set-EnvValue {
  param([string]$Text, [string]$Name, [string]$Value)
  $pattern = "(?m)^\s*" + [regex]::Escape($Name) + "=.*$"
  if ([regex]::IsMatch($Text, $pattern)) {
    return [regex]::Replace($Text, $pattern, "$Name=$Value")
  }
  if ($Text.Length -gt 0 -and -not $Text.EndsWith("`n")) { $Text += "`r`n" }
  return $Text + "$Name=$Value`r`n"
}

$raw = Set-EnvValue $raw "MT5_BRIDGE_ENABLED" "true"
$raw = Set-EnvValue $raw "MT5_BRIDGE_BASE_URL" "http://127.0.0.1:$BridgePort"
$raw = Set-EnvValue $raw "MT5_BRIDGE_API_KEY" $bridgeKey
$raw = Set-EnvValue $raw "EXECUTION_WORKER_EXECUTION_ENABLED" "false"
[System.IO.File]::WriteAllText($apiEnv, $raw, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "PHASE7_API_ENV_SYNC=PASS"

$listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
$pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($processId in $pids) {
  Write-Host "PHASE7_STOPPING_STALE_API_PID=$processId"
  taskkill /PID $processId /T /F | Out-Null
}
Start-Sleep -Seconds 2

if (Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue) {
  throw "API port $ApiPort is still occupied after stale-process cleanup."
}
Write-Host "PHASE7_API_PORT_CLEARED=PASS"

$launcher = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$apiDir'
`$env:PORT = '$ApiPort'
`$env:HOST = '127.0.0.1'
`$env:MT5_BRIDGE_ENABLED = 'true'
`$env:MT5_BRIDGE_BASE_URL = 'http://127.0.0.1:$BridgePort'
`$env:MT5_BRIDGE_API_KEY = '$bridgeKey'
`$env:EXECUTION_WORKER_EXECUTION_ENABLED = 'false'
Write-Host 'PHASE7_API_PROCESS_KEY_LENGTH='`$env:MT5_BRIDGE_API_KEY.Length
Write-Host 'PHASE7_EXECUTION_WORKER_EXECUTION_ENABLED='`$env:EXECUTION_WORKER_EXECUTION_ENABLED
pnpm dev
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
Start-Process powershell.exe -ArgumentList @('-NoExit','-EncodedCommand',$encoded) | Out-Null

$deadline = (Get-Date).AddSeconds(20)
$ready = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue) {
    $ready = $true
    break
  }
}
if (-not $ready) { throw "API did not begin listening on port $ApiPort." }

Write-Host "PHASE7_RESEARCH_API_RESTART=PASS"
Write-Host "PHASE7_API_URL=http://127.0.0.1:$ApiPort"
Write-Host "PHASE7_BRIDGE_URL=http://127.0.0.1:$BridgePort"
Write-Host "PHASE7_EXECUTION_ENABLED=False"
Write-Host "PHASE7_NEXT=rerun the Phase 7 research self-test"
