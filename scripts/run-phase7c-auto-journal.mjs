import fs from "node:fs";
import path from "node:path";

const controlApiBase = (process.env.ZIQ_PHASE7C_CONTROL_API_URL || "http://127.0.0.1:3711").trim().replace(/\/$/, "");
const symbol = (process.env.ZIQ_PHASE7C_REGIME_SYMBOL || "XAUUSD").trim().toUpperCase();
const candleCount = clampInteger(process.env.ZIQ_PHASE7C_REGIME_CANDLE_COUNT, 320, 220, 1000);
const intervalMs = clampInteger(process.env.ZIQ_PHASE7C_AUTO_JOURNAL_INTERVAL_MS, 15_000, 5_000, 300_000);
const once = truthy(process.env.ZIQ_PHASE7C_AUTO_JOURNAL_ONCE);
const workDir = path.resolve(process.env.ZIQ_PHASE7C_AUTO_JOURNAL_WORK_DIR || path.join(".runtime", "phase7c-executors"));
const journalPath = path.join(workDir, "auto-decisions.jsonl");
const statePath = path.join(workDir, "auto-journal-state.json");

fs.mkdirSync(workDir, { recursive: true });
let state = loadState();
let lastError = "";

console.log("PHASE7C_AUTO_JOURNAL=RUNNING");
console.log(`PHASE7C_AUTO_JOURNAL_API=${controlApiBase}`);
console.log(`PHASE7C_AUTO_JOURNAL_SYMBOL=${symbol}`);
console.log(`PHASE7C_AUTO_JOURNAL_INTERVAL_MS=${intervalMs}`);
console.log(`PHASE7C_AUTO_JOURNAL_FILE=${journalPath}`);
console.log("PHASE7C_AUTO_JOURNAL_MT5_ORDER_PERMISSION=NONE");

while (true) {
  const startedAt = Date.now();
  try {
    const [modePayload, regime] = await Promise.all([
      apiGet("/api/v1/phase7c/bot-mode"),
      apiGet(`/api/v1/phase7c/live-regime?symbol=${encodeURIComponent(symbol)}&count=${candleCount}`),
    ]);

    const snapshot = normalizeSnapshot(modePayload, regime, startedAt);
    const reasons = decisionReasons(snapshot, state);
    if (lastError) {
      reasons.push("RECOVERED_AFTER_ERROR");
      lastError = "";
    }

    if (reasons.length > 0) {
      appendJournal({ ...snapshot, reasons });
      console.log(
        `PHASE7C_AUTO_DECISION=${snapshot.regime}|RECOMMENDED=${snapshot.recommendedMode}|ACTIVE=${snapshot.activeMode}|CONFIDENCE=${snapshot.confidence}|REASONS=${reasons.join(",")}`,
      );
    }

    state = {
      activeMode: snapshot.activeMode,
      regime: snapshot.regime,
      recommendedMode: snapshot.recommendedMode,
      confidence: snapshot.confidence,
      lastCandleCloseTime: snapshot.lastCandleCloseTime,
      updatedAt: snapshot.timestamp,
    };
    saveState(state);
  } catch (error) {
    const message = errorMessage(error);
    if (message !== lastError) {
      appendJournal({
        timestamp: Date.now(),
        timestampIso: new Date().toISOString(),
        symbol,
        type: "AUTO_JOURNAL_ERROR",
        message,
      });
      console.error(`PHASE7C_AUTO_JOURNAL_ERROR=${message}`);
      lastError = message;
    }
  }

  if (once) break;
  const elapsed = Date.now() - startedAt;
  await sleep(Math.max(1_000, intervalMs - elapsed));
}

function normalizeSnapshot(modePayload, regime, now) {
  const activeMode = String(modePayload?.state?.mode ?? regime?.activeMode ?? "PAUSE").toUpperCase();
  const recommendedMode = String(regime?.recommendedMode ?? "PAUSE").toUpperCase();
  return {
    timestamp: now,
    timestampIso: new Date(now).toISOString(),
    type: "AUTO_DECISION",
    symbol,
    activeMode,
    regime: String(regime?.regime ?? "UNCERTAIN").toUpperCase(),
    recommendedMode,
    confidence: finiteNumber(regime?.confidence),
    engineReasons: Array.isArray(regime?.reasons) ? regime.reasons.map(String) : [],
    engineSource: "MarketRegimeClassifier",
    modeMatchesRecommendation: activeMode === recommendedMode,
    lastCandleCloseTime: finiteNumber(regime?.lastCandleCloseTime),
    metrics: regime?.metrics ?? null,
    supplyDemandRange: regime?.supplyDemandRange ?? null,
    modeUpdatedAt: modePayload?.state?.updatedAt ?? null,
    modeUpdatedBy: modePayload?.state?.updatedBy ?? null,
  };
}

function decisionReasons(snapshot, previous) {
  const reasons = [];
  if (!previous || !previous.regime) {
    reasons.push("INITIAL");
    return reasons;
  }
  if (snapshot.activeMode !== previous.activeMode) reasons.push("ACTIVE_MODE_CHANGED");
  if (snapshot.regime !== previous.regime) reasons.push("REGIME_CHANGED");
  if (snapshot.recommendedMode !== previous.recommendedMode) reasons.push("RECOMMENDATION_CHANGED");
  if (snapshot.lastCandleCloseTime !== previous.lastCandleCloseTime) reasons.push("M15_CLOSED");
  return reasons;
}

async function apiGet(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${controlApiBase}${endpoint}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Phase7C API ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function appendJournal(row) {
  fs.appendFileSync(journalPath, `${JSON.stringify(row)}\n`, "utf8");
}

function loadState() {
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function saveState(next) {
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, statePath);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(raw, fallback, min, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
