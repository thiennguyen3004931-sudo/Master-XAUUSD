// Customer Windows installation OFFLINE / READ-ONLY local identity preflight.
// Does not activate a customer, call Gateway/MT5, mutate file ACLs or print secrets.
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertNoLegacyIdentity,
  loadInstallationPrivateKey,
} from "./installation-identity-dpapi.mjs";

const aclScript = fileURLToPath(new URL("./audit-customer-key-ntfs-acl.ps1", import.meta.url));

async function requireOrdinaryFile(file, max) {
  const info = await lstat(file);
  if (!info.isFile() || info.size < 1 || info.size > max) {
    throw new Error("INSTALLATION_OFFLINE_FILE_INVALID");
  }
}

export async function verifyOfflineCustomerInstallation(root) {
  if (process.platform !== "win32") throw new Error("INSTALLATION_OFFLINE_WINDOWS_ONLY");
  const keys = path.resolve(root, "keys");
  const dir = await lstat(keys);
  if (!dir.isDirectory()) throw new Error("INSTALLATION_OFFLINE_KEYS_DIR_INVALID");
  const dpapi = path.join(keys, "installation-private.dpapi");
  const publicFile = path.join(keys, "installation-public.txt");
  const idFile = path.join(keys, "installation-id.txt");
  await assertNoLegacyIdentity(dpapi);
  await requireOrdinaryFile(dpapi, 65536);
  await requireOrdinaryFile(publicFile, 8192);
  await requireOrdinaryFile(idFile, 8192);

  // Require conservative filesystem policy BEFORE decrypting private material.
  // Process stdout/stderr are discarded to avoid accidentally logging local
  // user information, absolute paths or future PowerShell details.
  const audit = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", aclScript, "-InstallationRoot", path.resolve(root),
  ], { windowsHide: true, stdio: "ignore", timeout: 30_000 });
  if (audit.error || audit.status !== 0 || audit.signal) {
    throw new Error("INSTALLATION_OFFLINE_ACL_NOT_PROVEN");
  }

  const installationId = (await readFile(idFile, "utf8")).trim();
  if (installationId.length < 1 || installationId.length > 256 ||
      /[\r\n\u0000]/.test(installationId)) {
    throw new Error("INSTALLATION_OFFLINE_ID_INVALID");
  }
  const publicKey = (await readFile(publicFile, "utf8")).trim();
  // This decrypts only in local process memory, verifies the expected public
  // key and never prints/export the private key or create an API transport.
  await loadInstallationPrivateKey(dpapi, publicKey);
  return true;
}


// Required before activating a customer agent or constructing a Gateway transport.
// A configuration must point to the same local identity whose DPAPI/ACL state
// was checked. Otherwise a safe preflight could be followed by a different,
// unverified private-key path. This is read-only; no customer state is mutated.
export async function verifyOfflineCustomerActivation(config, installationRoot) {
  const root = path.resolve(installationRoot);
  const identityPaths = {
    installationIdFile: path.join(root, "keys", "installation-id.txt"),
    installationPublicKeyFile: path.join(root, "keys", "installation-public.txt"),
    installationPrivateKeyFile: path.join(root, "keys", "installation-private.dpapi"),
  };
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("CUSTOMER_ACTIVATION_IDENTITY_CONFIG_INVALID");
  }
  for (const [field, expected] of Object.entries(identityPaths)) {
    const supplied = config[field];
    if (typeof supplied !== "string" || supplied.length === 0 ||
        supplied.trim() !== supplied || path.resolve(root, supplied) !== expected) {
      throw new Error("CUSTOMER_ACTIVATION_IDENTITY_PATH_MISMATCH");
    }
  }
  return verifyOfflineCustomerInstallation(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Always inspect the current local directory, never accept arbitrary
    // customer absolute paths or credentials as CLI arguments.
    if (process.argv.length !== 2) throw new Error("INSTALLATION_OFFLINE_ARGUMENTS_INVALID");
    await verifyOfflineCustomerInstallation(process.cwd());
    console.log("CUSTOMER_INSTALLATION_OFFLINE_READINESS=PASS");
    console.log("CUSTOMER_DPAPI_IDENTITY_CURRENT_USER=VERIFIED");
    console.log("CUSTOMER_NTFS_ACL_CONSERVATIVE_PREFLIGHT=PASS");
    console.log("CUSTOMER_EFFECTIVE_HOST_SECURITY_ACCEPTANCE=NOT_VERIFIED");
    console.log("CUSTOMER_LICENSE_AND_GRANT=NOT_VERIFIED");
    console.log("CUSTOMER_MT5_EXECUTION=NOT_VERIFIED");
    console.log("CUSTOMER_COMMERCIAL_RELEASE=NOT_APPROVED");
  } catch {
    // Fail closed with sanitized output on missing legacy/corrupt key, broad
    // ACL, wrong user profile or any other exception.
    console.error("CUSTOMER_INSTALLATION_OFFLINE_READINESS=BLOCKED");
    console.error("CUSTOMER_PRIVATE_KEY_BYTES_LOGGED=NO");
    process.exitCode = 2;
  }
}
