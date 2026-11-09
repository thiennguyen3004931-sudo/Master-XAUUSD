// Windows-only DPAPI CurrentUser installation identity contract.
// No plaintext PEM read fallback and no automatic migration.
import { createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  protectEphemeralInstallationBytes,
  unprotectEphemeralInstallationBytes,
} from "./windows-dpapi-key-vault.mjs";

export const DPAPI_PRIVATE_KEY_BASENAME = "installation-private.dpapi";
export const LEGACY_PRIVATE_KEY_BASENAME = "installation-private.pem";

async function existsEvenIfSymlink(file) {
  try { await lstat(file); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertNoLegacyIdentity(privateFile) {
  const candidate = path.resolve(privateFile);
  if (path.basename(candidate) !== DPAPI_PRIVATE_KEY_BASENAME) {
    throw new Error("INSTALLATION_DPAPI_PATH_REQUIRED");
  }
  if (await existsEvenIfSymlink(path.join(path.dirname(candidate), LEGACY_PRIVATE_KEY_BASENAME))) {
    throw new Error("INSTALLATION_LEGACY_PEM_PRESENT: manual migration approval required");
  }
}

function assertSamePublicKey(publicKey, privateKey) {
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(publicKey)) {
    throw new Error("INSTALLATION_PUBLIC_KEY_INVALID");
  }
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url");
  const expected = Buffer.from(publicKey, "utf8");
  const received = Buffer.from(actual, "utf8");
  try {
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error("INSTALLATION_IDENTITY_KEY_MISMATCH");
    }
  } finally {
    expected.fill(0);
    received.fill(0);
  }
}

export async function protectInstallationPrivateKey(privateKey, publicKey) {
  if (process.platform !== "win32") throw new Error("INSTALLATION_DPAPI_WINDOWS_ONLY");
  assertSamePublicKey(publicKey, privateKey);
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    return await protectEphemeralInstallationBytes(privateDer);
  } finally {
    privateDer.fill(0);
  }
}

export async function loadInstallationPrivateKey(privateFile, publicKey) {
  if (process.platform !== "win32") throw new Error("INSTALLATION_DPAPI_WINDOWS_ONLY");
  await assertNoLegacyIdentity(privateFile);
  const file = path.resolve(privateFile);
  // Reject symlink/reparse paths as well as unexpectedly huge or empty blobs.
  const info = await lstat(file);
  if (!info.isFile() || info.size < 36 || info.size > 65536) {
    throw new Error("INSTALLATION_DPAPI_FILE_INVALID");
  }
  const blob = await readFile(file);
  let der;
  try {
    der = await unprotectEphemeralInstallationBytes(blob);
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("INSTALLATION_KEY_TYPE_INVALID");
    assertSamePublicKey(publicKey, key);
    return key;
  } catch (error) {
    if (error.message === "INSTALLATION_IDENTITY_KEY_MISMATCH") throw error;
    throw new Error("INSTALLATION_DPAPI_DECRYPT_OR_KEY_INVALID");
  } finally {
    blob.fill(0);
    if (der) der.fill(0);
  }
}
