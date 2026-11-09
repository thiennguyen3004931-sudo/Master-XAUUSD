import { loadInstallationPrivateKey } from "./installation-identity-dpapi.mjs";
import { verifyOfflineCustomerActivation } from "./check-customer-installation-readiness.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CustomerAgent,
  HttpsCustomerAgentTransport,
} from "@xauusd/customer-agent";

const configPath = path.resolve(
  process.argv[2] || "config/customer-agent.json",
);
const config = JSON.parse(await readFile(configPath, "utf8"));

const token = process.env.XAUUSD_CUSTOMER_API_TOKEN;
if (!token || token.trim() !== token || token.length === 0) {
  throw new Error("XAUUSD_CUSTOMER_API_TOKEN is required");
}

const requiredString = (value, field) => {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(field + " must be a canonical non-blank string");
  }
  return value;
};

// Fail closed before reading key files, DPAPI decryption, constructing a
// Gateway transport or sending any activation request. This enforces the
// read-only Windows host ACL/DPAPI preflight; it is NOT customer-host signoff.
await verifyOfflineCustomerActivation(config, process.cwd());

const installationId = (
  await readFile(path.resolve(config.installationIdFile), "utf8")
).trim();
const installationPublicKey = (
  await readFile(path.resolve(config.installationPublicKeyFile), "utf8")
).trim();
// Legacy plaintext PEMs are refused. DPAPI CurrentUser decryption and the
// private/public key match must pass before any Customer API transport is created.
if (typeof config.installationPrivateKeyFile !== "string") {
  throw new Error("INSTALLATION_DPAPI_PATH_REQUIRED");
}
const installationPrivateKey = await loadInstallationPrivateKey(
  path.resolve(config.installationPrivateKeyFile),
  installationPublicKey,
);

const mt5Login = Number(config.mt5Login);
if (!Number.isSafeInteger(mt5Login) || mt5Login <= 0) {
  throw new Error("mt5Login must be a positive safe integer");
}

const transport = new HttpsCustomerAgentTransport(
  requiredString(config.apiBaseUrl, "apiBaseUrl"),
);
const agent = new CustomerAgent(transport, {
  apiToken: token,
  grantId: requiredString(config.grantId, "grantId"),
  installationId,
  installationPublicKey,
  installationPrivateKey,
  mt5Login,
  brokerServer: requiredString(config.brokerServer, "brokerServer"),
});

let result;
if (config.productMode === "SELF_MANAGED") {
  result = await agent.activateSelfManaged(
    requiredString(config.requestedBotMode, "requestedBotMode"),
  );
} else if (config.productMode === "COPY_FOLLOWER") {
  result = await agent.activateCopyFollower(
    requiredString(config.requestedSizingMode, "requestedSizingMode"),
  );
} else {
  throw new Error("productMode must be SELF_MANAGED or COPY_FOLLOWER");
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 2;
