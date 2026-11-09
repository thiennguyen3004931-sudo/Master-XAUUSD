import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const files = {
  controller: path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
  route: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
  gate: path.join(root, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx"),
  layout: path.join(root, "apps", "web", "src", "ui", "DashboardLayout.tsx"),
  telegram: path.join(root, "scripts", "run-phase7b-telegram-notifier-compact.mjs"),
};

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function insertBefore(text, marker, block, name) {
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`${name} marker not found: ${marker}`);
  return text.slice(0, idx) + block + text.slice(idx);
}

function replaceRequired(text, from, to, name) {
  if (!text.includes(from)) throw new Error(`${name} marker not found.`);
  return text.replace(from, to);
}

function run(cmd, args, label) {
  const executable = process.platform === "win32" && cmd === "pnpm" ? "pnpm.cmd" : cmd;
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed: ${result.status}`);
}

// ---------------------------------------------------------------------------
// A. DEMO controller: closed daily P&L recovery management.
// ---------------------------------------------------------------------------
let controller = read(files.controller);
if (!controller.includes("THREE_CANDLE_BODY_DOMINANCE")) throw new Error("Apply V6 three-candle rule first.");
if (!controller.includes("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")) throw new Error("Controller is not on M15+M5 Supertrend alignment rule.");

if (!controller.includes("cashPerPriceUnitPerLot: number;")) {
  controller = replaceRequired(
    controller,
    "  effectiveTickValuePerLot: number;",
    "  effectiveTickValuePerLot: number;\n  cashPerPriceUnitPerLot: number;",
    "SymbolSpec cash value",
  );
}

if (!controller.includes("type DailyManagementSnapshot =")) {
  controller = insertBefore(
    controller,
    "type ManagedState = {",
`type DealHistory = {
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

`,
    "Controller daily types",
  );
}

if (!controller.includes("DAY_RECOVERY_MIN_MOVE")) {
  controller = replaceRequired(
    controller,
    "const ENGULF_BODY_TOLERANCE_PRICE = 0.1;",
`const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const DAY_RECOVERY_MIN_MOVE = 6;
const DAY_RECOVERY_MAX_MOVE = 10;
const DAY_RECOVERY_BUFFER_USD = Math.max(0.01, Number(process.env.ZIQ_DAY_RECOVERY_BUFFER_USD ?? "1"));
let lastDailyRecoveryDataErrorAt = 0;`,
    "Controller daily constants",
  );
}

if (!controller.includes("async function getDailyManagementSnapshot(")) {
  controller = insertBefore(
    controller,
    "async function managePosition(",
`async function getDailyManagementSnapshot(position: Position, spec: SymbolSpec): Promise<DailyManagementSnapshot> {
  const now = Date.now();
  const boundary = await get<TradingDayBoundary>(\`/v1/session/day-boundary/\${encodeURIComponent(symbol)}\`);
  const deals = await get<DealHistory[]>(
    \`/v1/history/deals?fromMs=\${boundary.currentStartTime}&toMs=\${now}&symbol=\${encodeURIComponent(symbol)}\`,
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

`,
    "Controller daily helper",
  );
}

if (!controller.includes("let dailyManagement: DailyManagementSnapshot | null = null;")) {
  const anchor = '  const favorable = managed.side === "BUY" ? exitPrice - position.entry : position.entry - exitPrice;';
  controller = replaceRequired(
    controller,
    anchor,
`${anchor}

  let dailyManagement: DailyManagementSnapshot | null = null;
  try {
    dailyManagement = await getDailyManagementSnapshot(position, spec);
  } catch (error) {
    const now = Date.now();
    if (now - lastDailyRecoveryDataErrorAt >= 60_000) {
      lastDailyRecoveryDataErrorAt = now;
      journal("DAY_RECOVERY_DATA_UNAVAILABLE", { ticket: managed.ticket, message: errorMessage(error) });
    }
  }`,
    "managePosition daily read",
  );
}

if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) {
  const partialAnchor = "  if (!managed.partialApplied && favorable >= 10) {";
  const recoveryBlock = `  if (dailyManagement?.mode === "RECOVERY") {
    if (favorable + 1e-9 >= dailyManagement.targetMove) {
      managed.exitAttempt += 1;
      saveState();
      const commandId = \`p7b-day-recovery-\${managed.ticket}-\${managed.exitAttempt}\`;
      const response = await post<CommandResponse>(\`/v1/positions/\${encodeURIComponent(managed.ticket)}/close\`, {
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
    // While today's closed bot P&L is negative, do not use +10 one-third
    // partial or the runner. The broker SL and the +6 break-even rule remain.
    return;
  }

`;
  controller = replaceRequired(controller, partialAnchor, recoveryBlock + partialAnchor, "Recovery close block");
}

if (!controller.includes('reason: "DAY_RECOVERY_6_TO_10"')) throw new Error("Daily recovery controller block missing after patch.");
write(files.controller, controller);
console.log("PHASE7B_DAY_RECOVERY_CONTROLLER=PASS");
console.log("PHASE7B_DAY_RECOVERY_PNL_SOURCE=MT5_CLOSED_DEALS_MAGIC");
console.log("PHASE7B_DAY_RECOVERY_TARGET_RANGE=6_TO_10_PRICE");
console.log("PHASE7B_DAY_RECOVERY_VOLUME_ESCALATION=False");

// ---------------------------------------------------------------------------
// B. API: expose broker-day realized P&L and management mode.
// ---------------------------------------------------------------------------
let route = read(files.route);
if (!route.includes("THREE_CANDLE_BODY_DOMINANCE")) throw new Error("API V6 three-candle source missing.");

if (!route.includes("type DailyManagementStatus =")) {
  route = insertBefore(
    route,
    "const ENGULF_BODY_TOLERANCE_PRICE",
`type DailyDealHistory = {
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

`,
    "API daily types",
  );
}

if (!route.includes("let dailyManagement: DailyManagementStatus | null = null;")) {
  route = insertBefore(
    route,
    "    res.json({",
`    let dailyManagement: DailyManagementStatus | null = null;
    let dailyManagementError: string | null = null;
    try {
      dailyManagement = await getDailyManagementStatus();
    } catch (error) {
      dailyManagementError = error instanceof Error ? error.message : "Daily management unavailable.";
    }

`,
    "API response daily status",
  );
}

if (!route.includes("      dailyManagement,")) {
  route = replaceRequired(
    route,
    "      entryDiagnosticsError,",
    "      entryDiagnosticsError,\n      dailyManagement,\n      dailyManagementError,",
    "API response fields",
  );
}

if (!route.includes("async function getDailyManagementStatus()")) {
  route = insertBefore(
    route,
    "async function getEntryDiagnostics()",
`async function getDailyManagementStatus(): Promise<DailyManagementStatus> {
  const baseUrl = process.env.MT5_BRIDGE_BASE_URL?.trim().replace(/\\\/$/, "") ?? "";
  const apiKey = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!baseUrl || !apiKey) throw new Error("Bridge credentials unavailable for daily management.");
  const magic = Number(process.env.MT5_MAGIC_NUMBER ?? "270713");
  const headers = { "x-mt5-api-key": apiKey };

  const boundaryResponse = await fetch(\`\${baseUrl}/v1/session/day-boundary/XAUUSD\`, { headers });
  const boundaryText = await boundaryResponse.text();
  if (!boundaryResponse.ok) throw new Error(\`Daily boundary failed \${boundaryResponse.status}: \${boundaryText}\`);
  const boundary = JSON.parse(boundaryText) as DailyBoundary;

  const toMs = Date.now();
  const dealsResponse = await fetch(
    \`\${baseUrl}/v1/history/deals?fromMs=\${boundary.currentStartTime}&toMs=\${toMs}&symbol=XAUUSD\`,
    { headers },
  );
  const dealsText = await dealsResponse.text();
  if (!dealsResponse.ok) throw new Error(\`Daily deals failed \${dealsResponse.status}: \${dealsText}\`);
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

`,
    "API daily helper",
  );
}

write(files.route, route);
console.log("PHASE7B_DAY_RECOVERY_API_SOURCE=PASS");

// ---------------------------------------------------------------------------
// C. Web: current rule text, countdown, and daily mode card.
// ---------------------------------------------------------------------------
let layout = read(files.layout);
layout = layout
  .replace(
    "Rule hiện hành: 2 mô hình nến + Supertrend M15 + M5 fresh flip; FVG chỉ là bối cảnh.",
    "Rule hiện hành: 1 trong 3 mô hình nến + Supertrend M15 + Supertrend M5 cùng hướng + SL 6–10 giá.",
  )
  .replace(
    "Mô hình nến → Supertrend M15 → M5 fresh flip · FVG chỉ là bối cảnh",
    "1 trong 3 mô hình nến → Supertrend M15 cùng hướng → Supertrend M5 cùng hướng → SL 6–10 giá",
  );
write(files.layout, layout);

let gate = read(files.gate);
if (!gate.includes("dailyManagement?: {")) {
  gate = replaceRequired(
    gate,
    "  entryDiagnosticsError?: string | null;",
`  entryDiagnosticsError?: string | null;
  dailyManagement?: {
    dayStartTime: number;
    realizedPnl: number;
    mode: "RECOVERY" | "TREND";
    recoveryMinMove: 6;
    recoveryMaxMove: 10;
    guaranteedPositive: false;
  } | null;
  dailyManagementError?: string | null;`,
    "Gate Snapshot daily type",
  );
}

const oldRemaining = "  const remainingMs = d ? d.nextCloseTime - now : 0;";
if (gate.includes(oldRemaining)) {
  gate = gate.replace(
    oldRemaining,
`  const m15Ms = 15 * 60_000;
  const nextM15Boundary = Math.floor(now / m15Ms) * m15Ms + m15Ms;
  const remainingMs = d ? Math.max(0, Math.min(m15Ms, nextM15Boundary - now)) : 0;`,
  );
}

if (!gate.includes("const dayManagement = query.data.dailyManagement")) {
  const confidenceRegex = /^(\s*const confidence = .*;)$/m;
  if (!confidenceRegex.test(gate)) throw new Error("Gate confidence anchor missing.");
  gate = gate.replace(confidenceRegex, "$1\n  const dayManagement = query.data.dailyManagement ?? null;");
}

gate = gate
  .replace("Chưa xuất hiện một trong 2 mô hình nến bắt buộc.", "Chưa xuất hiện một trong 3 mô hình nến bắt buộc.")
  .replace("Chờ nến nhấn chìm hoặc hai nến thân chiếm ưu thế", "Chờ nến nhấn chìm, hai nến hoặc ba nến thân chiếm ưu thế");

if (!gate.includes("QUẢN LÝ LỢI NHUẬN TRONG NGÀY")) {
  const conditionGrid = /      <Grid container spacing=\{2\}>\r?\n        <Grid size=\{\{ xs: 12, sm: 6, xl: 3 \}\}>/;
  const match = gate.match(conditionGrid);
  if (!match || match.index == null) throw new Error("Gate four-condition grid anchor missing.");
  const dailyCard = `      <Card variant="outlined" sx={{ borderColor: dayManagement?.mode === "RECOVERY" ? "warning.main" : "success.main" }}>
        <CardContent>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1.2} alignItems={{ md: "center" }}>
            <Box>
              <Typography variant="caption" color="text.secondary" fontWeight={900}>QUẢN LÝ LỢI NHUẬN TRONG NGÀY</Typography>
              <Typography variant="h6" fontWeight={950} mt={0.5}>
                P&L Bot đã chốt: {dayManagement ? \`\${dayManagement.realizedPnl >= 0 ? "+" : ""}$\${dayManagement.realizedPnl.toFixed(2)}\` : "—"}
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

`;
  gate = gate.slice(0, match.index) + dailyCard + gate.slice(match.index);
}

write(files.gate, gate);
console.log("PHASE7B_DAY_RECOVERY_WEB_SOURCE=PASS");
console.log("PHASE7B_M15_COUNTDOWN=LOCAL_15_MINUTE_BOUNDARY");
console.log("PHASE7B_OLD_M5_FRESH_FLIP_HEADER=False");

// ---------------------------------------------------------------------------
// D. Telegram: recovery-mode entry and compact recovery close reason.
// ---------------------------------------------------------------------------
let telegram = read(files.telegram);
telegram = telegram.replace("Chờ: 1 trong 2 mô hình nến", "Chờ: 1 trong 3 mô hình nến");

if (!telegram.includes('const recoveryDay = enrichment.live?.dailyManagement?.mode === "RECOVERY";')) {
  const tpAnchor = '    const tp = entry === null ? null : side === "BUY" ? entry + 10 : entry - 10;';
  telegram = replaceRequired(
    telegram,
    tpAnchor,
`    const recoveryDay = enrichment.live?.dailyManagement?.mode === "RECOVERY";
    const dailyPnl = numberOrNull(enrichment.live?.dailyManagement?.realizedPnl);
${tpAnchor}`,
    "Telegram entry recovery state",
  );
}

const oldTp = '      `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,';
if (telegram.includes(oldTp)) {
  telegram = telegram.replace(
    oldTp,
    '      recoveryDay ? `🎯 Hồi phục ngày: <b>chốt toàn bộ trong +6 → +10 giá</b>` : `🎯 TP dự kiến: <b>${fmtPrice(tp)}</b> · +10.00 giá · chốt 1/3`,',
  );
}

const oldRunner = '      "ℹ️ 2/3 runner còn lại không có TP cứng; tiếp tục canonical management.",';
if (telegram.includes(oldRunner)) {
  telegram = telegram.replace(
    oldRunner,
    '      recoveryDay ? `📅 P&L Bot hôm nay: ${fmtMoney(dailyPnl, true)} · ưu tiên hồi phục ngày, không tăng lot.` : "ℹ️ 2/3 runner còn lại không có TP cứng; tiếp tục canonical management.",',
  );
}

if (!telegram.includes('if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;')) {
  const exitAnchor = '  if (type === "EXIT_EXECUTED" || type === "MANAGED_POSITION_CLOSED") {';
  telegram = replaceRequired(
    telegram,
    exitAnchor,
    '  if (type === "MANAGED_POSITION_CLOSED" && !state.trade) return null;\n\n' + exitAnchor,
    "Telegram duplicate close suppression",
  );
}

if (!telegram.includes('if (v === "DAY_RECOVERY_6_TO_10")')) {
  const reasonAnchor = '  if (v === "REVERSAL_FVG_REJECTION") return "điều kiện thoát canonical";';
  telegram = replaceRequired(
    telegram,
    reasonAnchor,
    '  if (v === "DAY_RECOVERY_6_TO_10") return "chốt hồi phục ngày trong vùng +6 đến +10 giá";\n' + reasonAnchor,
    "Telegram recovery reason",
  );
}

write(files.telegram, telegram);
run("node", ["--check", files.telegram], "Telegram syntax check");
console.log("PHASE7B_DAY_RECOVERY_TELEGRAM=PASS");

// ---------------------------------------------------------------------------
// E. Build before any runtime restart.
// ---------------------------------------------------------------------------
run("pnpm", ["--filter", "@xauusd/api", "build"], "API build");
console.log("PHASE7B_DAY_RECOVERY_API_BUILD=PASS");
run("pnpm", ["--filter", "@xauusd/web", "build"], "Web build");
console.log("PHASE7B_DAY_RECOVERY_WEB_BUILD=PASS");

console.log("PHASE7B_DAY_RECOVERY_WHEN_NEGATIVE=FULL_CLOSE_6_TO_10");
console.log("PHASE7B_DAY_RECOVERY_WHEN_NON_NEGATIVE=PLUS6_BE_PLUS10_ONE_THIRD_RUNNER");
console.log("PHASE7B_DAY_RECOVERY_GUARANTEED_POSITIVE=False");
console.log("PHASE7B_DAY_RECOVERY_BOT_RESTARTED=False");
console.log("PHASE7B_DAY_RECOVERY_TELEGRAM_RESTARTED=False");
console.log("PHASE7B_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_DAY_RECOVERY_V8_PATCH=PASS");
