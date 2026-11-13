import type { getPhase7CDecisionMonitor } from "./phase7c-decision-monitor.service";

type Snapshot = Awaited<ReturnType<typeof getPhase7CDecisionMonitor>>;
export type Phase7CUiState = "WAITING" | "SETUP_READY" | "MANAGING";
export type Phase7CUiGate = "ALLOWED" | "BLOCKED_BY_MODE" | "BLOCKED_BY_REGIME" | "PENDING";
export type Phase7CEntryCheckStatus = "PASS" | "FAIL" | "WAIT" | "BLOCKED" | "IGNORED";

export interface Phase7CEntryCheck {
  code: string;
  label: string;
  status: Phase7CEntryCheckStatus;
  actual: string;
  required: string;
  reason: string;
}

export interface Phase7CUiContract {
  version: 2;
  generatedAt: number;
  symbol: string;
  uiState: Phase7CUiState;
  mode: string;
  effectiveStrategy: string | null;
  regime: string;
  confidence: number | null;
  stage: string;
  approved: boolean;
  recommendedMode: string;
  reasons: {
    auto: string[];
    trendWait: string[];
    sidewayWait: string[];
    wait: string[];
    entry: string[];
    hold: string[];
    stopMove: string[];
    partial: string[];
    exit: string[];
  };
  entryChecks: {
    trend: Phase7CEntryCheck[];
    sideway: Phase7CEntryCheck[];
  };
  gates: {
    trend: Phase7CUiGate;
    sideway: Phase7CUiGate;
    reversalFilter: "BLOCKING" | "CLEAR";
  };
  status: {
    mt5Connected: boolean;
    accountGuardValid: boolean;
    trendOn: boolean;
    sidewayOn: boolean;
  };
  setup: null | {
    strategy: string | null;
    side: string | null;
    name: string | null;
    entry: number | null;
    stopLoss: number | null;
    tp1: number | null;
    tp2: number | null;
    finalLot: number | null;
    estimatedRiskPercent: number | null;
  };
  position: null | {
    state: string;
    count: number;
    strategy: string | null;
    ticket: string | null;
    side: string | null;
    volume: number | null;
    entry: number | null;
    stopLoss: number | null;
    tp1: number | null;
    tp2: number | null;
    floatingPnlUsd: number | null;
    floatingPnlPercent: number | null;
  };
  safety: {
    accountMode: "DEMO" | "LIVE";
    demoOnly: boolean;
    readOnly: true;
    orderPermission: "NONE";
    newPositionsOnly: true;
    martingale: false;
    recoveryLotEscalation: false;
  };
}

function normalizeReason(value: unknown): string {
  let text = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/A confirmed CHOCH indicates a possible structural reversal\.?/gi, "CHOCH xác nhận khả năng đảo chiều cấu trúc.")
    .replace(/Bollinger bandwidth is\s*/gi, "Bollinger bandwidth: ")
    .replace(/PAUSE chặn mọi lệnh mới; không thay đổi vị thế đang được quản lý\.?/gi, "PAUSE chặn lệnh mới.")
    .replace(/No valid setup/gi, "Chưa có setup hợp lệ")
    .replace(/ENTRY_MODE_BLOCK:\s*/gi, "")
    .replace(/PAUSE_MODE_BLOCKS_NEW_ENTRY/gi, "Bot đang PAUSE; không mở lệnh mới.");
  return text.trim();
}

function isTradingReason(value: string): boolean {
  if (!value) return false;
  return !/(fixed lot|martingale|recovery lot|lot escalation|broker clock|clock offset|position sizing|sizing|lot cap|cap .*lot|configured lot)/i.test(value);
}

function isExpectedEntryBlockedReason(value: unknown): boolean {
  const text = String(value ?? "");
  return /\bPHASE7C_(?:TREND|SIDEWAY)_ENTRY_BLOCKED\b/i.test(text);
}

function pushUnique(target: string[], raw: unknown, max = 4) {
  if (target.length >= max) return;

  // These canonical bridge responses mean the entry gate intentionally
  // rejected a submit attempt. Mode/regime/checklist already explains the
  // blocker, so do not surface the raw HTTP/JSON response as a cycle error.
  // Unknown HTTP 423 and real transport/server errors remain visible.
  if (isExpectedEntryBlockedReason(raw)) return;

  const reason = normalizeReason(raw);
  if (!reason || !isTradingReason(reason)) return;
  const key = reason.toLocaleLowerCase("vi-VN");
  if (target.some((item) => item.toLocaleLowerCase("vi-VN") === key)) return;
  target.push(reason);
}

function uiState(snapshot: Snapshot): Phase7CUiState {
  if (
    snapshot.position.count > 0 ||
    snapshot.position.state === "MANAGING" ||
    snapshot.position.state === "UNMANAGED"
  ) return "MANAGING";
  if (
    snapshot.preTrade.approved &&
    snapshot.preTrade.entry !== null &&
    snapshot.preTrade.stopLoss !== null
  ) return "SETUP_READY";
  return "WAITING";
}

function gateFor(snapshot: Snapshot, strategy: "TREND" | "SIDEWAY"): Phase7CUiGate {
  if (snapshot.mode.active === "PAUSE") return "BLOCKED_BY_MODE";
  if (snapshot.mode.active === strategy) return "ALLOWED";
  if (snapshot.mode.active === "AUTO") {
    return snapshot.mode.effectiveStrategy === strategy ? "ALLOWED" : "BLOCKED_BY_REGIME";
  }
  return "BLOCKED_BY_MODE";
}

function autoReasons(snapshot: Snapshot): string[] {
  const reasons: string[] = [];
  if (snapshot.mode.active === "AUTO") {
    const confidence = Number.isFinite(Number(snapshot.engine.confidence))
      ? ` (${Number(snapshot.engine.confidence)}%)`
      : "";
    const recommendation = snapshot.engine.recommendedMode;
    const effectiveStrategy = snapshot.mode.effectiveStrategy;
    pushUnique(
      reasons,
      effectiveStrategy !== recommendation
        ? `AUTO: regime ${snapshot.engine.regime}${confidence} → khuyến nghị ${recommendation}; strategy hiệu lực ${effectiveStrategy}.`
        : `AUTO: regime ${snapshot.engine.regime}${confidence} → chọn ${recommendation}.`,
    );
    for (const reason of snapshot.engine.reasons) pushUnique(reasons, reason);
  } else if (snapshot.mode.active === "SEMI") {
    pushUnique(reasons, "SEMI: chỉ vào lệnh thủ công; Trend/Sideway không được tạo entry mới. MANUAL_SEMI đã PROTECTED/MANAGED được quản lý theo Trend.");
  } else {
    pushUnique(reasons, `Bot đang ở chế độ ${snapshot.mode.active}; AUTO không quyết định strategy lúc này.`);
  }
  return reasons.slice(0, 4);
}

function canonicalEntryWaitReason(strategy: "TREND" | "SIDEWAY", event: string, rawReason: unknown): string {
  const upper = event.toUpperCase();

  if (upper === "CYCLE_ERROR") {
    return `${strategy}: chưa lấy được dữ liệu trong chu kỳ gần nhất; bot đang chờ dữ liệu mới.`;
  }

  if (strategy === "TREND") {
    if (upper === "M15_NO_ENTRY_SIGNAL") return "Trend: chưa xuất hiện một trong 3 mẫu nến M15 hợp lệ để xét entry.";
    if (upper === "WAIT_PULLBACK" || upper === "ENTRY_DISTANCE_REGRESSION_WAIT") return "Trend: SL cấu trúc đang lớn hơn 10 giá; chờ pullback để SL trở về vùng 6–10 giá.";
    if (upper.includes("SUPERTREND")) return "Trend: Supertrend M15/M5 chưa cùng hướng với tín hiệu.";
    if (upper === "SIGNAL_EXPIRED") return "Trend: tín hiệu đã hết cửa sổ chờ; đợi setup M15 mới.";
    if (upper.includes("BROKER_DISTANCE")) return "Trend: khoảng SL chưa đáp ứng giới hạn broker; chưa gửi lệnh.";
    if (upper === "ENTRY_MODE_BLOCK") return "Trend: mode hiện tại chưa cho phép Trend mở lệnh mới.";
  } else {
    if (upper === "ENTRY_MODE_BLOCK") return "Sideway: mode/AUTO gate hiện tại chưa cho phép Sideway mở lệnh mới.";
    if (upper === "ENTRY_REGIME_BLOCK") return "Sideway: chỉ xét entry khi regime là RANGING, recommended mode là SIDEWAY và confidence đạt ngưỡng.";
    if (upper === "ENTRY_LOCATION_BLOCK") return "Sideway: giá chưa ở vùng demand/supply đủ gần; giữa range không vào lệnh.";
    if (upper === "ENTRY_M5_CONFIRMATION_BLOCK") return "Sideway: chưa có xác nhận M5 hợp lệ tại vùng vào lệnh.";
    if (upper === "ENTRY_PLAN_BLOCK" || upper === "ENTRY_FINAL_PLAN_BLOCK") return "Sideway: kế hoạch entry chưa đạt điều kiện SL 6–10, TP sau +10 và RR tối thiểu.";
    if (upper === "ENTRY_SPREAD_BLOCK") return "Sideway: spread hiện tại vượt giới hạn cho phép.";
    if (upper.includes("FRESHNESS")) return "Sideway: dữ liệu quote/M5/M15 chưa đủ mới; fail-closed và chờ dữ liệu mới.";
    if (upper === "ENTRY_AUTO_LOT_BLOCK") return "Sideway: Auto Lot snapshot chưa hợp lệ; không gửi lệnh.";
    if (upper === "ENTRY_FINAL_GATE_BLOCK") return "Sideway: final gate thay đổi ngay trước order; setup bị chặn và phải đánh giá lại.";
  }
  return normalizeReason(rawReason || event);
}

function strategyWaitReasons(snapshot: Snapshot, strategy: "TREND" | "SIDEWAY"): string[] {
  const reasons: string[] = [];
  const gate = gateFor(snapshot, strategy);
  if (gate === "BLOCKED_BY_MODE") {
    pushUnique(reasons, `${strategy}: bot mode ${snapshot.mode.active} đang chặn entry mới.`);
  } else if (gate === "BLOCKED_BY_REGIME") {
    pushUnique(reasons, `${strategy}: AUTO hiện chưa chọn ${strategy}; strategy không được phép gửi entry.`);
  }

  for (const row of snapshot.recentDecisions) {
    if (row.strategy !== strategy) continue;
    const event = String(row.event ?? "");
    if (!event) continue;
    if (snapshot.generatedAt - Number(row.timestamp) > 30 * 60_000) continue;
    if (
      strategy === "TREND" &&
      snapshot.mode.active === "AUTO" &&
      snapshot.engine.regime === "REVERSAL" &&
      /SUPERTREND/i.test(`${event} ${String(row.reason ?? "")}`)
    ) {
      continue;
    }

    // Submission lifecycle events are not reasons why a strategy is waiting.
    // They belong to execution history, not the "why no entry" checklist.
    if (/^(?:ENTRY_SUBMIT|ENTRY_SUBMITTED)$/i.test(event)) continue;

    if (/(?:EXIT|CLOSE|CLOSED|TAKE_PROFIT|STOP_LOSS|POSITION_GONE|PLUS6|PLUS10|STRUCTURAL_SL|FVG_HOLD|MANAGEMENT_)/i.test(event)) continue;
    pushUnique(reasons, canonicalEntryWaitReason(strategy, event, row.reason));
    if (reasons.length >= 3) break;
  }

  if (snapshot.preTrade.strategy === strategy && !snapshot.preTrade.approved) {
    pushUnique(reasons, snapshot.preTrade.decisionReason);
  }

  if (reasons.length === 0) {
    pushUnique(reasons, `${strategy}: chưa có setup mới đạt toàn bộ entry gate.`);
  }
  return reasons.slice(0, 3);
}

function compatibilityWaitReasons(
  snapshot: Snapshot,
  auto: string[],
  trend: string[],
  sideway: string[],
): string[] {
  if (snapshot.mode.effectiveStrategy === "TREND") return trend.slice(0, 3);
  if (snapshot.mode.effectiveStrategy === "SIDEWAY") return sideway.slice(0, 3);
  return auto.slice(0, 3);
}

function entryReasons(snapshot: Snapshot, state: Phase7CUiState): string[] {
  const reasons: string[] = [];
  if (state === "MANAGING") {
    pushUnique(reasons, snapshot.position.entryReason);
  } else if (state === "SETUP_READY") {
    pushUnique(reasons, snapshot.preTrade.decisionReason);
    if (snapshot.preTrade.setup) pushUnique(reasons, `Setup ${snapshot.preTrade.setup} đã được engine duyệt.`);
  }
  return reasons.slice(0, 3);
}

function holdReasons(snapshot: Snapshot, state: Phase7CUiState): string[] {
  if (state !== "MANAGING") return [];
  const reasons: string[] = [];
  pushUnique(reasons, snapshot.position.holdReason);
  return reasons;
}

function managementReasons(snapshot: Snapshot, kind: "STOP" | "PARTIAL"): string[] {
  if (snapshot.position.state != "MANAGING" || snapshot.position.count <= 0) return [];
  const reasons: string[] = [];
  const ticket = String(snapshot.position.ticket ?? "");
  for (const row of snapshot.recentDecisions) {
    if (ticket && String(row.management?.ticket ?? "") !== ticket) continue;
    const event = String(row.event ?? "");
    if (kind === "STOP") {
      if (/^PLUS6_(?:SL_TO_ENTRY|BREAK_EVEN_APPLIED)/.test(event)) {
        pushUnique(reasons, "SL đã được dời về Entry/BE khi lệnh đạt +6 giá.", 2);
      } else if (event === "STRUCTURAL_SL_TIGHTEN") {
        pushUnique(reasons, "SL runner đã được siết theo cấu trúc swing M15 mới; chỉ siết theo hướng có lợi.", 2);
      }
    } else if (/^PLUS10_PARTIAL_ONE_THIRD/.test(event)) {
      pushUnique(reasons, "Đã chốt đúng 1/3 vị thế khi giá đạt mốc +10.", 2);
    }
    if (reasons.length >= 2) break;
  }
  return reasons;
}

function exitReasons(snapshot: Snapshot): string[] {
  if (snapshot.position.state != "MANAGING") return [];
  const reasons: string[] = [];
  const ticket = String(snapshot.position.ticket ?? "");
  for (const row of snapshot.recentDecisions) {
    if (ticket && String(row.management?.ticket ?? "") !== ticket) continue;
    const event = String(row.event ?? "");
    if (!/(?:EXIT|CLOSE|CLOSED|TAKE_PROFIT|STOP_LOSS|POSITION_GONE|REGIME_LEFT_RANGE|TIME_STOP)/i.test(event)) continue;
    pushUnique(reasons, row.reason || event, 3);
    if (reasons.length >= 3) break;
  }
  return reasons;
}

function entryCheck(
  code: string,
  label: string,
  status: Phase7CEntryCheckStatus,
  actual: unknown,
  required: string,
  reason: string,
): Phase7CEntryCheck {
  const actualText = String(actual ?? "").trim();
  return {
    code,
    label,
    status,
    actual: actualText || "—",
    required,
    reason,
  };
}

function trendEntryChecks(snapshot: Snapshot): Phase7CEntryCheck[] {
  const diagnostics = snapshot.entryDiagnostics?.trend ?? null;
  const diagnosticError = snapshot.entryDiagnostics?.trendError ?? null;
  const pattern = diagnostics?.pattern ?? null;
  const side = pattern?.side ?? null;
  const selected = String(pattern?.name ?? "");
  const gate = gateFor(snapshot, "TREND");
  const checks: Phase7CEntryCheck[] = [];

  checks.push(entryCheck(
    "TREND_MODE_REGIME",
    "Mode / Regime",
    gate === "ALLOWED" ? "PASS" : "BLOCKED",
    `${snapshot.mode.active} → ${snapshot.mode.effectiveStrategy}`,
    "TREND được phép mở entry",
    gate === "ALLOWED"
      ? "Mode/regime hiện cho phép Trend."
      : "Mode hoặc AUTO regime hiện đang chặn Trend.",
  ));

  const reversalEntryPolicy =
    snapshot.mode.active === "AUTO" &&
    snapshot.engine.regime === "REVERSAL";
  if (reversalEntryPolicy) {
    const reversalSide = snapshot.engine.reversal?.side ?? null;
    const reversalDirection = snapshot.engine.reversal?.direction ?? null;
    const chochTimestamp = Number(snapshot.engine.reversal?.timestamp);
    const signalTimestamp = Number(diagnostics?.closeTime);
    const hasChochContext =
      (reversalSide === "BUY" || reversalSide === "SELL") &&
      Number.isFinite(chochTimestamp);
    const directionStatus: Phase7CEntryCheckStatus = !hasChochContext
      ? "BLOCKED"
      : !side
        ? "WAIT"
        : side === reversalSide
          ? "PASS"
          : "FAIL";

    checks.push(entryCheck(
      "TREND_REVERSAL_CHOCH_DIRECTION",
      "CHOCH direction",
      directionStatus,
      hasChochContext
        ? `${reversalDirection ?? "—"} → ${reversalSide}; signal ${side ?? "—"}`
        : "Thiếu canonical CHOCH context",
      hasChochContext
        ? `Signal phải là ${reversalSide}`
        : "Latest confirmed CHOCH phải có direction hợp lệ",
      !hasChochContext
        ? "REVERSAL thiếu direction/timestamp canonical nên entry bị fail-closed."
        : !side
          ? `CHOCH yêu cầu ${reversalSide}; đang chờ pattern M15 xác định signal side.`
          : side === reversalSide
            ? `Signal ${side} cùng hướng latest confirmed CHOCH.`
            : `Signal ${side} ngược yêu cầu ${reversalSide} của latest confirmed CHOCH; entry bị chặn.`,
    ));

    const freshnessStatus: Phase7CEntryCheckStatus = !hasChochContext
      ? "BLOCKED"
      : !Number.isFinite(signalTimestamp)
        ? "WAIT"
        : signalTimestamp > chochTimestamp
          ? "PASS"
          : "FAIL";
    checks.push(entryCheck(
      "TREND_REVERSAL_SIGNAL_AFTER_CHOCH",
      "Signal sau CHOCH",
      freshnessStatus,
      Number.isFinite(signalTimestamp)
        ? `${signalTimestamp}`
        : "Chưa có signal timestamp",
      hasChochContext
        ? `> ${chochTimestamp}`
        : "Có CHOCH timestamp canonical",
      !hasChochContext
        ? "Không thể xác minh freshness vì thiếu CHOCH context."
        : !Number.isFinite(signalTimestamp)
          ? "Chờ pattern M15 mới sau CHOCH."
          : signalTimestamp > chochTimestamp
            ? "Signal M15 phát sinh sau CHOCH; freshness PASS."
            : "Signal không mới hơn CHOCH; entry bị chặn và phải chờ signal M15 mới.",
    ));
  }

  const priorities: string[] = [
    "THREE_CANDLE_BODY_DOMINANCE",
    "TWO_CANDLE_BODY_DOMINANCE",
    "ENGULFING",
  ];
  const labels: Record<string, string> = {
    THREE_CANDLE_BODY_DOMINANCE: "Mẫu 3 nến",
    TWO_CANDLE_BODY_DOMINANCE: "Mẫu 2 nến",
    ENGULFING: "Engulfing",
  };
  const selectedIndex = priorities.indexOf(selected);

  priorities.forEach((code, index) => {
    let status: Phase7CEntryCheckStatus = "WAIT";
    let actual = "Chưa có diagnostics";
    let reason = diagnosticError || "Chờ dữ liệu M15.";

    if (diagnostics) {
      if (!pattern?.matched) {
        status = "FAIL";
        actual = "Không match";
        reason = "Pattern này không đạt trên nến M15 hiện tại.";
      }
      else if (selected === code) {
        status = "PASS";
        actual = `MATCH ${side ?? ""}`.trim();
        reason = "Đây là pattern được chọn theo priority THREE → TWO → ENGULFING.";
      }
      else if (selectedIndex >= 0 && index < selectedIndex) {
        status = "FAIL";
        actual = "Không đạt";
        reason = "Pattern ưu tiên cao hơn này không đạt.";
      }
      else {
        status = "WAIT";
        actual = "Không cần xét tiếp";
        reason = "Pattern ưu tiên cao hơn đã đạt nên không cần dùng pattern này.";
      }
    }

    checks.push(entryCheck(
      `TREND_PATTERN_${code}`,
      labels[code] ?? code,
      status,
      actual,
      "Pattern M15 hợp lệ",
      reason,
    ));
  });

  const m15 = diagnostics?.trend?.m15Supertrend ?? null;
  checks.push(entryCheck(
    "TREND_SUPERTREND_M15",
    "Supertrend M15",
    reversalEntryPolicy
      ? "IGNORED"
      : !side
        ? "WAIT"
        : m15 === side
          ? "PASS"
          : "FAIL",
    reversalEntryPolicy ? `IGNORED · observed ${m15 ?? "—"}` : m15 ?? "—",
    reversalEntryPolicy ? "Không áp dụng cho REVERSAL" : side ?? "Chờ pattern xác định hướng",
    reversalEntryPolicy
      ? "REVERSAL dùng latest confirmed CHOCH direction + pattern + structure; Supertrend M15 chỉ được quan sát, không chặn entry."
      : !side
        ? "Chưa có pattern để xác định hướng Supertrend cần khớp."
        : m15 === side
          ? "Supertrend M15 10/3 cùng hướng pattern."
          : "Supertrend M15 10/3 chưa cùng hướng pattern.",
  ));

  const m5 = diagnostics?.trend?.m5Supertrend ?? null;
  checks.push(entryCheck(
    "TREND_SUPERTREND_M5",
    "Supertrend M5",
    reversalEntryPolicy
      ? "IGNORED"
      : !side
        ? "WAIT"
        : m5 === side
          ? "PASS"
          : "FAIL",
    reversalEntryPolicy ? `IGNORED · observed ${m5 ?? "—"}` : m5 ?? "—",
    reversalEntryPolicy ? "Không áp dụng cho REVERSAL" : side ?? "Chờ pattern xác định hướng",
    reversalEntryPolicy
      ? "REVERSAL dùng latest confirmed CHOCH direction + pattern + structure; Supertrend M5 chỉ được quan sát, không chặn entry."
      : !side
        ? "Chưa có pattern để xác định hướng Supertrend cần khớp."
        : m5 === side
          ? "Supertrend M5 10/3 cùng hướng pattern."
          : "Supertrend M5 10/3 chưa cùng hướng pattern.",
  ));

  const structuralRaw = diagnostics?.entry?.structuralStopDistance;
  const structural = Number(structuralRaw);
  const structuralValid = Number.isFinite(structural) && structural > 0;
  const slStatus: Phase7CEntryCheckStatus = !side
    ? "WAIT"
    : !structuralValid
      ? "FAIL"
      : structural > 10
        ? "WAIT"
        : "PASS";

  checks.push(entryCheck(
    "TREND_STRUCTURE_SL",
    "SL cấu trúc",
    slStatus,
    structuralValid ? `${structural.toFixed(2)} giá` : "—",
    "0 < SL cấu trúc ≤ 10 giá",
    !side
      ? "Chờ pattern hợp lệ trước khi tính SL."
      : !structuralValid
        ? "Không tạo được khoảng SL cấu trúc hợp lệ."
        : structural > 10
          ? "SL lớn hơn 10 giá; chờ pullback rồi đánh giá lại."
          : "SL cấu trúc hợp lệ; nếu nhỏ hơn 6 thì stop thực thi dùng tối thiểu 6 giá.",
  ));

  checks.push(entryCheck(
    "TREND_ACCOUNT_GUARD",
    "Account safety",
    snapshot.safety.accountGuardValid ? "PASS" : "BLOCKED",
    snapshot.safety.accountGuardValid ? "VALID" : "INVALID",
    "Account-mode guard hợp lệ",
    snapshot.safety.accountGuardValid
      ? "Account runtime hợp lệ."
      : "Account-mode guard đang fail-closed.",
  ));

  checks.push(entryCheck(
    "TREND_FLAT_POSITION",
    "XAUUSD flat",
    snapshot.account.openXauusdPositions === 0 ? "PASS" : "BLOCKED",
    `${snapshot.account.openXauusdPositions} position`,
    "0 vị thế XAUUSD",
    snapshot.account.openXauusdPositions === 0
      ? "Không có vị thế XAUUSD đang mở."
      : "Đang có vị thế XAUUSD; entry mới bị chặn.",
  ));

  checks.push(entryCheck(
    "TREND_LOT_RUNTIME",
    "Lot runtime",
    snapshot.lotSettings.restartRequired ? "BLOCKED" : "PASS",
    snapshot.lotSettings.restartRequired ? "RESTART REQUIRED" : "ACTIVE",
    "Lot config đã active",
    snapshot.lotSettings.restartRequired
      ? "Cấu hình lot mới chưa active trong executor."
      : "Lot runtime đang active.",
  ));

  return checks;
}

function sidewayEntryChecks(snapshot: Snapshot): Phase7CEntryCheck[] {
  const gate = gateFor(snapshot, "SIDEWAY");
  const latest = snapshot.recentDecisions.find((row) =>
    row.strategy === "SIDEWAY" &&
    snapshot.generatedAt - Number(row.timestamp) <= 30 * 60_000
  ) ?? null;
  const event = String(latest?.event ?? "").toUpperCase();
  const stage = String(latest?.stage ?? "").toUpperCase();
  const latestReason = String(latest?.reason ?? "Chưa có Sideway decision mới.");
  const hasRange = Boolean(snapshot.engine.supplyDemandRange);
  const rangeReady =
    snapshot.engine.regime === "RANGING" &&
    snapshot.engine.recommendedMode === "SIDEWAY" &&
    hasRange;

  const afterLocation =
    /(ENTRY_M5_CONFIRMATION_BLOCK|ENTRY_PLAN_BLOCK|ENTRY_FINAL_PLAN_BLOCK|ENTRY_FINAL_GATE_BLOCK|ENTRY_AUTO_LOT_BLOCK|ENTRY_SUBMIT|ENTRY_FILLED)/.test(event) ||
    stage === "SUBMITTED";

  const afterM5 =
    /(ENTRY_PLAN_BLOCK|ENTRY_FINAL_PLAN_BLOCK|ENTRY_FINAL_GATE_BLOCK|ENTRY_AUTO_LOT_BLOCK|ENTRY_SUBMIT|ENTRY_FILLED)/.test(event) ||
    stage === "SUBMITTED";

  const afterFinal =
    /(ENTRY_AUTO_LOT_BLOCK|ENTRY_SUBMIT|ENTRY_FILLED)/.test(event) ||
    stage === "SUBMITTED";

  const submitted =
    /(ENTRY_SUBMIT|ENTRY_FILLED)/.test(event) ||
    stage === "SUBMITTED";

  const checks: Phase7CEntryCheck[] = [];

  checks.push(entryCheck(
    "SIDEWAY_MODE_REGIME",
    "Mode / Regime",
    gate === "ALLOWED" ? "PASS" : "BLOCKED",
    `${snapshot.mode.active} → ${snapshot.engine.recommendedMode}`,
    "SIDEWAY được phép mở entry",
    gate === "ALLOWED"
      ? "Mode/regime hiện cho phép Sideway."
      : "Mode hoặc AUTO regime hiện đang chặn Sideway.",
  ));

  checks.push(entryCheck(
    "SIDEWAY_RANGE",
    "Range + Supply/Demand",
    rangeReady ? "PASS" : "WAIT",
    `${snapshot.engine.regime} · ${snapshot.engine.confidence}% · S/D ${hasRange ? "YES" : "NO"}`,
    "RANGING + recommended SIDEWAY + Supply/Demand",
    rangeReady
      ? "Đã có corridor Supply/Demand hợp lệ cho Sideway."
      : event === "ENTRY_REGIME_BLOCK"
        ? latestReason
        : "Chưa đủ điều kiện range/Supply-Demand để xét entry.",
  ));

  const locationStatus: Phase7CEntryCheckStatus =
    !rangeReady
      ? "WAIT"
      : event === "ENTRY_LOCATION_BLOCK"
        ? "WAIT"
        : afterLocation
          ? "PASS"
          : "WAIT";

  checks.push(entryCheck(
    "SIDEWAY_LOCATION",
    "Vị trí Supply/Demand",
    locationStatus,
    event === "ENTRY_LOCATION_BLOCK" ? "Giá chưa ở biên" : afterLocation ? "Đã qua location gate" : "Đang chờ",
    "Giá ở demand/supply edge",
    event === "ENTRY_LOCATION_BLOCK"
      ? latestReason
      : afterLocation
        ? "Giá đã vượt qua location gate."
        : "Chờ giá tới vùng demand/supply đủ gần.",
  ));

  const m5Status: Phase7CEntryCheckStatus =
    event === "ENTRY_M5_CONFIRMATION_BLOCK"
      ? "WAIT"
      : afterM5
        ? "PASS"
        : "WAIT";

  checks.push(entryCheck(
    "SIDEWAY_M5_CONFIRMATION",
    "Xác nhận M5",
    m5Status,
    event === "ENTRY_M5_CONFIRMATION_BLOCK" ? "Chưa xác nhận" : afterM5 ? "PASS" : "Đang chờ",
    "M5 confirmation hợp lệ",
    event === "ENTRY_M5_CONFIRMATION_BLOCK"
      ? latestReason
      : afterM5
        ? "M5 confirmation đã đạt."
        : "Chưa tới bước xác nhận M5.",
  ));

  const finalGateStatus: Phase7CEntryCheckStatus =
    /(ENTRY_PLAN_BLOCK|ENTRY_FINAL_PLAN_BLOCK|ENTRY_FINAL_GATE_BLOCK)/.test(event)
      ? "FAIL"
      : afterFinal
        ? "PASS"
        : "WAIT";

  checks.push(entryCheck(
    "SIDEWAY_FINAL_GATE",
    "Final entry gate",
    finalGateStatus,
    /(ENTRY_PLAN_BLOCK|ENTRY_FINAL_PLAN_BLOCK|ENTRY_FINAL_GATE_BLOCK)/.test(event)
      ? event
      : afterFinal
        ? "PASS"
        : "Đang chờ",
    "Plan + quote + regime + side vẫn hợp lệ",
    /(ENTRY_PLAN_BLOCK|ENTRY_FINAL_PLAN_BLOCK|ENTRY_FINAL_GATE_BLOCK)/.test(event)
      ? latestReason
      : afterFinal
        ? "Final gate đã đạt ngay trước bước Auto Lot/order."
        : "Chưa tới final gate.",
  ));

  const autoLotStatus: Phase7CEntryCheckStatus =
    event === "ENTRY_AUTO_LOT_BLOCK"
      ? "FAIL"
      : submitted
        ? "PASS"
        : "WAIT";

  checks.push(entryCheck(
    "SIDEWAY_AUTO_LOT",
    "Auto Lot",
    autoLotStatus,
    event === "ENTRY_AUTO_LOT_BLOCK" ? "BLOCK" : submitted ? "PASS" : "Đang chờ",
    "Auto Lot snapshot hợp lệ",
    event === "ENTRY_AUTO_LOT_BLOCK"
      ? latestReason
      : submitted
        ? "Auto Lot đã được xác nhận trước submit."
        : "Auto Lot chỉ được tính sau final gate.",
  ));

  checks.push(entryCheck(
    "SIDEWAY_ACCOUNT_GUARD",
    "Account safety",
    snapshot.safety.accountGuardValid ? "PASS" : "BLOCKED",
    snapshot.safety.accountGuardValid ? "VALID" : "INVALID",
    "Account-mode guard hợp lệ",
    snapshot.safety.accountGuardValid
      ? "Account runtime hợp lệ."
      : "Account-mode guard đang fail-closed.",
  ));

  checks.push(entryCheck(
    "SIDEWAY_FLAT_POSITION",
    "XAUUSD flat",
    snapshot.account.openXauusdPositions === 0 ? "PASS" : "BLOCKED",
    `${snapshot.account.openXauusdPositions} position`,
    "0 vị thế XAUUSD",
    snapshot.account.openXauusdPositions === 0
      ? "Không có vị thế XAUUSD đang mở."
      : "Đang có vị thế XAUUSD; entry mới bị chặn.",
  ));

  checks.push(entryCheck(
    "SIDEWAY_LOT_RUNTIME",
    "Lot runtime",
    snapshot.lotSettings.restartRequired ? "BLOCKED" : "PASS",
    snapshot.lotSettings.restartRequired ? "RESTART REQUIRED" : "ACTIVE",
    "Lot config đã active",
    snapshot.lotSettings.restartRequired
      ? "Cấu hình lot mới chưa active trong executor."
      : "Lot/risk runtime đang active.",
  ));

  return checks;
}

export function buildPhase7CUiContract(snapshot: Snapshot): Phase7CUiContract {
  const state = uiState(snapshot);
  const accountMode: "DEMO" | "LIVE" = snapshot.account.accountMode === "real" ? "LIVE" : "DEMO";
  const trendGate = gateFor(snapshot, "TREND");
  const sidewayGate = gateFor(snapshot, "SIDEWAY");
  const auto = autoReasons(snapshot);
  const trendWait = strategyWaitReasons(snapshot, "TREND");
  const sidewayWait = strategyWaitReasons(snapshot, "SIDEWAY");
  const trendChecks = trendEntryChecks(snapshot);
  const sidewayChecks = sidewayEntryChecks(snapshot);
  const setup = state === "SETUP_READY" ? {
    strategy: snapshot.preTrade.strategy,
    side: snapshot.preTrade.side,
    name: snapshot.preTrade.setup,
    entry: snapshot.preTrade.entry,
    stopLoss: snapshot.preTrade.stopLoss,
    tp1: snapshot.preTrade.tp1,
    tp2: snapshot.preTrade.tp2,
    finalLot: snapshot.preTrade.finalLot,
    estimatedRiskPercent: snapshot.preTrade.estimatedRiskPercent,
  } : null;
  const position = state === "MANAGING" ? {
    state: snapshot.position.state,
    count: snapshot.position.count,
    strategy: snapshot.position.strategy,
    ticket: snapshot.position.ticket,
    side: snapshot.position.side,
    volume: snapshot.position.volume,
    entry: snapshot.position.entry,
    stopLoss: snapshot.position.stopLoss,
    tp1: snapshot.position.tp1,
    tp2: snapshot.position.tp2,
    floatingPnlUsd: snapshot.position.floatingPnlUsd,
    floatingPnlPercent: snapshot.position.floatingPnlPercent,
  } : null;

  return {
    version: 2,
    generatedAt: snapshot.generatedAt,
    symbol: snapshot.symbol,
    uiState: state,
    mode: snapshot.mode.active,
    effectiveStrategy: snapshot.mode.effectiveStrategy,
    regime: snapshot.engine.regime,
    confidence: snapshot.engine.confidence,
    stage: snapshot.preTrade.stage,
    approved: snapshot.preTrade.approved,
    recommendedMode: snapshot.engine.recommendedMode,
    reasons: {
      auto,
      trendWait,
      sidewayWait,
      wait: state === "WAITING" ? compatibilityWaitReasons(snapshot, auto, trendWait, sidewayWait) : [],
      entry: entryReasons(snapshot, state),
      hold: holdReasons(snapshot, state),
      stopMove: managementReasons(snapshot, "STOP"),
      partial: managementReasons(snapshot, "PARTIAL"),
      exit: exitReasons(snapshot),
    },
    entryChecks: {
      trend: trendChecks,
      sideway: sidewayChecks,
    },
    gates: {
      trend: trendGate,
      sideway: sidewayGate,
      reversalFilter:
        snapshot.engine.regime === "REVERSAL" &&
        snapshot.mode.effectiveStrategy !== "TREND"
          ? "BLOCKING"
          : "CLEAR",
    },
    status: {
      mt5Connected: snapshot.account.reachable === true,
      accountGuardValid: snapshot.safety.accountGuardValid === true,
      trendOn: trendGate === "ALLOWED",
      sidewayOn: sidewayGate === "ALLOWED",
    },
    setup,
    position,
    safety: {
      accountMode,
      demoOnly: accountMode === "DEMO",
      readOnly: true,
      orderPermission: "NONE",
      newPositionsOnly: true,
      martingale: false,
      recoveryLotEscalation: false,
    },
  };
}

function lineValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "n/a";
  return String(value).replace(/[\r\n]+/g, " ").slice(0, 480);
}

export function formatPhase7CUiContractForMt5(ui: Phase7CUiContract): string {
  const auto = ui.reasons.auto;
  const trendWait = ui.reasons.trendWait;
  const sidewayWait = ui.reasons.sidewayWait;
  const wait = ui.reasons.wait;
  const entry = ui.reasons.entry;
  const hold = ui.reasons.hold;
  const stopMove = ui.reasons.stopMove;
  const partial = ui.reasons.partial;
  const exit = ui.reasons.exit;
  const setup = ui.setup;
  const position = ui.position;
  const lines: Array<[string, unknown]> = [
    ["version", ui.version],
    ["generatedAt", ui.generatedAt],
    ["symbol", ui.symbol],
    ["uiState", ui.uiState],
    ["accountMode", ui.safety.accountMode],
    ["activeMode", ui.mode],
    ["effectiveStrategy", ui.effectiveStrategy],
    ["regime", ui.regime],
    ["confidence", ui.confidence],
    ["stage", ui.stage],
    ["approved", ui.approved],
    ["recommendedMode", ui.recommendedMode],
    ["trendGate", ui.gates.trend],
    ["sidewayGate", ui.gates.sideway],
    ["reversalFilter", ui.gates.reversalFilter],
    ["mt5Connected", ui.status.mt5Connected],
    ["accountGuardValid", ui.status.accountGuardValid],
    ["trendOn", ui.status.trendOn],
    ["sidewayOn", ui.status.sidewayOn],
    ["autoReason1", auto[0]],
    ["autoReason2", auto[1]],
    ["autoReason3", auto[2]],
    ["trendWaitReason1", trendWait[0]],
    ["trendWaitReason2", trendWait[1]],
    ["trendWaitReason3", trendWait[2]],
    ["sidewayWaitReason1", sidewayWait[0]],
    ["sidewayWaitReason2", sidewayWait[1]],
    ["sidewayWaitReason3", sidewayWait[2]],
    ["waitReason1", wait[0]],
    ["waitReason2", wait[1]],
    ["waitReason3", wait[2]],
    ["entryReason1", entry[0]],
    ["entryReason2", entry[1]],
    ["entryReason3", entry[2]],
    ["holdReason1", hold[0]],
    ["holdReason2", hold[1]],
    ["holdReason3", hold[2]],
    ["stopMoveReason1", stopMove[0]],
    ["stopMoveReason2", stopMove[1]],
    ["partialReason1", partial[0]],
    ["partialReason2", partial[1]],
    ["exitReason1", exit[0]],
    ["exitReason2", exit[1]],
    ["exitReason3", exit[2]],
    ["setupStrategy", setup?.strategy],
    ["setupSide", setup?.side],
    ["setupName", setup?.name],
    ["setupEntry", setup?.entry],
    ["setupStopLoss", setup?.stopLoss],
    ["setupTp1", setup?.tp1],
    ["setupTp2", setup?.tp2],
    ["setupFinalLot", setup?.finalLot],
    ["setupRiskPercent", setup?.estimatedRiskPercent],
    ["positionState", position?.state],
    ["positionCount", position?.count],
    ["positionStrategy", position?.strategy],
    ["ticket", position?.ticket],
    ["positionSide", position?.side],
    ["positionVolume", position?.volume],
    ["positionEntry", position?.entry],
    ["positionStopLoss", position?.stopLoss],
    ["positionTp1", position?.tp1],
    ["positionTp2", position?.tp2],
    ["floatingPnlUsd", position?.floatingPnlUsd],
    ["floatingPnlPercent", position?.floatingPnlPercent],
    ["demoOnly", ui.safety.demoOnly],
    ["readOnly", ui.safety.readOnly],
    ["newPositionsOnly", ui.safety.newPositionsOnly],
    ["martingale", ui.safety.martingale],
    ["recoveryLotEscalation", ui.safety.recoveryLotEscalation],
    ["mt5OrderPermission", ui.safety.orderPermission],
  ];

  for (let index = 0; index < 10; index += 1) {
    const trendCheck = ui.entryChecks.trend[index];
    const sidewayCheck = ui.entryChecks.sideway[index];
    const number = index + 1;

    lines.push(
      [`trendCheck${number}Status`, trendCheck?.status],
      [`trendCheck${number}Label`, trendCheck?.label],
      [`trendCheck${number}Actual`, trendCheck?.actual],
      [`trendCheck${number}Required`, trendCheck?.required],
      [`trendCheck${number}Reason`, trendCheck?.reason],
      [`sidewayCheck${number}Status`, sidewayCheck?.status],
      [`sidewayCheck${number}Label`, sidewayCheck?.label],
      [`sidewayCheck${number}Actual`, sidewayCheck?.actual],
      [`sidewayCheck${number}Required`, sidewayCheck?.required],
      [`sidewayCheck${number}Reason`, sidewayCheck?.reason],
    );
  }

  return `${lines.map(([key, value]) => `${key}=${lineValue(value)}`).join("\n")}\n`;
}
