# Operator-only maintenance declaration. Does NOT stop/start a bot or access MT5.
param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [switch]$Enable,
  [switch]$Clear,
  [ValidateSet('PLANNED_SHUTDOWN', 'MAINTENANCE')]
  [string]$Reason = 'PLANNED_SHUTDOWN',
  [ValidateRange(1, 24)]
  [int]$DurationHours = 12,
  [switch]$ConfirmPlannedDowntime
)
$ErrorActionPreference = 'Stop'
if ([bool]$Enable -eq [bool]$Clear) {
  throw 'Exactly one of -Enable or -Clear is required.'
}
if ($Enable -and -not $ConfirmPlannedDowntime) {
  throw 'Explicit -ConfirmPlannedDowntime is required; this action does not stop the bot.'
}
$runtime = Join-Path $ProductionRoot '.runtime'
if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
  throw 'RUNTIME_DIRECTORY_NOT_FOUND'
}
$dir = Join-Path $runtime 'ops'
$path = Join-Path $dir 'auto-live-monitor-offline-lease.json'
if ($Clear) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  Write-Host 'MONITOR_EXPECTED_OFFLINE_LEASE=CLEARED'
  Write-Host 'PRODUCTION_TRADING_MUTATION=NONE'
  exit 0
}
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$now = [DateTimeOffset]::UtcNow
$lease = [ordered]@{
  version = 1
  status = 'OFFLINE_EXPECTED'
  reason = $Reason
  issuedAtEpochMs = $now.ToUnixTimeMilliseconds()
  expiresAtEpochMs = $now.AddHours($DurationHours).ToUnixTimeMilliseconds()
}
$tempPath = Join-Path $dir ("auto-live-monitor-offline-lease." + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  [System.IO.File]::WriteAllText($tempPath, ($lease | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tempPath -Destination $path -Force -ErrorAction Stop
} finally {
  if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}
. (Join-Path $PSScriptRoot 'auto-live-offline-lease.ps1')
if ((Get-AutoLiveOfflineLeaseState -ProductionRoot $ProductionRoot) -ne 'VALID') {
  throw 'MONITOR_OFFLINE_LEASE_VERIFICATION_FAILED'
}
Write-Host 'MONITOR_EXPECTED_OFFLINE_LEASE=VALID'
Write-Host "MONITOR_OFFLINE_LEASE_EXPIRES_UTC=$($now.AddHours($DurationHours).ToString('o'))"
Write-Host 'MONITOR_RUNTIME_HEALTH=NOT_VERIFIED'
Write-Host 'PRODUCTION_TRADING_MUTATION=NONE'
