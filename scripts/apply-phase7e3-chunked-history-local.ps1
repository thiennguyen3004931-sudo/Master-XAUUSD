param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$phase7cPath = Join-Path $repoRoot "apps/api/src/services/phase7c.service.ts"
$phase7ePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

foreach ($path in @($phase7cPath, $phase7ePath)) {
  if (-not (Test-Path $path)) { throw "Required service not found: $path" }
}

function Normalize-Text([string]$Text) {
  return $Text.Replace("`r`n", "`n")
}

function Restore-Newlines([string]$Original, [string]$Content) {
  if ($Original.Contains("`r`n")) { return $Content.Replace("`n", "`r`n") }
  return $Content
}

function Insert-BeforeMarker {
  param(
    [string]$Content,
    [string]$Marker,
    [string]$Insert,
    [string]$Label
  )
  $index = $Content.IndexOf($Marker, [System.StringComparison]::Ordinal)
  if ($index -lt 0) { throw "$Label marker not found: $Marker" }
  return $Content.Substring(0, $index) + $Insert + $Content.Substring($index)
}

function Replace-BetweenMarkers {
  param(
    [string]$Content,
    [string]$StartMarker,
    [string]$EndMarker,
    [string]$Replacement,
    [string]$Label
  )
  $start = $Content.IndexOf($StartMarker, [System.StringComparison]::Ordinal)
  if ($start -lt 0) { throw "$Label start marker not found." }
  $end = $Content.IndexOf($EndMarker, $start, [System.StringComparison]::Ordinal)
  if ($end -lt 0) { throw "$Label end marker not found." }
  return $Content.Substring(0, $start) + $Replacement + $Content.Substring($end)
}

# Read both files first. Nothing is written until both patched contents validate.
$phase7cOriginal = [System.IO.File]::ReadAllText($phase7cPath)
$phase7eOriginal = [System.IO.File]::ReadAllText($phase7ePath)
$phase7c = Normalize-Text $phase7cOriginal
$phase7e = Normalize-Text $phase7eOriginal

# ---------------- Phase 7C canonical backtest ----------------
if (-not $phase7c.Contains("async function bridgeGetHistory<")) {
  $helper7c = @'
async function bridgeGetHistory<T extends { openTime: number }>(
  timeframe: "M15" | "M5",
  fromMs: number,
  toMs: number,
  timeoutMs: number,
): Promise<T[]> {
  const chunkMs = 60 * 86_400_000;
  const all: T[] = [];
  for (let cursor = fromMs; cursor < toMs;) {
    const chunkTo = Math.min(toMs, cursor + chunkMs);
    const rows = await bridgeGet<T[]>(
      `/v1/history/candles/XAUUSD?timeframe=${timeframe}&fromMs=${Math.trunc(cursor)}&toMs=${Math.trunc(chunkTo)}`,
      timeoutMs,
    );
    all.push(...rows);
    cursor = chunkTo;
  }
  const deduped = new Map<number, T>();
  for (const row of all) deduped.set(row.openTime, row);
  return [...deduped.values()].sort((a, b) => a.openTime - b.openTime);
}

'@
  $phase7c = Insert-BeforeMarker `
    -Content $phase7c `
    -Marker "export async function getPhase7CAccountRisk" `
    -Insert $helper7c `
    -Label "Phase 7C history helper"
}

if (-not $phase7c.Contains('bridgeGetHistory<Bar>("M15", warmupFromMs, toMs, 45_000)')) {
  $replacement7c = @'
  const [health, spec, m15, m5] = await Promise.all([
    bridgeGet<BridgeHealth>("/health", 20_000),
    bridgeGet<Spec>("/v1/symbols/XAUUSD/spec", 20_000),
    bridgeGetHistory<Bar>("M15", warmupFromMs, toMs, 45_000),
    bridgeGetHistory<Bar>("M5", fromMs, toMs, 60_000),
  ]);

'@
  $phase7c = Replace-BetweenMarkers `
    -Content $phase7c `
    -StartMarker "  const [health, spec, m15, m5] = await Promise.all([" `
    -EndMarker '  if (!health.connected || health.accountMode !== "demo") throw new Error("Canonical broker backtest requires a connected DEMO terminal.");' `
    -Replacement $replacement7c `
    -Label "Phase 7C history fetch"
}

# ---------------- Phase 7E realignment research ----------------
if (-not $phase7e.Contains("async function bridgeGetHistory<")) {
  $helper7e = @'
async function bridgeGetHistory<T extends { openTime: number }>(
  timeframe: "M15" | "M5",
  fromMs: number,
  toMs: number,
  timeoutMs: number,
): Promise<T[]> {
  const chunkMs = 60 * DAY_MS;
  const all: T[] = [];
  for (let cursor = fromMs; cursor < toMs;) {
    const chunkTo = Math.min(toMs, cursor + chunkMs);
    const rows = await bridgeGet<T[]>(
      `/v1/history/candles/XAUUSD?timeframe=${timeframe}&fromMs=${Math.trunc(cursor)}&toMs=${Math.trunc(chunkTo)}`,
      timeoutMs,
    );
    all.push(...rows);
    cursor = chunkTo;
  }
  const deduped = new Map<number, T>();
  for (const row of all) deduped.set(row.openTime, row);
  return [...deduped.values()].sort((a, b) => a.openTime - b.openTime);
}

'@
  $phase7e = Insert-BeforeMarker `
    -Content $phase7e `
    -Marker "export async function runPhase7ERealignmentResearch" `
    -Insert $helper7e `
    -Label "Phase 7E history helper"
}

$oldM15 = '    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${warmupFromMs}&toMs=${toMs}`, 60_000),'
$newM15 = '    bridgeGetHistory<Bar>("M15", warmupFromMs, toMs, 60_000),'
$oldM5 = '    bridgeGet<Bar[]>(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${warmupFromMs}&toMs=${toMs}`, 90_000),'
$newM5 = '    bridgeGetHistory<Bar>("M5", warmupFromMs, toMs, 90_000),'

if ($phase7e.Contains($oldM15)) { $phase7e = $phase7e.Replace($oldM15, $newM15) }
elseif (-not $phase7e.Contains($newM15)) { throw "Phase 7E M15 history fetch does not match expected revision." }

if ($phase7e.Contains($oldM5)) { $phase7e = $phase7e.Replace($oldM5, $newM5) }
elseif (-not $phase7e.Contains($newM5)) { throw "Phase 7E M5 history fetch does not match expected revision." }

# Validate complete intended patch before writing either service.
$required7c = @(
  "async function bridgeGetHistory<",
  'bridgeGetHistory<Bar>("M15", warmupFromMs, toMs, 45_000)',
  'bridgeGetHistory<Bar>("M5", fromMs, toMs, 60_000)'
)
foreach ($needle in $required7c) {
  if (-not $phase7c.Contains($needle)) { throw "Phase 7C validation failed after patch: $needle" }
}

$required7e = @(
  "async function bridgeGetHistory<",
  'bridgeGetHistory<Bar>("M15", warmupFromMs, toMs, 60_000)',
  'bridgeGetHistory<Bar>("M5", warmupFromMs, toMs, 90_000)'
)
foreach ($needle in $required7e) {
  if (-not $phase7e.Contains($needle)) { throw "Phase 7E validation failed after patch: $needle" }
}

$phase7cOut = Restore-Newlines -Original $phase7cOriginal -Content $phase7c
$phase7eOut = Restore-Newlines -Original $phase7eOriginal -Content $phase7e

[System.IO.File]::WriteAllText($phase7cPath, $phase7cOut, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($phase7ePath, $phase7eOut, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7E3_HISTORY_PATCH=PASS"
Write-Host "PHASE7E3_HISTORY_PATCH_MATCHING=MARKER_BASED_ATOMIC"
Write-Host "PHASE7E3_HISTORY_CHUNK_DAYS=60"
Write-Host "PHASE7E3_PHASE7C_CHUNKED=True"
Write-Host "PHASE7E3_PHASE7E_CHUNKED=True"
Write-Host "PHASE7E3_RESEARCH_ONLY=True"
Write-Host "PHASE7E3_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7E3_NEXT=pnpm --filter @xauusd/api build"
