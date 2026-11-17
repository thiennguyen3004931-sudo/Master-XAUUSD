import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  protectEphemeralInstallationBytes,
  unprotectEphemeralInstallationBytes,
} from "../customer-release/bin/windows-dpapi-key-vault.mjs";

const ps = fileURLToPath(new URL("../customer-release/bin/windows-dpapi-key-vault.ps1", import.meta.url));

test("DPAPI wrapper never accepts empty, non-buffer or unversioned payload", async () => {
  await assert.rejects(protectEphemeralInstallationBytes(Buffer.alloc(0)), /CUSTOMER_DPAPI_INPUT_INVALID/);
  await assert.rejects(protectEphemeralInstallationBytes("plaintext"), /CUSTOMER_DPAPI_INPUT_INVALID/);
  await assert.rejects(unprotectEphemeralInstallationBytes(Buffer.from("-----BEGIN PRIVATE KEY-----")), /CUSTOMER_DPAPI_BLOB_VERSION_INVALID|CUSTOMER_DPAPI_WINDOWS_ONLY/);
  const src = await readFile(ps, "utf8");
  assert.match(src, /DataProtectionScope\]::CurrentUser/);
  assert.doesNotMatch(src, /LocalMachine|Set-Content|Out-File|WriteAllBytes|Invoke-WebRequest|Invoke-RestMethod/);
});

test("Windows DPAPI CurrentUser protects ephemeral bytes and detects tampering", {
  skip: process.platform !== "win32" && "Windows-only DPAPI smoke test",
}, async () => {
  const secret = randomBytes(256);
  let protectedBlob, recovered;
  try {
    protectedBlob = await protectEphemeralInstallationBytes(secret);
    const encoded = protectedBlob.toString("utf8");
    assert.match(encoded, /^XAUUSD_DPAPI_CURRENT_USER_V1:[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(encoded.includes(secret.toString("base64")), false);
    recovered = await unprotectEphemeralInstallationBytes(protectedBlob);
    assert.deepEqual(recovered, secret);
    const corrupted = Buffer.from(protectedBlob);
    const midpoint = Math.floor(corrupted.length * 0.75);
    corrupted[midpoint] = corrupted[midpoint] === 65 ? 66 : 65;
    await assert.rejects(unprotectEphemeralInstallationBytes(corrupted), /CUSTOMER_DPAPI_OPERATION_FAILED|CUSTOMER_DPAPI_BASE64_INVALID/);
    await assert.rejects(unprotectEphemeralInstallationBytes(Buffer.from("XAUUSD_DPAPI_CURRENT_USER_V2:QUFB")), /CUSTOMER_DPAPI_BLOB_VERSION_INVALID/);
    corrupted.fill(0);
  } finally {
    secret.fill(0);
    if (protectedBlob) protectedBlob.fill(0);
    if (recovered) recovered.fill(0);
  }
});

test("Non-Windows callers fail closed rather than silently storing plaintext", {
  skip: process.platform === "win32" && "Non-Windows contract",
}, async () => {
  await assert.rejects(protectEphemeralInstallationBytes(randomBytes(32)), /CUSTOMER_DPAPI_WINDOWS_ONLY/);
});
