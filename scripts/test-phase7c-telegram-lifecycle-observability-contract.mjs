import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");

const HOLD_TREND = {
  reasonCode: "HOLD_TREND_STRUCTURE_INTACT",
  reason:
    "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
};

function json(response, body) {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function withMonitor(run, overrides = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/v1/phase7b-demo") {
      json(response, overrides.demo ?? {
        mt5: {
          managedPosition: {
            ticket: "TREND-LIFE-1",
            entry: 2311.25,
            stopLoss: 2311.25,
            volume: 0.06,
            profit: 9.75,
          },
          quote: {
            bid: 2322.25,
            ask: 2322.45,
          },
          spec: {
            tickSize: 0.01,
            effectiveTickValuePerLot: 1,
          },
        },
        state: {
          managed: {
            ticket: "TREND-LIFE-1",
            side: "BUY",
            entry: 2311.25,
            expectedRemainingVolume: 0.06,
            lastStructuralStop: 2311.25,
          },
        },
      });
      return;
    }

    if (url.pathname === "/api/v1/mt5/performance") {
      json(response, overrides.performance ?? { trades: [] });
      return;
    }

    if (url.pathname === "/api/v1/phase7c/daily-recovery") {
      json(response, overrides.dailyRecovery ?? {
        dailyNetPnl: 1,
        dailyMode: "NORMAL",
      });
      return;
    }

    if (url.pathname === "/api/v1/phase7c-canonical-ledger/position-realized") {
      const positionId = String(url.searchParams.get("positionId") ?? "");
      const snapshot = overrides.canonicalRealized?.[positionId] ?? null;
      if (snapshot) {
        json(response, snapshot);
        return;
      }
      response.statusCode = 404;
      response.end("canonical realized position not found");
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

async function runNotifier({
  events,
  source = "TREND",
  monitorApiBase,
  label,
  initialState = null,
}) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `phase7c-telegram-lifecycle-${label}-`),
  );
  const trendJournal = path.join(tempDir, "trend.jsonl");
  const sidewayJournal = path.join(tempDir, "sideway.jsonl");
  const statePath = path.join(tempDir, "state.json");
  const sinkPath = path.join(tempDir, "sink.jsonl");
  const serialized = events.map((event) => JSON.stringify(event)).join("\n") + "\n";

  fs.writeFileSync(trendJournal, source === "TREND" ? serialized : "", "utf8");
  fs.writeFileSync(sidewayJournal, source === "SIDEWAY" ? serialized : "", "utf8");
  if (initialState) {
    fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2) + "\n", "utf8");
  }

  const child = spawn(process.execPath, [notifierPath], {
    env: {
      ...process.env,
      ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
      ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
      ZIQ_TELEGRAM_JOURNAL_PATH: trendJournal,
      ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: sidewayJournal,
      ZIQ_TELEGRAM_STATE_PATH: statePath,
      ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
      ZIQ_PHASE7C_ACCOUNT_MODE: "DEMO",
      ZIQ_TELEGRAM_REPLAY_EXISTING: "true",
      ZIQ_TELEGRAM_SEND_STARTUP: "false",
      ZIQ_TELEGRAM_ONCE: "true",
      ZIQ_TELEGRAM_DRY_RUN: "true",
      ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath,
      ZIQ_TELEGRAM_MONITOR_API_URL: monitorApiBase,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(
    status,
    0,
    `notifier must exit cleanly\nstdout=${stdout}\nstderr=${stderr}`,
  );
  assert.match(
    stdout,
    /PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR/,
  );

  const notifications = fs.existsSync(sinkPath)
    ? fs.readFileSync(sinkPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    : [];

  return { notifications, stdout, stderr };
}

function assertCanonicalContext(text, {
  regime,
  ticket,
  entry,
  tp,
  lot,
}) {
  assert.match(text, new RegExp(`Regime[^\\n]*${regime}`, "i"));
  assert.match(text, new RegExp(`Ticket[^\\n]*${ticket}`, "i"));
  assert.match(text, new RegExp(`Entry[^\\n]*${entry}`, "i"));
  assert.match(text, /SL:/i);
  assert.match(text, new RegExp(`TP[^\\n]*${tp}`, "i"));
  assert.match(text, new RegExp(`Lot[^\\n]*(?:${lot})`, "i"));
}

test("Trend lifecycle keeps full context for lifecycle cards while HOLD and M5 structure stay compact", async () => {
  const partialTimestamp = "2026-08-29T06:17:00.000Z";
  const events = [
    {
      type: "ENTRY_FILLED",
      timestamp: "2026-08-29T06:00:00.000Z",
      signalEntry: 2300,
      position: {
        ticket: "TREND-LIFE-1",
        side: "LONG",
        entry: 2311.25,
        stopLoss: 2304.25,
        volume: 0.09,
      },
    },
    {
      type: "HOLD_POSITION",
      timestamp: "2026-08-29T06:15:00.000Z",
      m15CloseTime: Date.parse("2026-08-29T06:15:00.000Z"),
      ticket: "TREND-LIFE-1",
      side: "BUY",
      ...HOLD_TREND,
    },
    {
      type: "PLUS6_SL_TO_ENTRY",
      timestamp: "2026-08-29T06:16:00.000Z",
      ticket: "TREND-LIFE-1",
      side: "BUY",
      favorable: 6,
      stopLoss: 2311.25,
    },
    {
      type: "PLUS10_PARTIAL_ONE_THIRD",
      timestamp: partialTimestamp,
      ticket: "TREND-LIFE-1",
      side: "BUY",
      favorable: 10,
      stopLoss: 2311.25,
      closedVolume: 0.03,
      remainingVolume: 0.06,
    },
    {
      type: "M5_STRUCTURAL_SL_TIGHTEN",
      timestamp: "2026-08-29T06:30:00.000Z",
      ticket: "TREND-LIFE-1",
      side: "BUY",
      previousStopLoss: 2311.25,
      stopLoss: 2315.25,
      structurePrice: 2316.25,
      m5CloseTime: Date.parse("2026-08-29T06:30:00.000Z"),
    },
  ];

  const canonicalRealized = {
    "TREND-LIFE-1": {
      positionId: "TREND-LIFE-1",
      realizedNetPnl: 4.21,
      dealCount: 1,
      deals: [{
        ticket: "TREND-PARTIAL-DEAL-1",
        positionId: "TREND-LIFE-1",
        timestamp: Date.parse(partialTimestamp),
        volume: 0.03,
        netPnl: 4.21,
      }],
    },
  };

  const { notifications } = await withMonitor(
    (monitorApiBase) => runNotifier({ events, monitorApiBase, label: "trend-context" }),
    { canonicalRealized },
  );

  assert.equal(notifications.length, 5);
  for (const notification of notifications) {
    assert.equal(notification.route, "trade");
  }

  for (const index of [0, 2, 3]) {
    assertCanonicalContext(notifications[index].text, {
      regime: "TREND",
      ticket: "TREND-LIFE-1",
      entry: "2311.25",
      tp: "RUNNER M15",
      lot: notifications[index].text.includes("CHỐT 1/3") ? "0.06" : "0.09|0.06",
    });
  }

  const hold = notifications[1].text;
  assert.match(hold, /BUY · HOLD/);
  assert.match(hold, /TREND-LIFE-1/);
  assert.match(hold, new RegExp(HOLD_TREND.reason));
  assert.doesNotMatch(hold, /PHASE 7C ·/);
  assert.doesNotMatch(hold, /Regime:|Entry:|SL:|TP:|Lot:/);

  const structure = notifications[4].text;
  assert.match(structure, /BUY · SL → STRUCTURE M5/);
  assert.match(structure, /TREND-LIFE-1/);
  assert.match(structure, /2311\.25 → 2315\.25/);
  assert.match(structure, /Dời StopLoss theo cấu trúc M5 đã xác nhận/);
  assert.doesNotMatch(structure, /PHASE 7C ·/);
  assert.doesNotMatch(structure, /Regime:|Entry:|TP:|Lot:/);

  assert.doesNotMatch(notifications[0].text, /2300(?:\.00)?/);
  assert.match(notifications[3].text, /Realized P&L[^\n]*\+\$4\.21/i);
  assert.doesNotMatch(notifications[3].text, /≈/);
  assert.doesNotMatch(notifications[3].text, /đang chờ MT5 deal/i);
});

test("Sideway ENTRY and BE cards persist TP2 and remaining lifecycle context", async () => {
  const events = [
    {
      type: "ENTRY_FILLED",
      timestamp: "2026-08-29T07:00:00.000Z",
      signalEntry: 4698,
      position: {
        ticket: "SIDEWAY-LIFE-1",
        side: "LONG",
        entry: 4700.5,
        stopLoss: 4694.5,
        takeProfit: 4720.5,
        volume: 0.12,
      },
      management: {
        side: "BUY",
        entry: 4700.5,
        initialVolume: 0.12,
        expectedRemainingVolume: 0.12,
        stopLoss: 4694.5,
        tp1: 4710.5,
        tp2: 4720.5,
        dailyMode: "NORMAL",
      },
    },
    {
      type: "PLUS6_SL_TO_ENTRY",
      timestamp: "2026-08-29T07:01:00.000Z",
      ticket: "SIDEWAY-LIFE-1",
      side: "BUY",
      favorable: 6,
      stopLoss: 4700.5,
    },
  ];

  const demo = {
    mt5: {
      managedPosition: {
        ticket: "SIDEWAY-LIFE-1",
        entry: 4700.5,
        stopLoss: 4700.5,
        volume: 0.12,
        profit: 7.2,
      },
      quote: { bid: 4706.5, ask: 4706.7 },
      spec: { tickSize: 0.01, effectiveTickValuePerLot: 1 },
    },
    state: {
      managed: {
        ticket: "SIDEWAY-LIFE-1",
        side: "BUY",
        entry: 4700.5,
        expectedRemainingVolume: 0.12,
        lastStructuralStop: 4700.5,
      },
    },
  };

  const { notifications } = await withMonitor(
    (monitorApiBase) => runNotifier({
      events,
      source: "SIDEWAY",
      monitorApiBase,
      label: "sideway-context",
    }),
    { demo },
  );

  assert.equal(notifications.length, 2);
  for (const notification of notifications) {
    assertCanonicalContext(notification.text, {
      regime: "SIDEWAY",
      ticket: "SIDEWAY-LIFE-1",
      entry: "4700.50",
      tp: "4720.50",
      lot: "0.12",
    });
  }
  assert.doesNotMatch(notifications[0].text, /4698(?:\.00)?/);
});

test("Recovery ENTRY exposes adaptive TP through the same lifecycle context", async () => {
  const events = [{
    type: "ENTRY_FILLED",
    timestamp: "2026-08-29T08:00:00.000Z",
    position: {
      ticket: "RECOVERY-LIFE-1",
      side: "SHORT",
      entry: 4750.25,
      stopLoss: 4757.25,
      takeProfit: 4742.25,
      volume: 0.06,
    },
    management: {
      side: "SELL",
      entry: 4750.25,
      initialVolume: 0.06,
      expectedRemainingVolume: 0.06,
      stopLoss: 4757.25,
      dailyMode: "RECOVERY_TP",
      recoveryTpDistance: 8,
      recoveryTakeProfit: 4742.25,
    },
    dailyMode: "RECOVERY_TP",
    dailyNetPnlAtEntry: -5,
    recoveryTargetNetPnl: 1,
    recoveryTpDistance: 8,
    recoveryTakeProfit: 4742.25,
  }];

  const { notifications } = await withMonitor((monitorApiBase) =>
    runNotifier({ events, monitorApiBase, label: "recovery-context" }),
  );

  assert.equal(notifications.length, 1);
  assertCanonicalContext(notifications[0].text, {
    regime: "TREND",
    ticket: "RECOVERY-LIFE-1",
    entry: "4750.25",
    tp: "4742.25",
    lot: "0.06",
  });
  assert.match(notifications[0].text, /RECOVERY/i);
});

test("EXIT uses canonical realized netPnl and MT5 performance only for actual average exit", async () => {
  const exitTimestamp = "2026-08-29T09:04:00.000Z";
  const events = [
    {
      type: "ENTRY_FILLED",
      timestamp: "2026-08-29T09:00:00.000Z",
      position: {
        ticket: "EXIT-LIFE-1",
        side: "LONG",
        entry: 4800.25,
        stopLoss: 4794.25,
        volume: 0.09,
      },
    },
    {
      type: "EXIT_EXECUTED",
      timestamp: exitTimestamp,
      ticket: "EXIT-LIFE-1",
      side: "BUY",
      reason: "TREND_MA20",
    },
  ];

  const performance = {
    trades: [{
      id: "position-EXIT-LIFE-1",
      ownership: "SYSTEM",
      side: "BUY",
      entry: 4800.25,
      exit: 4812.75,
      netPnl: 999.99,
      closedAt: Date.parse(exitTimestamp),
    }],
  };
  const canonicalRealized = {
    "EXIT-LIFE-1": {
      positionId: "EXIT-LIFE-1",
      realizedNetPnl: 17.43,
      dealCount: 1,
      deals: [{
        ticket: "EXIT-DEAL-1",
        positionId: "EXIT-LIFE-1",
        timestamp: Date.parse(exitTimestamp),
        volume: 0.09,
        netPnl: 17.43,
      }],
    },
  };

  const { notifications } = await withMonitor(
    (monitorApiBase) => runNotifier({
      events,
      monitorApiBase,
      label: "exit-performance",
    }),
    { performance, canonicalRealized },
  );

  assert.equal(notifications.length, 2);
  const exit = notifications[1].text;
  assert.match(exit, /P&L[^\n]*\+\$17\.43/i);
  assert.doesNotMatch(exit, /999\.99/);
  assert.match(exit, /Exit[^\n]*4812\.75/i);
  assertCanonicalContext(exit, {
    regime: "TREND",
    ticket: "EXIT-LIFE-1",
    entry: "4800.25",
    tp: "RUNNER M15",
    lot: "0.09",
  });
  assert.doesNotMatch(exit, /đang đồng bộ MT5/i);
  assert.doesNotMatch(exit, /≈/);
});

test("runtime CYCLE_ERROR must not emit MT5 recovered when MT5 is healthy", async () => {
  const initialState = {
    version: 3,
    initialized: true,
    offset: 0,
    offsets: { trend: 0, sideway: 0 },
    sent: 0,
    lastEventAt: null,
    trade: null,
    hold: null,
    holdM15ByTicketReason: {},
    systemAlerts: {
      CYCLE_ERROR: {
        active: true,
        type: "CYCLE_ERROR",
        message: "readPhase7CReversalEntryContext is not defined",
        lastSeenAt: "2026-10-05T00:00:00.000Z",
        lastSeenAtMs: 1,
      },
    },
  };

  const demo = {
    mt5: {
      reachable: true,
      health: {
        accountMode: "live",
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
      },
      positions: [],
      managedPosition: null,
    },
    state: { managed: null },
  };

  const { notifications } = await withMonitor(
    (monitorApiBase) => runNotifier({
      events: [],
      monitorApiBase,
      label: "runtime-cycle-error-no-false-mt5-recovery",
      initialState,
    }),
    { demo },
  );

  assert.equal(
    notifications.some((notification) =>
      /Kết nối dữ liệu \/ MT5 đã phục hồi/i.test(notification.text)),
    false,
    "JavaScript/runtime CYCLE_ERROR must never be classified as MT5 recovery.",
  );
});


test("MT5 CYCLE_ERROR still emits MT5 recovered when MT5 is healthy", async () => {
  const initialState = {
    version: 3,
    initialized: true,
    offset: 0,
    offsets: { trend: 0, sideway: 0 },
    sent: 0,
    lastEventAt: null,
    trade: null,
    hold: null,
    holdM15ByTicketReason: {},
    systemAlerts: {
      CYCLE_ERROR: {
        active: true,
        type: "CYCLE_ERROR",
        message: "MT5 bridge GET /health | timeout=8000ms | attempts=2",
        lastSeenAt: "2026-10-05T00:00:00.000Z",
        lastSeenAtMs: 1,
      },
    },
  };

  const demo = {
    mt5: {
      reachable: true,
      health: {
        accountMode: "live",
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
      },
      positions: [],
      managedPosition: null,
    },
    state: { managed: null },
  };

  const { notifications } = await withMonitor(
    (monitorApiBase) => runNotifier({
      events: [],
      monitorApiBase,
      label: "mt5-cycle-error-recovery-preserved",
      initialState,
    }),
    { demo },
  );

  assert.equal(notifications.length, 1);
  assert.match(
    notifications[0].text,
    /Kết nối dữ liệu \/ MT5 đã phục hồi/i,
  );
});
