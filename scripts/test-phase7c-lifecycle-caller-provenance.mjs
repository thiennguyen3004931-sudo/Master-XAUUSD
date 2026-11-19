import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.resolve(root, relativePath), "utf8");

const lifecycle = read("apps/api/src/services/phase7c-lifecycle.service.ts");
const brokerClient = read("apps/api/src/services/phase7c-lifecycle-broker.service.ts");
const route = read("apps/api/src/routes/phase7c.route.ts");
const webApi = read("apps/web/src/api.ts");

// Lifecycle STOP provenance must be an internal canonical union, never a free-form request value.
assert.match(
  lifecycle,
  /export type Phase7CLifecycleStopProvenance\s*=\s*[\s\S]*?["']web-control-center-stop["'][\s\S]*?["']local-lifecycle-api-stop["'][\s\S]*?;/,
  "lifecycle service must define the two canonical STOP provenance values",
);
assert.match(
  lifecycle,
  /phase7CBotModeService\.set\(\s*["']PAUSE["']\s*,\s*provenance\s*\)/,
  "lifecycle STOP must persist the caller provenance supplied by the trusted server route",
);

// Lifecycle START needs the same trusted caller boundary as STOP.
assert.match(
  lifecycle,
  /export type Phase7CLifecycleStartProvenance\s*=\s*[\s\S]*?["']web-control-center-start["'][\s\S]*?["']local-lifecycle-api-start["'][\s\S]*?;/,
  "lifecycle service must define the two canonical START provenance values",
);
assert.match(
  lifecycle,
  /startPhase7C[\s\S]*?phase7CBotModeService\.set\(\s*["']PAUSE["']\s*,\s*provenance\s*\)/,
  "lifecycle START must persist the caller provenance supplied by the trusted server route",
);
assert.doesNotMatch(
  lifecycle,
  /provenance\s*:\s*Phase7CLifecycleStartProvenance\s*=\s*["']web-control-center-start["']/,
  "lifecycle START provenance must be explicit; omitting provenance must never silently inherit Web authority",
);

// Broker request provenance must remain a trusted closed enum all the way to the SYSTEM broker.
assert.match(
  brokerClient,
  /export type Phase7CLifecycleBrokerRequestSource\s*=\s*[\s\S]*?["']WEB_CONTROL_CENTER["'][\s\S]*?["']LOCAL_LIFECYCLE_API["'][\s\S]*?;/,
  "broker client must define the two trusted lifecycle request sources",
);
assert.match(
  brokerClient,
  /submitPhase7CLifecycleBrokerRequest\([\s\S]*?source\s*:\s*Phase7CLifecycleBrokerRequestSource/,
  "broker submit API must require trusted caller provenance instead of hard-coding Web",
);

// Local lifecycle START must not inherit Web account-selection/account-switch behavior.
const lifecycleStartFunctionStart = lifecycle.indexOf("export async function startPhase7CFromWeb(");
assert.ok(lifecycleStartFunctionStart >= 0, "cannot locate lifecycle START implementation");
const lifecycleStopFunctionStart = lifecycle.indexOf("export async function stopPhase7C(", lifecycleStartFunctionStart);
assert.ok(lifecycleStopFunctionStart > lifecycleStartFunctionStart, "cannot isolate lifecycle START implementation");
const lifecycleStartFunction = lifecycle.slice(lifecycleStartFunctionStart, lifecycleStopFunctionStart);
assert.match(
  lifecycleStartFunction,
  /if\s*\(\s*provenance\s*===\s*["']local-lifecycle-api-start["']\s*\)[\s\S]*?targetAccountMode\s*=\s*initialAccountState\.accountMode/,
  "local lifecycle START must keep the currently selected canonical account instead of auto-selecting from MT5",
);
assert.match(
  lifecycleStartFunction,
  /if\s*\(\s*provenance\s*===\s*["']web-control-center-start["']\s*\)[\s\S]*?resolvePhase7CWebStartAccount[\s\S]*?activatePhase7CAccountRiskProfile[\s\S]*?setPhase7CAccountModeFromWebAutoDetection/,
  "Web account selection and account-mode mutation must be isolated behind the Web START provenance",
);

// Local LIVE START must prove the already-durable authorization before any privileged broker request.
const initialAccountStateIndex = lifecycleStartFunction.indexOf("const initialAccountState = getPhase7CAccountModeState()");
assert.ok(initialAccountStateIndex >= 0, "cannot locate canonical account state read in lifecycle START");
const localAccountBoundaryStart = lifecycleStartFunction.indexOf(
  'if (provenance === "local-lifecycle-api-start")',
  initialAccountStateIndex,
);
const webAccountBoundaryStart = lifecycleStartFunction.indexOf(
  'if (provenance === "web-control-center-start")',
  localAccountBoundaryStart,
);
assert.ok(localAccountBoundaryStart >= 0 && webAccountBoundaryStart > localAccountBoundaryStart, "cannot isolate local START account boundary");
const localAccountBoundary = lifecycleStartFunction.slice(localAccountBoundaryStart, webAccountBoundaryStart);
assert.match(
  localAccountBoundary,
  /targetAccountMode\s*===\s*["']LIVE["'][\s\S]*?!liveAuthorization\.valid[\s\S]*?!liveAuthorization\.identity[\s\S]*?throw\s+new\s+Error/,
  "local LIVE lifecycle START must fail closed on missing durable LIVE authorization before broker mutation",
);
assert.doesNotMatch(
  localAccountBoundary,
  /ensurePhase7CLiveAuthorizationForWebStart|preserveLegacyExplicitLiveAuthorization|resolvePhase7CWebStartAccount|setPhase7CAccountModeFromWebAutoDetection|activatePhase7CAccountRiskProfile/,
  "local lifecycle START must never create, migrate, auto-select, or persist Web LIVE/account authorization state",
);
const firstBrokerSubmit = lifecycleStartFunction.indexOf("submitPhase7CLifecycleBrokerRequest(");
const localLiveAuthGuard = lifecycleStartFunction.indexOf("!liveAuthorization.valid", localAccountBoundaryStart);
assert.ok(
  localLiveAuthGuard >= localAccountBoundaryStart && localLiveAuthGuard < webAccountBoundaryStart && localLiveAuthGuard < firstBrokerSubmit,
  "local LIVE authorization guard must execute before the first broker START/RESTART submission",
);
assert.match(
  lifecycleStartFunction,
  /const\s+brokerSource\s*:\s*Phase7CLifecycleBrokerRequestSource\s*=\s*provenance\s*===\s*["']local-lifecycle-api-start["'][\s\S]*?["']LOCAL_LIFECYCLE_API["'][\s\S]*?["']WEB_CONTROL_CENTER["']/,
  "START must map trusted route provenance to trusted broker request provenance",
);
assert.match(
  lifecycleStartFunction,
  /submitPhase7CLifecycleBrokerRequest\(\s*brokerRequest\.action\s*,\s*brokerRequest\.reason\s*,\s*brokerSource\s*\)/,
  "START/RESTART must submit the trusted broker source",
);

const lifecycleStopFunction = lifecycle.slice(lifecycleStopFunctionStart);
assert.match(
  lifecycleStopFunction,
  /const\s+brokerSource\s*:\s*Phase7CLifecycleBrokerRequestSource\s*=\s*provenance\s*===\s*["']local-lifecycle-api-stop["'][\s\S]*?["']LOCAL_LIFECYCLE_API["'][\s\S]*?["']WEB_CONTROL_CENTER["']/,
  "STOP must map trusted route provenance to trusted broker request provenance",
);
assert.match(
  lifecycleStopFunction,
  /submitPhase7CLifecycleBrokerRequest\(\s*["']STOP["']\s*,\s*["']USER_STOP["']\s*,\s*brokerSource\s*\)/,
  "STOP must submit the trusted broker source",
);

// Generic localhost lifecycle API remains the maintenance/automation surface.
const genericStopStart = route.indexOf('router.post("/lifecycle/stop"');
assert.ok(genericStopStart >= 0, "generic lifecycle STOP route must remain available");
const genericStopEnd = route.indexOf("router.", genericStopStart + 12);
assert.ok(genericStopEnd > genericStopStart, "cannot isolate generic lifecycle STOP route");
const genericStop = route.slice(genericStopStart, genericStopEnd);
assert.match(
  genericStop,
  /["']local-lifecycle-api-stop["']/,
  "direct localhost lifecycle STOP must be attributed to local-lifecycle-api-stop",
);
assert.doesNotMatch(
  genericStop,
  /req\.body[\s\S]{0,120}source|source[\s\S]{0,120}req\.body/,
  "generic STOP must not accept arbitrary caller provenance from the request body",
);

const genericStartStart = route.indexOf('router.post("/lifecycle/start"');
assert.ok(genericStartStart >= 0, "generic lifecycle START route must remain available");
const genericStartEnd = route.indexOf("router.", genericStartStart + 12);
assert.ok(genericStartEnd > genericStartStart, "cannot isolate generic lifecycle START route");
const genericStart = route.slice(genericStartStart, genericStartEnd);
assert.match(
  genericStart,
  /["']local-lifecycle-api-start["']/,
  "direct localhost lifecycle START must be attributed to local-lifecycle-api-start",
);
assert.doesNotMatch(
  genericStart,
  /req\.body[\s\S]{0,120}source|source[\s\S]{0,120}req\.body/,
  "generic START must not accept arbitrary caller provenance from the request body",
);

// Web UI uses dedicated server routes so maintenance callers cannot accidentally inherit Web provenance.
const webStopStart = route.indexOf('router.post("/lifecycle/stop/web"');
assert.ok(webStopStart >= 0, "dedicated Web lifecycle STOP route is required");
const webStopEnd = route.indexOf("router.", webStopStart + 12);
assert.ok(webStopEnd > webStopStart, "cannot isolate Web lifecycle STOP route");
const webStop = route.slice(webStopStart, webStopEnd);
assert.match(webStop, /["']web-control-center-stop["']/);
assert.doesNotMatch(
  webStop,
  /req\.body[\s\S]{0,120}source|source[\s\S]{0,120}req\.body/,
  "Web STOP provenance must be selected by the dedicated route, not client-supplied free text",
);

const webStartStart = route.indexOf('router.post("/lifecycle/start/web"');
assert.ok(webStartStart >= 0, "dedicated Web lifecycle START route is required");
const webStartEnd = route.indexOf("router.", webStartStart + 12);
assert.ok(webStartEnd > webStartStart, "cannot isolate Web lifecycle START route");
const webStart = route.slice(webStartStart, webStartEnd);
assert.match(webStart, /["']web-control-center-start["']/);
assert.doesNotMatch(
  webStart,
  /req\.body[\s\S]{0,120}source|source[\s\S]{0,120}req\.body/,
  "Web START provenance must be selected by the dedicated route, not client-supplied free text",
);

// The browser must call only the dedicated Web lifecycle endpoints.
assert.match(
  webApi,
  /action\s*===\s*["']stop["'][\s\S]*?\/api\/v1\/phase7c\/lifecycle\/stop\/web/,
  "Web STOP must use the dedicated provenance-preserving endpoint",
);
assert.match(
  webApi,
  /action\s*===\s*["']stop["'][\s\S]*?\/api\/v1\/phase7c\/lifecycle\/stop\/web[\s\S]*?:\s*["']\/api\/v1\/phase7c\/lifecycle\/start\/web["']/,
  "Web START must use the dedicated provenance-preserving endpoint",
);

console.log("PHASE7C_LIFECYCLE_CALLER_PROVENANCE_TEST=PASS");
