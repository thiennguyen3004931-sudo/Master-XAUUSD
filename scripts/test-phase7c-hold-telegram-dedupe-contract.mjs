import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir =
  path.dirname(fileURLToPath(import.meta.url));

const notifierPath =
  path.join(
    scriptsDir,
    "run-phase7b-telegram-notifier.mjs",
  );

const trendControllerPath =
  path.join(
    scriptsDir,
    "run-phase7b-demo-controller.ts",
  );

const sidewayControllerPath =
  path.join(
    scriptsDir,
    "run-phase7c-sideway-controller.mjs",
  );

const HOLD = Object.freeze({
  TREND: Object.freeze({
    code: "HOLD_TREND_STRUCTURE_INTACT",
    message:
      "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
  }),

  SIDEWAY: Object.freeze({
    code: "HOLD_SIDEWAY_RANGE_VALID",
    message:
      "GIỮ LỆNH: Biên sideway vẫn còn hiệu lực; tiếp tục giữ đến TP2 hoặc khi có điều kiện thoát.",
  }),

  RECOVERY: Object.freeze({
    code: "HOLD_RECOVERY_TP_ACTIVE",
    message:
      "GIỮ LỆNH: Recovery TP đang hoạt động; giữ toàn bộ vị thế đến Adaptive TP hoặc SL/BE.",
  }),
});

function holdEvent(
  ticket,
  contract,
  {
    timestamp =
      "2026-08-27T08:00:00.000Z",
    side = "BUY",
  } = {},
) {
  return {
    type: "HOLD_POSITION",
    timestamp,
    ticket,
    side,
    reasonCode: contract.code,
    reason: contract.message,
  };
}

function runNotifier({
  trendEvents = [],
  sidewayEvents = [],
  label,
}) {
  const tempDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `phase7c-hold-dedupe-${label}-`,
      ),
    );

  const trendJournal =
    path.join(
      tempDir,
      "trend-events.jsonl",
    );

  const sidewayJournal =
    path.join(
      tempDir,
      "sideway-events.jsonl",
    );

  const statePath =
    path.join(
      tempDir,
      "telegram-state.json",
    );

  const sinkPath =
    path.join(
      tempDir,
      "notifications.jsonl",
    );

  const writeJournal = (file, events) => {
    fs.writeFileSync(
      file,
      events.length
        ? events
            .map((event) =>
              JSON.stringify(event))
            .join("\n") + "\n"
        : "",
      "utf8",
    );
  };

  writeJournal(
    trendJournal,
    trendEvents,
  );

  writeJournal(
    sidewayJournal,
    sidewayEvents,
  );

  const result =
    spawnSync(
      process.execPath,
      [notifierPath],
      {
        env: {
          ...process.env,

          ZIQ_TELEGRAM_BOT_TOKEN:
            "synthetic-token-not-used",

          ZIQ_TELEGRAM_CHAT_ID:
            "synthetic-chat-not-used",

          ZIQ_TELEGRAM_JOURNAL_PATH:
            trendJournal,

          ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH:
            sidewayJournal,

          ZIQ_TELEGRAM_STATE_PATH:
            statePath,

          ZIQ_TELEGRAM_SYMBOL:
            "XAUUSD",

          ZIQ_PHASE7C_ACCOUNT_MODE:
            "DEMO",

          ZIQ_TELEGRAM_REPLAY_EXISTING:
            "true",

          ZIQ_TELEGRAM_SEND_STARTUP:
            "false",

          ZIQ_TELEGRAM_ONCE:
            "true",

          ZIQ_TELEGRAM_DRY_RUN:
            "true",

          ZIQ_TELEGRAM_DRY_RUN_SINK:
            sinkPath,

          ZIQ_TELEGRAM_MONITOR_API_URL:
            "http://127.0.0.1:9",
        },

        encoding: "utf8",
        timeout: 30_000,
      },
    );

  assert.equal(
    result.status,
    0,
    [
      "notifier synthetic process must exit cleanly",
      `stdout=${result.stdout}`,
      `stderr=${result.stderr}`,
    ].join("\n"),
  );

  assert.match(
    result.stdout,
    /PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR/,
  );

  const notifications =
    fs.existsSync(sinkPath)
      ? fs
          .readFileSync(
            sinkPath,
            "utf8",
          )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) =>
            JSON.parse(line))
      : [];

  const state =
    fs.existsSync(statePath)
      ? JSON.parse(
          fs.readFileSync(
            statePath,
            "utf8",
          ),
        )
      : null;

  return {
    notifications,
    state,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test(
  "Telegram dedupes same ticket plus same holdReasonCode exactly once",
  () => {
    const first =
      holdEvent(
        "TICKET-1",
        HOLD.TREND,
        {
          timestamp:
            "2026-08-27T08:00:00.000Z",
        },
      );

    const duplicate =
      holdEvent(
        "TICKET-1",
        HOLD.TREND,
        {
          timestamp:
            "2026-08-27T08:01:00.000Z",
        },
      );

    const {
      notifications,
      state,
    } = runNotifier({
      trendEvents: [
        first,
        duplicate,
      ],
      label: "same-ticket-same-code",
    });

    assert.equal(
      notifications.length,
      1,
    );

    assert.equal(
      notifications[0].route,
      "trade",
    );

    assert.ok(
      notifications[0]
        .text
        .includes(
          HOLD.TREND.message,
        ),
    );

    assert.equal(
      state?.hold?.reasonCode,
      HOLD.TREND.code,
    );

    assert.equal(
      state?.hold?.key,
      `TICKET-1|${HOLD.TREND.code}`,
    );
  },
);

test(
  "Telegram allows same ticket plus different holdReasonCode",
  () => {
    const { notifications } =
      runNotifier({
        trendEvents: [
          holdEvent(
            "TICKET-2",
            HOLD.TREND,
            {
              timestamp:
                "2026-08-27T08:00:00.000Z",
            },
          ),

          holdEvent(
            "TICKET-2",
            HOLD.RECOVERY,
            {
              timestamp:
                "2026-08-27T08:01:00.000Z",
            },
          ),
        ],

        label:
          "same-ticket-different-code",
      });

    assert.equal(
      notifications.length,
      2,
    );

    assert.ok(
      notifications[0]
        .text
        .includes(
          HOLD.TREND.message,
        ),
    );

    assert.ok(
      notifications[1]
        .text
        .includes(
          HOLD.RECOVERY.message,
        ),
    );
  },
);

test(
  "Telegram allows different tickets plus same holdReasonCode",
  () => {
    const { notifications } =
      runNotifier({
        trendEvents: [
          holdEvent(
            "TICKET-3A",
            HOLD.TREND,
          ),

          holdEvent(
            "TICKET-3B",
            HOLD.TREND,
            {
              timestamp:
                "2026-08-27T08:01:00.000Z",
            },
          ),
        ],

        label:
          "different-ticket-same-code",
      });

    assert.equal(
      notifications.length,
      2,
    );
  },
);

test(
  "Sideway Telegram receives exact canonical Vietnamese backend HOLD text",
  () => {
    const { notifications } =
      runNotifier({
        sidewayEvents: [
          holdEvent(
            "SIDEWAY-1",
            HOLD.SIDEWAY,
            {
              side: "SELL",
            },
          ),
        ],

        label:
          "sideway-canonical",
      });

    assert.equal(
      notifications.length,
      1,
    );

    assert.equal(
      notifications[0].route,
      "trade",
    );

    assert.ok(
      notifications[0]
        .text
        .includes(
          HOLD.SIDEWAY.message,
        ),
    );

    assert.doesNotMatch(
      notifications[0].text,
      /FVG cùng hướng/i,
    );
  },
);

function recoveryBlock(source) {
  const marker =
    'if (managed.dailyMode === "RECOVERY_TP") {';

  const start =
    source.indexOf(marker);

  assert.notEqual(
    start,
    -1,
    "RECOVERY_TP management guard must exist",
  );

  const openBrace =
    source.indexOf("{", start);

  assert.notEqual(
    openBrace,
    -1,
    "RECOVERY_TP guard opening brace must exist",
  );

  let depth = 0;
  let end = -1;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  assert.notEqual(
    end,
    -1,
    "RECOVERY_TP management guard must close",
  );

  const block = source.slice(start, end);
  assert.match(
    block,
    /return;/,
    "RECOVERY_TP guard must retain its management return",
  );
  return block;
}

test(
  "Trend controller emits Recovery HOLD observability before RECOVERY_TP return",
  () => {
    const source =
      fs.readFileSync(
        trendControllerPath,
        "utf8",
      );

    const block =
      recoveryBlock(source);

    assert.match(
      block,
      /HOLD_POSITION/,
    );
  },
);

test(
  "Sideway controller emits Recovery HOLD observability before RECOVERY_TP return",
  () => {
    const source =
      fs.readFileSync(
        sidewayControllerPath,
        "utf8",
      );

    const block =
      recoveryBlock(source);

    assert.match(
      block,
      /HOLD_POSITION/,
    );
  },
);

test(
  "Sideway normal management emits canonical HOLD observability outside Recovery guard",
  () => {
    const source =
      fs.readFileSync(
        sidewayControllerPath,
        "utf8",
      );

    const manageStart =
      source.indexOf(
        "async function managePosition(",
      );

    const manageEnd =
      source.indexOf(
        "\nasync function closeAll",
        manageStart,
      );

    assert.notEqual(
      manageStart,
      -1,
    );

    assert.notEqual(
      manageEnd,
      -1,
    );

    const body =
      source.slice(
        manageStart,
        manageEnd,
      );

    const recovery =
      recoveryBlock(body);

    const normalBody =
      body.replace(
        recovery,
        "",
      );

    assert.match(
      normalBody,
      /HOLD_POSITION/,
    );
  },
);

test(
  "Trend FVG hold raw journal is wired to canonical HOLD metadata",
  () => {
    const source =
      fs.readFileSync(
        trendControllerPath,
        "utf8",
      );

    const marker =
      'journal("FVG_HOLD_CONFIRMED", {';

    const start =
      source.indexOf(marker);

    assert.notEqual(
      start,
      -1,
    );

    const end =
      source.indexOf(
        "});",
        start,
      );

    assert.notEqual(
      end,
      -1,
    );

    const block =
      source.slice(
        start,
        end + 3,
      );

    assert.match(
      block,
      /reasonCode|canonicalHold/i,
    );

    assert.match(
      block,
      /reason|canonicalHold/i,
    );
  },
);
test(
  "Trend normal management emits canonical HOLD_POSITION outside Recovery guard",
  () => {
    const source =
      fs.readFileSync(
        trendControllerPath,
        "utf8",
      );

    const manageStart =
      source.indexOf(
        "async function managePosition(",
      );

    const manageEnd =
      source.indexOf(
        "\nasync function closeAll",
        manageStart,
      );

    assert.notEqual(
      manageStart,
      -1,
    );

    assert.notEqual(
      manageEnd,
      -1,
    );

    const body =
      source.slice(
        manageStart,
        manageEnd,
      );

    const recovery =
      recoveryBlock(body);

    const normalBody =
      body.replace(
        recovery,
        "",
      );

    assert.match(
      normalBody,
      /journal\("HOLD_POSITION"/,
      "Normal Trend management must emit canonical HOLD_POSITION independently of FVG confirmation",
    );
  },
);