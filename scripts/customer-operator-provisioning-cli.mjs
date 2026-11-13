/**
 * Operator Provisioning, Grant Administration & Release Packaging CLI
 * Supports:
 *   1. init-publisher-key --key-id <id> --private-out <external-pem-path>
 *   2. provision-customer --db <sqlite-path> --customer-id <id> --license-id <id> --grant-id <id> --installation-id <id> --public-key <base64url> --mt5-login <num> --broker-server <str> --mode <SELF_MANAGED|COPY_FOLLOWER> [--allowed-modes <csv>] [--validity-days <num>]
 *   3. revoke-grant --db <sqlite-path> --grant-id <id>
 *   4. package-customer-release [--out-dir <dir>]
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCustomerProductGrantLifecycleRecord,
  createCustomerProductGrantLifecycle,
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
  revokeCustomerProductGrant,
} from "../packages/customer-product-access/dist/index.js";
import { assertLicenseRecord } from "../packages/license-service/dist/index.js";
import { sha256CustomerApiToken } from "../packages/customer-runtime-session/dist/api-gateway.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid CLI argument near ${key ?? "end"}`);
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

async function listFilesRecursive(dir) {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function sqliteExecPython(dbPath, op, payloadObj) {
  const pyScript = `
import sqlite3, json, sys
db_path = sys.argv[1]
op = sys.argv[2]
payload = json.loads(sys.argv[3])
conn = sqlite3.connect(db_path)
conn.executescript("""
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS customer_security_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO customer_security_meta(key, value) VALUES ('schema_version', '1');
CREATE TABLE IF NOT EXISTS customer_license_records (license_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_grant_records (grant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_runtime_challenges (challenge_id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_security_audit (audit_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, customer_id TEXT NOT NULL, old_license_id TEXT NOT NULL, new_license_id TEXT NOT NULL, old_grant_id TEXT NOT NULL, new_grant_id TEXT NOT NULL, old_installation_id TEXT NOT NULL, new_installation_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, authorized_by TEXT NOT NULL);
""")
if op == "provision":
    lic = payload["license"]
    grant = payload["lifecycle"]
    conn.execute("INSERT INTO customer_license_records(license_id, payload_json) VALUES (?, ?) ON CONFLICT(license_id) DO UPDATE SET payload_json = excluded.payload_json", (lic["licenseId"], json.dumps(lic)))
    conn.execute("INSERT INTO customer_grant_records(grant_id, revision, payload_json) VALUES (?, ?, ?) ON CONFLICT(grant_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json", (grant["grant"]["grantId"], grant["revision"], json.dumps(grant)))
    conn.commit()
    print(json.dumps({"ok": True}))
elif op == "get_grant":
    cur = conn.execute("SELECT payload_json FROM customer_grant_records WHERE grant_id = ?", (payload["grantId"],))
    row = cur.fetchone()
    print(json.dumps({"row": json.loads(row[0]) if row else None}))
elif op == "save_grant":
    grant = payload["lifecycle"]
    conn.execute("UPDATE customer_grant_records SET revision = ?, payload_json = ? WHERE grant_id = ?", (grant["revision"], json.dumps(grant), grant["grant"]["grantId"]))
    conn.commit()
    print(json.dumps({"ok": True}))
conn.close()
`;
  const stdout = execFileSync(
    "python3",
    ["-c", pyScript, dbPath, op, JSON.stringify(payloadObj)],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout.trim());
}

async function initPublisherKey(flags) {
  const keyId = flags["key-id"];
  const privateOut = flags["private-out"];
  if (!keyId || !privateOut) {
    throw new Error("Required: --key-id <id> --private-out <external-pem-path>");
  }
  const resolvedOut = path.resolve(privateOut);
  const rel = path.relative(repoRoot, resolvedOut);
  if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
    throw new Error("RELEASE_SIGNING_KEY_MUST_BE_OUTSIDE_REPOSITORY");
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  await mkdir(path.dirname(resolvedOut), { recursive: true });
  await writeFile(resolvedOut, privatePem, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const keyringPath = path.join(repoRoot, "security", "customer-release-trusted-signers.json");
  const keyring = JSON.parse(await readFile(keyringPath, "utf8"));
  if (!Array.isArray(keyring.signers)) keyring.signers = [];
  if (keyring.signers.some((s) => s.keyId === keyId)) {
    throw new Error(`Signer keyId ${keyId} already exists in trusted keyring`);
  }
  keyring.signers.push({ keyId, publicKeyPem: publicPem });
  await writeFile(keyringPath, JSON.stringify(keyring, null, 2) + "\n", "utf8");

  console.log("PUBLISHER_KEY_INITIALIZED=TRUE");
  console.log(`PUBLISHER_KEY_ID=${keyId}`);
  console.log(`PUBLISHER_PRIVATE_KEY_EXTERNAL_PATH=${resolvedOut}`);
}

async function provisionCustomer(flags) {
  const dbPath = path.resolve(flags["db"] || ".runtime/customer-security.sqlite");
  const customerId = flags["customer-id"];
  const licenseId = flags["license-id"];
  const grantId = flags["grant-id"];
  const installationId = flags["installation-id"];
  const installationPublicKey = flags["public-key"];
  const mt5Login = Number(flags["mt5-login"]);
  const brokerServer = flags["broker-server"];
  const mode = flags["mode"];
  const validityDays = Number(flags["validity-days"] || "365");

  if (
    !customerId ||
    !licenseId ||
    !grantId ||
    !installationId ||
    !installationPublicKey ||
    !Number.isSafeInteger(mt5Login) ||
    mt5Login <= 0 ||
    !brokerServer ||
    (mode !== "SELF_MANAGED" && mode !== "COPY_FOLLOWER")
  ) {
    throw new Error("Missing or invalid required provisioning parameters");
  }

  await mkdir(path.dirname(dbPath), { recursive: true });
  const now = Date.now();
  const expiresAt = now + Math.max(1, validityDays) * 86_400_000;

  const license = {
    licenseId,
    status: "ACTIVE",
    customerId,
    allowedMt5Logins: [mt5Login],
    allowedBrokerServers: [brokerServer],
    installationId,
    installationPublicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: now,
    expiresAt,
    revokedAt: null,
  };
  assertLicenseRecord(license);

  let grant;
  if (mode === "SELF_MANAGED") {
    const allowedBotModes = (flags["allowed-modes"] || "PAUSE,AUTO,TREND,SIDEWAY,SEMI")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    grant = issueSelfManagedGrant(license, {
      grantId,
      issuedAt: now,
      expiresAt,
      allowedBotModes,
    });
  } else {
    const allowedCopySizingModes = (flags["allowed-modes"] || "EQUITY_RATIO,LOT_MULTIPLIER,FIXED_LOT")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    grant = issueCopyFollowerGrant(license, {
      grantId,
      issuedAt: now,
      expiresAt,
      allowedCopySizingModes,
    });
  }

  const lifecycle = createCustomerProductGrantLifecycle(grant);
  assertCustomerProductGrantLifecycleRecord(lifecycle);
  sqliteExecPython(dbPath, "provision", { license, lifecycle });

  const bearerToken = `xau_cust_${randomBytes(24).toString("base64url")}`;
  const tokenSha256Hex = sha256CustomerApiToken(bearerToken);

  console.log(
    JSON.stringify(
      {
        ok: true,
        databasePath: dbPath,
        customerId,
        licenseId,
        grantId,
        installationId,
        productMode: mode,
        mt5Login,
        brokerServer,
        expiresAt: new Date(expiresAt).toISOString(),
        gatewayAuthRecord: {
          customerId,
          tokenSha256Hex,
        },
        customerEnvBearerToken: bearerToken,
      },
      null,
      2,
    ),
  );
}

async function revokeGrant(flags) {
  const dbPath = path.resolve(flags["db"] || ".runtime/customer-security.sqlite");
  const grantId = flags["grant-id"];
  if (!grantId) throw new Error("Required: --grant-id <id>");
  const current = sqliteExecPython(dbPath, "get_grant", { grantId });
  if (!current.row) {
    console.log(JSON.stringify({ ok: false, code: "GRANT_NOT_FOUND" }, null, 2));
    process.exitCode = 2;
    return;
  }
  const now = Date.now();
  const revoked = revokeCustomerProductGrant(current.row, now);
  sqliteExecPython(dbPath, "save_grant", { lifecycle: revoked });
  console.log(JSON.stringify({ ok: true, code: "GRANT_REVOKED", grantId, revokedAt: now, revision: revoked.revision }, null, 2));
}

async function packageCustomerRelease(flags) {
  const outRoot = path.resolve(repoRoot, flags["out-dir"] || "artifacts/customer-agent-release");
  const releaseDir = path.join(outRoot, "customer-agent-v1");
  const zipPath = path.join(outRoot, "customer-agent-v1.zip");

  await rm(releaseDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await mkdir(path.join(releaseDir, "node_modules", "@xauusd"), { recursive: true });

  for (const pkg of ["customer-agent", "copy-protocol", "installation-proof"]) {
    const src = path.join(repoRoot, "packages", pkg);
    const dst = path.join(releaseDir, "node_modules", "@xauusd", pkg);
    await mkdir(dst, { recursive: true });
    await cp(path.join(src, "package.json"), path.join(dst, "package.json"));
    await cp(path.join(src, "dist"), path.join(dst, "dist"), { recursive: true });
  }

  await cp(path.join(repoRoot, "customer-release", "bin"), path.join(releaseDir, "bin"), { recursive: true });
  await cp(path.join(repoRoot, "customer-release", "config"), path.join(releaseDir, "config"), { recursive: true });
  await cp(path.join(repoRoot, "customer-release", "README.md"), path.join(releaseDir, "README.md"));
  await cp(
    path.join(repoRoot, "customer-release", "acceptance-record.template.md"),
    path.join(releaseDir, "acceptance-record.template.md"),
  );

  await writeFile(
    path.join(releaseDir, "package.json"),
    JSON.stringify(
      {
        name: "xauusd-customer-agent-release",
        private: true,
        type: "module",
        version: "1.0.0",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const forbidden = [
    /[\\/]src[\\/]/,
    /strategy-engine/,
    /risk-engine/,
    /execution-engine/,
    /mt5-broker/,
    /[\\/]\.git[\\/]/,
    /\.env($|\.)/,
    /\.pem$/,
    /\.key$/,
  ];

  const files = (await listFilesRecursive(releaseDir)).sort();
  const manifestLines = [];
  for (const file of files) {
    if (file.endsWith(".map")) {
      await rm(file, { force: true });
      continue;
    }
    const rel = path.relative(releaseDir, file).replaceAll("\\", "/");
    if (rel === "release-manifest.sha256") continue;
    for (const pattern of forbidden) {
      if (pattern.test(rel)) {
        throw new Error(`FORBIDDEN_RELEASE_PATH=${rel}`);
      }
    }
    const hash = createHash("sha256").update(await readFile(file)).digest("hex");
    manifestLines.push(`${hash}  ${rel}`);
  }

  await writeFile(path.join(releaseDir, "release-manifest.sha256"), manifestLines.join("\n") + "\n", "utf8");
  execFileSync(
    "python3",
    [
      "-c",
      `import zipfile, os, sys
src_dir, zip_path = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(src_dir):
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src_dir).replace(os.sep, "/")
            zf.write(full, rel)
`,
      releaseDir,
      zipPath,
    ],
    { stdio: "inherit" },
  );

  console.log("CUSTOMER_RELEASE_PACKAGE=PASS");
  console.log(`CUSTOMER_RELEASE_DIR=${releaseDir}`);
  console.log(`CUSTOMER_RELEASE_ZIP=${zipPath}`);
  console.log("MASTER_SOURCE_INCLUDED=NO");
  console.log("PRIVATE_KEY_INCLUDED=NO");
  console.log("API_TOKEN_INCLUDED=NO");
  console.log("MT5_BRIDGE_INCLUDED=NO");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case "init-publisher-key":
      await initPublisherKey(flags);
      break;
    case "provision-customer":
      await provisionCustomer(flags);
      break;
    case "revoke-grant":
      await revokeGrant(flags);
      break;
    case "package-customer-release":
      await packageCustomerRelease(flags);
      break;
    default:
      throw new Error(
        "Usage: node scripts/customer-operator-provisioning-cli.mjs <init-publisher-key|provision-customer|revoke-grant|package-customer-release> [--flags]",
      );
  }
}

main().catch((err) => {
  console.error(`OPERATOR_CLI_ERROR=${err.message}`);
  process.exitCode = 1;
});
