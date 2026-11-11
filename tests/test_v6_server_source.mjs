import test from "node:test";
import { execFileSync as gitExecFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
