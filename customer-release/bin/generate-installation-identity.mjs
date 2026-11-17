import { randomUUID } from "node:crypto";
import { DPAPI_PRIVATE_KEY_BASENAME, LEGACY_PRIVATE_KEY_BASENAME, protectInstallationPrivateKey, loadInstallationPrivateKey } from "./installation-identity-dpapi.mjs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
} from "@xauusd/installation-proof";

if (process.platform !== "win32") {
  throw new Error("INSTALLATION_DPAPI_WINDOWS_ONLY: plaintext identity fallback is disabled.");
}

const root = process.cwd();
const keysDir = path.join(root, "keys");
await mkdir(keysDir, { recursive: true });

const identityFiles = [
  DPAPI_PRIVATE_KEY_BASENAME,
  LEGACY_PRIVATE_KEY_BASENAME,
  "installation-public.txt",
  "installation-id.txt",
];
const existingIdentityError = () => new Error(
  "INSTALLATION_IDENTITY_ALREADY_EXISTS: preserve the existing identity files; do not regenerate an enrolled identity.",
);

// Refuse partial identities too: their surviving files may already be enrolled.
for (const name of identityFiles) {
  try {
    await lstat(path.join(keysDir, name));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw existingIdentityError();
}

const installationId =
  process.argv[2]?.trim() || `installation-${randomUUID()}`;

const pair = generateInstallationDeviceKeyPair();
const publicKey = exportInstallationPublicKey(pair.publicKey);
let sealedKey = await protectInstallationPrivateKey(pair.privateKey, publicKey);

try {
  // Fail closed: ciphertext is the ONLY persisted private-key representation.
  // Exclusive creation prevents competing initializers from overwriting identities.
  await writeFile(
    path.join(keysDir, DPAPI_PRIVATE_KEY_BASENAME),
    sealedKey,
    { mode: 0o600, flag: "wx" },
  );
  // Verify ciphertext under the current Windows profile before publishing the public identity.
  await loadInstallationPrivateKey(path.join(keysDir, DPAPI_PRIVATE_KEY_BASENAME), publicKey);
  await writeFile(
    path.join(keysDir, "installation-public.txt"),
    publicKey + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(keysDir, "installation-id.txt"),
    installationId + "\n",
    { encoding: "utf8", flag: "wx" },
  );
} catch (error) {
  // Interrupted creation is intentionally left in partial state. Never regenerate blindly.
  if (error.code === "EEXIST") throw existingIdentityError();
  throw error;
} finally {
  if (sealedKey) sealedKey.fill(0);
}

console.log("INSTALLATION_ID=" + installationId);
console.log("INSTALLATION_PUBLIC_KEY=" + publicKey);
console.log("PRIVATE_KEY_STORED_LOCAL=keys/installation-private.dpapi");
console.log("SEND_PRIVATE_KEY_TO_ADMIN=NO");
