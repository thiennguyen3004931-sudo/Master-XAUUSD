import type { Phase7CAccountMode } from "./phase7c-account-mode.service.js";

export interface Phase7CWebStartAccountState {
  valid: boolean;
  accountMode: Phase7CAccountMode;
  liveExecutionEnabled: boolean;
}

export interface Phase7CWebStartAccountInput {
  reachable: boolean;
  brokerAccountMode: string | null | undefined;
  currentState: Phase7CWebStartAccountState;
  durableLiveAuthorizationValid: boolean;
}

export type Phase7CWebStartAuthorizationSource =
  | "NOT_REQUIRED"
  | "DURABLE_LIVE_AUTHORIZATION"
  | "LEGACY_EXPLICIT_LIVE_STATE"
  | "NONE";

export type Phase7CWebStartAccountDecision = {
  allowed: boolean;
  targetAccountMode: Phase7CAccountMode | null;
  liveExecutionEnabled: boolean;
  authorizationSource: Phase7CWebStartAuthorizationSource;
  reason:
    | "BROKER_DEMO_SELECTED"
    | "BROKER_LIVE_PREAUTHORIZED"
    | "BROKER_LIVE_LEGACY_EXPLICIT_STATE"
    | "LIVE_NOT_PREAUTHORIZED"
    | "MT5_BRIDGE_NOT_REACHABLE"
    | "ACCOUNT_MODE_STATE_INVALID"
    | "UNSUPPORTED_BROKER_ACCOUNT_MODE";
};

export function resolvePhase7CWebStartAccount(
  input: Phase7CWebStartAccountInput,
): Phase7CWebStartAccountDecision {
  if (!input.reachable) {
    return {
      allowed: false,
      targetAccountMode: null,
      liveExecutionEnabled: false,
      authorizationSource: "NONE",
      reason: "MT5_BRIDGE_NOT_REACHABLE",
    };
  }

  if (!input.currentState.valid) {
    return {
      allowed: false,
      targetAccountMode: null,
      liveExecutionEnabled: false,
      authorizationSource: "NONE",
      reason: "ACCOUNT_MODE_STATE_INVALID",
    };
  }

  if (input.brokerAccountMode === "demo") {
    return {
      allowed: true,
      targetAccountMode: "DEMO",
      liveExecutionEnabled: false,
      authorizationSource: "NOT_REQUIRED",
      reason: "BROKER_DEMO_SELECTED",
    };
  }

  if (input.brokerAccountMode !== "real") {
    return {
      allowed: false,
      targetAccountMode: null,
      liveExecutionEnabled: false,
      authorizationSource: "NONE",
      reason: "UNSUPPORTED_BROKER_ACCOUNT_MODE",
    };
  }

  if (input.durableLiveAuthorizationValid) {
    return {
      allowed: true,
      targetAccountMode: "LIVE",
      liveExecutionEnabled: true,
      authorizationSource: "DURABLE_LIVE_AUTHORIZATION",
      reason: "BROKER_LIVE_PREAUTHORIZED",
    };
  }

  if (
    input.currentState.accountMode === "LIVE" &&
    input.currentState.liveExecutionEnabled === true
  ) {
    return {
      allowed: true,
      targetAccountMode: "LIVE",
      liveExecutionEnabled: true,
      authorizationSource: "LEGACY_EXPLICIT_LIVE_STATE",
      reason: "BROKER_LIVE_LEGACY_EXPLICIT_STATE",
    };
  }

  return {
    allowed: false,
    targetAccountMode: null,
    liveExecutionEnabled: false,
    authorizationSource: "NONE",
    reason: "LIVE_NOT_PREAUTHORIZED",
  };
}
