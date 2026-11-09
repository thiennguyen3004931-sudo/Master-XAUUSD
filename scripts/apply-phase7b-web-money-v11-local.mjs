import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const gatePath = path.join(root, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx");
const demoPath = path.join(root, "apps", "web", "src", "pages", "Phase7BDemoPage.tsx");

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function requiredReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`${label} marker not found.`);
  return text.replace(from, to);
}

function run(cmd, args, label) {
  const executable = process.platform === "win32" && cmd === "pnpm" ? "pnpm.cmd" : cmd;
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed: ${result.status}`);
}

// ---------------------------------------------------------------------------
// Entry gate page: show Equity + Balance + floating P&L.
// ---------------------------------------------------------------------------
let gate = read(gatePath);
gate = gate.replace(
  'import { dateTime, price } from "../format";',
  'import { dateTime, money, price } from "../format";',
);

if (!gate.includes("accountEquity?: number")) {
  const compactHealth = 'health?: { accountMode?: string; accountLogin?: number | null; server?: string | null } | null;';
  if (gate.includes(compactHealth)) {
    gate = gate.replace(
      compactHealth,
      'health?: { accountMode?: string; accountLogin?: number | null; server?: string | null; accountBalance?: number; accountEquity?: number; accountProfit?: number; accountCurrency?: string } | null;',
    );
  } else {
    const serverLine = /(^\s*server\?: string \| null;?\r?$)/m;
    if (!serverLine.test(gate)) throw new Error("Gate MT5 health type marker not found.");
    gate = gate.replace(
      serverLine,
      '$1\n      accountBalance?: number;\n      accountEquity?: number;\n      accountProfit?: number;\n      accountCurrency?: string;',
    );
  }
}

if (!gate.includes("const accountEquity = health?.accountEquity")) {
  const marker = "  const quote = query.data.mt5?.quote;";
  const block = [
    marker,
    "  const health = query.data.mt5?.health ?? null;",
    '  const currency = health?.accountCurrency ?? "USD";',
    "  const accountEquity = health?.accountEquity ?? null;",
    "  const accountBalance = health?.accountBalance ?? null;",
    "  const accountFloating = health?.accountProfit ?? 0;",
  ].join("\n");
  gate = requiredReplace(gate, marker, block, "Gate account metrics");
}

// The first summary row has four cards after this patch.
gate = gate.replaceAll('size={{ xs: 12, md: 4 }}', 'size={{ xs: 12, md: 3 }}');

if (!gate.includes("TỔNG TIỀN HIỆN TẠI (EQUITY)")) {
  const firstSummaryGrid = '        <Grid size={{ xs: 12, md: 3 }}>';
  const idx = gate.indexOf(firstSummaryGrid);
  if (idx < 0) throw new Error("Gate summary grid marker not found.");
  const card = [
    '        <Grid size={{ xs: 12, md: 3 }}>',
    '          <Card variant="outlined"><CardContent>',
    '            <Typography variant="caption" color="text.secondary" fontWeight={900}>TỔNG TIỀN HIỆN TẠI (EQUITY)</Typography>',
    '            <Typography variant="h4" fontWeight={950}>{money(accountEquity, currency)}</Typography>',
    '            <Typography variant="caption" color="text.secondary">Số dư đã chốt {money(accountBalance, currency)} · Lệnh mở {money(accountFloating, currency)}</Typography>',
    '          </CardContent></Card>',
    '        </Grid>',
    '',
  ].join("\n");
  gate = gate.slice(0, idx) + card + gate.slice(idx);
}

write(gatePath, gate);
console.log("PHASE7B_WEB_MONEY_GATE=PASS");

// ---------------------------------------------------------------------------
// Main DEMO monitor: show Equity/Balance and daily bot P&L, remove stale flip gate.
// ---------------------------------------------------------------------------
let demo = read(demoPath);

if (!demo.includes("accountEquity?: number")) {
  const marker = "      accountProfit?: number;";
  if (!demo.includes(marker)) throw new Error("Demo health accountProfit marker not found.");
  demo = demo.replace(
    marker,
    [
      "      accountProfit?: number;",
      "      accountBalance?: number;",
      "      accountEquity?: number;",
    ].join("\n"),
  );
}

if (!demo.includes("dailyManagement?: {")) {
  const marker = "  entryDiagnosticsError?: string | null;";
  if (!demo.includes(marker)) throw new Error("Demo Snapshot daily management marker not found.");
  demo = demo.replace(
    marker,
    [
      marker,
      "  dailyManagement?: {",
      "    dayStartTime: number;",
      "    realizedPnl: number;",
      '    mode: "RECOVERY" | "TREND";',
      "    recoveryMinMove: 6;",
      "    recoveryMaxMove: 10;",
      "    guaranteedPositive: false;",
      "  } | null;",
      "  dailyManagementError?: string | null;",
    ].join("\n"),
  );
}

if (!demo.includes("const dailyManagement = data.dailyManagement")) {
  const marker = '  const currency = health?.accountCurrency ?? "USD";';
  demo = requiredReplace(
    demo,
    marker,
    [
      marker,
      "  const dailyManagement = data.dailyManagement ?? null;",
      "  const accountEquity = health?.accountEquity ?? null;",
      "  const accountBalance = health?.accountBalance ?? null;",
    ].join("\n"),
    "Demo account metrics",
  );
}

demo = demo.replace(
  "  const currentM5Aligned = Boolean(managed && diagnostics?.trend.m5Supertrend === managed.side && diagnostics?.trend.m5FreshAligned);",
  "  const currentM5Aligned = Boolean(managed && diagnostics?.trend.m5Supertrend === managed.side);",
);
demo = demo.replace(
  'label="Fresh flip M5"',
  'label="Flip age M5 (tham khảo)"',
);
demo = demo.replace(
  "? `Được phép vào ${tenHuong(diagnostics.entry.side)} vì 2 mô hình nến + Supertrend M15 cùng hướng + M5 fresh flip ≤ 2 đều đạt. FVG chỉ là bối cảnh.`",
  "? `Được phép vào ${tenHuong(diagnostics.entry.side)} vì 1 trong 3 mô hình nến + Supertrend M15 và M5 cùng hướng + SL 6–10 giá đều đạt. FVG/flip age chỉ là bối cảnh.`",
);

if (!demo.includes("Tổng tiền hiện tại")) {
  const accountCardEnd = '          <MetricCard label="Tài khoản DEMO" value={String(health?.accountLogin ?? data.state?.accountLogin ?? "—")} detail={`${health?.server ?? "—"}`} icon={<AccountCircleRounded color="primary" />} />\r\n        </Grid>';
  let marker = accountCardEnd;
  if (!demo.includes(marker)) {
    marker = accountCardEnd.replaceAll("\r\n", "\n");
  }
  if (!demo.includes(marker)) throw new Error("Demo account card marker not found.");
  const cards = [
    marker,
    '        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>',
    '          <MetricCard label="Tổng tiền hiện tại" value={money(accountEquity, currency)} detail={`Số dư đã chốt ${money(accountBalance, currency)}`} icon={<ReceiptLongRounded color="primary" />} />',
    '        </Grid>',
    '        <Grid size={{ xs: 12, sm: 6, xl: 3 }}>',
    '          <MetricCard label="P&L Bot hôm nay" value={dailyManagement ? money(dailyManagement.realizedPnl, currency) : "—"} detail={dailyManagement?.mode === "RECOVERY" ? "HỒI PHỤC NGÀY · chốt toàn bộ +6 đến +10 giá" : "GỒNG THEO TREND"} icon={<ReceiptLongRounded color={dailyManagement && dailyManagement.realizedPnl < 0 ? "warning" : "success"} />} tone={dailyManagement && dailyManagement.realizedPnl < 0 ? "warning.main" : "success.main"} />',
    '        </Grid>',
  ].join("\n");
  demo = demo.replace(marker, cards);
}

write(demoPath, demo);
console.log("PHASE7B_WEB_MONEY_MONITOR=PASS");
console.log("PHASE7B_WEB_MONEY_EQUITY=VISIBLE");
console.log("PHASE7B_WEB_MONEY_BALANCE=VISIBLE");
console.log("PHASE7B_WEB_MONEY_DAILY_PNL=VISIBLE");
console.log("PHASE7B_WEB_STALE_FRESH_FLIP_GATE=False");

run("pnpm", ["--filter", "@xauusd/web", "build"], "Web build");
console.log("PHASE7B_WEB_MONEY_BUILD=PASS");
console.log("PHASE7B_WEB_MONEY_V11=PASS");
