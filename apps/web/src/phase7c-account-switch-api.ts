import { requestLocalControlJson } from "./local-control-request";
import type {
  Phase7CAccountMode,
  Phase7CAccountSwitchCapability,
  Phase7CAccountSwitchExecuteResponse,
  Phase7CAccountSwitchPreflight,
  Phase7CAccountSwitchStatus,
  Phase7CSameModeAccountChangeReadiness,
} from "./phase7c-account-switch-types";

const ACCOUNT_SWITCH_BASE = "/api/v1/phase7c-account-switch";

export function getPhase7CAccountSwitchCapability() {
  return requestLocalControlJson<Phase7CAccountSwitchCapability>(`${ACCOUNT_SWITCH_BASE}/capability`);
}

export function preflightPhase7CAccountSwitch(targetMode: Phase7CAccountMode) {
  return requestLocalControlJson<Phase7CAccountSwitchPreflight>(`${ACCOUNT_SWITCH_BASE}/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetMode }),
  });
}

export function executePhase7CAccountSwitch(input: {
  targetMode: Phase7CAccountMode;
  preflightToken: string;
  confirmation: string;
}) {
  return requestLocalControlJson<Phase7CAccountSwitchExecuteResponse>(`${ACCOUNT_SWITCH_BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getPhase7CAccountSwitchStatus(requestId: string) {
  return requestLocalControlJson<Phase7CAccountSwitchStatus>(
    `${ACCOUNT_SWITCH_BASE}/status?requestId=${encodeURIComponent(requestId)}`,
  );
}

export function getPhase7CSameModeAccountChangeReadiness() {
  return requestLocalControlJson<Phase7CSameModeAccountChangeReadiness>(
    `${ACCOUNT_SWITCH_BASE}/same-mode-readiness`,
  );
}
