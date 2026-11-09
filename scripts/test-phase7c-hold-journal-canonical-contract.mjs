import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  __test as auditTest,
} from "./phase7c-decision-audit.mjs";

const scriptsDir =
  path.dirname(fileURLToPath(import.meta.url));

const projectRoot =
  path.resolve(scriptsDir, "..");

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

function normalize(
  strategy,
  event = "HOLD_POSITION",
  payload = {},
) {
  return auditTest.normalizeRecord(
    strategy,
    "XAUUSD",
    {},
    event,
    payload,
  );
}

test(
  "Trend HOLD_POSITION journal is MANAGING with exact canonical code and message",
  () => {
    const row = normalize(
      "TREND",
      "HOLD_POSITION",
      {
        ticket: "TREND-1",
        side: "BUY",
      },
    );

    assert.equal(row.stage, "MANAGING");
    assert.equal(
      row.reasonCode,
      HOLD.TREND.code,
    );
    assert.equal(
      row.reason,
      HOLD.TREND.message,
    );
  },
);

test(
  "Sideway HOLD_POSITION journal has exact canonical code and message",
  () => {
    const row = normalize(
      "SIDEWAY",
      "HOLD_POSITION",
      {
        ticket: "SIDEWAY-1",
        side: "SELL",
      },
    );

    assert.equal(row.stage, "MANAGING");
    assert.equal(
      row.reasonCode,
      HOLD.SIDEWAY.code,
    );
    assert.equal(
      row.reason,
      HOLD.SIDEWAY.message,
    );
  },
);

test(
  "Recovery TP overrides Trend journal HOLD",
  () => {
    const row = normalize(
      "TREND",
      "HOLD_POSITION",
      {
        ticket: "TREND-RECOVERY-1",
        side: "BUY",
        dailyMode: "RECOVERY_TP",
      },
    );

    assert.equal(
      row.reasonCode,
      HOLD.RECOVERY.code,
    );
    assert.equal(
      row.reason,
      HOLD.RECOVERY.message,
    );
  },
);

test(
  "Recovery TP overrides Sideway journal HOLD",
  () => {
    const row = normalize(
      "SIDEWAY",
      "HOLD_POSITION",
      {
        ticket: "SIDEWAY-RECOVERY-1",
        side: "SELL",
        dailyMode: "RECOVERY_TP",
      },
    );

    assert.equal(
      row.reasonCode,
      HOLD.RECOVERY.code,
    );
    assert.equal(
      row.reason,
      HOLD.RECOVERY.message,
    );
  },
);

test(
  "existing Trend FVG hold event normalizes to canonical Trend HOLD",
  () => {
    const row = normalize(
      "TREND",
      "FVG_HOLD_CONFIRMED",
      {
        ticket: "TREND-FVG-1",
        side: "BUY",
        m15CloseTime: 123,
      },
    );

    assert.equal(
      row.reasonCode,
      HOLD.TREND.code,
    );
    assert.equal(
      row.reason,
      HOLD.TREND.message,
    );
  },
);

test(
  "canonical Vietnamese HOLD literals have one production source only",
  () => {
    const candidates = [
      path.join(
        projectRoot,
        "apps",
        "api",
        "src",
        "services",
        "phase7c-decision-monitor.service.ts",
      ),
      path.join(
        scriptsDir,
        "phase7c-decision-audit.mjs",
      ),
      path.join(
        scriptsDir,
        "run-phase7b-telegram-notifier.mjs",
      ),
      path.join(
        scriptsDir,
        "run-phase7b-demo-controller.ts",
      ),
      path.join(
        scriptsDir,
        "run-phase7c-sideway-controller.mjs",
      ),

      // GREEN implementation may move the source here.
      path.join(
        scriptsDir,
        "phase7c-hold-observability.mjs",
      ),
    ].filter((file) => fs.existsSync(file));

    const productionText =
      candidates
        .map((file) =>
          fs.readFileSync(file, "utf8"))
        .join("\n");

    for (const contract of [
      HOLD.TREND,
      HOLD.SIDEWAY,
      HOLD.RECOVERY,
    ]) {
      const messageCount =
        productionText
          .split(contract.message)
          .length - 1;

      assert.equal(
        messageCount,
        1,
        `${contract.code} Vietnamese message must have one production source`,
      );
    }
  },
);