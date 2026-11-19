import { canonicalHoldReason } from "../../../../scripts/phase7c-hold-observability.mjs";
import { evaluateAutoTrendEntryModeGate } from "../../../../scripts/phase7c-trend-mode-gate.mjs";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Mt5TelemetrySnapshot } from "./mt5.service";
import { getMt5Telemetry } from "./mt5.service";
import { getPhase7CLiveRegime } from "./phase7c-live-regime.service";
import { phase7CBotModeService } from "./phase7c-bot-mode.service";
import { phase7CLotSettingsService } from "./phase7c-lot-settings.service";
import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
  type Phase7CAccountModeState,
} from "./phase7c-account-mode.service";
import type { DurableSemiAdoptionState } from "./phase7c-semi-adoption-state.service";
import { getPhase7CSemiAdoptionStateRepository } from "./phase7c-semi-adoption-runtime.service";

type Strategy = "TREND" | "SIDEWAY" | "PAUSE";

interface EntryDiagnostics {
  pattern?: {
    matched?: boolean;
    name?: string | null;
    side?: "BUY" | "SELL" | null;
    extreme?: number | null;
  };
  trend?: {
    confidenceScore?: number | null;
    confidenceLevel?: string | null;
    m15Supertrend?: "BUY" | "SELL" | null;
    m5Supertrend?: "BUY" | "SELL" | null;
  };
  closeTime?: number;
  entry?: {
    eligible?: boolean;
    reversalEligible?: boolean;
    side?: "BUY" | "SELL" | null;
    referenceEntry?: number;
    structuralStopDistance?: number | null;
    stopDistance?: number | null;
    reversalStopDistance?: number | null;
    action?: string;
    reversalAction?: string;
    reason?: string;
    reversalReason?: string;
  };
}

interface Phase7BDemoStatus {
  botStatus?: string;
  entryDiagnostics?: EntryDiagnostics | null;
  entryDiagnosticsError?: string | null;
}

interface EntryConditionsDecision {
  configVersion: number;
  side: "BUY" | "SELL";
  anchorCondition: string;
  enabledCount: number;
  allEnabledPassed: boolean;
  failedConditions: string[];
  conditions: Array<{
    id: string;
    enabled: boolean;
    mandatory: boolean;
    status: "PASS" | "FAIL" | "IGNORED";
    observed: unknown;
  }>;
}

interface DecisionAuditRecord {
  schemaVersion?: number;
  timestamp: number;
  timestampIso?: string;
  strategy: "TREND" | "SIDEWAY";
  symbol?: string;
  event: string;
  stage: string;
  reasonCode?: string;
  reason: string;
  entryConditions?: EntryConditionsDecision | null;
  setup?: {
    side?: string | null;
    pattern?: string | null;
    entryState?: string | null;
    activeMode?: string | null;
    recommendedMode?: string | null;
    regime?: string | null;
    confidence?: number | null;
  };
  sizing?: {
    configuredLot?: number | null;
    rawLot?: number | null;
    finalLot?: number | null;
    maxLot?: number | null;
    riskPercent?: number | null;
    estimatedRiskUsd?: number | null;
    estimatedRiskPercent?: number | null;
    limitReason?: string | null;
  };
  plan?: {
    entry?: number | null;
    stopLoss?: number | null;
    stopDistance?: number | null;
    breakEvenPrice?: number | null;
    breakEvenTriggerDistance?: number | null;
    partialTriggerDistance?: number | null;
    partialFraction?: string | null;
    tp1?: number | null;
    tp2?: number | null;
    dailyMode?: string | null;
  };
  management?: {
    ticket?: string | null;
    breakEvenApplied?: boolean;
    partialApplied?: boolean;
  };
  source?: string;
  raw?: unknown;
}

interface ManagedRuntimePosition {
  ticket?: string | number | null;
  side?: "BUY" | "SELL" | null;
  pattern?: string | null;
  entry?: number | null;
  initialVolume?: number | null;
  stopLoss?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  dailyMode?: string | null;
  breakEvenApplied?: boolean;
  partialApplied?: boolean;
  openedAt?: number | null;
}

interface ManagedRuntimeStates {
  TREND: ManagedRuntimePosition | null;
  SIDEWAY: ManagedRuntimePosition | null;
}

export interface Phase7CPreTradeDecision {
  strategy: Strategy | null;
  stage: string;
  approved: boolean;
  side: string | null;
  setup: string | null;
  confidenceScore: number | null;
  confidenceLabel: string | null;
  entry: number | null;
  stopLoss: number | null;
  stopDistance: number | null;
  breakEvenPrice: number | null;
  breakEvenTriggerDistance: number;
  tp1: number | null;
  tp2: number | null;
  partialTriggerDistance: number;
  partialFraction: "1/3";
  rawLot: number | null;
  finalLot: number | null;
  lotCap: number | null;
  riskTargetPercent: number | null;
  estimatedRiskUsd: number | null;
  estimatedRiskPercent: number | null;
  limitReason: string;
  decisionReason: string;
  source: string;
  updatedAt: number;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number | null, digits = 4): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return resolve(demoDir, "..");
  return resolve(process.cwd(), ".runtime");
}

function readJsonlTail(file: string, limit: number): DecisionAuditRecord[] {
  const maxBytes = 2 * 1024 * 1024;
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const fileSize = fstatSync(fd).size;
    const start = Math.max(0, fileSize - maxBytes);
    const bytesToRead = Math.max(0, fileSize - start);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const bytesRead = readSync(fd, buffer, offset, bytesToRead - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }

    const text = buffer.subarray(0, offset).toString("utf8");
    const rows: DecisionAuditRecord[] = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line) as DecisionAuditRecord;
        if (
          (value.strategy === "TREND" || value.strategy === "SIDEWAY") &&
          Number.isFinite(Number(value.timestamp)) &&
          typeof value.event === "string"
        ) {
          rows.push({ ...value, timestamp: Number(value.timestamp) });
        }
      } catch {
        // The first line can be partial when only a bounded file tail was read.
      }
    }
    return rows.slice(-limit);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Read-only observability remains fail-closed on close errors.
      }
    }
  }
}

function decisionAuditRoot(accountModeState: Phase7CAccountModeState): string {
  const base = resolve(runtimeRoot(), "phase7c-executors", "decision-observability");
  const accountRoot = resolve(base, accountModeState.accountMode.toLowerCase());
  if (accountModeState.accountMode === "LIVE") return accountRoot;
  return existsSync(accountRoot) ? accountRoot : base;
}

function loadAudit(accountModeState: Phase7CAccountModeState): DecisionAuditRecord[] {
  const root = decisionAuditRoot(accountModeState);
  const rows = [
    ...readJsonlTail(resolve(root, "trend-decisions.jsonl"), 160),
    ...readJsonlTail(resolve(root, "sideway-decisions.jsonl"), 160),
  ];
  return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 160);
}

function readManagedState(file: string): ManagedRuntimePosition | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { managed?: ManagedRuntimePosition | null };
    return parsed?.managed && typeof parsed.managed === "object" ? parsed.managed : null;
  } catch {
    return null;
  }
}

function loadManagedStates(accountModeState: Phase7CAccountModeState): ManagedRuntimeStates {
  const root = runtimeRoot();
  const trendDir = accountModeState.accountMode === "LIVE" ? "phase7b-live-forward" : "phase7b-demo-forward";
  const sidewayDir = accountModeState.accountMode === "LIVE" ? "phase7c-sideway-live-forward" : "phase7c-sideway-forward";
  return {
    TREND: readManagedState(resolve(root, trendDir, "phase7b-demo-state.json")),
    SIDEWAY: readManagedState(resolve(root, sidewayDir, "phase7c-sideway-state.json")),
  };
}

async function loadSemiAdoptions(): Promise<DurableSemiAdoptionState[]> {
  try {
    return await getPhase7CSemiAdoptionStateRepository().listActive();
  } catch {
    // Decision observability must never invent SEMI ownership. An unreadable
    // durable ledger therefore degrades to no adopted owner and stays fail-closed.
    return [];
  }
}

function localApiBase(): string {
  const configured = process.env.PHASE7C_CONTROL_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const port = Number(process.env.PORT ?? 3711);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3711}`;
}

async function getPhase7BDemoStatus(): Promise<Phase7BDemoStatus | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${localApiBase()}/api/v1/phase7b-demo`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json() as Phase7BDemoStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function safeAccount(telemetry: Mt5TelemetrySnapshot) {
  return {
    reachable: telemetry.reachable,
    accountMode: telemetry.health?.accountMode ?? null,
    server: telemetry.health?.server ?? null,
    currency: telemetry.health?.accountCurrency ?? null,
    balance: finite(telemetry.health?.accountBalance),
    equity: finite(telemetry.health?.accountEquity),
    openXauusdPositions: telemetry.positions.length,
  };
}

function trendDecision(input: {
  regime: Awaited<ReturnType<typeof getPhase7CLiveRegime>>;
  demo: Phase7BDemoStatus | null;
  telemetry: Mt5TelemetrySnapshot;
  lots: ReturnType<typeof phase7CLotSettingsService.get>;
  accountModeState: Phase7CAccountModeState;
  now: number;
}): Phase7CPreTradeDecision {
  const { regime, demo, telemetry, lots, accountModeState, now } = input;
  const diagnostics = demo?.entryDiagnostics ?? null;
  const entryInfo = diagnostics?.entry;
  const side = entryInfo?.side ?? diagnostics?.pattern?.side ?? null;
  const autoModeGate = regime.activeMode === "AUTO"
    ? evaluateAutoTrendEntryModeGate({
        activeMode: regime.activeMode,
        regime,
        demo,
      })
    : null;
  const autoReversalEntry = autoModeGate?.allowed === true &&
    autoModeGate.reason === "AUTO_REVERSAL_CHOCH_DIRECTION_ENTRY";
  const entry = finite(entryInfo?.referenceEntry);
  const stopDistance = autoReversalEntry
    ? finite(entryInfo?.reversalStopDistance) ?? finite(entryInfo?.structuralStopDistance)
    : finite(entryInfo?.stopDistance) ?? finite(entryInfo?.structuralStopDistance);
  const stopLoss = entry !== null && stopDistance !== null && side
    ? side === "BUY" ? entry - stopDistance : entry + stopDistance
    : null;
  const activeLot = lots.activeAlive && lots.active?.armed
    ? lots.active.trendFixedLot
    : lots.state.trendFixedLot;
  const cashPerPriceUnitPerLot = finite(telemetry.spec?.cashPerPriceUnitPerLot);
  const estimatedRiskUsd = stopDistance !== null && cashPerPriceUnitPerLot !== null
    ? stopDistance * cashPerPriceUnitPerLot * activeLot
    : null;
  const balance = finite(telemetry.health?.accountBalance);
  const estimatedRiskPercent = estimatedRiskUsd !== null && balance !== null && balance > 0
    ? estimatedRiskUsd / balance * 100
    : null;
  const eligible = autoReversalEntry
    ? entryInfo?.reversalEligible === true
    : entryInfo?.eligible === true;
  const modeAllows = regime.activeMode === "TREND" ||
    (regime.activeMode === "AUTO" && autoModeGate?.allowed === true);
  const safetyAllows = telemetry.reachable &&
    accountModeAllowsBroker(telemetry.health?.accountMode, accountModeState) &&
    telemetry.positions.length === 0 &&
    lots.activeAlive && lots.active?.armed === true &&
    !lots.restartRequired;
  const approved = modeAllows && safetyAllows && eligible;
  const setup = diagnostics?.pattern?.matched
    ? diagnostics.pattern.name ?? "TREND_PATTERN"
    : null;
  const action = String(entryInfo?.action ?? "WAIT_SIGNAL");
  const stage = approved
    ? "READY"
    : action === "WAIT_PULLBACK"
      ? "WAITING"
      : !modeAllows || !safetyAllows
        ? "BLOCKED"
        : "WAITING";
  const limitReason = !accountModeState.valid
    ? `Account-mode state không hợp lệ: ${accountModeState.error ?? "unknown"}.`
    : lots.restartRequired
      ? "Cấu hình lot chưa được executor active; cần restart an toàn khi PAUSE."
      : `Trend dùng fixed lot ${activeLot.toFixed(2)}; không martingale, không recovery lot escalation.`;

  return {
    strategy: "TREND",
    stage,
    approved,
    side,
    setup,
    confidenceScore: finite(diagnostics?.trend?.confidenceScore),
    confidenceLabel: diagnostics?.trend?.confidenceLevel ?? null,
    entry: round(entry, 5),
    stopLoss: round(stopLoss, 5),
    stopDistance: round(stopDistance, 5),
    breakEvenPrice: round(entry, 5),
    breakEvenTriggerDistance: 6,
    tp1: entry !== null && side ? round(side === "BUY" ? entry + 10 : entry - 10, 5) : null,
    tp2: null,
    partialTriggerDistance: 10,
    partialFraction: "1/3",
    rawLot: round(activeLot, 2),
    finalLot: round(activeLot, 2),
    lotCap: round(activeLot, 2),
    riskTargetPercent: null,
    estimatedRiskUsd: round(estimatedRiskUsd, 2),
    estimatedRiskPercent: round(estimatedRiskPercent, 4),
    limitReason,
    decisionReason: autoReversalEntry
      ? entryInfo?.reversalReason ?? "REVERSAL chờ CHOCH-direction Pattern + Structure + SL 6–10; SuperTrend không tham gia gate."
      : entryInfo?.reason ?? demo?.entryDiagnosticsError ?? "Chưa có Trend diagnostics.",
    source: "PHASE7B_CANONICAL_ENTRY_DIAGNOSTICS+ACTIVE_LOT_SETTINGS",
    updatedAt: now,
  };
}

function sidewayDecision(input: {
  regime: Awaited<ReturnType<typeof getPhase7CLiveRegime>>;
  telemetry: Mt5TelemetrySnapshot;
  lots: ReturnType<typeof phase7CLotSettingsService.get>;
  audit: DecisionAuditRecord[];
  accountModeState: Phase7CAccountModeState;
  now: number;
}): Phase7CPreTradeDecision {
  const { regime, telemetry, lots, audit, accountModeState, now } = input;
  const latest = audit.find((row) => row.strategy === "SIDEWAY") ?? null;
  const activeRisk = lots.activeAlive && lots.active?.armed
    ? lots.active.sidewayRiskPercent
    : lots.state.sidewayRiskPercent;
  const activeMaxLot = lots.activeAlive && lots.active?.armed
    ? lots.active.sidewayMaxLot
    : lots.state.sidewayMaxLot;
  const modeAllows = regime.activeMode === "SIDEWAY" ||
    (regime.activeMode === "AUTO" && regime.recommendedMode === "SIDEWAY");
  const safetyAllows = telemetry.reachable &&
    accountModeAllowsBroker(telemetry.health?.accountMode, accountModeState) &&
    telemetry.positions.length === 0 &&
    lots.activeAlive && lots.active?.armed === true &&
    !lots.restartRequired;
  const currentDecision = Boolean(latest && now - latest.timestamp <= 30 * 60_000);
  const current = currentDecision ? latest : null;
  const executorReady = currentDecision && new Set(["READY", "SUBMITTED"]).has(String(latest?.stage));
  const approved = modeAllows && safetyAllows && executorReady;
  const stage = !modeAllows || !safetyAllows
    ? "BLOCKED"
    : currentDecision
      ? String(latest?.stage ?? "WAITING")
      : "WAITING";

  return {
    strategy: "SIDEWAY",
    stage,
    approved,
    side: current?.setup?.side ?? null,
    setup: current?.setup?.pattern ?? null,
    confidenceScore: finite(regime.confidence),
    confidenceLabel: null,
    entry: round(finite(current?.plan?.entry), 5),
    stopLoss: round(finite(current?.plan?.stopLoss), 5),
    stopDistance: round(finite(current?.plan?.stopDistance), 5),
    breakEvenPrice: round(finite(current?.plan?.breakEvenPrice), 5),
    breakEvenTriggerDistance: 6,
    tp1: round(finite(current?.plan?.tp1), 5),
    tp2: round(finite(current?.plan?.tp2), 5),
    partialTriggerDistance: 10,
    partialFraction: "1/3",
    rawLot: round(finite(current?.sizing?.rawLot), 4),
    finalLot: round(finite(current?.sizing?.finalLot), 2),
    lotCap: round(finite(current?.sizing?.maxLot) ?? activeMaxLot, 2),
    riskTargetPercent: round(finite(current?.sizing?.riskPercent) ?? activeRisk, 2),
    estimatedRiskUsd: round(finite(current?.sizing?.estimatedRiskUsd), 2),
    estimatedRiskPercent: round(finite(current?.sizing?.estimatedRiskPercent), 4),
    limitReason: !accountModeState.valid
      ? `Account-mode state không hợp lệ: ${accountModeState.error ?? "unknown"}.`
      : current?.sizing?.limitReason ??
        `Sideway tính lot sau final gate theo ${activeRisk.toFixed(2)}% balance, cap ${activeMaxLot.toFixed(2)} lot và bước chốt đúng 1/3.`,
    decisionReason: currentDecision
      ? current?.reason ?? "Chờ Sideway setup."
      : "Chưa có Sideway setup mới trong 30 phút; lot chỉ được tính sau Supply/Demand + ATR + M5 final gate.",
    source: current?.source ?? "SIDEWAY_EXECUTOR_CANONICAL_JOURNAL",
    updatedAt: current?.timestamp ?? now,
  };
}

function pauseDecision(
  regime: Awaited<ReturnType<typeof getPhase7CLiveRegime>>,
  now: number,
): Phase7CPreTradeDecision {
  return {
    strategy: "PAUSE",
    stage: "BLOCKED",
    approved: false,
    side: null,
    setup: null,
    confidenceScore: finite(regime.confidence),
    confidenceLabel: null,
    entry: null,
    stopLoss: null,
    stopDistance: null,
    breakEvenPrice: null,
    breakEvenTriggerDistance: 6,
    tp1: null,
    tp2: null,
    partialTriggerDistance: 10,
    partialFraction: "1/3",
    rawLot: null,
    finalLot: null,
    lotCap: null,
    riskTargetPercent: null,
    estimatedRiskUsd: null,
    estimatedRiskPercent: null,
    limitReason: "PAUSE chặn mọi lệnh mới; không thay đổi vị thế đang được quản lý.",
    decisionReason: regime.reasons.join(" · ") || "Engine chưa cho phép Trend hoặc Sideway.",
    source: "MARKET_REGIME_CLASSIFIER",
    updatedAt: now,
  };
}

function semiManualOnlyDecision(
  regime: Awaited<ReturnType<typeof getPhase7CLiveRegime>>,
  now: number,
): Phase7CPreTradeDecision {
  return {
    strategy: null,
    stage: "BLOCKED",
    approved: false,
    side: null,
    setup: null,
    confidenceScore: finite(regime.confidence),
    confidenceLabel: null,
    entry: null,
    stopLoss: null,
    stopDistance: null,
    breakEvenPrice: null,
    breakEvenTriggerDistance: 6,
    tp1: null,
    tp2: null,
    partialTriggerDistance: 10,
    partialFraction: "1/3",
    rawLot: null,
    finalLot: null,
    lotCap: null,
    riskTargetPercent: null,
    estimatedRiskUsd: null,
    estimatedRiskPercent: null,
    limitReason: "SEMI chỉ cho phép vào lệnh thủ công; hệ thống chặn mọi system-generated new entry.",
    decisionReason: "SEMI manual-entry-only: sau khi vị thế thủ công được xác minh và PROTECTED/MANAGED, Trend management mới được phép quản lý SL/BE/TP/FastMove.",
    source: "PHASE7C_SEMI_MANUAL_ENTRY_ONLY",
    updatedAt: now,
  };
}

function cleanReason(value: string | null | undefined, fallback: string): string {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return text || fallback;
}

function entryReason(
  strategy: Strategy | null,
  managed: ManagedRuntimePosition | null,
  audit: DecisionAuditRecord | null,
): string {
  if (strategy === "TREND") {
    const setup = audit?.setup?.pattern ?? managed?.pattern;
    return cleanReason(
      setup
        ? `${setup} · Supertrend M15/M5 cùng hướng · SL cấu trúc hợp lệ.`
        : null,
      "Trend entry đã được executor xác nhận từ journal canonical.",
    );
  }
  if (strategy === "SIDEWAY") {
    const setup = audit?.setup?.pattern ?? managed?.pattern;
    return cleanReason(
      setup
        ? `${setup} · Supply/Demand + ATR + xác nhận M5 final gate.`
        : null,
      "Sideway entry đã qua Supply/Demand, ATR và M5 final gate.",
    );
  }
  return "Vị thế không khớp state của Trend/Sideway executor; panel không suy đoán lý do vào lệnh.";
}

function positionMonitor(input: {
  telemetry: Mt5TelemetrySnapshot;
  audit: DecisionAuditRecord[];
  managedStates?: ManagedRuntimeStates;
  semiAdoptions?: DurableSemiAdoptionState[];
  activeMode?: string;
}) {
  const positions = input.telemetry.positions;
  const position = positions[0] ?? null;
  if (!position) {
    return {
      state: "FLAT" as const,
      count: 0,
      strategy: null,
      ticket: null,
      side: null,
      setup: null,
      volume: null,
      entry: null,
      currentPrice: null,
      stopLoss: null,
      takeProfit: null,
      tp1: null,
      tp2: null,
      floatingPnlUsd: null,
      floatingPnlPercent: null,
      favorableDistance: null,
      breakEvenApplied: false,
      partialApplied: false,
      openedAt: null,
      entryReason: "Chưa có vị thế XAUUSD đang mở.",
      holdReasonCode: null,
      holdReason: "Chờ setup hợp lệ; panel không có quyền gửi lệnh.",
    };
  }

  const states = input.managedStates ?? { TREND: null, SIDEWAY: null };
  const ticket = String(position.ticket);
  const hasExactlyOnePosition = positions.length === 1;
  const trendManaged = hasExactlyOnePosition && String(states.TREND?.ticket ?? "") === ticket ? states.TREND : null;
  const sidewayManaged = hasExactlyOnePosition && String(states.SIDEWAY?.ticket ?? "") === ticket ? states.SIDEWAY : null;
  const semiManaged = hasExactlyOnePosition && input.activeMode === "SEMI"
    ? input.semiAdoptions?.find((owner) =>
      String(owner.ticket) === ticket &&
      owner.entrySource === "MANUAL" &&
      owner.managementStrategy === "TREND" &&
      (owner.protectionStatus === "PROTECTED" || owner.protectionStatus === "MANAGED")) ?? null
    : null;
  const strategy: Strategy | null = trendManaged
    ? "TREND"
    : sidewayManaged
      ? "SIDEWAY"
      : semiManaged
        ? "TREND"
        : null;
  const managed = trendManaged ?? sidewayManaged;
  const ticketAudit = hasExactlyOnePosition
    ? input.audit.filter((row) => String(row.management?.ticket ?? "") === ticket)
    : [];
  const entryAudit = ticketAudit.find((row) =>
    row.event === "ENTRY_FILLED" || row.event === "PENDING_ENTRY_RECOVERED") ?? null;
  const latestManagement = ticketAudit.find((row) =>
    row.stage === "MANAGING" ||
    /^(?:PLUS6|PLUS10|STRUCTURAL|MANAGEMENT|FVG_HOLD)/.test(row.event)) ?? null;
  const side = position.side === "LONG" ? "BUY" : "SELL";
  const currentPrice = side === "BUY"
    ? finite(input.telemetry.quote?.bid)
    : finite(input.telemetry.quote?.ask);
  const favorableDistance = currentPrice === null
    ? null
    : side === "BUY" ? currentPrice - position.entry : position.entry - currentPrice;
  const floatingPnlUsd = Number(position.profit ?? 0) +
    Number(position.swap ?? 0) + Number(position.commission ?? 0);
  const balance = finite(input.telemetry.health?.accountBalance);
  const floatingPnlPercent = balance !== null && balance > 0
    ? floatingPnlUsd / balance * 100
    : null;
  const entryPlan = entryAudit?.plan;
  const inferredTp1 = side === "BUY" ? position.entry + 10 : position.entry - 10;
  const tp1 = finite(managed?.tp1) ?? finite(entryPlan?.tp1) ?? inferredTp1;
  const brokerTp = finite(position.takeProfit);
  const tp2 = (brokerTp !== null && brokerTp > 0 ? brokerTp : null) ??
    finite(managed?.tp2) ?? finite(entryPlan?.tp2);

  return {
    state: strategy ? "MANAGING" as const : "UNMANAGED" as const,
    count: positions.length,
    strategy,
    ticket,
    side,
    setup: entryAudit?.setup?.pattern ?? managed?.pattern ?? null,
    volume: round(finite(position.volume), 2),
    entry: round(finite(position.entry), 5),
    currentPrice: round(currentPrice, 5),
    stopLoss: round(finite(position.stopLoss), 5),
    takeProfit: round(brokerTp !== null && brokerTp > 0 ? brokerTp : null, 5),
    tp1: round(tp1, 5),
    tp2: round(tp2, 5),
    floatingPnlUsd: round(floatingPnlUsd, 2),
    floatingPnlPercent: round(floatingPnlPercent, 4),
    favorableDistance: round(favorableDistance, 5),
    breakEvenApplied: Boolean(managed?.breakEvenApplied),
    partialApplied: Boolean(managed?.partialApplied),
    openedAt: finite(position.openedAt) ?? finite(managed?.openedAt),
    entryReason: semiManaged
      ? "SEMI manual entry đã được xác minh ownership; bot chỉ tiếp quản Trend management và không tạo entry mới."
      : entryReason(strategy, managed, entryAudit),
    holdReasonCode: canonicalHoldReason(strategy, managed)?.reasonCode ?? null,
    holdReason: canonicalHoldReason(strategy, managed)?.reason
      ?? "Vị thế không thuộc state executor; cần kiểm tra thủ công, không suy đoán lý do giữ.",
  };
}

export function buildPhase7CDecisionMonitor(input: {
  regime: Awaited<ReturnType<typeof getPhase7CLiveRegime>>;
  demo: Phase7BDemoStatus | null;
  telemetry: Mt5TelemetrySnapshot;
  lots: ReturnType<typeof phase7CLotSettingsService.get>;
  audit: DecisionAuditRecord[];
  managedStates?: ManagedRuntimeStates;
  semiAdoptions?: DurableSemiAdoptionState[];
  accountModeState?: Phase7CAccountModeState;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const accountModeState = input.accountModeState ?? getPhase7CAccountModeState();
  const autoTrendModeGate = input.regime.activeMode === "AUTO"
    ? evaluateAutoTrendEntryModeGate({
        activeMode: input.regime.activeMode,
        regime: input.regime,
        demo: input.demo,
      })
    : null;
  const position = positionMonitor({
    ...input,
    activeMode: input.regime.activeMode,
  });
  const requestedStrategy = input.regime.activeMode === "AUTO"
    ? autoTrendModeGate?.allowed === true
      ? "TREND"
      : input.regime.recommendedMode
    : input.regime.activeMode;
  const effectiveStrategy: Strategy | null = input.regime.activeMode === "SEMI"
    ? position.state === "MANAGING" && position.strategy === "TREND"
      ? "TREND"
      : null
    : requestedStrategy === "TREND" || requestedStrategy === "SIDEWAY"
      ? requestedStrategy
      : "PAUSE";
  const preTrade = input.regime.activeMode === "SEMI"
    ? semiManualOnlyDecision(input.regime, now)
    : effectiveStrategy === "TREND"
      ? trendDecision({ ...input, accountModeState, now })
      : effectiveStrategy === "SIDEWAY"
        ? sidewayDecision({ ...input, accountModeState, now })
        : pauseDecision(input.regime, now);

  return {
    version: 1 as const,
    source: "PHASE7C_CANONICAL_DECISION_OBSERVABILITY" as const,
    generatedAt: now,
    symbol: input.regime.symbol,
    engine: {
      source: "MarketRegimeClassifier" as const,
      timeframe: input.regime.timeframe,
      regime: input.regime.regime,
      confidence: input.regime.confidence,
      recommendedMode: input.regime.recommendedMode,
      reversal: input.regime.reversal,
      reasons: input.regime.reasons,
      checkedAt: input.regime.checkedAt,
      lastCandleCloseTime: input.regime.lastCandleCloseTime,
      supplyDemandRange: input.regime.supplyDemandRange,
    },
    mode: {
      active: input.regime.activeMode,
      effectiveStrategy,
      matchesRecommendation: input.regime.modeMatchesRecommendation,
    },
    account: safeAccount(input.telemetry),
    position,
    lotSettings: input.lots,
    preTrade,
    entryDiagnostics: {
      trend: input.demo?.entryDiagnostics ?? null,
      trendError: input.demo?.entryDiagnosticsError ?? null,
    },
    strategyEntryConditions: {
      trend: input.audit.find((row) => row.strategy === "TREND" && row.entryConditions)?.entryConditions ?? null,
      sideway: input.audit.find((row) => row.strategy === "SIDEWAY" && row.entryConditions)?.entryConditions ?? null,
    },
    recentDecisions: input.audit.slice(0, 40).map(({ raw: _raw, ...row }) => row),
    safety: {
      readOnlyEndpoint: true as const,
      accountMode: accountModeState.accountMode,
      accountGuardValid: accountModeState.valid,
      liveExecutionEnabled: accountModeState.liveExecutionEnabled,
      demoOnly: accountModeState.accountMode === "DEMO",
      mt5PanelOrderPermission: "NONE" as const,
      newPositionsOnly: true as const,
      existingPositionMutation: false as const,
      martingale: false as const,
      recoveryLotEscalation: false as const,
    },
  };
}

let cached: { at: number; value: ReturnType<typeof buildPhase7CDecisionMonitor> } | null = null;
let pending: {
  mode: ReturnType<typeof phase7CBotModeService.get>["mode"];
  promise: Promise<ReturnType<typeof buildPhase7CDecisionMonitor>>;
} | null = null;

export async function getPhase7CDecisionMonitor(symbol = "XAUUSD") {
  const now = Date.now();
  const accountModeState = getPhase7CAccountModeState();
  const currentBotMode = phase7CBotModeService.get().mode;
  if (
    cached &&
    now - cached.at <= 2_000 &&
    cached.value.symbol === symbol.toUpperCase() &&
    cached.value.safety.accountMode === accountModeState.accountMode &&
    cached.value.safety.accountGuardValid === accountModeState.valid &&
    cached.value.mode.active === currentBotMode
  ) {
    return cached.value;
  }
  if (pending?.mode === currentBotMode) return pending.promise;

  const request = (async () => {
    const [regime, demo, telemetry, semiAdoptions] = await Promise.all([
      getPhase7CLiveRegime(symbol),
      getPhase7BDemoStatus(),
      getMt5Telemetry(symbol),
      currentBotMode === "SEMI" ? loadSemiAdoptions() : Promise.resolve([]),
    ]);
    const value = buildPhase7CDecisionMonitor({
      regime,
      demo,
      telemetry,
      lots: phase7CLotSettingsService.get(),
      audit: loadAudit(accountModeState),
      managedStates: loadManagedStates(accountModeState),
      semiAdoptions,
      accountModeState,
      now: Date.now(),
    });
    cached = { at: Date.now(), value };
    return value;
  })();
  pending = { mode: currentBotMode, promise: request };

  try {
    return await request;
  } finally {
    if (pending?.promise === request) pending = null;
  }
}

function lineValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "n/a";
  return String(value).replace(/[\r\n]+/g, " ").slice(0, 600);
}

function mt5FlatEntryReason(snapshot: ReturnType<typeof buildPhase7CDecisionMonitor>): string {
  const p = snapshot.preTrade;
  if (!snapshot.safety.accountGuardValid) {
    return "Account-mode state không hợp lệ; executor phải giữ fail-closed và không mở lệnh mới.";
  }
  if (snapshot.mode.active === "SEMI") {
    return "SEMI chỉ cho phép vào lệnh thủ công; bot không tạo lệnh mới. Vị thế MANUAL_SEMI chỉ được Trend management tiếp quản sau khi đã xác minh và PROTECTED/MANAGED.";
  }
  if (snapshot.mode.active === "PAUSE") {
    return "Bot đang PAUSE; không mở lệnh mới. Mở Control Center và nhấn BẬT BOT sau khi hoàn tất kiểm tra an toàn.";
  }
  if (snapshot.lotSettings.restartRequired) {
    return "Cấu hình lot chưa active; hãy khởi động Bot an toàn từ Control Center.";
  }
  if (p.approved) {
    const setup = p.setup ? ` ${p.setup}` : "";
    return `Setup${setup} đã hợp lệ; executor đang xử lý qua các cổng an toàn.`;
  }
  const canonical = cleanReason(p.decisionReason, "Chưa có setup hợp lệ; tiếp tục chờ tín hiệu.");
  if (/sideway is suspected|no qualified supply\/demand/i.test(canonical)) {
    return "Thị trường có dấu hiệu Sideway nhưng chưa có vùng Supply/Demand đạt chuẩn; tiếp tục chờ.";
  }
  return canonical;
}

export function formatPhase7CDecisionMonitorForMt5(
  snapshot: ReturnType<typeof buildPhase7CDecisionMonitor>,
): string {
  const p = snapshot.preTrade;
  const position = snapshot.position;
  const lines: Array<[string, unknown]> = [
    ["version", snapshot.version],
    ["generatedAt", snapshot.generatedAt],
    ["symbol", snapshot.symbol],
    ["accountMode", snapshot.account.accountMode],
    ["configuredAccountMode", snapshot.safety.accountMode],
    ["accountGuardValid", snapshot.safety.accountGuardValid],
    ["activeMode", snapshot.mode.active],
    ["effectiveStrategy", snapshot.mode.effectiveStrategy],
    ["regime", snapshot.engine.regime],
    ["recommendedMode", snapshot.engine.recommendedMode],
    ["confidence", snapshot.engine.confidence],
    ["stage", p.stage],
    ["approved", p.approved],
    ["side", p.side],
    ["setup", p.setup],
    ["entry", p.entry],
    ["stopLoss", p.stopLoss],
    ["stopDistance", p.stopDistance],
    ["rawLot", p.rawLot],
    ["finalLot", p.finalLot],
    ["lotCap", p.lotCap],
    ["riskTargetPercent", p.riskTargetPercent],
    ["estimatedRiskUsd", p.estimatedRiskUsd],
    ["estimatedRiskPercent", p.estimatedRiskPercent],
    ["breakEvenPrice", p.breakEvenPrice],
    ["breakEvenTriggerDistance", p.breakEvenTriggerDistance],
    ["tp1", p.tp1],
    ["tp2", p.tp2],
    ["partial", `${p.partialFraction}@+${p.partialTriggerDistance}`],
    ["limitReason", p.limitReason],
    ["decisionReason", p.decisionReason],
    ["engineReasons", snapshot.engine.reasons.join(" | ")],
    ["positionState", position.state],
    ["positionCount", position.count],
    ["positionStrategy", position.strategy],
    ["ticket", position.ticket],
    ["positionSide", position.side],
    ["positionSetup", position.setup],
    ["positionVolume", position.volume],
    ["positionEntry", position.entry],
    ["currentPrice", position.currentPrice],
    ["positionStopLoss", position.stopLoss],
    ["positionTakeProfit", position.takeProfit],
    ["positionTp1", position.tp1],
    ["positionTp2", position.tp2],
    ["floatingPnlUsd", position.floatingPnlUsd],
    ["floatingPnlPercent", position.floatingPnlPercent],
    ["favorableDistance", position.favorableDistance],
    ["breakEvenApplied", position.breakEvenApplied],
    ["partialApplied", position.partialApplied],
    ["openedAt", position.openedAt],
    ["entryReason", position.state === "FLAT" ? mt5FlatEntryReason(snapshot) : position.entryReason],
    ["holdReasonCode", position.holdReasonCode],
    ["holdReason", position.holdReason],
    ["source", p.source],
    ["mt5OrderPermission", snapshot.safety.mt5PanelOrderPermission],
  ];
  return `${lines.map(([key, value]) => `${key}=${lineValue(value)}`).join("\n")}\n`;
}
