import { pauseDailyRecoveryForNewEntry, assertDailyRecoveryPausedBeforeSend } from "./phase7c-daily-recovery-pause.mjs";
const SUBMISSION_REGISTRY = Symbol.for("xauusd.phase7c.canonicalDailyRecoverySubmissions");
const STRATEGY_NATIVE_MODE = Object.freeze({
  TREND: "TREND",
  SIDEWAY: "SIDEWAY_NATIVE",
});

function registry() {
  if (!globalThis[SUBMISSION_REGISTRY]) globalThis[SUBMISSION_REGISTRY] = new Map();
  return globalThis[SUBMISSION_REGISTRY];
}

function canonicalControlApiBase(env = process.env) {
  return (env.ZIQ_PHASE7C_CONTROL_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Canonical Daily Recovery ${label} is invalid.`);
  return number;
}

function strategyName(value) {
  const strategy = String(value ?? "").trim().toUpperCase();
  if (!Object.hasOwn(STRATEGY_NATIVE_MODE, strategy)) {
    throw new Error(`Canonical Daily Recovery strategy is invalid: ${strategy || "missing"}.`);
  }
  return strategy;
}

function normalizeCanonicalView(view, { strategy, volume }) {
  if (!view || typeof view !== "object") throw new Error("Canonical Daily Recovery response is unavailable.");
  if (view.readOnly !== true || !/^MT5_(?:LIVE|DEMO)_READ_ONLY$/.test(String(view.source ?? ""))) {
    throw new Error("Canonical Daily Recovery provenance is invalid.");
  }

  const dailyNetPnl = finiteNumber(view.dailyNetPnl, "dailyNetPnl");
  const dayStartTime = finiteNumber(view.dayStartTime, "dayStartTime");
  if (!(dayStartTime > 0)) throw new Error("Canonical Daily Recovery dayStartTime is invalid.");

  const dailyMode = String(view.dailyMode ?? "").toUpperCase();
  const expectedDailyMode = dailyNetPnl < 0 ? "RECOVERY_TP" : "NORMAL";
  if (dailyMode !== expectedDailyMode) {
    throw new Error(`Canonical Daily Recovery sign/mode mismatch: pnl=${dailyNetPnl};mode=${dailyMode || "missing"}.`);
  }

  const preview = view.preview;
  if (!preview || typeof preview !== "object") throw new Error("Canonical Daily Recovery preview is unavailable.");
  const actualVolume = finiteNumber(preview.volume, "preview.volume");
  if (Math.abs(actualVolume - volume) > 1e-9) {
    throw new Error(`Canonical Daily Recovery volume mismatch: requested=${volume};actual=${actualVolume}.`);
  }

  const requiredUsd = finiteNumber(preview.requiredUsd, "preview.requiredUsd");
  let rawTpDistance;
  let tpDistance;
  if (dailyMode === "RECOVERY_TP") {
    rawTpDistance = finiteNumber(preview.rawTpDistance, "preview.rawTpDistance");
    tpDistance = finiteNumber(preview.tpDistance, "preview.tpDistance");
    if (!(requiredUsd > 0) || !(rawTpDistance > 0) || !(tpDistance > 0)) {
      throw new Error("Canonical Daily Recovery recovery preview is invalid.");
    }
  } else {
    if (preview.rawTpDistance !== null || preview.tpDistance !== null || requiredUsd !== 0) {
      throw new Error("Canonical Daily Recovery positive/flat day returned a recovery preview.");
    }
    rawTpDistance = 0;
    tpDistance = 0;
  }

  const targetNetPnl = finiteNumber(view?.strategy?.targetNetUsd, "strategy.targetNetUsd");
  const dealCount = Math.max(0, Math.trunc(finiteNumber(view.dealCount, "dealCount")));
  const internalMode = dailyMode === "RECOVERY_TP" ? "RECOVERY_TP" : STRATEGY_NATIVE_MODE[strategy];

  return Object.freeze({
    mode: internalMode,
    canonicalDailyMode: dailyMode,
    dayStartTime,
    dailyNetPnl,
    targetNetPnl,
    requiredUsd,
    rawTpDistance,
    tpDistance,
    canRecoverInOneTrade: Boolean(preview.canRecoverInOneTrade),
    dealCount,
    actualVolume,
    source: String(view.source),
    readOnly: true,
  });
}

export async function fetchPhase7CCanonicalDailyRecoveryPlan({
  strategy: rawStrategy,
  symbol,
  volume: rawVolume,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const strategy = strategyName(rawStrategy);
  const volume = finiteNumber(rawVolume, "requested volume");
  if (!(volume > 0)) throw new Error("Canonical Daily Recovery requested volume must be positive.");
  if (typeof fetchImpl !== "function") throw new Error("Canonical Daily Recovery fetch implementation is unavailable.");

  const normalizedSymbol = String(symbol ?? "XAUUSD").trim().toUpperCase() || "XAUUSD";
  const url = `${canonicalControlApiBase(env)}/api/v1/phase7c/daily-recovery?symbol=${encodeURIComponent(normalizedSymbol)}&volume=${encodeURIComponent(volume)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Canonical Daily Recovery HTTP ${response.status}: ${text.slice(0, 300)}`);
    let view;
    try {
      view = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Canonical Daily Recovery returned invalid JSON.");
    }
    return pauseDailyRecoveryForNewEntry(strategy, normalizeCanonicalView(view, { strategy, volume }));
  } finally {
    clearTimeout(timeout);
  }
}

export function registerPhase7CCanonicalDailyRecoverySubmission({
  strategy: rawStrategy,
  clientOrderId,
  volume: rawVolume,
  plan,
} = {}) {
  const strategy = strategyName(rawStrategy);
  const orderId = String(clientOrderId ?? "").trim();
  const volume = finiteNumber(rawVolume, "submission volume");
  if (!orderId || !(volume > 0)) throw new Error("Canonical Daily Recovery submission identity is invalid.");
  if (!plan || typeof plan !== "object") throw new Error("Canonical Daily Recovery submission plan is unavailable.");
  assertDailyRecoveryPausedBeforeSend(strategy, plan);
  registry().set(strategy, Object.freeze({ orderId, volume, plan }));
}

function parseRequestBody(body) {
  if (typeof body !== "string" || !body.trim()) throw new Error("Canonical Daily Recovery final gate cannot verify broker request body.");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Canonical Daily Recovery final gate broker request body is invalid JSON.");
  }
}

function plansEquivalent(planned, current) {
  return planned?.mode === current?.mode &&
    planned?.canonicalDailyMode === current?.canonicalDailyMode &&
    Number(planned?.dayStartTime) === Number(current?.dayStartTime) &&
    Math.abs(Number(planned?.dailyNetPnl) - Number(current?.dailyNetPnl)) <= 1e-6 &&
    Math.abs(Number(planned?.tpDistance) - Number(current?.tpDistance)) <= 1e-6 &&
    Math.abs(Number(planned?.actualVolume) - Number(current?.actualVolume)) <= 1e-9;
}

export async function verifyPhase7CCanonicalDailyRecoverySubmission({
  strategy: rawStrategy,
  requestBody,
  fetchImpl,
  env = process.env,
} = {}) {
  const strategy = strategyName(rawStrategy);
  const request = parseRequestBody(requestBody);
  const orderId = String(request.clientOrderId ?? "").trim();
  const volume = finiteNumber(request.volume, "final broker volume");
  if (!orderId || !(volume > 0)) throw new Error("Canonical Daily Recovery final broker identity is invalid.");

  const key = strategy;
  const submission = registry().get(key);
  registry().delete(key);
  if (!submission) throw new Error(`Canonical Daily Recovery ${strategy} submission snapshot is missing.`);
  if (submission.orderId !== orderId || Math.abs(submission.volume - volume) > 1e-9) {
    throw new Error(`Canonical Daily Recovery ${strategy} submission snapshot does not match broker request.`);
  }

  const current = await fetchPhase7CCanonicalDailyRecoveryPlan({
    strategy,
    symbol: request.symbol,
    volume,
    fetchImpl,
    env,
  });

  // Defense in depth against stale or manually injected recovery snapshots.
  assertDailyRecoveryPausedBeforeSend(strategy, submission.plan);
  assertDailyRecoveryPausedBeforeSend(strategy, current);

  if (!plansEquivalent(submission.plan, current)) {
    throw new Error(
      `Canonical Daily Recovery changed before SEND: planned=${submission.plan?.canonicalDailyMode ?? submission.plan?.mode ?? "UNKNOWN"};current=${current.canonicalDailyMode};plannedPnl=${submission.plan?.dailyNetPnl};currentPnl=${current.dailyNetPnl}.`,
    );
  }

  if (current.dailyNetPnl >= 0 && current.canonicalDailyMode !== "NORMAL") {
    throw new Error("Canonical positive/flat day attempted Recovery before SEND.");
  }
  if (current.dailyNetPnl < 0 && current.canonicalDailyMode !== "RECOVERY_TP") {
    throw new Error("Canonical negative day lost Recovery before SEND.");
  }

  return current;
}
