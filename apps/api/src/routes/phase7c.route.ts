import { Router, type Request, type Response } from "express";
import {
  runPhase7CCanonicalBacktest,
  type Phase7CBacktestRequest,
} from "../services/phase7c.service";
import { getPhase7CForwardRange } from "../services/phase7c-forward.service";
import { getPhase7CAutoLotPreview } from "../services/phase7c-autolot.service";
import { getPhase7CCanonicalAccountRisk } from "../services/phase7c-risk-view.service";
import {
  runPhase7CAutoLotBacktestComparison,
  type Phase7CAutoLotBacktestRequest,
} from "../services/phase7c-auto-lot.service";
import {
  getPhase7CBotModeOptions,
  isPhase7CAutoActivationSourceAllowed,
  isPhase7CBotMode,
  phase7CBotModeService,
} from "../services/phase7c-bot-mode.service";
import { getPhase7CLiveRegime } from "../services/phase7c-live-regime.service";
import { getPhase7CDailyRecoveryView } from "../services/phase7c-daily-recovery-view.service";
import { getPhase7CSourceSafetyContract } from "../services/phase7c-source-safety.service";
import {
  phase7CLotSettingsService,
  validatePhase7CLotSettings,
} from "../services/phase7c-lot-settings.service";
import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
} from "../services/phase7c-account-mode.service";
import { getMt5Telemetry } from "../services/mt5.service";
import {
  formatPhase7CDecisionMonitorForMt5,
  getPhase7CDecisionMonitor,
} from "../services/phase7c-decision-monitor.service";
import {
  getPhase7CLifecycleRuntimeStatus,
  startPhase7CFromWeb,
  stopPhase7C,
} from "../services/phase7c-lifecycle.service";
import {
  Phase7CStrategyEntryConfigError,
  evaluatePhase7CStrategyEntrySaveGuard,
  phase7CStrategyEntryConditionsService,
} from "../services/phase7c-strategy-entry-conditions.service";

const router = Router();
let lifecycleActionInProgress = false;

function isLoopbackRequest(req: Request): boolean {
  const addresses = [req.ip, req.socket.remoteAddress]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return addresses.some((value) =>
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1");
}

function canChangeBotMode(req: Request): boolean {
  if (isLoopbackRequest(req)) return true;
  const configuredToken = process.env.PHASE7C_BOT_MODE_TOKEN?.trim();
  if (!configuredToken) return false;
  const providedToken = String(req.header("x-phase7c-token") ?? "").trim();
  return providedToken === configuredToken;
}

async function getStrategyEntryConditionGuards() {
  const mode = phase7CBotModeService.get().mode;
  const accountModeState = getPhase7CAccountModeState();
  try {
    const telemetry = await getMt5Telemetry("XAUUSD");
    const bridgeReachable = telemetry.reachable === true;
    return {
      mode,
      accountStateValid: accountModeState.valid,
      bridgeReachable,
      accountModeMatches:
        bridgeReachable && accountModeAllowsBroker(telemetry.health?.accountMode, accountModeState),
      openXauusdPositions: bridgeReachable ? telemetry.positions.length : null,
    };
  } catch {
    return {
      mode,
      accountStateValid: accountModeState.valid,
      bridgeReachable: false,
      accountModeMatches: false,
      openXauusdPositions: null,
    };
  }
}

router.get("/source-safety", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store");
  res.json(getPhase7CSourceSafetyContract());
});

router.get("/account-mode", (_req: Request, res: Response) => {
  res.setHeader("cache-control", "no-store");
  const state = getPhase7CAccountModeState();
  res.json({
    state: {
      version: state.version,
      accountMode: state.accountMode,
      liveExecutionEnabled: state.liveExecutionEnabled,
      valid: state.valid,
      source: state.source,
      error: state.error,
      updatedAt: state.updatedAt,
      updatedBy: state.updatedBy,
    },
    switchPolicy: {
      localAdminOnly: true,
      liveRequiresExplicitConfirmation: true,
      requiresPause: true,
      requiresZeroXauusdPositions: true,
      finalBotMode: "PAUSE",
      webCanSwitchAccount: false,
    },
  });
});

router.get("/bot-mode", (_req: Request, res: Response) => {
  res.json({
    state: phase7CBotModeService.get(),
    options: getPhase7CBotModeOptions(),
  });
});

router.post("/bot-mode", async (req: Request, res: Response) => {
  if (!canChangeBotMode(req)) {
    res.status(403).json({
      error: "Bot mode changes are restricted to localhost unless PHASE7C_BOT_MODE_TOKEN is configured.",
    });
    return;
  }

  const requestedMode = typeof req.body?.mode === "string"
    ? req.body.mode.trim().toUpperCase()
    : req.body?.mode;
  if (!isPhase7CBotMode(requestedMode)) {
    res.status(400).json({
      error: `Invalid bot mode. Expected one of: ${getPhase7CBotModeOptions().join(", ")}.`,
    });
    return;
  }

  const source = typeof req.body?.source === "string" && req.body.source.trim()
    ? req.body.source.trim().slice(0, 80)
    : "operator";
  if (requestedMode === "AUTO" && !isPhase7CAutoActivationSourceAllowed(source)) {
    res.status(403).json({
      error: "AUTO activation is restricted to the manual Web control center.",
    });
    return;
  }

  const accountModeState = getPhase7CAccountModeState();
  if (requestedMode !== "PAUSE" && !accountModeState.valid) {
    res.status(409).json({
      error: `Account-mode state is invalid; only PAUSE is allowed. ${accountModeState.error ?? ""}`.trim(),
    });
    return;
  }

  const state = phase7CBotModeService.set(requestedMode, source);

  if (requestedMode === "PAUSE") {
    const barrier = await phase7CBotModeService.waitForPauseBarrierDrain();
    if (!barrier.drained) {
      res.status(503).json({
        error: "PAUSE was persisted but an entry execution lock did not drain before timeout.",
        state,
        pauseBarrier: barrier,
        options: getPhase7CBotModeOptions(),
        accountMode: accountModeState.accountMode,
      });
      return;
    }

    res.json({
      state,
      pauseBarrier: barrier,
      options: getPhase7CBotModeOptions(),
      accountMode: accountModeState.accountMode,
    });
    return;
  }

  res.json({
    state,
    options: getPhase7CBotModeOptions(),
    accountMode: accountModeState.accountMode,
  });
});

router.get("/lifecycle", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Bot lifecycle status is restricted to localhost." });
    return;
  }
  try {
    const telemetry = await getMt5Telemetry("XAUUSD");
    const accountModeState = getPhase7CAccountModeState();
    res.setHeader("cache-control", "no-store");
    res.json({
      ...getPhase7CLifecycleRuntimeStatus(),
      accountMode: accountModeState,
      actionInProgress: lifecycleActionInProgress,
      bridge: {
        reachable: telemetry.reachable,
        accountMode: telemetry.health?.accountMode ?? null,
        accountModeMatchesConfigured: accountModeAllowsBroker(telemetry.health?.accountMode, accountModeState),
        server: telemetry.health?.server ?? null,
        tradingEnabled: telemetry.health?.tradingEnabled ?? null,
        terminalTradeAllowed: telemetry.health?.terminalTradeAllowed ?? null,
        expertTradeAllowed: telemetry.health?.expertTradeAllowed ?? null,
        liveExecutionArmed: telemetry.health?.liveExecutionArmed ?? null,
        liveArmStatus: telemetry.health?.liveArmStatus ?? null,
        liveArmReason: telemetry.health?.liveArmReason ?? null,
        liveArmScope: telemetry.health?.liveArmScope ?? null,
        liveRiskReductionAllowedWhenDisarmed: telemetry.health?.liveRiskReductionAllowedWhenDisarmed ?? null,
        openXauusdPositions: telemetry.positions.length,
      },
    });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Phase 7C lifecycle status failed." });
  }
});

router.post("/lifecycle/start", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Bot lifecycle controls are restricted to localhost." });
    return;
  }
  if (lifecycleActionInProgress) {
    res.status(409).json({ error: "Một thao tác Bật/Dừng Bot đang chạy. Vui lòng chờ hoàn tất." });
    return;
  }
  lifecycleActionInProgress = true;
  try {
    res.json(await startPhase7CFromWeb(
      await getMt5Telemetry("XAUUSD"),
      "local-lifecycle-api-start",
    ));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Phase 7C start failed." });
  } finally {
    lifecycleActionInProgress = false;
  }
});

router.post("/lifecycle/start/web", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Bot lifecycle controls are restricted to localhost." });
    return;
  }
  if (lifecycleActionInProgress) {
    res.status(409).json({ error: "Một thao tác Bật/Dừng Bot đang chạy. Vui lòng chờ hoàn tất." });
    return;
  }
  lifecycleActionInProgress = true;
  try {
    res.json(await startPhase7CFromWeb(
      await getMt5Telemetry("XAUUSD"),
      "web-control-center-start",
    ));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Phase 7C start failed." });
  } finally {
    lifecycleActionInProgress = false;
  }
});

router.post("/lifecycle/stop/web", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Bot lifecycle controls are restricted to localhost." });
    return;
  }
  if (lifecycleActionInProgress) {
    res.status(409).json({ error: "Một thao tác Bật/Dừng Bot đang chạy. Vui lòng chờ hoàn tất." });
    return;
  }
  lifecycleActionInProgress = true;
  try {
    res.json(await stopPhase7C(await getMt5Telemetry("XAUUSD"), "web-control-center-stop"));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Phase 7C stop failed." });
  } finally {
    lifecycleActionInProgress = false;
  }
});

router.post("/lifecycle/stop", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Bot lifecycle controls are restricted to localhost." });
    return;
  }
  if (lifecycleActionInProgress) {
    res.status(409).json({ error: "Một thao tác Bật/Dừng Bot đang chạy. Vui lòng chờ hoàn tất." });
    return;
  }
  lifecycleActionInProgress = true;
  try {
    res.json(await stopPhase7C(await getMt5Telemetry("XAUUSD"), "local-lifecycle-api-stop"));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Phase 7C stop failed." });
  } finally {
    lifecycleActionInProgress = false;
  }
});

router.get("/lot-settings", (_req: Request, res: Response) => {
  res.json(phase7CLotSettingsService.get());
});

router.post("/lot-settings", async (req: Request, res: Response) => {
  if (!canChangeBotMode(req)) {
    res.status(403).json({
      error: "Lot setting changes are restricted to localhost unless PHASE7C_BOT_MODE_TOKEN is configured.",
    });
    return;
  }

  try {
    const currentMode = phase7CBotModeService.get();
    if (currentMode.mode !== "PAUSE") {
      res.status(409).json({
        error: `Lot settings can only change while bot mode is PAUSE. Current=${currentMode.mode}.`,
      });
      return;
    }

    const accountModeState = getPhase7CAccountModeState();
    if (!accountModeState.valid) {
      res.status(409).json({ error: `Account-mode state is invalid. ${accountModeState.error ?? ""}`.trim() });
      return;
    }

    const telemetry = await getMt5Telemetry("XAUUSD");
    if (!telemetry.reachable || !accountModeAllowsBroker(telemetry.health?.accountMode, accountModeState) || !telemetry.spec) {
      res.status(409).json({
        error: `Lot settings require a healthy ${accountModeState.accountMode} MT5 bridge matching the configured account mode and an available XAUUSD broker specification.`,
      });
      return;
    }
    if (telemetry.positions.length > 0) {
      res.status(409).json({
        error: `Lot settings require zero open XAUUSD positions. Current=${telemetry.positions.length}.`,
      });
      return;
    }

    const input = validatePhase7CLotSettings({
      trendFixedLot: Number(req.body?.trendFixedLot),
      sidewayRiskPercent: Number(req.body?.sidewayRiskPercent),
      sidewayMaxLot: Number(req.body?.sidewayMaxLot),
      trendFixedTpEnabled: req.body?.trendFixedTpEnabled === true,
      trendFixedTpDistance: Number(req.body?.trendFixedTpDistance),
      sidewayFixedTpEnabled: req.body?.sidewayFixedTpEnabled === true,
      sidewayFixedTpDistance: Number(req.body?.sidewayFixedTpDistance),
    });
    const step = Number(telemetry.spec.volumeStep);
    const minVolume = Number(telemetry.spec.minVolume);
    const maxVolume = Number(telemetry.spec.maxVolume);
    const trendLot = input.trendFixedLot;
    if (trendLot < minVolume - 1e-9 || trendLot > maxVolume + 1e-9) {
      throw new Error(`Trend fixed lot ${trendLot} is outside broker range ${minVolume}-${maxVolume}.`);
    }
    const trendUnits = trendLot / step;
    if (Math.abs(trendUnits - Math.round(trendUnits)) > 1e-8 || Math.round(trendUnits) % 3 !== 0) {
      throw new Error(`Trend fixed lot ${trendLot} is not compatible with broker step ${step} and exact one-third partial close.`);
    }

    const sidewayCap = input.sidewayMaxLot;
    if (sidewayCap < minVolume - 1e-9 || sidewayCap > maxVolume + 1e-9) {
      throw new Error(`Sideway max lot ${sidewayCap} is outside broker range ${minVolume}-${maxVolume}.`);
    }
    const sidewayCapUnits = sidewayCap / step;
    if (Math.abs(sidewayCapUnits - Math.round(sidewayCapUnits)) > 1e-8 || Math.round(sidewayCapUnits) % 3 !== 0) {
      throw new Error(`Sideway max lot ${sidewayCap} is not compatible with broker step ${step} and exact one-third partial close.`);
    }

    const source = typeof req.body?.source === "string" && req.body.source.trim()
      ? req.body.source.trim().slice(0, 80)
      : "operator";
    res.json(phase7CLotSettingsService.set(input, source));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Phase 7C lot settings update failed.",
    });
  }
});

router.get("/strategy-entry-conditions", async (_req: Request, res: Response) => {
  const read = phase7CStrategyEntryConditionsService.read();
  const guards = await getStrategyEntryConditionGuards();
  const guard = evaluatePhase7CStrategyEntrySaveGuard(guards);
  res.setHeader("cache-control", "no-store");
  res.json({
    state: read.valid ? read.state : null,
    valid: read.valid,
    persisted: read.persisted,
    editable: read.valid && guard.allowed,
    error: read.error,
    appliesTo: "NEW_ENTRIES_ONLY",
    sharedAcrossAccounts: true,
    mandatory: {
      trend: ["patternM15"],
      sideway: ["rangeEdge"],
    },
    guards,
    safety: {
      requiresPause: true,
      requiresZeroXauusdPositions: true,
    },
  });
});

router.post("/strategy-entry-conditions", async (req: Request, res: Response) => {
  if (!canChangeBotMode(req)) {
    res.status(403).json({
      code: "STRATEGY_PROFILE_MUTATION_FORBIDDEN",
      error: "Strategy entry condition changes are restricted to localhost unless PHASE7C_BOT_MODE_TOKEN is configured.",
    });
    return;
  }

  const read = phase7CStrategyEntryConditionsService.read();
  if (!read.valid) {
    res.status(409).json({
      code: "ENTRY_STRATEGY_CONFIG_INVALID",
      error: read.error ?? "Persisted strategy entry condition config is invalid.",
    });
    return;
  }

  const guards = await getStrategyEntryConditionGuards();
  const guard = evaluatePhase7CStrategyEntrySaveGuard(guards);
  if (!guard.allowed) {
    res.status(409).json({ code: guard.code, error: guard.message, guards });
    return;
  }

  try {
    res.json(phase7CStrategyEntryConditionsService.set(req.body));
  } catch (error) {
    if (error instanceof Phase7CStrategyEntryConfigError) {
      const status = error.code === "CONFIG_VERSION_CONFLICT" ? 409 : 400;
      res.status(status).json({ code: error.code, error: error.message });
      return;
    }
    res.status(400).json({
      code: "ENTRY_STRATEGY_CONFIG_INVALID",
      error: error instanceof Error ? error.message : "Phase 7C strategy entry condition update failed.",
    });
  }
});

router.get("/live-regime", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase();
    const count = Number(req.query.count ?? 320);
    res.json(await getPhase7CLiveRegime(symbol || "XAUUSD", count));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7C live regime detection failed.",
    });
  }
});

router.get("/decision-monitor", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase() || "XAUUSD";
    res.setHeader("cache-control", "no-store");
    res.json(await getPhase7CDecisionMonitor(symbol));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7C decision monitor failed.",
    });
  }
});

router.get("/decision-monitor/mt5", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase() || "XAUUSD";
    const snapshot = await getPhase7CDecisionMonitor(symbol);
    res.setHeader("cache-control", "no-store");
    res.type("text/plain; charset=utf-8").send(
      formatPhase7CDecisionMonitorForMt5(snapshot),
    );
  } catch (error) {
    res.status(503).type("text/plain; charset=utf-8").send(
      `error=${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Phase 7C MT5 decision monitor failed."}\n`,
    );
  }
});

router.get("/daily-recovery", async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol ?? "XAUUSD").trim().toUpperCase();
    const volume = Number(req.query.volume ?? 0.03);
    res.json(await getPhase7CDailyRecoveryView(symbol || "XAUUSD", volume));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7C Daily Recovery view failed.",
    });
  }
});

router.get("/account-risk", async (req: Request, res: Response) => {
  try {
    const riskPercent = Number(req.query.riskPercent ?? 0.25);
    const maxLot = Number(req.query.maxLot ?? 0.03);
    res.json(await getPhase7CCanonicalAccountRisk(riskPercent, maxLot));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Phase 7C account/risk request failed." });
  }
});

router.get("/auto-lot-preview", async (req: Request, res: Response) => {
  try {
    const stopDistance = Number(req.query.stopDistance);
    const riskPercent = Number(req.query.riskPercent ?? 0.25);
    const maxLot = Number(req.query.maxLot ?? 0.03);
    res.json(await getPhase7CAutoLotPreview(stopDistance, riskPercent, maxLot));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Phase 7C Auto Lot preview failed." });
  }
});

router.get("/forward-range", async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from ?? "").trim();
    const to = String(req.query.to ?? "").trim();
    res.json(await getPhase7CForwardRange(from, to));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Phase 7C forward comparison failed." });
  }
});

router.post("/backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7CCanonicalBacktest(req.body as Phase7CBacktestRequest));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Phase 7C backtest failed." });
  }
});

router.post("/auto-lot-backtest", async (req: Request, res: Response) => {
  try {
    res.json(await runPhase7CAutoLotBacktestComparison(req.body as Phase7CAutoLotBacktestRequest));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Phase 7C Auto Lot backtest comparison failed." });
  }
});

export default router;
