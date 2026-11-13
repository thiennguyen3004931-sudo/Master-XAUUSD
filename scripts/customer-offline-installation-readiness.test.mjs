import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { verifyOfflineCustomerInstallation, verifyOfflineCustomerActivation } from "../customer-release/bin/check-customer-installation-readiness.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "customer-release/bin/check-customer-installation-readiness.mjs");

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "xauusd-customer-offline-readiness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function run(cwd, args = []) {
  try {
    const r = await exec(process.execPath, [cli, ...args], {
      cwd, timeout: 15000,
      env: { ...process.env, XAUUSD_CUSTOMER_API_TOKEN: "" },
    });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { status: e.code, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}
function assertSanitizedFailure(result) {
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CUSTOMER_INSTALLATION_OFFLINE_READINESS=BLOCKED/);
  assert.doesNotMatch(result.stdout + result.stderr, /-----BEGIN PRIVATE KEY-----|syntheticsecret|access denied|C:\\Users\\/i);
}

test("read-only offline preflight always fails closed on missing identity", async (t) => {
  const dir = await fixture(t);
  const result = await run(dir);
  assertSanitizedFailure(result);
});

test("offline preflight rejects unexpected CLI arguments without printing them", async (t) => {
  const dir = await fixture(t);
  const result = await run(dir, ["syntheticsecret"]);
  assertSanitizedFailure(result);
});

test("preflight rejects legacy PEM + DPAPI mixed identity; original bytes unchanged", async (t) => {
  const dir = await fixture(t);
  const keys = path.join(dir, "keys");
  await mkdir(keys);
  const legacy = path.join(keys, "installation-private.pem");
  await writeFile(legacy, "synthetic legacy fixture only");
  await writeFile(path.join(keys, "installation-private.dpapi"), "XAUUSD_DPAPI_CURRENT_USER_V1:ZmFrZQ==");
  await writeFile(path.join(keys, "installation-id.txt"), "synthetic-installation");
  await writeFile(path.join(keys, "installation-public.txt"), "synthetic-public");
  const before = await readFile(legacy, "utf8");
  const result = await run(dir);
  assertSanitizedFailure(result);
  assert.equal(await readFile(legacy, "utf8"), before);
});

test("offline preflight contains no customer Gateway/MT5/runtime/ACL mutation", async () => {
  const source = await readFile(cli, "utf8");
  for (const forbidden of [
    /CustomerAgent/, /HttpsCustomerAgentTransport/, /fetch\(/,
    /node:https/, /node:http/, /mt5-broker/, /order_send/,
    /BOT_MODE/, /ARM_LIVE/, /Set-Acl/, /icacls\b/,
    /writeFile\(/, /unlink\(/, /rm\(/,
  ]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /assertNoLegacyIdentity\(dpapi\)/);
  assert.match(source, /spawnSync\("powershell.exe"/);
  assert.match(source, /stdio: "ignore"/);
  assert.match(source, /await loadInstallationPrivateKey\(dpapi, publicKey\)/);
  assert.match(source, /CUSTOMER_COMMERCIAL_RELEASE=NOT_APPROVED/);
  assert.ok(source.indexOf("const audit = spawnSync(") < source.indexOf("await loadInstallationPrivateKey("));
});

test("non-Windows refuses to inspect DPAPI identity without plaintext fallback", {
  skip: process.platform === "win32" && "Windows-only behavior",
}, async (t) => {
  const dir = await fixture(t);
  await assert.rejects(verifyOfflineCustomerInstallation(dir), /INSTALLATION_OFFLINE_WINDOWS_ONLY/);
});

test("activation preflight rejects mismatched identity file paths before any Windows IO", async () => {
  const dir = path.join(tmpdir(), "xauusd-preflight-nonexistent-only");
  const valid = {
    installationIdFile: "keys/installation-id.txt",
    installationPublicKeyFile: "keys/installation-public.txt",
    installationPrivateKeyFile: "keys/installation-private.dpapi",
  };
  for (const [field, replacement] of [
    ["installationIdFile", "other/installation-id.txt"],
    ["installationPublicKeyFile", "keys/../unverified-public.txt"],
    ["installationPrivateKeyFile", "keys/installation-private.pem"],
    ["installationPrivateKeyFile", "../other-customer/installation-private.dpapi"],
    ["installationPrivateKeyFile", ""],
  ]) {
    await assert.rejects(
      verifyOfflineCustomerActivation({ ...valid, [field]: replacement }, dir),
      /CUSTOMER_ACTIVATION_IDENTITY_PATH_MISMATCH/,
    );
  }
  await assert.rejects(
    verifyOfflineCustomerActivation(null, dir),
    /CUSTOMER_ACTIVATION_IDENTITY_CONFIG_INVALID/,
  );
});

test("activation script enforces offline ACL and DPAPI gate before identity load or Gateway transport", async () => {
  const activation = await readFile(path.join(root, "customer-release/bin/activate-customer-agent.mjs"), "utf8");
  const gate = activation.indexOf("await verifyOfflineCustomerActivation(config, process.cwd());");
  const load = activation.indexOf("await loadInstallationPrivateKey(");
  const transport = activation.indexOf("new HttpsCustomerAgentTransport(");
  assert.ok(gate >= 0 && load > gate && transport > load);
  assert.ok(activation.includes('from "./check-customer-installation-readiness.mjs"'));
  assert.doesNotMatch(activation.slice(gate, transport), /try\s*\{|catch\s*\(/);
  const policy = await readFile(cli, "utf8");
  assert.ok(policy.includes('installationPrivateKeyFile: path.join(root, "keys", "installation-private.dpapi")'));
  assert.ok(policy.indexOf("return verifyOfflineCustomerInstallation(root);") >= 0);
});
