import test from "node:test";
import { execFileSync as gitExecFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = readFileSync(resolve(root, "scripts/xauusd-standalone-server.mjs"), "utf8");

test("manual V6 order requires an explicit BUY/SELL direction; never defaults to BUY", () => {
  assert.match(server, /requestedSide !== "BUY" && requestedSide !== "SELL"/);
  assert.match(server, /side: requestedSide/);
  assert.doesNotMatch(server, /side:\s*body\.side\s*\|\|\s*["']BUY["']/);
});

test("V6 close and BE both require strict explicit tickets", () => {
  assert.match(server, /parseRequiredTicket\(body\.ticket\)/);
  assert.match(server, /action: "close", ticket/);
  assert.match(server, /action: "breakeven", ticket/);
  assert.doesNotMatch(server, /ticket: body\.ticket \|\| null/);
});

test("DCA and auto-bot do not coerce strings into enabled trading", () => {
  assert.match(server, /parseOptionalBoolean\(body\.executeNow/);
  assert.match(server, /parseOptionalBoolean\(body\.enabled/);
  assert.match(server, /parseOptionalBoolean\(body\.semiAutoAdoptManual/);
  assert.match(server, /executeNow === true \? "dca_plus" : "probe"/);
  const dcaRoute = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/positive-dca"'),
    server.indexOf('if (pathname === "/api/v1/mt5/approve-proposal"'),
  );
  const autoRoute = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/auto-bot"'),
    server.indexOf('if (pathname === "/api/v1/mt5/status"'),
  );
  assert.ok(dcaRoute.length > 0 && autoRoute.length > 0);
  assert.doesNotMatch(dcaRoute, /Boolean\(body\.enabled\)|Boolean\(body\.executeNow\)/);
  assert.doesNotMatch(autoRoute, /Boolean\(body\.enabled\)|Boolean\(body\.semiAutoAdoptManual\)/);
});

import { parseRequiredTicket, parseOptionalBoolean } from "../scripts/v6-api-input-guards.mjs";

test("ticket parser permits only canonical positive safe integers", () => {
  assert.equal(parseRequiredTicket(42), 42);
  assert.equal(parseRequiredTicket("4201"), 4201);
  for (const input of [undefined, null, true, false, 0, -1, 1.5, "0", "01", "1.0", "1e3", " 7", "7 ", "-7", "", [], {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseRequiredTicket(input), /EXPLICIT_POSITIVE_TICKET_REQUIRED/);
  }
});

test("trading switches only accept actual booleans", () => {
  assert.equal(parseOptionalBoolean(undefined), undefined);
  assert.equal(parseOptionalBoolean(false), false);
  assert.equal(parseOptionalBoolean(true), true);
  for (const input of [null, 0, 1, "true", "false", "", [], {}]) {
    assert.throws(() => parseOptionalBoolean(input, "enabled"), /BOOLEAN_REQUIRED/);
  }
});

test("server never force-kills other Windows processes to reclaim its ports", () => {
  assert.doesNotMatch(server, /Stop-Process\s+-Id/);
  assert.doesNotMatch(server, /freeStalePortsOnWindows\s*\(/);
  assert.match(server, /V6_\$\{label\}_LISTEN_FAILED/);
  assert.match(server, /code === "EADDRINUSE"/);
  assert.match(server, /process\.exit\(1\)/);
});

test("pending or partially filled V6 entries disable automatic re-submission", () => {
  const loop = server.slice(
    server.indexOf('if (openPos.length > 0 && positiveDcaConfig.enabled)'),
    server.indexOf('// Đã tắt tự động gửi kịch bản 15 phút'),
  );
  assert.ok(loop.length > 0);
  assert.match(loop, /dcaSnap\?\.actionResult\?\.submitted/);
  assert.match(loop, /positiveDcaConfig\.enabled = false/);
  assert.match(loop, /orderSnap\?\.actionResult\?\.submitted/);
  assert.match(loop, /autoBotState\.enabled = false/);
  const manualDca = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/positive-dca"'),
    server.indexOf('if (pathname === "/api/v1/mt5/approve-proposal"'),
  );
  assert.match(manualDca, /executeNow === true && probe\?\.actionResult\?\.submitted/);
  assert.match(manualDca, /positiveDcaConfig\.enabled = false/);
});

test("independent V6 never modifies legacy Phase7C bridge, account mode or LIVE ARM", () => {
  assert.doesNotMatch(server, /writeBridgeEnvAndArmFiles/);
  assert.doesNotMatch(server, /MT5_TRADING_ENABLED=/);
  assert.doesNotMatch(server, /MT5_ALLOW_REAL_ACCOUNT=/);
  assert.doesNotMatch(server, /XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=/);
  assert.doesNotMatch(server, /phase7c-live-arm[.]json/);
  assert.doesNotMatch(server, /phase7c-account-mode[.]json/);
  assert.doesNotMatch(server, /[.]env[.]phase7b-(demo|live)/);
  assert.match(server, /Independent V6 direct-MT5 must never mutate Phase7C bridge profile/);
});

test("standalone V6 is loopback-only, remote tunnels are disabled", () => {
  assert.match(server, /apiServer[.]listen\(API_PORT, "127[.]0[.]0[.]1",/);
  assert.match(server, /webServer[.]listen\(WEB_PORT, "127[.]0[.]0[.]1",/);
  assert.doesNotMatch(server, /[.]listen\((?:API_PORT|WEB_PORT), "0[.]0[.]0[.]0"/);
  assert.doesNotMatch(server, /startInternetTunnelForMobile|readSavedTunnelUrl/);
  assert.doesNotMatch(server, /\bspawn\s*\(|\bcloudflared\b/i);
  const tunnelRoute = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/internet-tunnel"'),
    server.indexOf('if (pathname === "/api/v1/mt5/order"'),
  );
  assert.ok(tunnelRoute.length > 0);
  assert.match(tunnelRoute, /sendJson\(res, 403,/);
  assert.match(tunnelRoute, /V6_REMOTE_TUNNEL_DISABLED/);
  assert.doesNotMatch(tunnelRoute, /invokeMt5PythonEngine|startInternetTunnelForMobile/);
  assert.match(server, /V6_NETWORK_SCOPE=LOOPBACK_ONLY\|REMOTE_TUNNEL=DISABLED/);
});

test("runtime account and credential files must never be tracked in Git", () => {
  const { execFileSync } = requireGuardedGit();
  const tracked = execFileSync("git", ["ls-files", "--", ".runtime"], {
    cwd: root, encoding: "utf8",
  }).trim();
  assert.equal(tracked, "", "LIVE arm state, MT5 credentials and Telegram token must be local-only");
});

function requireGuardedGit() {
  return { execFileSync: gitExecFileSync };
}

test("V6 broker credentials are sent over stdin, never via Windows process arguments", () => {
  const engine = server.slice(
    server.indexOf("function invokeMt5PythonEngineDirect("),
    server.indexOf("// All broker-mutating actions are serialized"),
  );
  assert.ok(engine.length > 0);
  assert.match(engine, /const args = \[\.\.\.py\.prefixArgs, DIRECT_PROBE_SCRIPT\];/);
  assert.match(engine, /child\.stdin\?\.end\(payloadStr/);
  assert.doesNotMatch(engine, /DIRECT_PROBE_SCRIPT\s*,\s*payloadStr/);
  assert.match(engine, /child\.stdin\?\.on\("error"/);
  const probe = readFileSync(resolve(root, "scripts/mt5-direct-probe.py"), "utf8");
  assert.match(probe, /def _read_stdin_payload\(\):/);
  assert.match(probe, /if len\(sys\.argv\) != 1:/);
  assert.doesNotMatch(probe, /sys\.argv\[1\]/);
});


test("V6 synthetic strategy metrics cannot masquerade as broker-verified results", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const banner = 'data-v6-synthetic-evidence-warning="true"';
  assert.equal(ui.split(banner).length - 1, 4, "dashboard, approvals, backtest and performance must disclose synthetic evidence");
  for (const section of ["route-dashboard", "route-approvals", "route-backtest", "route-performance"]) {
    const fragment = ui.slice(ui.indexOf('<section id="' + section + '"'));
    assert.ok(fragment.startsWith('<section id="' + section + '"'), "missing section " + section);
    assert.ok(fragment.indexOf(banner) > 0 && fragment.indexOf(banner) < 300, "no conspicuous evidence warning on " + section);
  }
  assert.match(ui, /MINH HỌA — KHÔNG PHẢI BẰNG CHỨNG GIAO DỊCH/);
  assert.match(ui, /không phải xác nhận lợi nhuận hay cấp quyền giao dịch LIVE/);
  assert.match(server, /source: "STATIC_UI_DEMONSTRATION"/);
  assert.match(server, /brokerVerified: false/);
  assert.match(server, /backtestVerified: false/);
  assert.match(server, /liveAuthorized: false/);
  assert.equal(server.split("botSampleEvidence: V6_SAMPLE_EVIDENCE").length - 1, 2);
});


test("public V6 UI never embeds or persists Telegram credentials", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  assert.doesNotMatch(ui, /DEFAULT_TG_PART_[AB]|DEFAULT_TG_CHAT_ID/);
  assert.doesNotMatch(ui, /localStorage\.(?:getItem|setItem)\(["']xauusd_tg_token["']/);
  assert.match(ui, /localStorage\.removeItem\("xauusd_tg_token"\)/);
  assert.match(ui, /id="inpTgToken" autocomplete="off"/);
  assert.match(ui, /const tok = document\.getElementById\("inpTgToken"\)\?\.value\.trim\(\) \|\| "";/);
  assert.doesNotMatch(ui, /<input[^>]+id="inpTgChatId"[^>]+value="[^"]+"/);
  assert.match(ui, /if \(!tok \|\| !chat\)/);
});


test("Telegram notifier is disabled on first start without explicit operator configuration", () => {
  const block = server.slice(
    server.indexOf("function loadTelegramConfig()"),
    server.indexOf("let telegramConfig = loadTelegramConfig()"),
  );
  assert.match(block, /enabled: false/);
  assert.match(block, /botToken: process\.env\.ZIQ_TELEGRAM_BOT_TOKEN \|\| ""/);
  assert.match(block, /chatId: process\.env\.ZIQ_TELEGRAM_CHAT_ID \|\| ""/);
  assert.doesNotMatch(block, /chatId: process\.env\.ZIQ_TELEGRAM_CHAT_ID \|\| "\d+"/);
});


test("public root standalone HTML mirrors credential-safe V6 UI", () => {
  const appHtml = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const fallbackHtml = readFileSync(resolve(root, "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html"), "utf8");
  assert.equal(fallbackHtml, appHtml, "fallback HTML must never retain a prior exposed token");
  assert.doesNotMatch(fallbackHtml, /DEFAULT_TG_PART_[AB]|DEFAULT_TG_CHAT_ID/);
  assert.doesNotMatch(fallbackHtml, /localStorage\.(?:getItem|setItem)\(["']xauusd_tg_token["']/);
});


test("V6 disconnected status never presents configured or demonstration broker metrics", () => {
  const status = server.slice(
    server.indexOf("function buildStatusPayload(probe)"),
    server.indexOf("async function handleApiRequest("),
  );
  assert.ok(status.length > 0, "missing V6 status builder");
  for (const sourceLine of [
    "accountLogin: isConnected ? probe.accountLogin : null,",
    'accountMode: isConnected ? probe.accountMode.toLowerCase() : "unknown",',
    "accountBalance: isConnected ? probe.balance : null,",
    "accountEquity: isConnected ? probe.equity : null,",
    "accountFreeMargin: isConnected ? probe.freeMargin : null,",
    "accountProfit: isConnected ? probe.profit : null,",
    "accountCurrency: isConnected ? probe.currency : null,",
    "server: isConnected ? probe.server : null,",
    "brokerSymbol: isConnected ? probe.brokerSymbol : null,",
    "availableGoldSymbols: isConnected ? (probe?.availableGoldSymbols || []) : [],",
  ]) {
    assert.ok(status.includes(sourceLine), "disconnected broker metric is not fail-closed: " + sourceLine);
  }
  assert.match(status, /mtfAnalysis = isConnected \?/);
  assert.match(status, /entrySignal: isConnected \?/);
  assert.doesNotMatch(status, /currentAccountConfig\.login \|\| 5201362/);
  assert.doesNotMatch(status, /accountBalance: isConnected \? probe\.balance : lastKnownAccountMetrics\.balance/);
});

test("V6 disconnected Web clears broker identity, quotes and percent-risk lot calculations", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const rootUi = readFileSync(resolve(root, "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html"), "utf8");
  assert.equal(ui, rootUi, "fallback Web must receive the same MT5-disconnect protection");
  assert.ok(ui.includes("data.mt5LiveBridgeConnected === true && h.connected === true"));
  assert.match(ui, /if \(connected\) \{\s*dotEl\.className = "dot dot-up"/);
  assert.ok(ui.includes("window.__latestAccountBalance = null"));
  assert.ok(ui.includes("window.__mt5BalanceVerified = false"));
  assert.ok(ui.includes('window.__mt5BalanceVerified !== true'));
  assert.ok(ui.includes("if (calcLot === null) return"));
  assert.ok(ui.includes("CHẶN TÍNH LOT: MT5 chưa xác minh"));
  assert.ok(ui.includes("ĐÃ CHẶN GỬI THAM SỐ LOT THEO %"));
  assert.ok(ui.includes("applyMt5StatusToUi({ mt5LiveBridgeConnected: false, health: { connected: false } })"));
  assert.ok(ui.includes('document.getElementById("dashEquityVal").textContent = "—"'));
  assert.doesNotMatch(ui, /window\.__latestAccountBalance = 4131\.83/);
  assert.doesNotMatch(ui, /const bal = window\.__latestAccountBalance \|\| 4131\.83/);
});


test("V6 market Telegram notifications cannot use offline synthetic data", () => {
  const mtf = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/mtf-refresh"'),
    server.indexOf("// API BẬT ĐƯỜNG HẦM", server.indexOf('if (pathname === "/api/v1/mt5/mtf-refresh"')),
  );
  assert.ok(mtf.length > 0);
  assert.match(mtf, /if \(!payload\.mt5LiveBridgeConnected \|\| !mtf\?\.h4 \|\| !mtf\?\.h1 \|\| !mtf\?\.m15 \|\| !mtf\?\.scenario15m\)/);
  assert.match(mtf, /code: "MT5_MTF_UNVERIFIED"/);
  assert.match(mtf, /payload\.telegramResult = await sendTelegramNotification/);
  const testEndpoint = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/telegram-config"'),
    server.indexOf('if (pathname === "/api/v1/mt5/mtf-refresh"'),
  );
  assert.match(testEndpoint, /Đây chỉ là tin nhắn kiểm tra kênh/);
  assert.doesNotMatch(testEndpoint, /mtf\.currentPrice|mtf\.h4\.bias|mtf\.scenario15m/);
  const entryMsg = server.slice(server.indexOf("function formatOrderEntryTelegramMsg("), server.indexOf("function sendTelegramNotification("));
  assert.doesNotMatch(entryMsg, /\*\s*100/);
  assert.match(entryMsg, /Chưa đối chiếu order_calc_profit/);
});

test("V6 percent-risk sizing never assumes $100 per price-unit/lot", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const rootUi = readFileSync(resolve(root, "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html"), "utf8");
  assert.equal(ui, rootUi);
  const sizing = ui.slice(ui.indexOf("function syncLotDisplayEverywhere("), ui.indexOf("async function saveTradeParamsToServer("));
  assert.ok(sizing.length > 0);
  assert.doesNotMatch(sizing, /slDist\s*\*\s*100|slDist\s*\*\s*100\.0/);
  assert.doesNotMatch(sizing, /riskUsd\s*\/\s*\(slDist\s*\*\s*100/);
  assert.match(sizing, /thiếu order_calc_profit/);
  assert.match(sizing, /return null/);
  const mutation = ui.slice(ui.indexOf("async function saveTradeParamsToServer("), ui.indexOf("function onChangeBotStrategyMode("));
  assert.match(mutation, /if \(\(document\.getElementById\("lotAllocMode"\)\?\.value \|\| "AUTO_RISK_PCT"\) === "AUTO_RISK_PCT"\)/);
  assert.match(mutation, /ĐÃ CHẶN GỬI THAM SỐ LOT THEO %/);
});

test("V6 Web Telegram tests are neutral and unverified market reports cannot be sent", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const report = ui.slice(
    ui.indexOf("async function sendDetailedTradeStatusToTelegram()"),
    ui.indexOf("async function triggerMtfScenarioRefresh("),
  );
  assert.match(report, /CHẶN BÁO CÁO MT5/);
  assert.match(report, /lastLiveMt5Payload\?\.mt5LiveBridgeConnected !== true/);
  assert.doesNotMatch(report, /\$4,131\.83|TK #5201362/);
  const refresh = ui.slice(
    ui.indexOf("async function triggerMtfScenarioRefresh("),
    ui.indexOf("async function saveAndTestTelegram("),
  );
  assert.match(refresh, /!data\.mtfAnalysis\?\.h4/);
  assert.match(refresh, /data\.telegramResult\?\.ok === true/);
  assert.doesNotMatch(refresh, /sendDirectTelegramFromBrowser/);
  assert.match(refresh, /Không kết nối API\/MT5; không gửi Telegram bằng dữ liệu mẫu/);
  const telegramTest = ui.slice(
    ui.indexOf("async function saveAndTestTelegram("),
    ui.indexOf("(function initLiveUrlAndApi()"),
  );
  assert.match(telegramTest, /Thông báo thử nghiệm kênh\. Không xác minh MT5/);
  assert.doesNotMatch(telegramTest, /\$4,131\.83|LIVE #5201362/);
});

test("V6 operator inline script remains syntactically valid", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const inlineJs = ui.split("<script>")[1]?.split("</script>")[0];
  assert.ok(inlineJs && inlineJs.length > 10000);
  assert.doesNotThrow(() => new Script(inlineJs), "public standalone UI must parse without executing trading actions");
});


import { parseReadOnlyLotQuoteRequest } from "../scripts/v6-api-input-guards.mjs";

test("V6 read-only broker risk quote parser rejects account/symbol overrides", () => {
  assert.deepEqual(parseReadOnlyLotQuoteRequest({ side: "BUY", slPrice: 3993.4, riskPercent: 0.5 }),
    { side: "BUY", slPrice: 3993.4, riskPercent: 0.5 });
  for (const payload of [
    null, [], {}, { side:"SELL", slPrice: 4008, riskPercent: 0.8 },
    { side:"BUY", slPrice: 3993.4, riskPercent: 0.5, symbol:"XAUUSD" },
    { side:"BUY", slPrice: 3993.4, riskPercent: 0.5, action:"order" },
    { side:"BUY", slPrice: 3993.4, riskPercent: "0.5" },
    { side:"WAIT", slPrice: 3993.4, riskPercent: 0.5 },
    { side:"BUY", slPrice: null, riskPercent: 0.5 },
    { side:"BUY", slPrice: Infinity, riskPercent: 0.5 },
  ]) {
    assert.throws(() => parseReadOnlyLotQuoteRequest(payload), /INVALID_READ_ONLY_RISK_REQUEST/);
  }
});

test("V6 read-only risk API never authorizes execution or contaminates cached MT5 status", () => {
  const route = server.slice(
    server.indexOf('if (pathname === "/api/v1/mt5/lot-quote"'),
    server.indexOf('if (pathname === "/api/v1/mt5/connect-account"'),
  );
  assert.ok(route.length > 0);
  assert.match(route, /parseReadOnlyLotQuoteRequest/);
  assert.match(route, /action: "quote_lot"/);
  assert.match(route, /symbol: currentAccountConfig\.brokerSymbol/);
  assert.match(route, /maxRiskPercent: 0\.5/);
  assert.match(route, /executionAuthorized: false/);
  assert.match(route, /liveAuthorized: false/);
  assert.doesNotMatch(route, /action: "order"|order_send|liveArmed = true|saveAccountConfig/);
  const transport = server.slice(
    server.indexOf("function invokeMt5PythonEngineDirect("),
    server.indexOf("// All broker-mutating actions are serialized"),
  );
  assert.match(transport, /if \(isProbeOnly\) \{\s*lastDirectProbeSnapshot = parsed/);
  assert.doesNotMatch(transport, /isProbeOnly \|\| parsed\.connected !== undefined/);
});
