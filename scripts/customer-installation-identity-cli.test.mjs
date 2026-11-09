import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { unprotectEphemeralInstallationBytes } from "../customer-release/bin/windows-dpapi-key-vault.mjs";
import { loadInstallationPrivateKey } from "../customer-release/bin/installation-identity-dpapi.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const identityFiles = [
  "installation-private.dpapi",
  "installation-public.txt",
  "installation-id.txt",
];
const windowsOnly = { skip: process.platform !== "win32" && "Windows CurrentUser DPAPI required" };

async function releaseFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xauusd-installation-cli-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(path.join(root, "bin"));
  for (const name of [
    "generate-installation-identity.mjs",
    "installation-identity-dpapi.mjs",
    "windows-dpapi-key-vault.mjs",
    "windows-dpapi-key-vault.ps1",
  ]) {
    await cp(path.join(repoRoot, "customer-release/bin", name), path.join(root, "bin", name));
  }
  for (const name of ["copy-protocol", "installation-proof"]) {
    const target = path.join(root, "node_modules/@xauusd", name);
    await mkdir(target, { recursive: true });
    await cp(path.join(repoRoot, "packages", name, "package.json"), path.join(target, "package.json"));
    await cp(path.join(repoRoot, "packages", name, "dist"), path.join(target, "dist"), { recursive: true });
  }
  return root;
}

async function run(root, installationId) {
  const args = [path.join(root, "bin/generate-installation-identity.mjs")];
  if (installationId !== undefined) args.push(installationId);
  try {
    const result = await execFileAsync(process.execPath, args, { cwd: root, timeout: 30_000 });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function snapshot(root) {
  const entries = await Promise.all(identityFiles.map(async (name) => [
    name, createHash("sha256").update(await readFile(path.join(root, "keys", name))).digest("hex"),
  ]));
  return Object.fromEntries(entries);
}

async function assertMatchingKeyPair(root) {
  const privateBlob = await readFile(path.join(root, "keys/installation-private.dpapi"));
  const publicKey = (await readFile(path.join(root, "keys/installation-public.txt"), "utf8")).trim();
  assert.match(privateBlob.toString("utf8"), /^XAUUSD_DPAPI_CURRENT_USER_V1:[A-Za-z0-9+/]+={0,2}$/);
  assert.equal((await readdir(path.join(root, "keys"))).includes("installation-private.pem"), false);
  let decrypted;
  try {
    decrypted = await unprotectEphemeralInstallationBytes(privateBlob);
    const key = createPrivateKey({ key: decrypted, format: "der", type: "pkcs8" });
    const derived = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url");
    assert.equal(publicKey, derived);
    const activationKey = await loadInstallationPrivateKey(
      path.join(root, "keys/installation-private.dpapi"), publicKey,
    );
    assert.equal(
      createPublicKey(activationKey).export({ type: "spki", format: "der" }).toString("base64url"),
      publicKey,
    );
    await assert.rejects(
      loadInstallationPrivateKey(path.join(root, "keys/installation-private.dpapi"), "Q".repeat(43)),
      /INSTALLATION_IDENTITY_KEY_MISMATCH|INSTALLATION_PUBLIC_KEY_INVALID/,
    );
  } finally {
    if (decrypted) decrypted.fill(0);
    privateBlob.fill(0);
  }
  assert.ok((await stat(path.join(root, "keys/installation-private.dpapi"))).isFile());
}

test("non-Windows identity generation refuses plaintext fallback", { skip: process.platform === "win32" && "Non-Windows contract" }, async (t) => {
  const root = await releaseFixture(t);
  const result = await run(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /INSTALLATION_DPAPI_WINDOWS_ONLY/);
});

test("packaged identity CLI creates only DPAPI ciphertext and a consistent public key", windowsOnly, async (t) => {
  const root = await releaseFixture(t);
  const result = await run(root);
  assert.equal(result.code, 0, result.stderr);
  await assertMatchingKeyPair(root);
  const id = (await readFile(path.join(root, "keys/installation-id.txt"), "utf8")).trim();
  assert.match(id, /^installation-[0-9a-f-]{36}$/);
  assert.ok(result.stdout.includes("INSTALLATION_ID=" + id));
  assert.ok(result.stdout.includes("PRIVATE_KEY_STORED_LOCAL=keys/installation-private.dpapi"));
  assert.equal(result.stdout.includes("PRIVATE KEY"), false);
});

test("rerunning identity generation preserves the enrolled DPAPI blob and installation ID", windowsOnly, async (t) => {
  const root = await releaseFixture(t);
  assert.equal((await run(root, "installation-original")).code, 0);
  const before = await snapshot(root);
  const result = await run(root, "installation-replacement");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /INSTALLATION_IDENTITY_ALREADY_EXISTS/);
  assert.deepEqual(await snapshot(root), before);
  await assertMatchingKeyPair(root);
});

for (const name of [...identityFiles, "installation-private.pem"]) {
  test("partial or legacy identity containing " + name + " is preserved", windowsOnly, async (t) => {
    const root = await releaseFixture(t);
    await mkdir(path.join(root, "keys"));
    const retained = "retained-existing-identity-" + name;
    await writeFile(path.join(root, "keys", name), retained);
    const result = await run(root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /INSTALLATION_IDENTITY_ALREADY_EXISTS/);
    assert.deepEqual(await readdir(path.join(root, "keys")), [name]);
    assert.equal(await readFile(path.join(root, "keys", name), "utf8"), retained);
  });
}

test("concurrent initializers never replace a winning encrypted identity", windowsOnly, async (t) => {
  const root = await releaseFixture(t);
  const results = await Promise.all([run(root, "installation-first"), run(root, "installation-second")]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  const rejected = results.find((result) => result.code !== 0);
  assert.match(rejected.stderr, /INSTALLATION_IDENTITY_ALREADY_EXISTS/);
  await assertMatchingKeyPair(root);
  const winner = results.find((result) => result.code === 0);
  const id = (await readFile(path.join(root, "keys/installation-id.txt"), "utf8")).trim();
  assert.ok(winner.stdout.includes("INSTALLATION_ID=" + id));
});

test("corrupt DPAPI ciphertext and mixed legacy private PEM fail closed", windowsOnly, async (t) => {
  const root = await releaseFixture(t);
  assert.equal((await run(root)).code, 0);
  const keyPath = path.join(root, "keys/installation-private.dpapi");
  const publicKey = (await readFile(path.join(root, "keys/installation-public.txt"), "utf8")).trim();
  const original = await readFile(keyPath);
  try {
    await writeFile(path.join(root, "keys/installation-private.pem"), "synthetic legacy fixture");
    await assert.rejects(loadInstallationPrivateKey(keyPath, publicKey), /INSTALLATION_LEGACY_PEM_PRESENT/);
    await rm(path.join(root, "keys/installation-private.pem"));
    const tampered = Buffer.from(original);
    tampered[tampered.length - 6] = tampered[tampered.length - 6] === 65 ? 66 : 65;
    await writeFile(keyPath, tampered);
    await assert.rejects(loadInstallationPrivateKey(keyPath, publicKey), /INSTALLATION_DPAPI_DECRYPT_OR_KEY_INVALID/);
    tampered.fill(0);
  } finally {
    original.fill(0);
  }
});

test("customer activation refuses plaintext PEM without constructing any gateway transport", async () => {
  const source = await readFile(
    path.join(repoRoot, "customer-release/bin/activate-customer-agent.mjs"), "utf8",
  );
  const example = JSON.parse(await readFile(
    path.join(repoRoot, "customer-release/config/customer-agent.example.json"), "utf8",
  ));
  assert.equal(example.installationPrivateKeyFile, "keys/installation-private.dpapi");
  assert.match(source, /loadInstallationPrivateKey\(/);
  assert.doesNotMatch(source, /createPrivateKey\(privatePem\)|readFile\([^)]*installationPrivateKeyFile/);
  assert.ok(source.indexOf("await loadInstallationPrivateKey(") < source.indexOf("new HttpsCustomerAgentTransport("));
  assert.match(source, /config\.productMode === "SELF_MANAGED"/);
  assert.match(source, /config\.productMode === "COPY_FOLLOWER"/);
});
