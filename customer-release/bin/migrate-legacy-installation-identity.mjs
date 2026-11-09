// Explicit legacy PEM -> Windows CurrentUser DPAPI migration helper.
// NEVER deletes, renames, chmods, logs or uploads the existing private PEM.
// Writes ONLY an exclusive new DPAPI file; a failed/partial migration remains blocked.
import { createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DPAPI_PRIVATE_KEY_BASENAME,
  LEGACY_PRIVATE_KEY_BASENAME,
  protectInstallationPrivateKey,
} from "./installation-identity-dpapi.mjs";
import { unprotectEphemeralInstallationBytes } from "./windows-dpapi-key-vault.mjs";

const confirmation = "--confirm-preserve-legacy-pem";
const maxLegacyBytes = 16384;

async function requireRegularFile(file, maxSize) {
  const info = await lstat(file);
  if (!info.isFile() || info.size <= 0 || info.size > maxSize) {
    throw new Error("INSTALLATION_MIGRATION_SOURCE_INVALID");
  }
  return info;
}

async function refuseExistingTarget(file) {
  try {
    await lstat(file);
    throw new Error("INSTALLATION_MIGRATION_TARGET_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function compareIdentity(privateKey, expectedPublic) {
  if (typeof expectedPublic !== "string" || !/^[A-Za-z0-9_-]+$/.test(expectedPublic)) {
    throw new Error("INSTALLATION_MIGRATION_PUBLIC_INVALID");
  }
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expectedPublic, "utf8");
  try {
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("INSTALLATION_MIGRATION_KEY_MISMATCH");
    }
  } finally {
    a.fill(0);
    b.fill(0);
  }
}

export async function migrateLegacyInstallationIdentity(root, explicitConfirmation) {
  if (process.platform !== "win32") throw new Error("INSTALLATION_MIGRATION_WINDOWS_ONLY");
  if (explicitConfirmation !== confirmation) throw new Error("INSTALLATION_MIGRATION_CONFIRMATION_REQUIRED");
  const keys = path.resolve(root, "keys");
  const legacy = path.join(keys, LEGACY_PRIVATE_KEY_BASENAME);
  const target = path.join(keys, DPAPI_PRIVATE_KEY_BASENAME);
  const publicFile = path.join(keys, "installation-public.txt");
  const idFile = path.join(keys, "installation-id.txt");

  // No rollback that overwrites an enrolled identity. Reject stale/partial
  // DPAPI state before opening plaintext; no migration if target already exists.
  await refuseExistingTarget(target);
  const directory = await lstat(keys);
  if (!directory.isDirectory()) throw new Error("INSTALLATION_MIGRATION_DIR_INVALID");
  const first = await requireRegularFile(legacy, maxLegacyBytes);
  await requireRegularFile(publicFile, 8192);
  await requireRegularFile(idFile, 8192);

  const id = (await readFile(idFile, "utf8")).trim();
  if (!id || id.length > 256 || /[\r\n]/.test(id)) {
    throw new Error("INSTALLATION_MIGRATION_ID_INVALID");
  }
  const expectedPublic = (await readFile(publicFile, "utf8")).trim();
  let input;
  let sealed;
  let stored;
  let decrypted;
  const handle = await open(legacy, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== first.dev || opened.ino !== first.ino || opened.size !== first.size) {
      throw new Error("INSTALLATION_MIGRATION_SOURCE_CHANGED");
    }
    input = await handle.readFile();
    const finished = await handle.stat();
    const named = await lstat(legacy);
    if (opened.dev !== finished.dev || opened.ino !== finished.ino ||
        opened.size !== finished.size || opened.mtimeMs !== finished.mtimeMs ||
        first.dev !== named.dev || first.ino !== named.ino ||
        named.size !== first.size || named.mtimeMs !== first.mtimeMs) {
      throw new Error("INSTALLATION_MIGRATION_SOURCE_CHANGED");
    }
    const key = createPrivateKey(input);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("INSTALLATION_MIGRATION_KEY_TYPE_INVALID");
    compareIdentity(key, expectedPublic);

    sealed = await protectInstallationPrivateKey(key, expectedPublic);
    // Atomic *exclusive creation*, never overwrite even if another initializer
    // won the race while DPAPI was being invoked. A failure leaves partial
    // ciphertext for operator investigation; no automatic deletion.
    await writeFile(target, sealed, { flag: "wx", mode: 0o600 });
    await requireRegularFile(target, 65536);
    stored = await readFile(target);
    decrypted = await unprotectEphemeralInstallationBytes(stored);
    const checked = createPrivateKey({ key: decrypted, format: "der", type: "pkcs8" });
    if (checked.asymmetricKeyType !== "ed25519") throw new Error("INSTALLATION_MIGRATION_VERIFY_FAILED");
    compareIdentity(checked, expectedPublic);
    return {
      dpapiWrittenAndVerified: true,
      legacyPreserved: true,
      activationBlockedUntilLegacyHandled: true,
    };
  } finally {
    await handle.close();
    if (input) input.fill(0);
    if (sealed) sealed.fill(0);
    if (stored) stored.fill(0);
    if (decrypted) decrypted.fill(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("INSTALLATION_MIGRATION_ARGUMENTS_INVALID");
    const outcome = await migrateLegacyInstallationIdentity(process.cwd(), process.argv[2]);
    if (!outcome.dpapiWrittenAndVerified || !outcome.legacyPreserved) {
      throw new Error("INSTALLATION_MIGRATION_VERIFICATION_FAILED");
    }
    console.log("CUSTOMER_MIGRATION_NEW_DPAPI_VERIFIED=TRUE");
    console.log("CUSTOMER_MIGRATION_LEGACY_PEM_PRESERVED=TRUE");
    console.log("CUSTOMER_ACTIVATION_BLOCKED_PENDING_OPERATOR_CLEANUP=TRUE");
    console.log("CUSTOMER_MIGRATION_HOST_ACL_VERIFIED=FALSE");
    console.log("CUSTOMER_COMMERCIAL_RELEASE_APPROVAL=NOT_VERIFIED");
  } catch {
    // Sanitized error output only; never print contents, paths, key/ID/token.
    console.error("CUSTOMER_LEGACY_PEM_MIGRATION=BLOCKED");
    process.exitCode = 2;
  }
}
