import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { unprotectEphemeralInstallationBytes } from "../customer-release/bin/windows-dpapi-key-vault.mjs";

const runProcess = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" && "Windows DPAPI requires current Windows user" };

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xauusd-synthetic-legacy-dpapi-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  await mkdir(path.join(dir, "keys"));
  await mkdir(path.join(dir, "bin"));
  for (const name of [
    "migrate-legacy-installation-identity.mjs",
    "installation-identity-dpapi.mjs",
    "windows-dpapi-key-vault.mjs",
    "windows-dpapi-key-vault.ps1",
  ]) {
    await cp(path.join(repoRoot, "customer-release/bin", name), path.join(dir, "bin", name));
  }
  const pair = generateKeyPairSync("ed25519");
  const privateBytes = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const legacyPath = path.join(dir, "keys/installation-private.pem");
  await writeFile(legacyPath, privateBytes, { flag: "wx" });
  await writeFile(path.join(dir, "keys/installation-public.txt"), options.badPublic ? "Q".repeat(43) : publicKey, { flag: "wx" });
  if (!options.missingId) await writeFile(path.join(dir, "keys/installation-id.txt"), "synthetic-installation-001\n", { flag: "wx" });
  privateBytes.fill(0);
  return { dir, publicKey, legacyPath, blobPath: path.join(dir, "keys/installation-private.dpapi") };
}

async function run(dir, args = []) {
  try {
    const r = await runProcess(process.execPath, [
      path.join(dir, "bin/migrate-legacy-installation-identity.mjs"), ...args,
    ], { cwd: dir, timeout: 35000 });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { status: e.code, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

async function exists(file) {
  try { await readFile(file); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

test("non-Windows migration fails closed before creating ciphertext", {
  skip: process.platform === "win32" && "non-Windows refusal test",
}, async (t) => {
  const f = await fixture(t);
  const r = await run(f.dir, ["--confirm-preserve-legacy-pem"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CUSTOMER_LEGACY_PEM_MIGRATION=BLOCKED/);
  assert.equal(await exists(f.blobPath), false);
  assert.equal(await exists(f.legacyPath), true);
});

test("operator confirmation is mandatory and legacy remains unchanged", windowsOnly, async (t) => {
  const f = await fixture(t);
  const digest = createHash("sha256").update(await readFile(f.legacyPath)).digest("hex");
  for (const args of [[], ["--confirm-preserve-legacy-pem", "--extra"], ["--unknown-flag"]]) {
    const r = await run(f.dir, args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CUSTOMER_LEGACY_PEM_MIGRATION=BLOCKED/);
    assert.equal(await exists(f.blobPath), false);
  }
  assert.equal(createHash("sha256").update(await readFile(f.legacyPath)).digest("hex"), digest);
});

test("valid synthetic legacy identity makes verified DPAPI blob but preserves legacy PEM", windowsOnly, async (t) => {
  const f = await fixture(t);
  const before = createHash("sha256").update(await readFile(f.legacyPath)).digest("hex");
  const result = await run(f.dir, ["--confirm-preserve-legacy-pem"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CUSTOMER_MIGRATION_NEW_DPAPI_VERIFIED=TRUE/);
  assert.match(result.stdout, /CUSTOMER_MIGRATION_LEGACY_PEM_PRESERVED=TRUE/);
  assert.match(result.stdout, /CUSTOMER_ACTIVATION_BLOCKED_PENDING_OPERATOR_CLEANUP=TRUE/);
  assert.doesNotMatch(result.stdout + result.stderr, /-----BEGIN PRIVATE KEY-----/);
  assert.equal(createHash("sha256").update(await readFile(f.legacyPath)).digest("hex"), before);
  const fileNames = await readdir(path.join(f.dir, "keys"));
  assert.deepEqual(fileNames.sort(), [
    "installation-id.txt", "installation-private.dpapi", "installation-private.pem", "installation-public.txt",
  ]);
  const sealed = await readFile(f.blobPath);
  let decrypted;
  try {
    assert.match(sealed.toString("utf8"), /^XAUUSD_DPAPI_CURRENT_USER_V1:/);
    decrypted = await unprotectEphemeralInstallationBytes(sealed);
    const { createPrivateKey, createPublicKey } = await import("node:crypto");
    const restored = createPrivateKey({ key: decrypted, format: "der", type: "pkcs8" });
    const derived = createPublicKey(restored).export({ type: "spki", format: "der" }).toString("base64url");
    assert.equal(derived, f.publicKey);
  } finally {
    sealed.fill(0);
    if (decrypted) decrypted.fill(0);
  }
  const second = await run(f.dir, ["--confirm-preserve-legacy-pem"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /CUSTOMER_LEGACY_PEM_MIGRATION=BLOCKED/);
  assert.equal(createHash("sha256").update(await readFile(f.legacyPath)).digest("hex"), before);
});

test("wrong public key, incomplete identity and existing target all refuse migration", windowsOnly, async (t) => {
  for (const options of [{ badPublic: true }, { missingId: true }]) {
    const f = await fixture(t, options);
    const result = await run(f.dir, ["--confirm-preserve-legacy-pem"]);
    assert.notEqual(result.status, 0);
    assert.equal(await exists(f.blobPath), false);
    assert.equal(await exists(f.legacyPath), true);
  }
  const f = await fixture(t);
  await writeFile(f.blobPath, "synthetic-corrupt-existing-dpapi", { flag: "wx" });
  const result = await run(f.dir, ["--confirm-preserve-legacy-pem"]);
  assert.notEqual(result.status, 0);
  assert.equal((await readFile(f.blobPath, "utf8")), "synthetic-corrupt-existing-dpapi");
  assert.equal(await exists(f.legacyPath), true);
});

test("concurrent synthetic migration attempts never overwrite an encrypted result", windowsOnly, async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([
    run(f.dir, ["--confirm-preserve-legacy-pem"]),
    run(f.dir, ["--confirm-preserve-legacy-pem"]),
  ]);
  assert.equal(results.filter(r => r.status === 0).length, 1);
  assert.equal(results.filter(r => r.status !== 0).length, 1);
  assert.equal(await exists(f.legacyPath), true);
  const sealed = await readFile(f.blobPath);
  try {
    assert.match(sealed.toString("utf8"), /^XAUUSD_DPAPI_CURRENT_USER_V1:/);
  } finally { sealed.fill(0); }
});
