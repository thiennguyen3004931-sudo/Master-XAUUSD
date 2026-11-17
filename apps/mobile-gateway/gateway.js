"use strict";

const fs = require("node:fs");
const { URL } = require("node:url");
const { createMobileGatewayServer } = require("./server.cjs");
const { createCanonicalClient } = require("./canonical-client.cjs");
const { createTransactionStore } = require("./transaction-store.cjs");
const { createAuditSink } = require("./audit.cjs");
const { createM4ActionBroker } = require("./m4-action-broker.cjs");

const CONFIG_PATH = process.env.XAUUSD_MOBILE_GATEWAY_CONFIG ||
  "C:\\ProgramData\\XAUUSD-AI-MASTER\\mobile-readonly-gateway\\gateway.config.json";

function validateProductionConfig(config) {
  if (!config || typeof config !== "object") throw new Error("GATEWAY_CONFIG_REQUIRED");
  if (config.listenHost !== "127.0.0.1") throw new Error("GATEWAY_LISTEN_HOST_MUST_BE_LOOPBACK");
  if (!Number.isInteger(config.listenPort) || config.listenPort <= 0 || config.listenPort > 65535) {
    throw new Error("GATEWAY_LISTEN_PORT_INVALID");
  }
  if (config.webOrigin !== "http://127.0.0.1:5717") throw new Error("GATEWAY_WEB_ORIGIN_MUST_BE_LOOPBACK_5717");
  if (config.apiOrigin !== "http://127.0.0.1:3711") throw new Error("GATEWAY_API_ORIGIN_MUST_BE_LOOPBACK_3711");
  if (!Array.isArray(config.allowedUsers) || config.allowedUsers.length === 0) {
    throw new Error("GATEWAY_ALLOWED_USERS_REQUIRED");
  }
  const normalizedUsers = config.allowedUsers.map((value) => String(value ?? "").trim().toLowerCase());
  if (normalizedUsers.some((value) => !value || !value.includes("@"))) {
    throw new Error("GATEWAY_ALLOWED_USERS_INVALID");
  }
  let allowedOrigin;
  try {
    allowedOrigin = new URL(String(config.allowedOrigin ?? ""));
  } catch {
    throw new Error("GATEWAY_ALLOWED_ORIGIN_INVALID");
  }
  if (allowedOrigin.protocol !== "https:" || allowedOrigin.username || allowedOrigin.password) {
    throw new Error("GATEWAY_ALLOWED_ORIGIN_MUST_BE_HTTPS");
  }
  if (!config.auditPath || typeof config.auditPath !== "string") throw new Error("GATEWAY_AUDIT_PATH_REQUIRED");
  return {
    ...config,
    allowedUsers: normalizedUsers,
    allowedOrigin: allowedOrigin.origin,
  };
}

function loadConfig(filePath = CONFIG_PATH) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return validateProductionConfig(JSON.parse(raw));
}

function buildServer(config, { fetchImpl = fetch } = {}) {
  const canonical = createCanonicalClient({ apiOrigin: config.apiOrigin, fetchImpl });
  const transactions = createTransactionStore();
  const audit = createAuditSink({ auditPath: config.auditPath });
  const broker = createM4ActionBroker({ canonical, transactions, audit });
  return createMobileGatewayServer({ config, broker, fetchImpl });
}

function start() {
  const config = loadConfig();
  const server = buildServer(config);
  server.listen(config.listenPort, config.listenHost, () => {
    process.stdout.write(`MOBILE_GATEWAY_LISTENING=${config.listenHost}:${config.listenPort}\n`);
    process.stdout.write("MOBILE_GATEWAY_M4=ENABLED\n");
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { CONFIG_PATH, validateProductionConfig, loadConfig, buildServer, start };
