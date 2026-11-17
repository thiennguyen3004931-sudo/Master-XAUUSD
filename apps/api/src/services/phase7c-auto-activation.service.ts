import { accountModeAllowsBroker, getPhase7CAccountModeState } from "./phase7c-account-mode.service";
import { phase7CBotModeService } from "./phase7c-bot-mode.service";
import { getPhase7CLifecycleRuntimeStatus } from "./phase7c-lifecycle.service";
import { getPhase7CRuntimeSourceAttestationSnapshot } from "./phase7c-runtime-source-attestation.service";
import type { Mt5TelemetrySnapshot } from "./mt5.service";

export type Phase7CAutoActivationChecks = {
  controlEnabled: boolean;
  accountStateValid: boolean;
  botPaused: boolean;
  runtimeReady: boolean;
  bridgeReachable: boolean;
  bridgeMatchesSelectedAccount: boolean;
  tradingEnabled: boolean;
  terminalTradeAllowed: boolean;
  expertTradeAllowed: boolean;
  zeroXauusdPositions: boolean;
  zeroXauusdPendingOrders: boolean;
  runtimeSourceExact: boolean;
  liveArmSatisfied: boolean;
};

export function evaluatePhase7CAutoActivation(telemetry: Mt5TelemetrySnapshot) {
  const accountMode = getPhase7CAccountModeState();
  const lifecycle = getPhase7CLifecycleRuntimeStatus();
  const runtimeSource = getPhase7CRuntimeSourceAttestationSnapshot();
  const liveArmSatisfied =
    accountMode.accountMode === "LIVE"
      ? telemetry.health?.liveExecutionArmed === true && telemetry.health?.liveArmStatus === "ARMED"
      : true;

  const checks: Phase7CAutoActivationChecks = {
    controlEnabled: lifecycle.controlEnabled === true,
    accountStateValid: accountMode.valid === true,
    botPaused: lifecycle.mode.mode === "PAUSE",
    runtimeReady: lifecycle.ready === true,
    bridgeReachable: telemetry.reachable === true,
    bridgeMatchesSelectedAccount: accountModeAllowsBroker(telemetry.health?.accountMode, accountMode),
    tradingEnabled: telemetry.health?.tradingEnabled === true,
    terminalTradeAllowed: telemetry.health?.terminalTradeAllowed === true,
    expertTradeAllowed: telemetry.health?.expertTradeAllowed === true,
    zeroXauusdPositions: telemetry.positions.length === 0,
    zeroXauusdPendingOrders: telemetry.pendingOrders.length === 0,
    runtimeSourceExact: runtimeSource.overall === "EXACT_MATCH",
    liveArmSatisfied,
  };
  const blockedBy = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);

  return {
    approved: blockedBy.length === 0,
    accountMode: accountMode.accountMode,
    brokerAccountMode: telemetry.health?.accountMode ?? null,
    botMode: lifecycle.mode.mode,
    liveArmRequired: accountMode.accountMode === "LIVE",
    liveArmStatus: telemetry.health?.liveArmStatus ?? null,
    runtimeSourceOverall: runtimeSource.overall,
    runtimeSourceCommit: runtimeSource.deployment?.sourceCommit ?? null,
    checks,
    blockedBy,
  };
}

export function enablePhase7CAutoFromWeb(telemetry: Mt5TelemetrySnapshot) {
  const evaluation = evaluatePhase7CAutoActivation(telemetry);
  if (!evaluation.approved) {
    throw new Error(
      `AUTO bị khóa bởi cổng an toàn: ${evaluation.blockedBy.join(", ") || "UNKNOWN"}. ` +
      `Account=${evaluation.accountMode}; Bot=${evaluation.botMode}; ARM=${evaluation.liveArmStatus ?? "NOT_REQUIRED"}.`,
    );
  }
  const state = phase7CBotModeService.set("AUTO", "web-control-center");
  return { ...evaluation, state, approved: true as const };
}
