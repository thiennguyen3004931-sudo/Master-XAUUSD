import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptsDir);
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");

const options = parseArgs(process.argv.slice(2));
const accountMode = String(options.accountMode ?? "LIVE").trim().toUpperCase();
if (!new Set(["LIVE", "DEMO"]).has(accountMode)) {
  throw new Error(`Invalid --account-mode ${options.accountMode}; expected LIVE or DEMO.`);
}
if (!options.dryRun && !options.confirmNotificationOnly) {
  throw new Error(
    "Explicit --confirm-notification-only is required. This harness sends Telegram notifications only and never sends broker orders.",
  );
}

const envFile = path.resolve(
  options.envFile ?? path.join(projectRoot, ".env.phase7b-telegram"),
);
const dotenv = readDotEnv(envFile);
const tradeToken = firstConfigured(dotenv, [
  "ZIQ_TELEGRAM_TRADE_BOT_TOKEN",
  "ZIQ_TELEGRAM_BOT_TOKEN",
]);
const tradeChatId = firstConfigured(dotenv, [
  "ZIQ_TELEGRAM_TRADE_CHAT_ID",
  "ZIQ_TELEGRAM_CHAT_ID",
]);
const fallbackToken = firstConfigured(dotenv, [
  "ZIQ_TELEGRAM_BOT_TOKEN",
  "ZIQ_TELEGRAM_TRADE_BOT_TOKEN",
]);
const fallbackChatId = firstConfigured(dotenv, [
  "ZIQ_TELEGRAM_CHAT_ID",
  "ZIQ_TELEGRAM_TRADE_CHAT_ID",
]);

if (!tradeToken || !fallbackToken) {
  throw new Error("Telegram trade/fallback bot token is missing/not configured.");
}
if (!tradeChatId || !fallbackChatId) {
  throw new Error("Telegram trade/fallback chat ID is missing/not configured.");
}

const symbol = String(dotenv.ZIQ_TELEGRAM_SYMBOL || "XAUUSD").trim() || "XAUUSD";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-sideway-production-telegram-sample-"));
const trendJournalPath = path.join(tempDir, "trend-events.jsonl");
const sidewayJournalPath = path.join(tempDir, "sideway-events.jsonl");
const statePath = path.join(tempDir, "telegram-state.json");
const sinkPath = path.resolve(options.sink ?? path.join(tempDir, "notifications.jsonl"));

const ticket = "SIDEWAY-PRODUCTION-SAMPLE-1";
const openedAt = "2026-08-27T04:00:00.000Z";
const closedAt = "2026-08-27T04:05:00.000Z";
const partialAt = "2026-08-27T04:02:00.000Z";
const events = buildSidewayLifecycle({ ticket, openedAt, closedAt });
const canonicalDeals = [
  {
    ticket: "SIDEWAY-PRODUCTION-PARTIAL-DEAL-1",
    positionId: ticket,
    timestamp: Date.parse(partialAt),
    volume: 0.04,
    netPnl: 40,
  },
  {
    ticket: "SIDEWAY-PRODUCTION-EXIT-DEAL-1",
    positionId: ticket,
    timestamp: Date.parse(closedAt),
    volume: 0.08,
    netPnl: 120,
  },
];
fs.writeFileSync(trendJournalPath, "", "utf8");
fs.writeFileSync(
  sidewayJournalPath,
  events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  "utf8",
);

let snapshotCalls = 0;
const monitorServer = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/api/v1/phase7b-demo") {
    snapshotCalls += 1;
    const atPlus10 = snapshotCalls >= 2;
    sendJson(response, 200, {
      mt5: {
        reachable: true,
        managedPosition: {
          ticket,
          entry: 4700,
          stopLoss: 4700,
          volume: atPlus10 ? 0.08 : 0.12,
          profit: atPlus10 ? 80 : 72,
        },
        quote: {
          bid: atPlus10 ? 4710 : 4706,
          ask: atPlus10 ? 4710.2 : 4706.2,
        },
        spec: {
          tickSize: 0.01,
          effectiveTickValuePerLot: 1,
        },
      },
      state: {
        managed: {
          ticket,
          side: "BUY",
          entry: 4700,
          expectedRemainingVolume: atPlus10 ? 0.08 : 0.12,
          lastStructuralStop: 4700,
        },
      },
    });
    return;
  }

  if (url.pathname === "/api/v1/mt5/performance") {
    sendJson(response, 200, {
      trades: [
        {
          id: `SYSTEM-${ticket}`,
          ownership: "SYSTEM",
          side: "BUY",
          entry: 4700,
          exit: 4720,
          netPnl: 999.99,
          closedAt: Date.parse(closedAt),
        },
      ],
    });
    return;
  }

  if (url.pathname === "/api/v1/phase7c-canonical-ledger/position-realized") {
    const requestedPositionId = String(url.searchParams.get("positionId") ?? "");
    if (requestedPositionId !== ticket) {
      sendJson(response, 404, { error: "POSITION_NOT_FOUND" });
      return;
    }

    const fromMs = Number(url.searchParams.get("fromMs"));
    const toMs = Number(url.searchParams.get("toMs"));
    const deals = canonicalDeals.filter((deal) =>
      (!Number.isFinite(fromMs) || deal.timestamp >= fromMs) &&
      (!Number.isFinite(toMs) || deal.timestamp <= toMs),
    );

    sendJson(response, 200, {
      positionId: ticket,
      realizedNetPnl: deals.reduce((sum, deal) => sum + deal.netPnl, 0),
      dealCount: deals.length,
      deals,
    });
    return;
  }

  sendJson(response, 404, { error: "NOT_FOUND" });
});

await new Promise((resolve, reject) => {
  monitorServer.once("error", reject);
  monitorServer.listen(0, "127.0.0.1", resolve);
});

const address = monitorServer.address();
if (!address || typeof address === "string") {
  monitorServer.close();
  throw new Error("Unable to allocate local monitor fixture port.");
}
const monitorApiBase = `http://127.0.0.1:${address.port}`;

console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE=START");
console.log(`SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_SYMBOL=${symbol}`);
console.log(`SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_ACCOUNT_MODE=${accountMode}`);
console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_CHANNEL=TRADE_WITH_FALLBACK");
console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_PRODUCTION_NOTIFIER=True");
console.log(`SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_DRY_RUN=${options.dryRun ? "True" : "False"}`);
console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_TOKEN=CONFIGURED_NOT_PRINTED");
console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_CHAT_ID=CONFIGURED_NOT_PRINTED");

try {
  const childEnv = {
    ...process.env,
    ...dotenv,
    ZIQ_TELEGRAM_BOT_TOKEN: fallbackToken,
    ZIQ_TELEGRAM_CHAT_ID: fallbackChatId,
    ZIQ_TELEGRAM_TRADE_BOT_TOKEN: tradeToken,
    ZIQ_TELEGRAM_TRADE_CHAT_ID: tradeChatId,
    ZIQ_TELEGRAM_JOURNAL_PATH: trendJournalPath,
    ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: sidewayJournalPath,
    ZIQ_TELEGRAM_STATE_PATH: statePath,
    ZIQ_TELEGRAM_SYMBOL: symbol,
    ZIQ_PHASE7C_ACCOUNT_MODE: accountMode,
    ZIQ_TELEGRAM_MONITOR_API_URL: monitorApiBase,
    ZIQ_TELEGRAM_REPLAY_EXISTING: "true",
    ZIQ_TELEGRAM_SEND_STARTUP: "false",
    ZIQ_TELEGRAM_ONCE: "true",
    ZIQ_TELEGRAM_INTERVAL_MS: "1000",
    ZIQ_TELEGRAM_DRY_RUN: options.dryRun ? "true" : "false",
    ...(options.dryRun ? { ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath } : {}),
  };

  const result = await spawnNotifier(childEnv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.code !== 0) {
    throw new Error(`Production Telegram notifier exited with code ${result.code}.`);
  }

  if (options.dryRun) {
    if (!fs.existsSync(sinkPath)) {
      throw new Error(`Notifier dry-run sink was not created: ${sinkPath}`);
    }
    const sent = fs
      .readFileSync(sinkPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean).length;
    if (sent !== 6) {
      throw new Error(`Expected 6 production-format Sideway cards, got ${sent}.`);
    }
    console.log(`SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_SINK=${sinkPath}`);
  }

  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_TOTAL=6");
  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_BROKER_ORDER_SEND=False");
  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_POSITION_MUTATION=False");
  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_ACCOUNT_SWITCH=False");
  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_BOT_MODE_MUTATION=False");
  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_LIVE_ARM_MUTATION=False");
  console.log("SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE=PASS");
} finally {
  await new Promise((resolve) => monitorServer.close(resolve));
  if (!options.keepTemp) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildSidewayLifecycle({ ticket, openedAt, closedAt }) {
  return [
    {
      type: "ENTRY_SUBMIT",
      timestamp: openedAt,
      ticket,
      side: "BUY",
      confirmation: "M5_BULLISH_REJECTION",
      marketEntry: 4700,
      signalEntry: 4700,
      stopLoss: 4692,
      stopDistance: 8,
      volume: 0.12,
      plan: {
        entry: 4700,
        stopLoss: 4692,
        stopDistance: 8,
        tp1: 4710,
        takeProfit: 4720,
      },
    },
    {
      type: "ENTRY_FILLED",
      timestamp: "2026-08-27T04:00:01.000Z",
      ticket,
      side: "BUY",
      fillPrice: 4700,
      position: {
        ticket,
        side: "LONG",
        entry: 4700,
        stopLoss: 4692,
        takeProfit: 4720,
        volume: 0.12,
      },
      management: {
        side: "BUY",
        entry: 4700,
        initialVolume: 0.12,
        expectedRemainingVolume: 0.12,
        stopLoss: 4692,
        tp1: 4710,
        tp1Kind: "FIXED_PLUS_10",
        tp2: 4720,
        breakEvenApplied: false,
        partialApplied: false,
        dailyMode: "NORMAL",
      },
    },
    {
      type: "PLUS6_SL_TO_ENTRY",
      timestamp: "2026-08-27T04:01:00.000Z",
      ticket,
      side: "BUY",
      favorable: 6,
      stopLoss: 4700,
    },
    {
      type: "PLUS10_PARTIAL_ONE_THIRD",
      timestamp: partialAt,
      ticket,
      side: "BUY",
      favorable: 10,
      stopLoss: 4700,
      closedVolume: 0.04,
      remainingVolume: 0.08,
    },
    {
      type: "HOLD_POSITION",
      timestamp: "2026-08-27T04:03:00.000Z",
      ticket,
      side: "BUY",
      dailyMode: "NORMAL",
    },
    {
      type: "POSITION_CLOSED",
      timestamp: closedAt,
      ticket,
      side: "BUY",
      reason: "TP2_OPPOSITE_RANGE",
    },
  ];
}

function spawnNotifier(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [notifierPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Production Telegram notifier sample timed out."));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Telegram env file not found: ${filePath}`);
  }
  const config = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = String(raw).trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim().replace(/^\uFEFF/, "");
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    config[key] = value;
  }
  return config;
}

function firstConfigured(config, names) {
  for (const name of names) {
    const value = String(config[name] ?? "").trim();
    if (value && !value.includes("REPLACE_WITH")) return value;
  }
  return "";
}

function sendJson(response, statusCode, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    confirmNotificationOnly: false,
    keepTemp: false,
    accountMode: "LIVE",
    envFile: null,
    sink: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--confirm-notification-only") {
      parsed.confirmNotificationOnly = true;
    } else if (arg === "--keep-temp") {
      parsed.keepTemp = true;
    } else if (arg === "--account-mode") {
      parsed.accountMode = args[++index];
    } else if (arg === "--env-file") {
      parsed.envFile = args[++index];
    } else if (arg === "--sink") {
      parsed.sink = args[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}