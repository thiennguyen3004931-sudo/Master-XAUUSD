param(
  [string]$WorkDir = ".runtime",
  [int]$GatewayPort = 5791,
  [int]$WebPort = 5717,
  [int]$TailscaleHttpsPort = 8443,
  [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$GatewayHost = "127.0.0.1"
$GatewayScript = Join-Path $PSScriptRoot "run-phase7c-mobile-readonly-gateway.mjs"

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
  $WorkDir = Join-Path $ProjectRoot $WorkDir
}
$RemoteRuntimeDir = Join-Path $WorkDir "phase7c-mobile-remote-m2"
$PidPath = Join-Path $RemoteRuntimeDir "gateway.pid"
$OutLog = Join-Path $RemoteRuntimeDir "gateway.out.log"
$ErrLog = Join-Path $RemoteRuntimeDir "gateway.err.log"

foreach ($port in @($GatewayPort, $WebPort, $TailscaleHttpsPort)) {
  if ($port -lt 1024 -or $port -gt 65535) { throw "M2 port is invalid: $port" }
}
if ($GatewayPort -eq $WebPort) { throw "GatewayPort and WebPort must be different." }
if ($StartupTimeoutSeconds -lt 10 -or $StartupTimeoutSeconds -gt 120) {
  throw "StartupTimeoutSeconds must be between 10 and 120."
}
if (-not (Test-Path -LiteralPath $GatewayScript -PathType Leaf)) {
  throw "M2 gateway script is missing: $GatewayScript"
}

$node = Get-Command node -ErrorAction Stop
$tailscale = Get-Command tailscale -ErrorAction Stop
New-Item -ItemType Directory -Force -Path $RemoteRuntimeDir | Out-Null

function Get-ProcessCommandLine([int]$ProcessId) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return "" }
  return [string]$process.CommandLine
}

function Test-OwnedGatewayProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  return (
    $commandLine.IndexOf($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf("run-phase7c-mobile-readonly-gateway.mjs", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Stop-OwnedGateway([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  if (-not (Test-OwnedGatewayProcess -ProcessId $ProcessId)) {
    throw "Refusing to stop non-M2 process PID=$ProcessId."
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction Stop
}

function Read-PidFile() {
  if (-not (Test-Path -LiteralPath $PidPath -PathType Leaf)) { return 0 }
  $value = 0
  $raw = (Get-Content -LiteralPath $PidPath -Raw).Trim()
  if (-not [int]::TryParse($raw, [ref]$value) -or $value -le 0) { return 0 }
  return $value
}

function Test-ExpectedHttpError([string]$Uri, [string]$Method, [int]$ExpectedStatus) {
  try {
    Invoke-WebRequest -Uri $Uri -Method $Method -UseBasicParsing -TimeoutSec 5 | Out-Null
    return $false
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) { return $false }
    return ([int]$response.StatusCode -eq $ExpectedStatus)
  }
}

$webUrl = "http://${GatewayHost}:$WebPort"
$gatewayUrl = "http://${GatewayHost}:$GatewayPort"
$mobilePath = "/phase7c-mobile"

$webPreflight = Invoke-WebRequest -Uri "$webUrl$mobilePath" -Method Get -UseBasicParsing -TimeoutSec 8
if ($webPreflight.StatusCode -lt 200 -or $webPreflight.StatusCode -ge 400) {
  throw "M2 requires the existing localhost mobile page to be healthy before remote access is enabled."
}
Write-Host "PHASE7C_MOBILE_REMOTE_M2_LOCAL_WEB_PREFLIGHT=PASS"

$statusRaw = (& $tailscale.Source status --json | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($statusRaw)) {
  throw "Tailscale status is unavailable. Remote access was not enabled."
}
try {
  $tailStatus = $statusRaw | ConvertFrom-Json
} catch {
  throw "Tailscale status returned invalid JSON. Remote access was not enabled."
}
if ([string]$tailStatus.BackendState -ne "Running") {
  throw "Tailscale must be Running before M2 can be enabled. Current=$($tailStatus.BackendState)"
}
Write-Host "PHASE7C_MOBILE_REMOTE_M2_TAILSCALE=RUNNING"

$serveStatusBefore = (& $tailscale.Source serve status --json | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Tailscale Serve status preflight failed. Remote access was not changed."
}
$servePortToken = ":$TailscaleHttpsPort"
$serveQuotedPortToken = '"' + [string]$TailscaleHttpsPort + '"'
$servePortAlreadyConfigured = (
  $serveStatusBefore.IndexOf($servePortToken, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
  $serveStatusBefore.IndexOf($serveQuotedPortToken, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
)
if ($servePortAlreadyConfigured) {
  throw "Tailscale Serve HTTPS port $TailscaleHttpsPort is already configured. M2 refuses to overwrite an existing listener. Use another dedicated port or explicitly stop the existing owner first."
}
Write-Host "PHASE7C_MOBILE_REMOTE_M2_SERVE_PORT_PREFLIGHT=PASS|HTTPS_PORT=$TailscaleHttpsPort|STATE=FREE"

$gatewayPid = Read-PidFile
if ($gatewayPid -gt 0 -and -not (Test-OwnedGatewayProcess -ProcessId $gatewayPid)) {
  if ($null -ne (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue)) {
    throw "M2 gateway PID file points to a non-owned live process. PID=$gatewayPid"
  }
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  $gatewayPid = 0
}

if ($gatewayPid -le 0) {
  $listener = Get-NetTCPConnection -LocalAddress $GatewayHost -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $listener) {
    throw "M2 gateway port is already occupied by PID=$($listener.OwningProcess). No process was stopped."
  }

  $gatewayArgs = @(
    ('"{0}"' -f $GatewayScript),
    "--port", [string]$GatewayPort,
    "--web-port", [string]$WebPort
  )
  $gatewayProcess = Start-Process $node.Source -WindowStyle Hidden -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru -ArgumentList $gatewayArgs
  $gatewayPid = [int]$gatewayProcess.Id
  Set-Content -LiteralPath $PidPath -Value ([string]$gatewayPid) -Encoding ASCII -NoNewline
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_START=PID=$gatewayPid"
} else {
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY=ALREADY_RUNNING|PID=$gatewayPid"
}

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$gatewayReady = $false
while ((Get-Date) -lt $deadline) {
  if (-not (Test-OwnedGatewayProcess -ProcessId $gatewayPid)) { break }
  try {
    $probe = Invoke-WebRequest -Uri "$gatewayUrl$mobilePath" -Method Get -UseBasicParsing -TimeoutSec 3
    if ($probe.StatusCode -ge 200 -and $probe.StatusCode -lt 400) {
      $gatewayReady = $true
      break
    }
  } catch {}
  Start-Sleep -Milliseconds 500
}
if (-not $gatewayReady) {
  if (Test-OwnedGatewayProcess -ProcessId $gatewayPid) { Stop-OwnedGateway -ProcessId $gatewayPid }
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  throw "M2 read-only gateway did not become ready. Logs: $RemoteRuntimeDir"
}

if (-not (Test-ExpectedHttpError -Uri "$gatewayUrl/api/v1/phase7c/bot-mode" -Method Post -ExpectedStatus 405)) {
  Stop-OwnedGateway -ProcessId $gatewayPid
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  throw "M2 gateway mutation probe did not fail closed with HTTP 405."
}
if (-not (Test-ExpectedHttpError -Uri "$gatewayUrl/phase7c-control-center" -Method Get -ExpectedStatus 403)) {
  Stop-OwnedGateway -ProcessId $gatewayPid
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  throw "M2 gateway path probe did not fail closed with HTTP 403."
}
Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_METHOD_GATE=PASS"
Write-Host "PHASE7C_MOBILE_REMOTE_M2_GATEWAY_PATH_GATE=PASS"

$httpsArg = "--https=$TailscaleHttpsPort"
$serveArgs = @("serve", "--bg", $httpsArg, $gatewayUrl)
& $tailscale.Source @serveArgs
if ($LASTEXITCODE -ne 0) {
  Stop-OwnedGateway -ProcessId $gatewayPid
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  throw "Tailscale Serve failed. The M2 gateway was stopped."
}

$serveStatusRaw = (& $tailscale.Source serve status --json | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $serveStatusRaw.IndexOf($gatewayUrl, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  & $tailscale.Source serve $httpsArg off | Out-Null
  Stop-OwnedGateway -ProcessId $gatewayPid
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  throw "Tailscale Serve status does not attest the expected loopback gateway target."
}

$dnsName = ([string]$tailStatus.Self.DNSName).Trim().TrimEnd('.')
if ([string]::IsNullOrWhiteSpace($dnsName)) {
  & $tailscale.Source serve $httpsArg off | Out-Null
  if (Test-OwnedGatewayProcess -ProcessId $gatewayPid) {
    Stop-OwnedGateway -ProcessId $gatewayPid
  }
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  Write-Host "PHASE7C_MOBILE_REMOTE_M2_DNS_FAIL_ROLLBACK=PASS"
  throw "Tailscale DNS name is unavailable after Serve configuration. Remote access was rolled back."
}
$remoteUrl = "https://${dnsName}:$TailscaleHttpsPort$mobilePath"

Write-Host "PHASE7C_MOBILE_REMOTE_M2=PASS"
Write-Host "NETWORK_SCOPE=TAILNET_ONLY"
Write-Host "GATEWAY_BIND=${GatewayHost}:$GatewayPort"
Write-Host "UPSTREAM_WEB=${GatewayHost}:$WebPort"
Write-Host "HTTP_METHODS=GET_HEAD_ONLY"
Write-Host "PUBLIC_PORT_FORWARDING=NONE"
Write-Host "CANONICAL_TASK_MUTATION=NONE"
Write-Host "TRADING_PROCESS_MUTATION=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"
Write-Host "REMOTE_URL=$remoteUrl"
