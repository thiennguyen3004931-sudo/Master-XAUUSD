import type {
  BacktestResultDto,
  BacktestRunRequest,
  DashboardSnapshot,
  Mt5TelemetrySnapshot,
  TradingMode,
} from "./types";
import type { Mt5PerformanceSnapshot } from "./types";
import type {
  Phase7BDemoSnapshot,
  Phase7CAccountRiskSnapshot,
  Phase7CBacktestRequest,
  Phase7CBacktestResult,
  Phase7CDailyRecoverySnapshot,
  Phase7CDecisionMonitorSnapshot,
  Phase7CLifecycleActionResponse,
  Phase7CLifecycleSnapshot,
  Phase7CLiveRegimeSnapshot,
  Phase7CLotSettingsSnapshot,
  Phase7CSourceSafetySnapshot,
} from "./phase7c-types";
import type { Phase7CForwardRangeResult } from "./phase7c-forward-types";
import type { Phase7CAutoLotPreview } from "./phase7c-autolot-types";
import type {
  Phase7CAutoLotBacktestRequest,
  Phase7CAutoLotBacktestResult,
} from "./phase7c-auto-lot-types";
import type {
  Phase7DDailyPnlRequest,
  Phase7DDailyPnlResult,
} from "./phase7d-types";
import type {
  Phase7ESupertrendRequest,
  Phase7ESupertrendResult,
} from "./phase7e-types";
import type {
  Phase7ERealignmentRequest,
  Phase7ERealignmentResult,
} from "./phase7e-realignment-types";
import { enablePhase7CAuto } from "./phase7c-execution-control";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

type ApiErrorPayload = {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
};

function friendlyHttpMessage(status: number, raw?: string) {
  if (status === 502) return "Không lấy được dữ liệu từ dịch vụ nền (HTTP 502). API/Bridge/Telegram có thể đang khởi động lại; trang sẽ tự thử lại.";
  if (status === 503) return "Dịch vụ nền chưa sẵn sàng (HTTP 503). Giữ MT5/API mở và thử lại sau vài giây.";
  if (status === 504) return "Dịch vụ nền phản hồi quá thời gian (HTTP 504). Trang sẽ tự thử lại.";
  if (status >= 500) return `Lỗi dịch vụ nền HTTP ${status}. Kiểm tra API/Bridge rồi thử lại.`;
  if (status >= 400) return `Yêu cầu không hợp lệ hoặc bị từ chối HTTP ${status}.`;
  return raw?.trim() || `HTTP ${status}`;
}

function payloadMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const errorPayload = payload as ApiErrorPayload;
    const candidate = errorPayload.error ?? errorPayload.message ?? errorPayload.detail;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (candidate && typeof candidate === "object" && "message" in candidate) {
      const nested = (candidate as { message?: unknown }).message;
      if (typeof nested === "string" && nested.trim()) return nested;
    }
  }
  return fallback;
}

export async function safeReadJson<T>(response: Response, label = "API"): Promise<T> {
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(response.ok ? `${label} trả về dữ liệu rỗng. Trang sẽ tự thử lại; kiểm tra API nếu lỗi kéo dài.` : friendlyHttpMessage(response.status));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    if (!response.ok) throw new Error(friendlyHttpMessage(response.status, trimmed.slice(0, 180)));
    throw new Error(`${label} trả về JSON không hợp lệ hoặc chưa hoàn chỉnh. Trang sẽ tự thử lại.`);
  }
  if (!response.ok) throw new Error(payloadMessage(payload, friendlyHttpMessage(response.status, trimmed.slice(0, 180))));
  return payload as T;
}

async function read<T>(response: Response): Promise<T> {
  return safeReadJson<T>(response);
}

export async function getDashboard(): Promise<DashboardSnapshot> {
  return read<DashboardSnapshot>(await fetch(`${API_BASE}/api/v1/dashboard`, { cache: "no-store" }));
}

export async function getMt5Telemetry(symbol = "XAUUSD"): Promise<Mt5TelemetrySnapshot> {
  const response = await fetch(`${API_BASE}/api/v1/mt5/status?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
  return safeReadJson<Mt5TelemetrySnapshot>(response, "MT5 telemetry");
}

export async function setTradingMode(mode: Exclude<TradingMode, "LIVE_LOCKED">): Promise<DashboardSnapshot["control"]> {
  return read<DashboardSnapshot["control"]>(await fetch(`${API_BASE}/api/v1/control/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  }));
}

export async function runBacktest(input: BacktestRunRequest): Promise<BacktestResultDto> {
  return read<BacktestResultDto>(await fetch(`${API_BASE}/api/v1/backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function getMt5Performance(days = 90): Promise<Mt5PerformanceSnapshot> {
  return read<Mt5PerformanceSnapshot>(await fetch(`${API_BASE}/api/v1/mt5/performance?symbol=XAUUSD&days=${days}`, { cache: "no-store" }));
}

export async function getPhase7BDemo(): Promise<Phase7BDemoSnapshot> {
  return read<Phase7BDemoSnapshot>(await fetch(`${API_BASE}/api/v1/phase7b-demo`, { cache: "no-store" }));
}

export async function getPhase7CLiveRegime(): Promise<Phase7CLiveRegimeSnapshot> {
  return read<Phase7CLiveRegimeSnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/live-regime?symbol=XAUUSD`, { cache: "no-store" }));
}

export async function getPhase7CDecisionMonitor(): Promise<Phase7CDecisionMonitorSnapshot> {
  return read<Phase7CDecisionMonitorSnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/decision-monitor?symbol=XAUUSD`, { cache: "no-store" }));
}

export async function getPhase7CSourceSafety(): Promise<Phase7CSourceSafetySnapshot> {
  return read<Phase7CSourceSafetySnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/source-safety`, { cache: "no-store" }));
}

export async function getPhase7CLifecycle(): Promise<Phase7CLifecycleSnapshot> {
  return read<Phase7CLifecycleSnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/lifecycle`, { cache: "no-store" }));
}

export async function runPhase7CLifecycleAction(action: "start" | "stop"): Promise<Phase7CLifecycleActionResponse> {
  const lifecyclePath = action === "stop"
    ? "/api/v1/phase7c/lifecycle/stop/web"
    : "/api/v1/phase7c/lifecycle/start/web";
  return read<Phase7CLifecycleActionResponse>(await fetch(`${API_BASE}${lifecyclePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
}

export type Phase7cControlMode = "AUTO" | "TREND" | "SIDEWAY" | "SEMI" | "PAUSE";

export async function setPhase7CBotMode(mode: Phase7cControlMode): Promise<{
  state: Phase7CLifecycleSnapshot["mode"];
  options: string[];
  accountMode: string;
}> {
  if (mode === "AUTO") {
    const guardedAuto = await enablePhase7CAuto();
    return {
      state: guardedAuto.state,
      options: guardedAuto.options,
      accountMode: guardedAuto.accountMode,
    };
  }

  return read(await fetch(`${API_BASE}/api/v1/phase7c/bot-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, source: "web-control-center" }),
  }));
}

export async function getPhase7CDailyRecovery(volume = 0.03): Promise<Phase7CDailyRecoverySnapshot> {
  return read<Phase7CDailyRecoverySnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/daily-recovery?symbol=XAUUSD&volume=${encodeURIComponent(volume)}`, { cache: "no-store" }));
}

export async function getPhase7CAccountRisk(riskPercent = 0.25, maxLot = 0.03): Promise<Phase7CAccountRiskSnapshot> {
  return read<Phase7CAccountRiskSnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/account-risk?riskPercent=${encodeURIComponent(riskPercent)}&maxLot=${encodeURIComponent(maxLot)}`, { cache: "no-store" }));
}

export async function getPhase7CLotSettings(): Promise<Phase7CLotSettingsSnapshot> {
  return read<Phase7CLotSettingsSnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/lot-settings`, { cache: "no-store" }));
}

export async function setPhase7CLotSettings(input: {
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
}): Promise<Phase7CLotSettingsSnapshot> {
  return read<Phase7CLotSettingsSnapshot>(await fetch(`${API_BASE}/api/v1/phase7c/lot-settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, source: "web-control-center" }),
  }));
}

export async function getPhase7CAutoLotPreview(stopDistance: number, riskPercent = 0.25, maxLot = 0.03): Promise<Phase7CAutoLotPreview> {
  return read<Phase7CAutoLotPreview>(await fetch(`${API_BASE}/api/v1/phase7c/auto-lot-preview?stopDistance=${encodeURIComponent(stopDistance)}&riskPercent=${encodeURIComponent(riskPercent)}&maxLot=${encodeURIComponent(maxLot)}`, { cache: "no-store" }));
}

export async function getPhase7CForwardRange(from: string, to: string): Promise<Phase7CForwardRangeResult> {
  return read<Phase7CForwardRangeResult>(await fetch(`${API_BASE}/api/v1/phase7c/forward-range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cache: "no-store" }));
}

export async function runPhase7CBacktest(input: Phase7CBacktestRequest): Promise<Phase7CBacktestResult> {
  return read<Phase7CBacktestResult>(await fetch(`${API_BASE}/api/v1/phase7c/backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function runPhase7CAutoLotBacktest(input: Phase7CAutoLotBacktestRequest): Promise<Phase7CAutoLotBacktestResult> {
  return read<Phase7CAutoLotBacktestResult>(await fetch(`${API_BASE}/api/v1/phase7c/auto-lot-backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function runPhase7DDailyPnlBacktest(input: Phase7DDailyPnlRequest): Promise<Phase7DDailyPnlResult> {
  return read<Phase7DDailyPnlResult>(await fetch(`${API_BASE}/api/v1/phase7d/daily-pnl-backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function runPhase7ESupertrendBacktest(input: Phase7ESupertrendRequest): Promise<Phase7ESupertrendResult> {
  return read<Phase7ESupertrendResult>(await fetch(`${API_BASE}/api/v1/phase7e/supertrend-backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function runPhase7ERealignmentBacktest(input: Phase7ERealignmentRequest): Promise<Phase7ERealignmentResult> {
  return read<Phase7ERealignmentResult>(await fetch(`${API_BASE}/api/v1/phase7e/realignment-backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}