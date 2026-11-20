import "./test_daily_risk_scheduler_contract.mjs";
import test from "node:test";
import { execFileSync as gitExecFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getV6ExecutionSizingDisclosure } from "../scripts/v6-execution-sizing-disclosure.mjs";

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
