import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
};
const forbidText = (source, needle, label) => {
  if (source.includes(needle)) throw new Error(`${label}: forbidden ${needle}`);
};

const packager = read("scripts/package-phase7c-portable-release.ps1");
const bootstrap = read("scripts/bootstrap-phase7c-new-pc.ps1");
const portableDoc = read("docs/PORTABLE-DEPLOYMENT.md");
const mobileDoc = read("docs/MOBILE-DEVELOPMENT.md");
const devcontainerText = read(".devcontainer/devcontainer.json");
const gitignore = read(".gitignore");

for (const marker of [
  "git archive",
  "PORTABLE-RELEASE-MANIFEST.json",
  "PHASE7C_PORTABLE_PACKAGE_GIT_CLEAN=PASS",
  "PHASE7C_PORTABLE_PACKAGE_SECRETS_EXCLUDED=PASS",
  "PHASE7C_PORTABLE_PACKAGE_RUNTIME_EXCLUDED=PASS",
  "PHASE7C_PORTABLE_PACKAGE_LIVE_ARM=False",
  "PHASE7C_PORTABLE_PACKAGE_ACCOUNT_SWITCH=False",
  "PHASE7C_PORTABLE_PACKAGE_ORDER_SEND=False",
  "PHASE7C_PORTABLE_PACKAGE=PASS",
]) {
  requireText(packager, marker, `portable packager ${marker}`);
}
for (const forbidden of [
  "arm-phase7c-live-local.ps1",
  "phase7c-account-switch/execute",
  "/v1/orders",
  "order_send",
  "ConfirmLiveExecution",
]) {
  forbidText(packager, forbidden, "portable packager execution boundary");
}

for (const marker of [
  "Node.js",
  "pnpm",
  "Python",
  "CreateLocalConfigTemplates",
  "InstallDependencies",
  "RegisterAccountSwitchTask",
  "InstallMt5Panels",
  "register-phase7c-account-switch-task-local.ps1",
  "install-phase7c-mt5-decision-panel-both-accounts-local.ps1",
  "PHASE7C_NEW_PC_BOOTSTRAP_MODE=PREPARE_ONLY",
  "PHASE7C_NEW_PC_BOOTSTRAP_LIVE_ARM=False",
  "PHASE7C_NEW_PC_BOOTSTRAP_ACCOUNT_SWITCH=False",
  "PHASE7C_NEW_PC_BOOTSTRAP_ORDER_SEND=False",
  "PHASE7C_NEW_PC_BOOTSTRAP=PASS",
]) {
  requireText(bootstrap, marker, `new-PC bootstrap ${marker}`);
}
for (const forbidden of [
  "arm-phase7c-live-local.ps1",
  "phase7c-account-switch/execute",
  "/v1/orders",
  "order_send",
  "ConfirmLiveExecution",
  "activate-phase7c-local.ps1",
]) {
  forbidText(bootstrap, forbidden, "new-PC bootstrap execution boundary");
}

requireText(portableDoc, "source-of-truth", "portable deployment source-of-truth guidance");
requireText(portableDoc, ".runtime", "portable deployment runtime exclusion");
requireText(portableDoc, "LIVE + PAUSE + DISARMED", "portable deployment LIVE final safety state");
requireText(portableDoc, "package-phase7c-portable-release.ps1", "portable packaging command");
requireText(portableDoc, "bootstrap-phase7c-new-pc.ps1", "new-PC bootstrap command");

for (const marker of [
  "GitHub Codespaces",
  "phone browser",
  "Node.js 24",
  "Python 3.12",
  "pnpm 10.18.0",
  "Windows PC",
  "remain **private**",
]) {
  requireText(mobileDoc, marker, `mobile development ${marker}`);
}

const devcontainer = JSON.parse(devcontainerText);
if (!String(devcontainer.image ?? "").includes("javascript-node:1-24")) {
  throw new Error("devcontainer: Node 24 image is required");
}
if (devcontainer?.features?.["ghcr.io/devcontainers/features/python:1"]?.version !== "3.12") {
  throw new Error("devcontainer: Python 3.12 feature is required");
}
if (!String(devcontainer.postCreateCommand ?? "").includes("pnpm@10.18.0")) {
  throw new Error("devcontainer: pnpm 10.18.0 pin is required");
}
if (!Array.isArray(devcontainer.forwardPorts) || !devcontainer.forwardPorts.includes(5717) || !devcontainer.forwardPorts.includes(3711)) {
  throw new Error("devcontainer: development ports 5717 and 3711 must be declared");
}

requireText(gitignore, "/artifacts/", "generated portable artifact ignore");

console.log("PHASE7C_PORTABLE_DEPLOY_SOURCE_TEST=PASS");
