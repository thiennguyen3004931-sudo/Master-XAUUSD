import { loadInstallationPrivateKey } from "./installation-identity-dpapi.mjs";
import { verifyOfflineCustomerActivation } from "./check-customer-installation-readiness.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CustomerAgent,
  CustomerCopyCommandVerifier,
  CustomerFollowerExecutionAdapter,
  CustomerMt5FollowerExecutor,
  HttpsCustomerAgentTransport,
  InMemoryCustomerFollowerPositionRegistry,
} from "@xauusd/customer-agent";

const configPath = path.resolve(
  process.argv[2] || "config/customer-agent.json",
);
const commandsFilePath = process.argv[3]
  ? path.resolve(process.argv[3])
  : null;

const config = JSON.parse(await readFile(configPath, "utf8"));

if (config.productMode !== "COPY_FOLLOWER") {
  throw new Error("COPY_FOLLOWER_MODE_REQUIRED");
}

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

// Enforce read-only offline NTFS ACL + DPAPI preflight before loading keys or network transport
await verifyOfflineCustomerActivation(config, process.cwd());

const installationId = (
  await readFile(path.resolve(config.installationIdFile), "utf8")
).trim();
const installationPublicKey = (
  await readFile(path.resolve(config.installationPublicKeyFile), "utf8")
).trim();
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

const activation = await agent.activateCopyFollower(
  requiredString(config.requestedSizingMode, "requestedSizingMode"),
);

if (!activation.ok) {
  console.error(JSON.stringify(activation, null, 2));
  process.exitCode = 2;
  process.exit(2);
}

console.log(
  JSON.stringify(
    {
      event: "COPY_FOLLOWER_ACTIVATED",
      productMode: activation.productMode,
      decision: activation.decision,
    },
    null,
    2,
  ),
);

if (commandsFilePath) {
  const bundle = JSON.parse(await readFile(commandsFilePath, "utf8"));
  const licenseId = requiredString(bundle.licenseId, "licenseId");
  const trustedEntries = Object.entries(bundle.trustedSigningPublicKeys || {});
  if (trustedEntries.length === 0) {
    throw new Error("TRUSTED_SIGNING_PUBLIC_KEYS_REQUIRED");
  }
  const verifier = new CustomerCopyCommandVerifier(
    {
      licenseId,
      installationId,
      mt5Login,
      brokerServer: requiredString(config.brokerServer, "brokerServer"),
      allowedSymbols: Array.isArray(bundle.allowedSymbols) && bundle.allowedSymbols.length > 0
        ? bundle.allowedSymbols
        : ["XAUUSD"],
    },
    new Map(trustedEntries),
    { now: () => Date.now() },
  );

  const simulatedBridge = {
    async health() {
      return {
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
        accountLogin: mt5Login,
        server: config.brokerServer,
      };
    },
    async quote() {
      return { bid: 2400.0, ask: 2400.5 };
    },
    async placeOrder(req) {
      return {
        accepted: true,
        status: "SIMULATED_FILLED",
        ticket: `SIM-${req.clientOrderId}`,
      };
    },
    async modifyPosition() {
      return { success: true };
    },
    async closePosition() {
      return { success: true };
    },
    async openPositions() {
      return [];
    },
  };

  const executor = new CustomerMt5FollowerExecutor(
    simulatedBridge,
    new InMemoryCustomerFollowerPositionRegistry(),
    {
      expectedMt5Login: mt5Login,
      expectedBrokerServer: config.brokerServer,
    },
  );
  const adapter = new CustomerFollowerExecutionAdapter(executor);

  for (const command of Array.isArray(bundle.commands) ? bundle.commands : []) {
    const verified = verifier.accept(command);
    if (!verified.ok) {
      console.error(JSON.stringify({ event: "COMMAND_REJECTED", code: verified.code }));
      process.exitCode = 2;
      break;
    }
    const dispatched = await adapter.dispatch(verified);
    console.log(JSON.stringify({ event: "COMMAND_PROCESSED", result: dispatched }));
  }
}
