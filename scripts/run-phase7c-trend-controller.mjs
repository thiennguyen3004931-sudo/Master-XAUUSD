import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { acquireExecutionLock } from "./phase7c-execution-lock.mjs";
import { acquireRuntimeSingleton } from "./phase7c-runtime-singleton-lock.mjs";
import { evaluateAutoTrendEntryModeGate } from "./phase7c-trend-mode-gate.mjs";
import { evaluateLiveAutoReversalEntryLock } from "./phase7c-auto-live-reversal-lock.mjs";
import { createPhase7CDecisionAudit } from "./phase7c-decision-audit.mjs";
import { recordTrendEntryAttributionBestEffort } from "./phase7c-trend-entry-attribution.mjs";
import { transformPhase7CTrendM5TrailingSource } from "./phase7c-m5-structural-trailing-source-adapter.mjs";
import { transformPhase7CTrendM5PreStructureProfitLockSource } from "./phase7c-m5-prestructure-profit-lock-source-adapter.mjs";
import { transformPhase7CSemiTrendRuntimeSource } from "./phase7c-semi-trend-runtime-source-adapter.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);
const controlApiBase = (process.env.ZIQ_PHASE7C_CONTROL_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
const regimeSymbol = process.env.ZIQ_PHASE7C_REGIME_SYMBOL?.trim().toUpperCase() || process.env.ZIQ_DEMO_SYMBOL?.trim().toUpperCase() || "XAUUSD";
const regimeCandleCount = clampInt(process.env.ZIQ_PHASE7C_REGIME_CANDLE_COUNT, 320, 220, 1000);
const trendFinalPermissionAudit = createPhase7CDecisionAudit({
  strategy: "TREND",
  symbol: regimeSymbol,
});
const trendRuntimeArmed = /^(1|true|yes|on)$/i.test(
  process.env.ZIQ_DEMO_ARMED ?? "false",
);
const trendRuntimeIntervalSeconds = clampInt(
  process.env.ZIQ_DEMO_INTERVAL_SECONDS,
  5,
  1,
  60,
);
const trendRuntimeStartedAt = Date.now();
const trendRuntimeOwnershipFile =
  process.env.ZIQ_PHASE7C_TREND_RUNTIME_LOCK?.trim() ||
  (process.env.ZIQ_PHASE7C_EXECUTION_LOCK?.trim()
    ? path.join(
        path.dirname(process.env.ZIQ_PHASE7C_EXECUTION_LOCK.trim()),
        "phase7c-trend-runtime.lock",
      )
    : path.resolve(
        ".runtime",
        "phase7c-executors",
        "phase7c-trend-runtime.lock",
      ));
const trendRuntimeOwnership = acquireRuntimeSingleton({
  file: trendRuntimeOwnershipFile,
  owner: "TREND",
});
if (!trendRuntimeOwnership.acquired) {
  const currentPid = Number(trendRuntimeOwnership.current?.pid);
  throw new Error(
    "Phase 7C Trend runtime single-writer ownership blocked: " +
      trendRuntimeOwnership.reason +
      (Number.isSafeInteger(currentPid) && currentPid > 0
        ? `|OWNER_PID=${currentPid}`
        : ""),
  );
}
process.once("exit", () => {
  try {
    trendRuntimeOwnership.release();
  } catch {
    // Best-effort cleanup. A dead-owner lock is recovered by the next process.
  }
});
console.log(
  `PHASE7C_TREND_SINGLETON=ACQUIRED|PID=${process.pid}|FILE=${trendRuntimeOwnership.file}`,
);

startTrendRuntimeHeartbeat();

console.log("PHASE7C_TREND_ENTRY_GATE=ENABLED");
console.log(`PHASE7C_CONTROL_API=${controlApiBase}`);
console.log(`PHASE7C_REGIME_SYMBOL=${regimeSymbol}`);
console.log("PHASE7C_GATE_SCOPE=POST_/v1/orders_ONLY");
console.log("PHASE7C_POSITION_MANAGEMENT=PASS_THROUGH");
console.log("PHASE7C_EXECUTION_LOCK=ENABLED");

globalThis.fetch = async function phase7CTrendGate(input, init = undefined) {
  const request = toRequestInfo(input, init);
  if (!isNewOrderRequest(request)) {
    return nativeFetch(input, init);
  }

  const lock = acquireExecutionLock({ owner: "TREND" });
  if (!lock.acquired) {
    console.warn(`PHASE7C_TREND_ENTRY_BLOCKED=EXECUTION_LOCK_BUSY|DETAIL=${lock.reason}`);
    return blockedResponse({
      allowed: false,
      activeMode: "UNKNOWN",
      recommendedMode: null,
      reason: "EXECUTION_LOCK_BUSY",
      detail: lock.reason,
    });
  }

  try {
    const decision = await evaluateTrendEntryPermission(request);
    if (decision.activeMode === "SEMI") {
      const semiDecision = {
        ...decision,
        allowed: false,
        recommendedMode: null,
        reason: "SEMI_MANUAL_ENTRY_ONLY",
      };
      console.warn("PHASE7C_TREND_ENTRY_BLOCKED=SEMI_MANUAL_ENTRY_ONLY|ACTIVE_SEMI");
      return blockedResponse(semiDecision);
    }
    if (!decision.allowed) {
      console.warn(
        `PHASE7C_TREND_ENTRY_BLOCKED=${decision.reason}|ACTIVE_${decision.activeMode}|RECOMMENDED_${decision.recommendedMode ?? "N/A"}`,
      );
      return blockedResponse(decision);
    }

    // The Phase 7B controller checked positions before it reached this fetch,
    // but Sideway runs concurrently. Re-check under the shared lock so a
    // regime transition cannot produce one Trend and one Sideway order.
    const positions = await fetchOpenPositionsUnderLock(request);
    if (positions.length > 0) {
      console.warn(`PHASE7C_TREND_ENTRY_BLOCKED=POSITION_PRESENT_UNDER_LOCK|COUNT=${positions.length}`);
      return blockedResponse({
        allowed: false,
        activeMode: decision.activeMode,
        recommendedMode: decision.recommendedMode,
        reason: "POSITION_PRESENT_UNDER_LOCK",
        detail: `Open ${regimeSymbol} positions=${positions.length}`,
      });
    }

    const finalModePayload = await controlRequest("/api/v1/phase7c/bot-mode");
    const finalMode = String(finalModePayload?.state?.mode ?? "PAUSE").toUpperCase();
    if (finalMode !== decision.activeMode) {
      console.warn(
        `PHASE7C_TREND_ENTRY_BLOCKED=BOT_MODE_CHANGED_BEFORE_BROKER_SUBMIT|INITIAL_${decision.activeMode}|FINAL_${finalMode}`,
      );
      return blockedResponse({
        allowed: false,
        activeMode: finalMode,
        recommendedMode: finalMode === "PAUSE" ? "PAUSE" : null,
        reason: "BOT_MODE_CHANGED_BEFORE_BROKER_SUBMIT",
        detail: `initial=${decision.activeMode};final=${finalMode}`,
      });
    }

    recordTrendEntryAttributionBestEffort({
      audit: trendFinalPermissionAudit,
      decision,
      requestBody: request.body,
    });

    console.log(
      `PHASE7C_TREND_ENTRY_ALLOWED=MODE_${decision.activeMode}|RECOMMENDED_${decision.recommendedMode ?? "N/A"}|REASON_${decision.reason}`,
    );
    return await nativeFetch(input, init);
  } catch (error) {
    const message = errorMessage(error);
    console.error(`PHASE7C_TREND_ENTRY_BLOCKED=CONTROL_OR_LOCK_RECHECK_ERROR|DETAIL=${message}`);
    return blockedResponse({
      allowed: false,
      activeMode: "UNKNOWN",
      recommendedMode: null,
      reason: "CONTROL_OR_LOCK_RECHECK_ERROR_FAIL_CLOSED",
      detail: message,
    });
  } finally {
    lock.release();
  }
};

process.env.ZIQ_PHASE7C_REVERSAL_ENTRY_ENABLED = "true";
process.env.ZIQ_PHASE7C_CONTROL_API_URL = controlApiBase;
console.log("PHASE7C_REVERSAL_ENTRY_POLICY=CHOCH_DIRECTION_PATTERN_STRUCTURE_NO_SUPERTREND");

await importLegacyTrendController();

async function importLegacyTrendController() {
  // `tsx` resolves .ts files according to the repository's CommonJS package
  // context. The legacy controller intentionally uses top-level await, which
  // cannot be transformed to CJS. Transpile only its TypeScript syntax to ESM
  // in memory, then import it in this same process so the Phase 7C fetch gate
  // and execution lock remain active around every new-order request.
  const sourceUrl = new URL("./run-phase7b-demo-controller.ts", import.meta.url);
  let source = fs.readFileSync(sourceUrl, "utf8");
  source = transformPhase7CTrendM5TrailingSource(source);
  source = transformPhase7CTrendM5PreStructureProfitLockSource(source);
  source = transformPhase7CSemiTrendRuntimeSource(source);
  const transformed = ts.transpileModule(source, {
    fileName: "run-phase7b-demo-controller.ts",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: false,
    },
  });

  const errors = (transformed.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const detail = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join(" | ");
    throw new Error(`Legacy Trend TypeScript transpile failed: ${detail}`);
  }

  const sourceLabel = sourceUrl.href.replace(/\s/g, "%20");

  // Execute the transpiled legacy Trend controller from a real file URL.
  // A data: URL has no hierarchical filesystem base, so Node cannot
  // resolve workspace packages such as @xauusd/risk-engine from it.
  const runtimeUrl = new URL(
    `./.phase7c-trend-legacy-runtime-${process.pid}.mjs`,
    import.meta.url,
  );

  const riskEngineUrl = new URL(
    "../packages/risk-engine/dist/index.js",
    import.meta.url,
  ).href;
  const entryBlockClassifierUrl = new URL(
    "./phase7c-trend-entry-block.mjs",
    import.meta.url,
  ).href;

  // The temporary legacy runtime lives under scripts/, while the root
  // workspace does not expose @xauusd/risk-engine in root node_modules.
  // Rewrite only this known runtime dependency to the already-built ESM file.
  const previewCompleteSentinel = "__PHASE7C_TREND_PREVIEW_COMPLETE__";

  const runtimeOutput = transformed.outputText
    .replaceAll(
      '"@xauusd/risk-engine"',
      JSON.stringify(riskEngineUrl),
    )
    .replaceAll(
      "'@xauusd/risk-engine'",
      JSON.stringify(riskEngineUrl),
    )
    // The legacy preview path uses process.exit(0). Because this controller
    // is imported into the Phase 7C/tsx host, forcing process termination can
    // abort while loader handles are closing. Convert only the successful
    // preview exit into a sentinel unwind handled below.
    .replaceAll(
      "process.exit(0);",
      `throw new Error("${previewCompleteSentinel}");`,
    );

  // The legacy bridge client intentionally throws on every non-2xx response.
  // Phase 7C's final entry gate uses HTTP 423 for a normal policy decision,
  // not for an MT5/data failure. Canonicalize only that exact error at the
  // outer cycle boundary. Any other bridge/network error remains CYCLE_ERROR.
  const cycleErrorHandlerPattern = /catch \(error\) \{\s*journal\("CYCLE_ERROR", \{ message: errorMessage\(error\) \}\);\s*console\.error\(`PHASE7B_DEMO_CYCLE_ERROR=\$\{errorMessage\(error\)\}`\);\s*\}/;
  const classifiedRuntimeOutput = runtimeOutput.replace(
    cycleErrorHandlerPattern,
    `catch (error) {
        const entryBlock = classifyPhase7CTrendEntryBlock(error);
        if (entryBlock) {
            journal("ENTRY_MODE_BLOCKED", entryBlock);
            console.warn("PHASE7B_DEMO_ENTRY_MODE_BLOCKED=" + entryBlock.reasonCode + "|ACTIVE_" + (entryBlock.activeMode ?? "UNKNOWN") + "|RECOMMENDED_" + (entryBlock.recommendedMode ?? "N/A"));
        }
        else {
            journal("CYCLE_ERROR", { message: errorMessage(error) });
            console.error("PHASE7B_DEMO_CYCLE_ERROR=" + errorMessage(error));
        }
    }`,
  );

  if (classifiedRuntimeOutput === runtimeOutput) {
    throw new Error(
      "Legacy Trend cycle-error classifier patch did not match the transpiled controller.",
    );
  }

  const runtimeSource =
    `import { classifyPhase7CTrendEntryBlock } from ${JSON.stringify(entryBlockClassifierUrl)};\n` +
    `${classifiedRuntimeOutput}\n//# sourceURL=${sourceLabel}\n`;

  fs.writeFileSync(runtimeUrl, runtimeSource, "utf8");

  console.log("PHASE7C_TREND_LEGACY_TRANSPILE=ESM");
  console.log(`PHASE7C_TREND_LEGACY_RUNTIME=${runtimeUrl.href}`);
  console.log("PHASE7C_TREND_EXPECTED_MODE_BLOCK_CLASSIFICATION=ENABLED");

  try {
    await import(`${runtimeUrl.href}?pid=${process.pid}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === previewCompleteSentinel
    ) {
      console.log("PHASE7C_TREND_PREVIEW_COMPLETE=PASS");
      return;
    }

    throw error;
  } finally {
    try {
      fs.unlinkSync(runtimeUrl);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function trendRuntimeFilePath() {
  const workDir =
    process.env.ZIQ_DEMO_WORK_DIR?.trim() ?? "";

  return workDir
    ? path.join(workDir, "phase7b-demo-runtime.json")
    : null;
}

function writeTrendRuntimeState(
  status,
  armed,
  requireOwnership = false,
) {
  const runtimePath = trendRuntimeFilePath();
  if (!runtimePath) return;

  if (
    requireOwnership &&
    fs.existsSync(runtimePath)
  ) {
    try {
      const current = JSON.parse(
        fs.readFileSync(runtimePath, "utf8")
          .replace(/^\uFEFF/, ""),
      );

      if (Number(current?.pid) !== process.pid) {
        return;
      }
    } catch {
      return;
    }
  }

  const payload = {
    version: 1,
    status,
    armed,
    pid: process.pid,
    heartbeatAt: Date.now(),
    startedAt: trendRuntimeStartedAt,
    intervalSeconds: trendRuntimeIntervalSeconds,
  };

  fs.mkdirSync(
    path.dirname(runtimePath),
    { recursive: true },
  );

  const tempPath =
    runtimePath +
    "." +
    process.pid +
    ".tmp";

  fs.writeFileSync(
    tempPath,
    JSON.stringify(payload, null, 2),
    "utf8",
  );

  fs.renameSync(
    tempPath,
    runtimePath,
  );
}

function startTrendRuntimeHeartbeat() {
  if (!trendRuntimeArmed) {
    console.log(
      "PHASE7C_TREND_RUNTIME_HEARTBEAT=OFF_NOT_ARMED",
    );
    return;
  }

  const runtimePath = trendRuntimeFilePath();

  if (!runtimePath) {
    throw new Error(
      "Phase 7C Trend runtime heartbeat requires ZIQ_DEMO_WORK_DIR.",
    );
  }

  writeTrendRuntimeState(
    "RUNNING",
    true,
  );

  const heartbeatMs =
    Math.max(
      1000,
      Math.min(
        trendRuntimeIntervalSeconds,
        5,
      ) * 1000,
    );

  const heartbeatTimer = setInterval(
    () => {
      try {
        writeTrendRuntimeState(
          "RUNNING",
          true,
        );
      } catch (error) {
        console.error(
          "PHASE7C_TREND_RUNTIME_HEARTBEAT_ERROR=" +
            errorMessage(error),
        );
      }
    },
    heartbeatMs,
  );

  heartbeatTimer.unref();

  process.once(
    "exit",
    () => {
      try {
        writeTrendRuntimeState(
          "STOPPED",
          false,
          true,
        );
      } catch {
        // Best-effort only.
      }
    },
  );

  console.log(
    "PHASE7C_TREND_RUNTIME_STATE=" +
      runtimePath,
  );

  console.log(
    "PHASE7C_TREND_RUNTIME_HEARTBEAT=ON" +
      "|PID=" +
      process.pid +
      "|INTERVAL_MS=" +
      heartbeatMs,
  );
}

async function evaluateTrendEntryPermission(request) {
  const modePayload = await controlRequest("/api/v1/phase7c/bot-mode");
  const activeMode = String(modePayload?.state?.mode ?? "PAUSE").toUpperCase();
  const orderEvidence = reversalOrderGateDiagnostics(request?.body);

  if (orderEvidence.reversalOrigin && activeMode !== "AUTO") {
    return {
      allowed: false,
      activeMode,
      recommendedMode: null,
      reason: "REVERSAL_CONTEXT_CHANGED_BEFORE_SUBMIT",
      detail: `REVERSAL-origin order requires AUTO at final submit; actual mode=${activeMode}.`,
    };
  }

  if (activeMode === "TREND") {
    return {
      allowed: true,
      activeMode,
      recommendedMode: null,
      reason: "MANUAL_TREND_MODE",
    };
  }

  if (activeMode === "SIDEWAY") {
    return {
      allowed: false,
      activeMode,
      recommendedMode: "SIDEWAY",
      reason: "SIDEWAY_MODE_BLOCKS_TREND_ENTRY",
    };
  }

  if (activeMode === "SEMI") {
    return {
      allowed: false,
      activeMode,
      recommendedMode: null,
      reason: "SEMI_MANUAL_ENTRY_ONLY",
    };
  }

  if (activeMode === "PAUSE") {
    return {
      allowed: false,
      activeMode,
      recommendedMode: "PAUSE",
      reason: "PAUSE_MODE_BLOCKS_NEW_ENTRY",
    };
  }

  if (activeMode !== "AUTO") {
    return {
      allowed: false,
      activeMode,
      recommendedMode: null,
      reason: "INVALID_MODE_FAIL_CLOSED",
    };
  }

  const query = new URLSearchParams({
    symbol: regimeSymbol,
    count: String(regimeCandleCount),
  });
  const [regime, demo] = await Promise.all([
    controlRequest(`/api/v1/phase7c/live-regime?${query.toString()}`),
    controlRequest("/api/v1/phase7b-demo"),
  ]);

  const finalRegime = String(regime?.regime ?? "").toUpperCase();
  // Enforce the operator-approved LIVE AUTO reversal lock at the final POST gate.
  // Deny BOTH canonical reversal orders and any order while regime=REVERSAL.
  // Existing positions and management requests remain untouched.
  const liveReversalLock = evaluateLiveAutoReversalEntryLock({
    activeMode,
    regime: finalRegime,
    reversalOrigin: orderEvidence.reversalOrigin,
  });
  if (!liveReversalLock.allowed) {
    return {
      allowed: false,
      activeMode,
      recommendedMode: String(regime?.recommendedMode ?? "PAUSE").toUpperCase(),
      reason: liveReversalLock.reason,
      detail: liveReversalLock.detail,
    };
  }
  if (orderEvidence.reversalOrigin && finalRegime !== "REVERSAL") {
    return {
      allowed: false,
      activeMode,
      recommendedMode: String(regime?.recommendedMode ?? "PAUSE").toUpperCase(),
      reason: "REVERSAL_CONTEXT_CHANGED_BEFORE_SUBMIT",
      detail: `REVERSAL-origin order requires REVERSAL at final submit; actual regime=${finalRegime || "UNKNOWN"}.`,
    };
  }

  const gateDemo = finalRegime === "REVERSAL"
    ? orderEvidence.demo
    : demo;

  return evaluateAutoTrendEntryModeGate({
    activeMode,
    regime,
    demo: gateDemo,
  });
}

function reversalOrderGateDiagnostics(rawBody) {
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = null;
  }

  const side = String(body?.side ?? "").trim().toUpperCase();
  const clientOrderId = String(body?.clientOrderId ?? "").trim();
  const idempotencyKey = String(body?.idempotencyKey ?? "").trim();
  const requestedPrice = Number(body?.requestedPrice);
  const stopLoss = Number(body?.stopLoss);
  const match = /^p7b-(rv-)?(?:pb|im)-(\d+)-(BUY|SELL)$/.exec(clientOrderId);
  const reversalOrigin = match?.[1] === "rv-";
  const signalTimestamp = match ? Number(match[2]) : null;
  const idSide = match?.[3] ?? "";
  const structuralStopDistance =
    side === "BUY" && Number.isFinite(requestedPrice) && Number.isFinite(stopLoss)
      ? requestedPrice - stopLoss
      : side === "SELL" && Number.isFinite(requestedPrice) && Number.isFinite(stopLoss)
        ? stopLoss - requestedPrice
        : NaN;
  const canonicalOrderEvidence = Boolean(
    reversalOrigin &&
    (side === "BUY" || side === "SELL") &&
    idSide === side &&
    idempotencyKey === clientOrderId &&
    Number.isFinite(signalTimestamp) &&
    signalTimestamp > 0 &&
    Number.isFinite(structuralStopDistance) &&
    structuralStopDistance + 1e-9 >= 6 &&
    structuralStopDistance <= 10 + 1e-9
  );

  return {
    reversalOrigin,
    demo: {
      entryDiagnostics: {
      closeTime: signalTimestamp,
      pattern: {
        matched: canonicalOrderEvidence,
        side: side === "BUY" || side === "SELL" ? side : null,
        name: canonicalOrderEvidence ? "CANONICAL_RUNTIME_SIGNAL" : null,
      },
      entry: {
        eligible: false,
        reversalEligible: canonicalOrderEvidence,
        side: side === "BUY" || side === "SELL" ? side : null,
        structuralStopDistance: Number.isFinite(structuralStopDistance)
          ? structuralStopDistance
          : null,
        reversalStopDistance: canonicalOrderEvidence
          ? structuralStopDistance
          : null,
        },
      },
    },
  };
}

async function fetchOpenPositionsUnderLock(request) {
  const requestUrl = new URL(request.url);
  const query = new URLSearchParams({ symbol: regimeSymbol });
  const response = await nativeFetch(`${requestUrl.origin}/v1/positions?${query.toString()}`, {
    method: "GET",
    headers: request.headers,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MT5 bridge position recheck ${response.status}: ${text}`);
  }
  const parsed = text ? JSON.parse(text) : [];
  if (!Array.isArray(parsed)) throw new Error("MT5 bridge position recheck did not return an array.");
  return parsed;
}

async function controlRequest(pathname) {
  const timeoutMs = 5_000;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response;
      try {
        response = await nativeFetch(`${controlApiBase}${pathname}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
          cache: "no-store",
        });
      } catch (error) {
        const errorObject = error instanceof Error ? error : null;
        const aborted = timedOut || errorObject?.name === "AbortError";
        const reason = aborted
          ? `timeout=${timeoutMs}ms`
          : `transport=${errorObject?.message === "fetch failed" ? "fetch failed" : errorObject?.name || "request failed"}`;

        if (attempt < maxAttempts) {
          console.warn(
            `PHASE7C_TREND_CONTROL_READ_RETRY=GET|${pathname}|attempt=${attempt}|reason=${reason}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }

        throw new Error(
          `Phase7C control API GET ${pathname} | ${reason} | attempts=${attempt}`,
          errorObject ? { cause: errorObject } : undefined,
        );
      }

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Phase7C control API GET ${pathname} failed ${response.status}: ${text}`);
      }
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Phase7C control API GET ${pathname} | exhausted safe read retry`);
}

function isNewOrderRequest(request) {
  if (request.method !== "POST") return false;
  try {
    const url = new URL(request.url);
    return url.pathname === "/v1/orders";
  } catch {
    return false;
  }
}

function toRequestInfo(input, init) {
  const isRequest = input instanceof Request;
  const requestMethod = isRequest ? input.method : undefined;
  const rawUrl = isRequest
    ? input.url
    : input instanceof URL
      ? input.href
      : String(input);
  return {
    method: String(init?.method ?? requestMethod ?? "GET").toUpperCase(),
    url: rawUrl,
    headers: new Headers(init?.headers ?? (isRequest ? input.headers : undefined)),
    body: typeof init?.body === "string" ? init.body : null,
  };
}

function blockedResponse(decision) {
  return new Response(
    JSON.stringify({
      error: "PHASE7C_TREND_ENTRY_BLOCKED",
      accepted: false,
      status: "blocked_by_phase7c_mode_gate",
      message: decision.reason,
      activeMode: decision.activeMode,
      recommendedMode: decision.recommendedMode,
      detail: decision.detail,
    }),
    {
      status: 423,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function clampInt(raw, fallback, min, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}