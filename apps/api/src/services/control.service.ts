import type { DashboardTradingMode } from "../types/dashboard";

interface ControlState {
  mode: DashboardTradingMode;
  tradingEnabled: boolean;
  liveUnlockAvailable: false;
  updatedAt: number;
}

let state: ControlState = {
  mode: "SHADOW",
  tradingEnabled: false,
  liveUnlockAvailable: false,
  updatedAt: Date.now(),
};

export function getControlState(): ControlState {
  return { ...state };
}

export function setControlMode(mode: "SHADOW" | "DEMO"): ControlState {
  state = {
    mode,
    tradingEnabled: mode === "DEMO",
    liveUnlockAvailable: false,
    updatedAt: Date.now(),
  };
  return { ...state };
}
