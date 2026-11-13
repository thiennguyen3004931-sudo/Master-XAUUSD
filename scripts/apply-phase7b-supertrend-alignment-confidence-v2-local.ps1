param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ControllerPath = Join-Path $Root "scripts\run-phase7b-demo-controller.ts"
$RoutePath = Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts"
$DemoPagePath = Join-Path $Root "apps\web\src\pages\Phase7BDemoPage.tsx"
$GatePagePath = Join-Path $Root "apps\web\src\pages\Phase7BPatternCheckPage.tsx"
$TelegramPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-compact.mjs"
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$DemoDir = Join-Path $Root ".runtime\phase7b-demo-forward"

function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing file: $Path" }
  return [System.IO.File]::ReadAllText($Path)
}
function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}
function Sync-RemoteFile([string]$Relative, [string]$Destination) {
  $lines = @(& git show "${Remote}/${Branch}:$Relative")
  if ($LASTEXITCODE -ne 0) { throw "git show failed for $Relative" }
  Write-Text $Destination (($lines -join "`n") + "`n")
}
function Stop-Port([int]$Port) {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($processId -and $processId -ne $PID) {
      Write-Host "PHASE7B_ALIGNMENT_V2_STOP_PORT_${Port}_PID=$processId"
      & taskkill /PID $processId /T /F | Out-Null
    }
  }
}

Push-Location $Root
try {
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

  $controller = Read-Text $ControllerPath
  if (-not ($controller.Contains("PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2") -or $controller.Contains("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT"))) {
    throw "Controller does not contain a recognized synced Phase 7B Supertrend gate."
  }
  $controller = $controller.Replace("PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2", "PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")
  $controller = $controller.Replace("M15_DUAL_PATTERN_SUPERTREND_M5_FLIP2_CANONICAL_RIDER", "M15_DUAL_PATTERN_M15_M5_SUPERTREND_ALIGNMENT_CANONICAL_RIDER")
  $controller = $controller.Replace("M5_FLIP_2", "M5_ALIGNMENT")
  $controller = $controller.Replace("m5FlipAgeBars: number;", "m5FlipAgeBars: number | null;")
  $controller = [regex]::Replace(
    $controller,
    '(?m)^\s*if\s*\(\s*flipAge\s*===\s*null\s*\|\|\s*flipAge\s*>\s*1\s*\)\s*return\s+null;\s*$',
    '  // Flip age is informational only; M5 direction alignment is sufficient for entry.'
  )
  if ($controller -match 'flipAge\s*>\s*1\s*\)\s*return\s+null') {
    throw "Controller still contains a flip-age entry blocker."
  }
  Write-Text $ControllerPath $controller

  $route = Read-Text $RoutePath
  if (-not ($route.Contains("PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2") -or $route.Contains("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT"))) {
    throw "API route is not yet on the synced Supertrend diagnostics. Run apply-phase7b-forward-demo-sync-v2-local.ps1 first."
  }
  $route = $route.Replace("PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2", "PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")
  $route = $route.Replace("M15_DUAL_PATTERN_SUPERTREND_M5_FLIP2_CANONICAL_RIDER", "M15_DUAL_PATTERN_M15_M5_SUPERTREND_ALIGNMENT_CANONICAL_RIDER")
  $route = $route.Replace("M15_SUPERTREND_10_3_PLUS_ALIGNED_FRESH_M5_FLIP_WITHIN_2_CLOSED_BARS", "M15_SUPERTREND_10_3_PLUS_M5_SUPERTREND_10_3_SAME_DIRECTION")

  if (-not $route.Contains("const m5DirectionAligned = Boolean")) {
    $route = [regex]::Replace(
      $route,
      '(?m)^\s*const\s+m5FreshAligned\s*=\s*Boolean\([^;]+\);\s*$',
      "  const m5DirectionAligned = Boolean(wanted !== null && d5 === wanted);`r`n  // Compatibility field: now means M5 direction aligned. Flip age is information only.`r`n  const m5FreshAligned = m5DirectionAligned;"
    )
  }
  $route = [regex]::Replace(
    $route,
    '(?m)^\s*const\s+matchedPatternSide\s*=\s*Boolean\([^;]+\);\s*$',
    '  const matchedPatternSide = Boolean(wanted !== null && d15 === wanted && d5 === wanted);'
  )
  if (-not $route.Contains("const m5DirectionAligned = Boolean")) {
    throw "V2 could not patch m5 direction alignment."
  }

  if (-not $route.Contains("const confidenceLevel =")) {
    $pattern = '(?m)^(\s*const\s+matchedPatternSide\s*=\s*Boolean\([^;]+\);\s*)$'
    $match = [regex]::Match($route, $pattern)
    if (-not $match.Success) { throw "V2 could not locate matchedPatternSide marker." }
    $insert = @'
  const m15Reaction = wanted === null ? null : phase7bTrendlineReaction(bars, index, wanted, 10, 3);
  const m5Reaction = wanted === null || m5Index < 0 ? null : phase7bTrendlineReaction(m5, m5Index, wanted, 10, 3);
  const reactionCount = Number(Boolean(m15Reaction?.reaction)) + Number(Boolean(m5Reaction?.reaction));
  const confidenceLevel = wanted === null
    ? "CHƯA_ĐÁNH_GIÁ"
    : reactionCount >= 2
      ? "RẤT_CAO"
      : reactionCount === 1
        ? "CAO"
        : "TIÊU_CHUẨN";
'@
    $route = $route.Substring(0, $match.Index + $match.Length) + "`r`n" + $insert + $route.Substring($match.Index + $match.Length)
  }

  $route = [regex]::Replace(
    $route,
    '(?m)^\s*reason\s*=\s*`\$\{pattern\.side\} pattern \+ Supertrend M15 đạt nhưng M5[^`]*`;\s*$',
    '    reason = `${pattern.side} pattern + Supertrend M15 đạt nhưng Supertrend M5 chưa cùng hướng.`;'
  )
  $route = $route.Replace("Pattern + Supertrend M15 + M5_FLIP_2", "Pattern + Supertrend M15 + Supertrend M5 cùng hướng")
  $route = $route.Replace("M5_FLIP_2", "M5_ALIGNMENT")

  if (-not $route.Contains('confidenceLevel: "CHƯA_ĐÁNH_GIÁ"')) {
    $route = [regex]::Replace(
      $route,
      '(?m)^(\s*m5FreshAligned:\s*boolean;\s*)$',
@'
    m5FreshAligned: boolean;
    m15SupertrendLine: number | null;
    m5SupertrendLine: number | null;
    m15TrendlineDistance: number | null;
    m5TrendlineDistance: number | null;
    m15TrendlineReaction: boolean;
    m5TrendlineReaction: boolean;
    confidenceLevel: "CHƯA_ĐÁNH_GIÁ" | "TIÊU_CHUẨN" | "CAO" | "RẤT_CAO";
'@
    )
  }

  if (-not $route.Contains("m15TrendlineDistance:")) {
    $payloadPattern = '(?m)^(\s*m5FreshAligned,\s*)$'
    $payloadMatch = [regex]::Match($route, $payloadPattern)
    if (-not $payloadMatch.Success) { throw "V2 could not locate m5FreshAligned return marker." }
    $payload = @'
      m5FreshAligned,
      m15SupertrendLine: m15Reaction?.line ?? null,
      m5SupertrendLine: m5Reaction?.line ?? null,
      m15TrendlineDistance: m15Reaction?.distance ?? null,
      m5TrendlineDistance: m5Reaction?.distance ?? null,
      m15TrendlineReaction: Boolean(m15Reaction?.reaction),
      m5TrendlineReaction: Boolean(m5Reaction?.reaction),
      confidenceLevel,
'@
    $route = $route.Substring(0, $payloadMatch.Index) + $payload + $route.Substring($payloadMatch.Index + $payloadMatch.Length)
  }

  if (-not $route.Contains("function phase7bTrendlineReaction(")) {
    $marker = "function detectEntryPattern("
    $position = $route.IndexOf($marker)
    if ($position -lt 0) { throw "V2 could not locate detectEntryPattern marker." }
    $helpers = @'
function phase7bTrendlineReaction(
  bars: M15Bar[],
  index: number,
  wanted: 1 | -1,
  period: number,
  multiplier: number,
): { line: number | null; distance: number | null; threshold: number | null; reaction: boolean } {
  const detail = phase7bSupertrendDetail(bars, period, multiplier);
  const line = detail.line[index] ?? null;
  const atr = detail.atr[index] ?? null;
  if (line === null || atr === null || detail.direction[index] !== wanted) {
    return { line: null, distance: null, threshold: null, reaction: false };
  }
  const bar = bars[index]!;
  const probe = wanted === 1 ? bar.low : bar.high;
  const distance = Math.abs(probe - line);
  const threshold = Math.min(2, Math.max(0.5, atr * 0.2));
  const near = distance <= threshold + 1e-9;
  const reaction = wanted === 1
    ? near && bar.close > line && bar.close > bar.open
    : near && bar.close < line && bar.close < bar.open;
  return { line: round(line, 5), distance: round(distance, 5), threshold: round(threshold, 5), reaction };
}

function phase7bSupertrendDetail(
  bars: M15Bar[],
  period: number,
  multiplier: number,
): { direction: Array<1 | -1 | null>; line: Array<number | null>; atr: Array<number | null> } {
  const tr = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1]!.close), Math.abs(bar.low - bars[index - 1]!.close)));
  const atr: Array<number | null> = Array(bars.length).fill(null);
  if (bars.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i += 1) sum += tr[i]!;
    atr[period - 1] = sum / period;
    for (let i = period; i < bars.length; i += 1) atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  const upper: Array<number | null> = Array(bars.length).fill(null);
  const lower: Array<number | null> = Array(bars.length).fill(null);
  const direction: Array<1 | -1 | null> = Array(bars.length).fill(null);
  const line: Array<number | null> = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const a = atr[i];
    if (a === null) continue;
    const hl2 = (bar.high + bar.low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null || direction[i - 1] === null) {
      upper[i] = basicUpper; lower[i] = basicLower; direction[i] = bar.close >= hl2 ? 1 : -1;
      line[i] = direction[i] === 1 ? lower[i] : upper[i];
      continue;
    }
    const previous = bars[i - 1]!;
    const prevUpper = upper[i - 1]!;
    const prevLower = lower[i - 1]!;
    upper[i] = basicUpper < prevUpper || previous.close > prevUpper ? basicUpper : prevUpper;
    lower[i] = basicLower > prevLower || previous.close < prevLower ? basicLower : prevLower;
    let d = direction[i - 1]!;
    if (d === 1 && bar.close < lower[i]!) d = -1;
    else if (d === -1 && bar.close > upper[i]!) d = 1;
    direction[i] = d;
    line[i] = d === 1 ? lower[i] : upper[i];
  }
  return { direction, line, atr };
}

'@
    $route = $route.Substring(0, $position) + $helpers + $route.Substring($position)
  }

  if ($route.Contains("fresh flip trong 2 nến đóng gần nhất")) {
    throw "API still contains fresh-flip entry gate wording after V2 patch."
  }
  Write-Text $RoutePath $route

  Sync-RemoteFile "apps/web/src/pages/Phase7BPatternCheckPage.tsx" $GatePagePath

  $demo = Read-Text $DemoPagePath
  $demo = $demo.Replace(
    'const currentM5Aligned = Boolean(managed && diagnostics?.trend.m5Supertrend === managed.side && diagnostics?.trend.m5FreshAligned);',
    'const currentM5Aligned = Boolean(managed && diagnostics?.trend.m5Supertrend === managed.side);'
  )
  $demo = $demo.Replace('label="Fresh flip M5"', 'label="Flip age M5 (tham khảo)"')
  $demo = $demo.Replace('M5 cùng hướng và fresh flip không quá 2 nến đóng.', 'Supertrend M5 cùng hướng với mô hình. Flip age chỉ tham khảo.')
  $demo = $demo.Replace('M5 hiện tại {currentM5Aligned ? `vẫn cùng hướng ${tenHuong(managed.side)} và fresh` : "không còn đồng thuận fresh với hướng lệnh"}.', 'M5 hiện tại {currentM5Aligned ? `vẫn cùng hướng ${tenHuong(managed.side)}` : "không còn cùng hướng lệnh"}.')
  $demo = $demo.Replace('Entry: 2 mô hình nến + Supertrend M15 + M5 fresh flip ≤ 2', 'Entry: 2 mô hình nến + Supertrend M15 + Supertrend M5 cùng hướng')
  $demo = $demo.Replace('Supertrend M15 cùng hướng + M5 fresh flip ≤ 2', 'Supertrend M15 + Supertrend M5 cùng hướng')
  Write-Text $DemoPagePath $demo

  if (Test-Path $TelegramPath) {
    $tg = Read-Text $TelegramPath
    $tg = $tg.Replace(" + M5 cùng hướng/fresh flip ≤ 2 nến đóng.", " + Supertrend M5 cùng hướng.")
    $tg = $tg.Replace("• M5 = MUA, fresh flip 1 nến đóng (≤ 2).", "• Supertrend M5 = MUA.")
    Write-Text $TelegramPath $tg
  }

  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_ALIGNMENT_V2_BUILD=PASS"

  if (-not (Test-Path $BridgeEnv)) { throw "Missing demo bridge env: $BridgeEnv" }
  $keyLine = Get-Content $BridgeEnv | Where-Object { $_ -match '^\s*MT5_API_KEY=' } | Select-Object -First 1
  if (-not $keyLine) { throw "MT5_API_KEY missing from demo bridge env." }
  $bridgeKey = ($keyLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Headers @{ "x-mt5-api-key" = $bridgeKey } -TimeoutSec 8
  if ($health.accountMode -ne "demo") { throw "Expected demo account, got $($health.accountMode)." }
  Write-Host "PHASE7B_ALIGNMENT_V2_BRIDGE=PASS"
  Write-Host "PHASE7B_ALIGNMENT_V2_ACCOUNT_LOGIN=$($health.accountLogin)"

  Stop-Port $ApiPort
  $apiCmd = @"
Set-Location '$Root\apps\api'
`$env:PORT='$ApiPort'
`$env:HOST='127.0.0.1'
`$env:MT5_BRIDGE_ENABLED='true'
`$env:MT5_BRIDGE_BASE_URL='http://127.0.0.1:8765'
`$env:MT5_BRIDGE_API_KEY='$bridgeKey'
`$env:PHASE7B_DEMO_WORK_DIR='$DemoDir'
`$env:PHASE7B_LOCAL_CONTROL_ENABLED='true'
`$env:EXECUTION_WORKER_EXECUTION_ENABLED='false'
pnpm dev
"@
  $api = Start-Process powershell.exe -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-Command",$apiCmd -PassThru
  $apiReady = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue) { $apiReady = $true; break }
  }
  if (-not $apiReady) { throw "API did not become ready on port $ApiPort. PID=$($api.Id)" }
  $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 10
  if ($snapshot.entryDiagnostics.entry.rule -ne "PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT") {
    throw "API rule verification failed: $($snapshot.entryDiagnostics.entry.rule)"
  }

  Write-Host "PHASE7B_ALIGNMENT_V2_API=PASS"
  Write-Host "PHASE7B_ALIGNMENT_V2_ENTRY_GATE=PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT"
  Write-Host "PHASE7B_ALIGNMENT_V2_M5_FLIP_AGE=INFO_ONLY_NOT_GATE"
  Write-Host "PHASE7B_ALIGNMENT_V2_TRENDLINE_REACTION=CONFIDENCE_ONLY"
  Write-Host "PHASE7B_ALIGNMENT_V2_CONFIDENCE_LEVELS=TIEU_CHUAN,CAO,RAT_CAO"
  Write-Host "PHASE7B_ALIGNMENT_V2_FVG_ENTRY_GATE=False"
  Write-Host "PHASE7B_ALIGNMENT_V2_BOT_RESTARTED=False"
  Write-Host "PHASE7B_ALIGNMENT_V2_REAL_ACCOUNT_ALLOWED=False"
  Write-Host "PHASE7B_ALIGNMENT_V2=PASS"
}
finally {
  Pop-Location
}
