param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [int]$Tail = 40
)

$ErrorActionPreference = "Stop"
$WorkDir = (Resolve-Path $WorkDir).Path
$DemoDir = Join-Path $WorkDir "phase7b-demo-forward"
$State = Join-Path $DemoDir "phase7b-demo-state.json"
$Journal = Join-Path $DemoDir "phase7b-demo-events.jsonl"

Write-Host "PHASE7B_DEMO_DIR=$DemoDir"

if (Test-Path $State) {
  Write-Host "`n=== STATE ==="
  Get-Content $State -Raw
} else {
  Write-Host "No Phase 7B DEMO state file yet."
}

if (Test-Path $Journal) {
  Write-Host "`n=== LAST $Tail EVENTS ==="
  Get-Content $Journal -Tail $Tail
} else {
  Write-Host "No Phase 7B DEMO journal yet."
}
