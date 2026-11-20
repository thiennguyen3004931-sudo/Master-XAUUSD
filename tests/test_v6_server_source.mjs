import "./test_daily_risk_scheduler_contract.mjs";
import test from "node:test";
import { execFileSync as gitExecFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getV6ExecutionSizingDisclosure } from "../scripts/v6-execution-sizing-disclosure.mjs";
import { getV6BrokerStatusEvidence, readExplicitBacktestStartingBalance } from "../scripts/v6-broker-status-evidence.mjs";

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

test("DEMO bridge has no shared static API key and defaults to trading disabled", () => {
  const profile = server.slice(
    server.indexOf("function writeBridgeEnvAndArmFiles(cfg)"),
    server.indexOf("function getLanIps()"),
  );
  assert.ok(profile.length > 0);
  assert.doesNotMatch(profile, /xauusd_live_bridge_secret_2026_key/);
  assert.match(profile, /const bridgeApiReady = apiKey\.length >= 32/);
  assert.match(profile, /MT5_API_KEY=\$\{bridgeApiReady \? apiKey : ""\}/);
  assert.match(profile, /MT5_TRADING_ENABLED=\$\{bridgeApiReady \? "true" : "false"\}/);
  assert.match(profile, /if \(isLive\) \{/);
  assert.match(profile, /return;/);
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

test("P0 LIVE ARM is revoked when MT5 probe is missing, disconnected or identity incomplete", () => {
  const gate = server.slice(
    server.indexOf("export function getCanonicalLiveArmState("),
    server.indexOf("const IS_MAIN_SERVER_PROCESS"),
  );
  assert.ok(gate.length > 0);
  assert.match(gate, /!probeSnapshot \|\| probeSnapshot\.connected !== true/);
  assert.match(gate, /disarmLiveSession\("Mất hoặc thiếu xác nhận kết nối MT5/);
  assert.match(gate, /!actualLogin \|\| actualLogin !== liveArmSessionState\.accountLogin/);
  assert.match(gate, /!actualMode \|\| \(configuredMode && actualMode !== configuredMode\)/);
  assert.match(gate, /return getCanonicalLiveArmState\(null\)/);
});

test("V6 status accurately discloses Fixed Lot, not Phase7C shadow Auto Lot (#76)", () => {
  const source = server.slice(
    server.indexOf("function buildStatusPayload(probe)"),
    server.indexOf("export async function handleApiRequest("),
  );
  assert.match(source, /executionSizing:\s*getV6ExecutionSizingDisclosure\(/);
  assert.match(source, /fixedLot:\s*getCanonicalFixedLot\(\)/);
  assert.match(source, /configVerified:\s*configIntegrityState\.verified === true/);

  // An AUTO-labelled strategy is still Fixed Lot at the actual V6 order gate.
  assert.match(server, /volume:\s*getCanonicalFixedLot\(\)/);
  const configured = getV6ExecutionSizingDisclosure({ fixedLot: 0.03, configVerified: true });
  assert.equal(configured.executionFamily, "V6_STANDALONE");
  assert.equal(configured.orderSizingMode, "FIXED_LOT");
  assert.equal(configured.configuredLot, 0.03);
  assert.equal(configured.automaticCapitalSizingActiveOnV6, false);
  assert.equal(configured.phase7cAutoLotComparisonIsShadowOnly, true);
  assert.equal(configured.brokerVolumeValidatedForNextOrder, false);
  assert.equal(configured.riskPolicy.perTradePercent, "WARNING_ONLY");
  assert.equal(configured.riskPolicy.dailyLossForNewOrders, "HARD_GATE");
  assert.equal(configured.riskPolicy.freeMarginForNewOrders, "HARD_GATE");
});

test("V6 disclosure never invents a verified lot for corrupt or missing settings", () => {
  for (const fixedLot of [undefined, null, NaN, Infinity, -0.02, 0, "0.02", true]) {
    const disclosure = getV6ExecutionSizingDisclosure({ fixedLot, configVerified: true });
    assert.equal(disclosure.configuredLotValidInLocalConfig, false);
    assert.equal(disclosure.configuredLot, null);
    assert.equal(disclosure.automaticCapitalSizingActiveOnV6, false);
  }
  const unverified = getV6ExecutionSizingDisclosure({ fixedLot: 0.02, configVerified: false });
  assert.equal(unverified.configuredLotValidInLocalConfig, false);
  assert.equal(unverified.configuredLot, null);
  assert.equal(unverified.verificationScope, "SOURCE_POLICY_NOT_DEPLOYED_RUNTIME_OR_BROKER_PROOF");
});

test("V6 disconnected status must not expose placeholder or previously observed account/quote (#80)", () => {
  for (const raw of [
    null, undefined, {}, { connected: "true", balance: 9999, bid: 4000 },
    { connected: false, balance: 4131.83, equity: 4131.83, freeMargin: 4000,
      profit: 220, accountLogin: 1234567, brokerSymbol: "XAUUSD.G",
      bid: 4678.96, ask: 4679.16, quoteFresh: true, quoteAgeSeconds: 1 },
  ]) {
    const evidence = getV6BrokerStatusEvidence(raw);
    assert.equal(evidence.connected, false);
    assert.equal(evidence.dataStatus, "BROKER_UNAVAILABLE");
    for (const key of ["accountLogin", "accountBalance", "accountEquity", "accountFreeMargin",
      "accountProfit", "accountMode", "brokerSymbol", "brokerObservedAtMs"]) {
      assert.equal(evidence[key], null, key);
    }
    assert.equal(evidence.quote, null);
    assert.deepEqual(evidence.availableGoldSymbols, []);
  }
  assert.doesNotMatch(server, /lastKnownAccountMetrics|4131\.83|4678\.96|4679\.16/);
  assert.match(server, /const brokerEvidence = getV6BrokerStatusEvidence\(probe\)/);
  assert.match(server, /quote: brokerEvidence\.quote/);
  assert.match(server, /accountFreeMargin: brokerEvidence\.accountFreeMargin/);
  assert.match(server, /isConnected && brokerEvidence\.quote !== null && probe\?\.mtfAnalysis/);
  assert.match(server, /entrySignal: isConnected/);
});

test("V6 broker status accepts only finite connected broker data and fresh verified quote", () => {
  const broker = {
    connected: true, accountLogin: 111222, accountName: "Test Broker", accountMode: "LIVE",
    balance: 900, equity: 850, freeMargin: 600, profit: -50,
    brokerSymbol: "XAUUSD.G", availableGoldSymbols: ["XAUUSD.G"], server: "Example-Live",
    currency: "USD", bid: 4000.12, ask: 4000.23, spreadPoints: 11,
    quoteFresh: true, quoteAgeSeconds: 2, timestamp: 1795140000000,
  };
  const now = broker.timestamp + 2000;
  const ok = getV6BrokerStatusEvidence(broker, now);
  assert.equal(ok.accountDataStatus, "BROKER_VALUES_PRESENT");
  assert.equal(ok.quoteDataStatus, "BROKER_QUOTE_FRESH");
  assert.equal(ok.accountBalance, 900);
  assert.equal(ok.accountEquity, 850);
  assert.equal(ok.accountFreeMargin, 600);
  assert.equal(ok.accountProfit, -50);
  assert.equal(ok.accountMode, "live");
  assert.equal(ok.quote.bid, 4000.12);
  assert.equal(ok.quote.timestamp, 1795140000000);

  const malformed = getV6BrokerStatusEvidence({
    ...broker, balance: "900", equity: NaN, freeMargin: undefined,
    profit: Infinity, quoteAgeSeconds: 61,
  }, now);
  assert.equal(malformed.accountDataStatus, "PARTIAL_UNVERIFIED");
  for (const key of ["accountBalance", "accountEquity", "accountFreeMargin", "accountProfit"]) {
    assert.equal(malformed[key], null);
  }
  assert.equal(malformed.quote, null);
  for (const variation of [
    { quoteFresh: false }, { quoteAgeSeconds: -12 }, { bid: -1 },
    { ask: 3999 }, { spreadPoints: null }, { brokerSymbol: "" },
  ]) {
    assert.equal(getV6BrokerStatusEvidence({ ...broker, ...variation }, now).quote, null);
  }
});

test("backtest never silently substitutes capital from a disconnected MT5 or canned account", () => {
  const endpoint = server.slice(server.indexOf('if (pathname === "/api/v1/mt5/run-backtest"'),
    server.indexOf('const btRes = probe?.actionResult;'));
  assert.match(endpoint, /readExplicitBacktestStartingBalance\(body\.startingBalance\)/);
  assert.match(endpoint, /EXPLICIT_BACKTEST_BALANCE_REQUIRED/);
  assert.match(endpoint, /startingBalance,/);
  for (const invalid of [undefined, null, NaN, Infinity, -100, 0, "500", true, {}]) {
    assert.equal(readExplicitBacktestStartingBalance(invalid), null);
  }
  assert.equal(readExplicitBacktestStartingBalance(500), 500);
  assert.equal(readExplicitBacktestStartingBalance(12000.50), 12000.50);
});

test("stale connected broker snapshots cannot masquerade as current account/quote", () => {
  const oldProbe = {
    connected: true, timestamp: 1795140000000, accountLogin: 12,
    balance: 1200, equity: 1200, freeMargin: 1100, profit: 0,
    bid: 4200, ask: 4200.3, brokerSymbol: "XAUUSD.G",
    spreadPoints: 30, quoteFresh: true, quoteAgeSeconds: 1,
  };
  for (const observedNow of [oldProbe.timestamp + 30001, oldProbe.timestamp - 10001]) {
    const out = getV6BrokerStatusEvidence(oldProbe, observedNow);
    assert.equal(out.dataStatus, "STALE_OR_UNTIMESTAMPED_BROKER_SNAPSHOT");
    assert.equal(out.accountBalance, null);
    assert.equal(out.quote, null);
  }
  const noTime = getV6BrokerStatusEvidence({ ...oldProbe, timestamp: undefined }, oldProbe.timestamp);
  assert.equal(noTime.dataStatus, "STALE_OR_UNTIMESTAMPED_BROKER_SNAPSHOT");
  assert.equal(noTime.accountFreeMargin, null);
});

test("V6 standalone UI clears stale balance and does not calculate Auto Lot from a fake account", () => {
  const ui = readFileSync(resolve(root, "apps/web/public/standalone-ui.html"), "utf8");
  const status = ui.slice(ui.indexOf("function applyMt5StatusToUi(data)"),
    ui.indexOf("let isLiveChartMode = true;"));
  assert.match(status, /data\.mt5LiveBridgeConnected === true && h\.connected === true/);
  assert.match(status, /h\.accountDataStatus === "BROKER_VALUES_PRESENT"/);
  assert.match(status, /window\.__latestAccountBalance = null/);
  assert.match(status, /lastLiveMt5Payload = null/);
  const lot = ui.slice(ui.indexOf("function computeLotFromRiskPct(pctVal)"),
    ui.indexOf("function onManualLotInput()"));
  assert.match(lot, /if \(!Number\.isFinite\(bal\) \|\| bal <= 0/);
  assert.match(lot, /if \(calcLot === null\) \{ showUnverifiedAutoLotWarning\(\); return; \}/);
  assert.doesNotMatch(lot, /4131\.83/);
  assert.doesNotMatch(status, /DBG Market Limited|5201362/);
});

test("V6 release manifest covers every direct standalone helper import", () => {
  const pack = readFileSync(resolve(root, "scripts/package-v6-release.mjs"), "utf8");
  for (const helper of [
    "scripts/v6-api-input-guards.mjs",
    "scripts/v6-execution-sizing-disclosure.mjs",
    "scripts/v6-broker-status-evidence.mjs",
  ]) {
    assert.ok(pack.includes(JSON.stringify(helper)), "missing release manifest dependency: " + helper);
  }
});
