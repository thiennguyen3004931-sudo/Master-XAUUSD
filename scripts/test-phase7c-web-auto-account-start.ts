import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePhase7CWebStartAccount,
  type Phase7CWebStartAccountInput,
} from "../apps/api/src/services/phase7c-web-account-start-policy.ts";
import {
  evaluatePhase7CLiveAuthorization,
  type Phase7CLiveAuthorizationRecord,
  type Phase7CLiveProfileIdentity,
} from "../apps/api/src/services/phase7c-live-authorization.service.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const demoState = {
  valid: true,
  accountMode: "DEMO" as const,
  liveExecutionEnabled: false,
};
const liveState = {
  valid: true,
  accountMode: "LIVE" as const,
  liveExecutionEnabled: true,
};

function decide(overrides: Partial<Phase7CWebStartAccountInput> = {}) {
  return resolvePhase7CWebStartAccount({
    reachable: true,
    brokerAccountMode: "demo",
    currentState: demoState,
    durableLiveAuthorizationValid: false,
    ...overrides,
  });
}

const demo = decide();
assert.equal(demo.allowed, true);
assert.equal(demo.targetAccountMode, "DEMO");
assert.equal(demo.liveExecutionEnabled, false);
assert.equal(demo.authorizationSource, "NOT_REQUIRED");

const authorizedLive = decide({
  brokerAccountMode: "real",
  currentState: demoState,
  durableLiveAuthorizationValid: true,
});
assert.equal(authorizedLive.allowed, true);
assert.equal(authorizedLive.targetAccountMode, "LIVE");
assert.equal(authorizedLive.liveExecutionEnabled, true);
assert.equal(authorizedLive.authorizationSource, "DURABLE_LIVE_AUTHORIZATION");

const legacyExplicitLive = decide({
  brokerAccountMode: "real",
  currentState: liveState,
  durableLiveAuthorizationValid: false,
});
assert.equal(legacyExplicitLive.allowed, true);
assert.equal(legacyExplicitLive.targetAccountMode, "LIVE");
assert.equal(legacyExplicitLive.authorizationSource, "LEGACY_EXPLICIT_LIVE_STATE");

const unauthorizedLive = decide({
  brokerAccountMode: "real",
  currentState: demoState,
  durableLiveAuthorizationValid: false,
});
assert.equal(unauthorizedLive.allowed, false);
assert.equal(unauthorizedLive.reason, "LIVE_NOT_PREAUTHORIZED");
assert.equal(unauthorizedLive.liveExecutionEnabled, false);

for (const brokerAccountMode of ["contest", "REAL", "", null, undefined]) {
  const result = decide({ brokerAccountMode });
  assert.equal(result.allowed, false, `mode=${String(brokerAccountMode)} must fail closed`);
  assert.equal(result.reason, "UNSUPPORTED_BROKER_ACCOUNT_MODE");
}

assert.equal(decide({ reachable: false }).reason, "MT5_BRIDGE_NOT_REACHABLE");
assert.equal(
  decide({ currentState: { ...demoState, valid: false } }).reason,
  "ACCOUNT_MODE_STATE_INVALID",
);

const identity: Phase7CLiveProfileIdentity = {
  accountLogin: 123456,
  server: "DBGMarkets-Live",
  terminalPath: "C:\\MT5\\terminal64.exe",
  profileFingerprint: "0123456789abcdef",
};
const authorization: Phase7CLiveAuthorizationRecord = {
  version: 1,
  authorized: true,
  accountMode: "LIVE",
  accountLogin: identity.accountLogin,
  server: identity.server,
  profileFingerprint: identity.profileFingerprint,
  authorizedAt: "2026-08-25T00:00:00.000Z",
  authorizedBy: "switch-phase7c-account-mode-local",
};
const validAuth = evaluatePhase7CLiveAuthorization({
  authorization,
  expectedIdentity: identity,
  brokerAccountLogin: 123456,
  brokerServer: "DBGMarkets-Live",
});
assert.equal(validAuth.valid, true);
assert.equal(validAuth.reason, "LIVE_AUTHORIZED");

assert.equal(
  evaluatePhase7CLiveAuthorization({
    authorization: { ...authorization, profileFingerprint: "different" },
    expectedIdentity: identity,
    brokerAccountLogin: 123456,
    brokerServer: "DBGMarkets-Live",
  }).reason,
  "LIVE_AUTH_PROFILE_MISMATCH",
);
assert.equal(
  evaluatePhase7CLiveAuthorization({
    authorization,
    expectedIdentity: identity,
    brokerAccountLogin: 999999,
    brokerServer: "DBGMarkets-Live",
  }).reason,
  "LIVE_AUTH_BROKER_LOGIN_MISMATCH",
);
assert.equal(
  evaluatePhase7CLiveAuthorization({
    authorization,
    expectedIdentity: identity,
    brokerAccountLogin: null,
    brokerServer: "DBGMarkets-Live",
  }).reason,
  "LIVE_AUTH_BROKER_LOGIN_MISSING",
);
assert.equal(
  evaluatePhase7CLiveAuthorization({
    authorization,
    expectedIdentity: identity,
    brokerAccountLogin: 123456,
    brokerServer: "Other-Live",
  }).reason,
  "LIVE_AUTH_BROKER_SERVER_MISMATCH",
);
assert.equal(
  evaluatePhase7CLiveAuthorization({
    authorization: null,
    expectedIdentity: identity,
    brokerAccountLogin: 123456,
    brokerServer: "DBGMarkets-Live",
  }).reason,
  "LIVE_AUTH_MISSING",
);

const lifecycleSource = fs.readFileSync(
  path.join(root, "apps/api/src/services/phase7c-lifecycle.service.ts"),
  "utf8",
);
assert.match(lifecycleSource, /resolvePhase7CWebStartAccount/);
assert.match(lifecycleSource, /ensurePhase7CLiveAuthorizationForWebStart/);
assert.match(lifecycleSource, /preserveLegacyExplicitLiveAuthorization/);
assert.match(lifecycleSource, /submitPhase7CLifecycleBrokerRequest/);
assert.match(lifecycleSource, /chooseStartBrokerAction/);
assert.doesNotMatch(lifecycleSource, /launchSelectedSupervisor/);
assert.doesNotMatch(lifecycleSource, /Web cold-start chỉ được phép cho DEMO/);
assert.doesNotMatch(lifecycleSource, /web-control-center-live-start-blocked/);
assert.doesNotMatch(lifecycleSource, /-LiveExecutionEnabled/);
assert.match(lifecycleSource, /phase7CBotModeService\.set\("PAUSE", "web-control-center-preflight"\)/);
assert.match(lifecycleSource, /finalTelemetry/);
assert.match(lifecycleSource, /telemetry\.accountLogin/);
assert.match(lifecycleSource, /finalTelemetry\.accountLogin/);

const authorizationSource = fs.readFileSync(
  path.join(root, "apps/api/src/services/phase7c-live-authorization.service.ts"),
  "utf8",
);
assert.match(authorizationSource, /phase7c-live-authorization\.json/);
assert.match(authorizationSource, /brokerAccountLogin/);
assert.match(authorizationSource, /LIVE_AUTH_BROKER_LOGIN_MISMATCH/);
assert.match(authorizationSource, /accountState\.accountMode !== "LIVE"/);
assert.match(authorizationSource, /accountState\.liveExecutionEnabled !== true/);
assert.match(authorizationSource, /legacy-explicit-live-state:/);

const mt5Source = fs.readFileSync(
  path.join(root, "apps/api/src/services/mt5.service.ts"),
  "utf8",
);
assert.match(mt5Source, /accountLogin: number \| null/);
assert.match(mt5Source, /accountLogin: health\.accountLogin/);

const accountModeLibrarySource = fs.readFileSync(
  path.join(root, "scripts/lib/phase7c-account-mode.ps1"),
  "utf8",
);
assert.match(accountModeLibrarySource, /phase7c-live-authorization\.json/);
assert.match(accountModeLibrarySource, /Write-Phase7CLiveAuthorizationState/);

const switchSource = fs.readFileSync(
  path.join(root, "scripts/switch-phase7c-account-mode-local.ps1"),
  "utf8",
);
assert.match(switchSource, /ConfirmLiveExecution/);
assert.match(switchSource, /LIVE account switching requires explicit -ConfirmLiveExecution/);
assert.match(switchSource, /Write-Phase7CLiveAuthorizationState/);
assert.match(switchSource, /ACCOUNT_SWITCH_LIVE_AUTHORIZATION=PASS/);
assert.match(switchSource, /accountLogin.*identity\.login|identity\.login.*accountLogin/i);

const routeSource = fs.readFileSync(
  path.join(root, "apps/api/src/routes/phase7c.route.ts"),
  "utf8",
);
for (const field of [
  "liveExecutionArmed",
  "liveArmStatus",
  "liveArmReason",
  "liveArmScope",
  "liveRiskReductionAllowedWhenDisarmed",
]) {
  assert.match(routeSource, new RegExp(`${field}: telemetry\\.health\\?\\.${field}`));
}

const healthTypeSource = fs.readFileSync(
  path.join(root, "packages/mt5-broker/src/models/Mt5BridgeHealth.ts"),
  "utf8",
);
assert.match(healthTypeSource, /liveArmScope\?: "BRIDGE_SESSION" \| "LEGACY_TTL"/);
assert.match(healthTypeSource, /liveRiskReductionAllowedWhenDisarmed\?: boolean/);

const lifecycleTypeSource = fs.readFileSync(
  path.join(root, "apps/web/src/phase7c-types.ts"),
  "utf8",
);
assert.match(lifecycleTypeSource, /liveExecutionArmed: boolean \| null/);
assert.match(lifecycleTypeSource, /liveArmStatus: "ARMED" \| "DISARMED" \| "NOT_REQUIRED" \| null/);
assert.match(lifecycleTypeSource, /liveArmScope: "BRIDGE_SESSION" \| "LEGACY_TTL" \| null/);
assert.match(lifecycleTypeSource, /liveRiskReductionAllowedWhenDisarmed: boolean \| null/);

const uiSource = fs.readFileSync(
  path.join(root, "apps/web/src/pages/Phase7CControlCenterPage.tsx"),
  "utf8",
);
assert.doesNotMatch(uiSource, /lifecycleData\?\.bridge\.accountMode !== "demo"/);
assert.match(uiSource, /LIVE.*cấp quyền|cấp quyền.*LIVE/i);
assert.match(uiSource, /ARM LIVE/);
assert.match(uiSource, /ARM DISARMED/);
assert.match(uiSource, /BRIDGE_SESSION/);
assert.match(uiSource, /không mở lệnh mới/i);
assert.match(uiSource, /giảm rủi ro/i);

console.log("PHASE7C_WEB_AUTO_ACCOUNT_START_TEST=PASS");