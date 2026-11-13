param(
  [int]$ApiPort = 3711,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ControllerPath = Join-Path $Root "scripts\run-phase7b-demo-controller.ts"
$RoutePath = Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts"
$GatePagePath = Join-Path $Root "apps\web\src\pages\Phase7BPatternCheckPage.tsx"
$LayoutPath = Join-Path $Root "apps\web\src\ui\DashboardLayout.tsx"
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

function Insert-Before([string]$Text, [string]$Marker, [string]$Block, [string]$Name) {
  $idx = $Text.IndexOf($Marker)
  if ($idx -lt 0) { throw "$Name marker not found: $Marker" }
  return $Text.Substring(0, $idx) + $Block + $Text.Substring($idx)
}

function Bridge-Key {
  $line = Get-Content $BridgeEnv | Where-Object { $_ -match '^\s*MT5_API_KEY=' } | Select-Object -First 1
  if (-not $line) { throw "MT5_API_KEY missing from $BridgeEnv" }
  return (($line -split '=', 2)[1]).Trim()
}

Push-Location $Root
try {
  # -----------------------------------------------------------------------
  # A. DEMO controller: daily closed-PnL recovery mode.
  # -----------------------------------------------------------------------
  $controller = Read-Text $ControllerPath
  if (-not $controller.Contains("THREE_CANDLE_BODY_DOMINANCE")) {
    throw "Three-candle rule is not present. Apply V6 first."
  }
  if (-not $controller.Contains("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")) {
    throw "Controller is not on M15+M5 Supertrend alignment rule."
  }

  if (-not $controller.Contains("cashPerPriceUnitPerLot: number;")) {
    $anchor = "  effectiveTickValuePerLot: number;"
    if (-not $controller.Contains($anchor)) { throw "SymbolSpec cash-value anchor not found." }
    $controller = $controller.Replace($anchor, $anchor + "`r`n  cashPerPriceUnitPerLot: number;")
  }

  if (-not $controller.Contains("type DailyManagementSnapshot =")) {
    $types = @'
type DealHistory = {
  positionId: string;
  side: "BUY" | "SELL" | null;
  entry: "IN" | "OUT" | "INOUT" | "OUT_BY" | "UNKNOWN";
  netPnl: number;
  magic: number;
};

type TradingDayBoundary = {
  currentStartTime: number;
  previousStartTime: number | null;
};

type DailyManagementSnapshot = {
  dayStartTime: number;
  realizedPnl: number;
  deficitUsd: number;
  mode: "RECOVERY" | "TREND";
  targetMove: number;
  rawRequiredMove: number;
  canTurnPositiveWithinTen: boolean;
};

'@
    $controller = Insert-Before $controller "type ManagedState = {" $types "Controller daily type"
  }

  if (-not $controller.Contains("DAY_RECOVERY_MIN_MOVE")) {
    $anchor = "const ENGULF_BODY_TOLERANCE_PRICE = 0.1;"
    if (-not $controller.Contains($anchor)) { throw "Controller constant anchor not found." }
    $extra = @'
const DAY_RECOVERY_MIN_MOVE = 6;
const DAY_RECOVERY_MAX_MOVE = 10;
const DAY_RECOVERY_BUFFER_USD = Math.max(0.01, Number(process.env.ZIQ_DAY_RECOVERY_BUFFER_USD ?? "1"));
let lastDailyRecoveryDataErrorAt = 0;
'@
    $controller = $controller.Replace($anchor, $anchor + "`r`n" + $extra.TrimEnd())
  }

  if (-not $controller.Contains("async function getDailyManagementSnapshot(")) {
    $helper = @'
async function getDailyManagementSnapshot(position: Position, spec: SymbolSpec): Promise<DailyManagementSnapshot> {
  const now = Date.now();
  const boundary = await get<TradingDayBoundary>(`/v1/session/day-boundary/${encodeURIComponent(symbol)}`);
  const deals = await get<DealHistory[]>(
    `/v1/history/deals?fromMs=${boundary.currentStartTime}&toMs=${now}&symbol=${encodeURIComponent(symbol)}`,
  );

  const botDeals = deals.filter((deal) => deal.side !== null && Number(deal.magic) === magicNumber);
  const positionsWithRealizedExit = new Set(
    botDeals
      .filter((deal) => deal.entry === "OUT" || deal.entry === "INOUT" || deal.entry === "OUT_BY")
      .map((deal) => String(deal.positionId)),
  );
  const realizedPnl = botDeals
    .filter((deal) => positionsWithRealizedExit.has(String(deal.positionId)))
    .reduce((sum, deal) => sum + (Number.isFinite(Number(deal.netPnl)) ? Number(deal.netPnl) : 0), 0);

  const mode: "RECOVERY" | "TREND" = realizedPnl < -1e-9 ? "RECOVERY" : "TREND";
  const deficitUsd = Math.max(0, -realizedPnl);
  const cashPerPriceUnit = Number(spec.cashPerPriceUnitPerLot) * Number(position.volume);
  const rawRequiredMove = mode === "RECOVERY" && Number.isFinite(cashPerPriceUnit) && cashPerPriceUnit > 0
    ? (deficitUsd + DAY_RECOVERY_BUFFER_USD) / cashPerPriceUnit
    : DAY_RECOVERY_MIN_MOVE;
  const targetMove = clamp(rawRequiredMove, DAY_RECOVERY_MIN_MOVE, DAY_RECOVERY_MAX_MOVE);

  return {
    dayStartTime: boundary.currentStartTime,
    realizedPnl,
    deficitUsd,
    mode,
    targetMove,
    rawRequiredMove,
    canTurnPositiveWithinTen: rawRequiredMove <= DAY_RECOVERY_MAX_MOVE + 1e-9,
  };
}

'@
    $controller = Insert-Before $controller "async function managePosition(" $helper "Controller daily helper"
  }

  if (-not $controller.Contains("let dailyManagement: DailyManagementSnapshot | null = null;")) {
    $anchor = '  const favorable = managed.side === "BUY" ? exitPrice - position.entry : position.entry - exitPrice;'
    if (-not $controller.Contains($anchor)) { throw "managePosition favorable anchor not found." }
    $dailyRead = @'

  let dailyManagement: DailyManagementSnapshot | null = null;
  try {
    dailyManagement = await getDailyManagementSnapshot(position, spec);
  } catch (error) {
    const now = Date.now();
    if (now - lastDailyRecoveryDataErrorAt >= 60_000) {
      lastDailyRecoveryDataErrorAt = now;
      journal("DAY_RECOVERY_DATA_UNAVAILABLE", { ticket: managed.ticket, message: errorMessage(error) });
    }
  }
'@
    $controller = $controller.Replace($anchor, $anchor + $dailyRead)
  }

  if (-not $controller.Contains('reason: "DAY_RECOVERY_6_TO_10"')) {
    $partialAnchor = "  if (!managed.partialApplied && favorable >= 10) {"
    if (-not $controller.Contains($partialAnchor)) { throw "PLUS10 partial anchor not found." }
    $recoveryBlock = @'
  if (dailyManagement?.mode === "RECOVERY") {
    if (favorable + 1e-9 >= dailyManagement.targetMove) {
      managed.exitAttempt += 1;
      saveState();
      const commandId = `p7b-day-recovery-${managed.ticket}-${managed.exitAttempt}`;
      const response = await post<CommandResponse>(`/v1/positions/${encodeURIComponent(managed.ticket)}/close`, {
        volume: position.volume,
        commandId,
      });
      if (response.success) {
        journal("EXIT_EXECUTED", {
          ticket: managed.ticket,
          side: managed.side,
          reason: "DAY_RECOVERY_6_TO_10",
          favorable,
          recoveryTargetMove: dailyManagement.targetMove,
          rawRequiredMove: dailyManagement.rawRequiredMove,
          dailyRealizedPnlBefore: dailyManagement.realizedPnl,
          deficitUsdBefore: dailyManagement.deficitUsd,
          canTurnPositiveWithinTen: dailyManagement.canTurnPositiveWithinTen,
          positionProfitBeforeClose: position.profit,
          closedVolume: position.volume,
          response,
        });
      } else {
        journal("DAY_RECOVERY_CLOSE_REJECTED", {
          ticket: managed.ticket,
          favorable,
          recoveryTargetMove: dailyManagement.targetMove,
          dailyRealizedPnlBefore: dailyManagement.realizedPnl,
          response,
        });
      }
    }
    // While the bot's closed P&L for the broker day is negative, do not use
    // the +10 one-third partial or the runner. The broker SL remains active.
    return;
  }

'@
    $controller = $controller.Replace($partialAnchor, $recoveryBlock + $partialAnchor)
  }

  if (-not $controller.Contains('reason: "DAY_RECOVERY_6_TO_10"')) {
    throw "Daily recovery controller block was not applied."
  }
  Write-Text $ControllerPath $controller
  Write-Host "PHASE7B_DAY_RECOVERY_CONTROLLER=PASS"
  Write-Host "PHASE7B_DAY_RECOVERY_PNL_SOURCE=MT5_CLOSED_DEALS_MAGIC"
  Write-Host "PHASE7B_DAY_RECOVERY_TARGET_RANGE=6_TO_10_PRICE"
  Write-Host "PHASE7B_DAY_RECOVERY_VOLUME_ESCALATION=False"

  # -----------------------------------------------------------------------
  # B. API: expose broker-day closed P&L and current management mode.
  # -----------------------------------------------------------------------
  $route = Read-Text $RoutePath
  if (-not $route.Contains("THREE_CANDLE_BODY_DOMINANCE")) { throw "API V6 three-candle source missing." }

  if (-not $route.Contains("type DailyManagementStatus =")) {
    $types = @'
type DailyDealHistory = {
  positionId: string;
  side: "BUY" | "SELL" | null;
  entry: "IN" | "OUT" | "INOUT" | "OUT_BY" | "UNKNOWN";
  netPnl: number;
  magic: number;
};

type DailyBoundary = {
  currentStartTime: number;
  previousStartTime: number | null;
};

type DailyManagementStatus = {
  dayStartTime: number;
  realizedPnl: number;
  mode: "RECOVERY" | "TREND";
  recoveryMinMove: 6;
  recoveryMaxMove: 10;
  basis: "MT5_CLOSED_DEALS_MAGIC";
  guaranteedPositive: false;
};

'@
    $route = Insert-Before $route "const ENGULF_BODY_TOLERANCE_PRICE" $types "API daily type"
  }

  if (-not $route.Contains("let dailyManagement: DailyManagementStatus | null = null;")) {
    $marker = "    res.json({"
    $daily = @'
    let dailyManagement: DailyManagementStatus | null = null;
    let dailyManagementError: string | null = null;
    try {
      dailyManagement = await getDailyManagementStatus();
    } catch (error) {
      dailyManagementError = error instanceof Error ? error.message : "Daily management unavailable.";
    }

'@
    $route = Insert-Before $route $marker $daily "API res daily status"
  }

  if (-not $route.Contains("      dailyManagement,")) {
    $anchor = "      entryDiagnosticsError,"
    if (-not $route.Contains($anchor)) { throw "API response entryDiagnosticsError anchor missing." }
    $route = $route.Replace($anchor, $anchor + "`r`n      dailyManagement,`r`n      dailyManagementError,")
  }

  if (-not $route.Contains("async function getDailyManagementStatus()")) {
    $helper = @'
async function getDailyManagementStatus(): Promise<DailyManagementStatus> {
  const baseUrl = process.env.MT5_BRIDGE_BASE_URL?.trim().replace(/\/$/, "") ?? "";
  const apiKey = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!baseUrl || !apiKey) throw new Error("Bridge credentials unavailable for daily management.");
  const magic = Number(process.env.MT5_MAGIC_NUMBER ?? "270713");
  const headers = { "x-mt5-api-key": apiKey };

  const boundaryResponse = await fetch(`${baseUrl}/v1/session/day-boundary/XAUUSD`, { headers });
  const boundaryText = await boundaryResponse.text();
  if (!boundaryResponse.ok) throw new Error(`Daily boundary failed ${boundaryResponse.status}: ${boundaryText}`);
  const boundary = JSON.parse(boundaryText) as DailyBoundary;

  const toMs = Date.now();
  const dealsResponse = await fetch(
    `${baseUrl}/v1/history/deals?fromMs=${boundary.currentStartTime}&toMs=${toMs}&symbol=XAUUSD`,
    { headers },
  );
  const dealsText = await dealsResponse.text();
  if (!dealsResponse.ok) throw new Error(`Daily deals failed ${dealsResponse.status}: ${dealsText}`);
  const deals = JSON.parse(dealsText) as DailyDealHistory[];

  const botDeals = deals.filter((deal) => deal.side !== null && Number(deal.magic) === magic);
  const exitedPositions = new Set(
    botDeals
      .filter((deal) => deal.entry === "OUT" || deal.entry === "INOUT" || deal.entry === "OUT_BY")
      .map((deal) => String(deal.positionId)),
  );
  const realizedPnl = botDeals
    .filter((deal) => exitedPositions.has(String(deal.positionId)))
    .reduce((sum, deal) => sum + (Number.isFinite(Number(deal.netPnl)) ? Number(deal.netPnl) : 0), 0);

  return {
    dayStartTime: boundary.currentStartTime,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    mode: realizedPnl < -1e-9 ? "RECOVERY" : "TREND",
    recoveryMinMove: 6,
    recoveryMaxMove: 10,
    basis: "MT5_CLOSED_DEALS_MAGIC",
    guaranteedPositive: false,
  };
}

'@
    $route = Insert-Before $route "async function getEntryDiagnostics()" $helper "API daily helper"
  }

  Write-Text $RoutePath $route
  Write-Host "PHASE7B_DAY_RECOVERY_API_SOURCE=PASS"

  # -----------------------------------------------------------------------
  # C. Web: fix stale M5 fresh-flip text + M15 countdown + daily mode card.
  # -----------------------------------------------------------------------
  $layout = Read-Text $LayoutPath
  $layout = $layout.Replace(
    "Rule hiện hành: 2 mô hình nến + Supertrend M15 + M5 fresh flip; FVG chỉ là bối cảnh.",
    "Rule hiện hành: 1 trong 3 mô hình nến + Supertrend M15 + Supertrend M5 cùng hướng + SL 6–10 giá."
  )
  $layout = $layout.Replace(
    "Mô hình nến → Supertrend M15 → M5 fresh flip · FVG chỉ là bối cảnh",
    "1 trong 3 mô hình nến → Supertrend M15 cùng hướng → Supertrend M5 cùng hướng → SL 6–10 giá"
  )
  Write-Text $LayoutPath $layout

  $gate = Read-Text $GatePagePath
  if (-not $gate.Contains("dailyManagement?:")) {
    $anchor = "  botStatus: string;"
    if (-not $gate.Contains($anchor)) { throw "Gate Snapshot botStatus anchor missing." }
    $dailyType = @'
  dailyManagement?: {
    dayStartTime: number;
    realizedPnl: number;
    mode: "RECOVERY" | "TREND";
    recoveryMinMove: 6;
    recoveryMaxMove: 10;
    guaranteedPositive: false;
  } | null;
  dailyManagementError?: string | null;
'@
    $gate = $gate.Replace($anchor, $anchor + "`r`n" + $dailyType.TrimEnd())
  }

  $oldRemaining = "  const remainingMs = d ? d.nextCloseTime - now : 0;"
  if ($gate.Contains($oldRemaining)) {
    $gate = $gate.Replace(
      $oldRemaining,
      "  const m15Ms = 15 * 60_000;`r`n  const nextM15Boundary = Math.floor(now / m15Ms) * m15Ms + m15Ms;`r`n  const remainingMs = d ? Math.max(0, Math.min(m15Ms, nextM15Boundary - now)) : 0;"
    )
  }

  if (-not $gate.Contains("const dayManagement = query.data.dailyManagement")) {
    $anchor = "  const confidence = d.trend.confidenceLevel ?? (d.entry.eligible ? \"TIÊU_CHUẨN\" : \"CHƯA_ĐÁNH_GIÁ\");"
    if (-not $gate.Contains($anchor)) { throw "Gate confidence anchor missing." }
    $gate = $gate.Replace($anchor, $anchor + "`r`n  const dayManagement = query.data.dailyManagement ?? null;")
  }

  $gate = $gate.Replace("Chưa xuất hiện một trong 2 mô hình nến bắt buộc.", "Chưa xuất hiện một trong 3 mô hình nến bắt buộc.")

  if (-not $gate.Contains("QUẢN LÝ LỢI NHUẬN TRONG NGÀY")) {
    $gateGrid = '      <Grid container spacing={2}>' + "`r`n" + '        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>'
    if (-not $gate.Contains($gateGrid)) {
      $gateGrid = '      <Grid container spacing={2}>' + "`n" + '        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>'
    }
    if (-not $gate.Contains($gateGrid)) { throw "Gate four-condition grid anchor missing." }
    $dailyCard = @'
      <Card variant="outlined" sx={{ borderColor: dayManagement?.mode === "RECOVERY" ? "warning.main" : "success.main" }}>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1.2} alignItems={{ md: "center" }}>
            <Box>
              <Typography variant="caption" color="text.secondary" fontWeight={900}>QUẢN LÝ LỢI NHUẬN TRONG NGÀY</Typography>
              <Typography variant="h6" fontWeight={950} mt={0.5}>
                P&L Bot đã chốt: {dayManagement ? `${dayManagement.realizedPnl >= 0 ? "+" : ""}$${dayManagement.realizedPnl.toFixed(2)}` : "—"}
              </Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>
                {dayManagement?.mode === "RECOVERY"
                  ? "Ngày đang âm → lệnh có lợi nhuận sẽ chốt TOÀN BỘ trong vùng +6 đến +10 giá. Khi P&L ngày về không âm, Bot quay lại gồng trend."
                  : "Ngày đang không âm → +6 dời SL hòa vốn, +10 chốt 1/3, phần còn lại tiếp tục gồng theo trend."}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" mt={0.8}>
                Không tăng lot · không ép lệnh để gỡ · nếu +10 chưa đủ bù mức âm, Bot vẫn chốt +10 và tiếp tục hồi phục ở lệnh hợp lệ sau.
              </Typography>
            </Box>
            <Chip
              label={dayManagement?.mode === "RECOVERY" ? "HỒI PHỤC NGÀY" : "GỒNG THEO TREND"}
              color={dayManagement?.mode === "RECOVERY" ? "warning" : "success"}
              variant="outlined"
              sx={{ fontWeight: 900 }}
            />
          </Stack>
        </CardContent>
      </Card>

'@
    $gate = $gate.Replace($gateGrid, $dailyCard + $gateGrid)
  }

  Write-Text $GatePagePath $gate
  Write-Host "PHASE7B_DAY_RECOVERY_WEB_SOURCE=PASS"
  Write-Host "PHASE7B_M15_COUNTDOWN=LOCAL_15_MINUTE_BOUNDARY"
  Write-Host "PHASE7B_OLD_M5_FRESH_FLIP_HEADER=False"

  # -----------------------------------------------------------------------
  # D. Telegram: entry message follows daily mode; recovery exit is compact.
  # -----------------------------------------------------------------------
  $telegram = Read-Text $TelegramPath
  $telegram = $telegram.Replace("Chờ: 1 trong 2 mô hình nến", "Chờ: 1 trong 3 mô hình nến")

  if (-not $telegram.Contains("const recoveryDay = enrichment.live?.dailyManagement?.mode === \"RECOVERY\";")) {
    $anchor = '    const tp = entry === null ? null : side === "BUY" ? entry + 10 : entry - 10;'
    if (-not $telegram.Contains($anchor)) { throw "Telegram ENTRY tp anchor missing." }
    $telegram = $telegram.Replace(
      $anchor,
      '    const recoveryDay = enrichment.live?.dailyManagement?.mode === "RECOVERY";' + "`r`n" +
      '    const dailyPnl = numberOrNull(enrichment.live?.dailyManagement?.realizedPnl);' + "`r`n" +
      $anchor
    )
  }

  $oldTpLine = '      `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,'
  if ($telegram.Contains($oldTpLine)) {
    $newTpLine = '      recoveryDay ? `🎯 Hồi phục ngày: <b>chốt toàn bộ trong +6 → +10 giá</b>` : `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,'
    $telegram = $telegram.Replace($oldTpLine, $newTpLine)
  }

  $oldRunnerLine = '      "ℹ️ 2/3 runner còn lại không có TP cứng; tiếp tục canonical management.",'
  if ($telegram.Contains($oldRunnerLine)) {
    $newRunner = '      recoveryDay ? `📅 P&L Bot hôm nay: ${fmtMoney(dailyPnl, true)} · ưu tiên đưa ngày về dương, không tăng lot.` : "ℹ️ 2/3 runner còn lại không có TP cứng; tiếp tục canonical management.",'
    $telegram = $telegram.Replace($oldRunnerLine, $newRunner)
  }

  if (-not $telegram.Contains('if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;')) {
    $anchor = '  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {'
    if (-not $telegram.Contains($anchor)) { throw "Telegram exit formatter anchor missing." }
    $telegram = $telegram.Replace($anchor, '  if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;' + "`r`n`r`n" + $anchor)
  }

  if (-not $telegram.Contains('if (v === "DAY_RECOVERY_6_TO_10")')) {
    $anchor = '  if (v === "REVERSAL_FVG_REJECTION") return "điều kiện thoát canonical";'
    if (-not $telegram.Contains($anchor)) { throw "Telegram reasonLabel anchor missing." }
    $telegram = $telegram.Replace($anchor, '  if (v === "DAY_RECOVERY_6_TO_10") return "chốt hồi phục ngày trong vùng +6 đến +10 giá";' + "`r`n" + $anchor)
  }

  Write-Text $TelegramPath $telegram
  & node --check $TelegramPath
  if ($LASTEXITCODE -ne 0) { throw "Telegram syntax check failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_DAY_RECOVERY_TELEGRAM=PASS"

  # -----------------------------------------------------------------------
  # E. Build API/web before any restart.
  # -----------------------------------------------------------------------
  & pnpm --filter '@xauusd/api' build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_DAY_RECOVERY_API_BUILD=PASS"

  & pnpm --filter '@xauusd/web' build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_DAY_RECOVERY_WEB_BUILD=PASS"

  # -----------------------------------------------------------------------
  # F. Verify DEMO bridge, restart API only. Web dev server is left intact.
  # -----------------------------------------------------------------------
  $key = Bridge-Key
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/health" -Headers @{ 'x-mt5-api-key' = $key } -TimeoutSec 5
  if (-not $health.connected -or $health.accountMode -ne 'demo') {
    throw "DEMO bridge preflight failed. connected=$($health.connected) mode=$($health.accountMode)"
  }
  Write-Host "PHASE7B_DAY_RECOVERY_BRIDGE=PASS"
  Write-Host "PHASE7B_DAY_RECOVERY_ACCOUNT_LOGIN=$($health.accountLogin)"

  $listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($processId -and $processId -ne $PID) {
      Write-Host "PHASE7B_DAY_RECOVERY_STOP_API_PID=$processId"
      & taskkill /PID $processId /T /F | Out-Null
    }
  }
  Start-Sleep -Seconds 1

  $apiEnv = Join-Path $Root ".env.phase7b-demo"
  $bridgeDemoEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
  $apiLauncher = @"
Set-Location '$Root'
if (Test-Path '$apiEnv') {
  Get-Content '$apiEnv' | ForEach-Object {
    if (`$_ -match '^\s*([^#][^=]*)=(.*)$') { [Environment]::SetEnvironmentVariable(`$matches[1].Trim(), `$matches[2].Trim(), 'Process') }
  }
}
Get-Content '$bridgeDemoEnv' | ForEach-Object {
  if (`$_ -match '^\s*([^#][^=]*)=(.*)$') { [Environment]::SetEnvironmentVariable(`$matches[1].Trim(), `$matches[2].Trim(), 'Process') }
}
`$env:PORT = '$ApiPort'
`$env:HOST = '127.0.0.1'
`$env:MT5_BRIDGE_ENABLED = 'true'
`$env:MT5_BRIDGE_BASE_URL = 'http://127.0.0.1:$BridgePort'
`$env:MT5_BRIDGE_API_KEY = '$key'
`$env:EXECUTION_WORKER_ENABLED = 'false'
`$env:PHASE7B_DEMO_WORK_DIR = '$DemoDir'
`$env:PHASE7B_LOCAL_CONTROL_ENABLED = 'true'
`$env:PHASE7B_FIXED_VOLUME = '0.03'
`$env:WEB_ORIGIN = 'http://127.0.0.1:5717'
pnpm --filter @xauusd/api dev
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($apiLauncher))
  $apiProcess = Start-Process powershell.exe -PassThru -ArgumentList @('-NoExit', '-EncodedCommand', $encoded)

  $snapshot = $null
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 2
      if ($snapshot) { break }
    } catch {}
  }
  if (-not $snapshot) { throw "API PID $($apiProcess.Id) did not become ready on port $ApiPort." }
  if ($snapshot.mt5.health.accountMode -ne 'demo') { throw "API account mode is not demo." }

  Write-Host "PHASE7B_DAY_RECOVERY_API=PASS"
  Write-Host "PHASE7B_DAY_RECOVERY_MODE=$($snapshot.dailyManagement.mode)"
  Write-Host "PHASE7B_DAY_RECOVERY_REALIZED_PNL=$($snapshot.dailyManagement.realizedPnl)"
  Write-Host "PHASE7B_DAY_RECOVERY_WHEN_NEGATIVE=FULL_CLOSE_6_TO_10"
  Write-Host "PHASE7B_DAY_RECOVERY_WHEN_NON_NEGATIVE=PLUS6_BE_PLUS10_ONE_THIRD_RUNNER"
  Write-Host "PHASE7B_DAY_RECOVERY_GUARANTEED_POSITIVE=False"
  Write-Host "PHASE7B_DAY_RECOVERY_BOT_RESTARTED=False"
  Write-Host "PHASE7B_DAY_RECOVERY_TELEGRAM_RESTARTED=False"
  Write-Host "PHASE7B_DAY_RECOVERY_WEB_RESTARTED=False"
  Write-Host "PHASE7B_REAL_ACCOUNT_ALLOWED=False"
  Write-Host "PHASE7B_DAY_RECOVERY_V7=PASS"
}
finally {
  Pop-Location
}
