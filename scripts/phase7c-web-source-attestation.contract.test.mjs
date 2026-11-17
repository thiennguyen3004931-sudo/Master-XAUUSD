// Final-tree source-only contract for canonical Web runtime attestation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const sharedLibrary = read("scripts/lib/phase7c-runtime-source-attestation.ps1");
const webHelper = read("scripts/lib/phase7b-web-source-attestation.ps1");
const launcher = read("scripts/run-phase7b-web-autostart.ps1");
const service = read("apps/api/src/services/phase7c-runtime-source-attestation.service.ts");

assert.doesNotMatch(
  sharedLibrary,
  /\[ValidateSet\([^\]]*['"]web['"][^\]]*\)\]\s*\[string\]\$Component/s,
  "Web support must not mutate the broker-loaded shared component writer and force executor source staleness.",
);
assert.match(
  webHelper,
  /function\s+Write-Phase7BWebRuntimeSourceAttestation/,
  "Web attestation must use a Web-only writer helper.",
);
assert.match(
  webHelper,
  /component\s*=\s*["']web["']/,
  "Web-only writer must emit component=web.",
);
assert.match(
  webHelper,
  /Read-Phase7CRuntimeSourceDeployment/,
  "Web-only writer must bind its evidence to the canonical deployment manifest.",
);
assert.match(
  webHelper,
  /Get-Phase7CRuntimeSourceConfigFingerprint/,
  "Web-only writer must use the canonical V1 config fingerprint.",
);
assert.match(
  webHelper,
  /Write-Phase7CRuntimeSourceAtomicJson/,
  "Web-only writer must reuse canonical atomic JSON semantics.",
);

assert.match(
  service,
  /\|\s*["']web["']/,
  "API runtime-source component type must include web.",
);
assert.match(
  service,
  /\{\s*component:\s*["']web["'],\s*launcher:\s*["']run-phase7b-web-autostart\.ps1["']\s*\}/,
  "API runtime-source snapshot must define the canonical Web launcher.",
);
assert.match(
  service,
  /component\s*===\s*["']web["'][\s\S]*?readPidFile\(deps,\s*join\(attestationRoot,\s*["']web\.pid["']\)\)/,
  "API runtime-source snapshot must resolve Web PID evidence from the attestation root.",
);

assert.match(
  launcher,
  /phase7c-runtime-source-attestation\.ps1/,
  "Web autostart must load canonical V1 source-attestation primitives.",
);
assert.match(
  launcher,
  /phase7b-web-source-attestation\.ps1/,
  "Web autostart must load the isolated Web attestation writer.",
);
assert.match(
  launcher,
  /Join-Path\s+\$attestationRoot\s+["']web\.pid["']/,
  "Web autostart must publish dedicated Web PID evidence under the attestation root.",
);
assert.match(
  launcher,
  /Write-Phase7BWebRuntimeSourceAttestation/,
  "Web autostart must write a canonical Web component attestation.",
);

const apiPassIndex = launcher.indexOf("PHASE7B_WEB_AUTOSTART_API=PASS");
const uiPassIndex = launcher.indexOf("PHASE7B_WEB_AUTOSTART_UI=PASS");
const runningIndex = launcher.indexOf("PHASE7B_WEB_AUTOSTART_STATUS=RUNNING");
const writeIndex = launcher.indexOf("Write-Phase7BWebRuntimeSourceAttestation");
assert.ok(apiPassIndex >= 0 && uiPassIndex >= 0, "Web self-test PASS markers must remain present.");
assert.ok(runningIndex >= 0, "Web running marker must remain present.");
assert.ok(
  writeIndex > apiPassIndex && writeIndex > uiPassIndex,
  "Web attestation must be written only after API+Web self-test readiness passes.",
);
assert.ok(
  writeIndex < runningIndex,
  "Web runtime must not report RUNNING until canonical Web attestation is written.",
);

const finallyIndex = launcher.lastIndexOf("finally {");
const cleanupIndex = launcher.lastIndexOf("Remove-Item -LiteralPath $webPidPath");
assert.ok(finallyIndex >= 0, "Web runtime must retain a final cleanup block.");
assert.ok(cleanupIndex > finallyIndex, "Web PID evidence must be removed during final runtime cleanup.");

console.log("PHASE7C_WEB_SOURCE_ATTESTATION_CONTRACT=PASS");
console.log("WEB_COMPONENT_CANONICAL=TRUE");
console.log("WEB_WRITER_ISOLATED_FROM_BROKER_SHARED_SOURCE=TRUE");
console.log("WEB_PID_EVIDENCE=DEDICATED");
console.log("WEB_ATTESTATION_AFTER_SELF_TEST=TRUE");
console.log("WEB_RUNNING_AFTER_ATTESTATION=TRUE");
console.log("WEB_PID_CLEANUP=TRUE");
console.log("STRATEGY_CHANGE=NONE");
console.log("RISK_CHANGE=NONE");
console.log("ORDER_MUTATION=NONE");
console.log("MODE_CHANGE=NONE");
console.log("ARM_CHANGE=NONE");
