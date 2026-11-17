export type Phase7CPanelStatus = Record<string, string>;
export type Phase7CJson = Record<string, unknown>;
export type TradeUiState = "WAITING" | "SETUP_READY" | "MANAGING";
export type Phase7CUiGate = "ALLOWED" | "BLOCKED_BY_MODE" | "BLOCKED_BY_REGIME" | "PENDING";
export type Phase7CEntryCheckStatus = "PASS" | "FAIL" | "WAIT" | "BLOCKED";

export interface Phase7CEntryCheck {
  code: string;
  label: string;
  status: Phase7CEntryCheckStatus;
  actual: string;
  required: string;
  reason: string;
}

export interface Phase7CPerformanceTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  ownership: "SYSTEM" | "VALIDATION" | "OTHER";
  strategy: "TREND" | "SIDEWAY" | "OTHER";
  openedAt: number;
  closedAt: number;
  durationMinutes: number;
  volume: number;
  entry: number;
  exit: number;
  netPnl: number;
  session: string;
  brokerHour: number;
  weekday: string;
  exitReason: string;
}

export interface Phase7CPerformanceSnapshot {
  source: "MT5_ACCOUNT_READ_ONLY" | "MT5_DEMO_READ_ONLY";
  symbol: string;
  currency: string;
  days: number;
  generatedAt: number;
  account?: {
    accountMode: "DEMO" | "LIVE";
    brokerMode: "demo" | "real";
    login: number | null;
    server: string | null;
  };
  safety?: {
    accountMode: "DEMO" | "LIVE" | "demo";
    bridgeTradingEnabled: boolean;
    readOnly?: true;
    strategyAutoChange: false;
    liveUnlockAvailable: false;
  };
  accountWide: {
    metrics: {
      totalTrades: number;
      wins: number;
      losses: number;
      netPnl: number;
      winRatePercent: number;
      profitFactor: number | null;
      maxDrawdown: number;
      maxDrawdownPercent: number;
    };
  };
  systemOwned: {
    metrics: {
      totalTrades: number;
      wins: number;
      losses: number;
      netPnl: number;
      winRatePercent: number;
      profitFactor: number | null;
    };
    sampleReady: boolean;
  };
  trades: Phase7CPerformanceTrade[];
}

export interface Phase7CUiContract {
  version: 2;
  generatedAt: number;
  symbol: string;
  uiState: TradeUiState;
  mode: string;
  effectiveStrategy: string;
  regime: string;
  confidence: number | null;
  stage: string;
  approved: boolean;
  recommendedMode: string;
  reasons: {
    auto?: string[];
    trendWait?: string[];
    sidewayWait?: string[];
    wait: string[];
    entry: string[];
    hold: string[];
    stopMove?: string[];
    partial?: string[];
    exit: string[];
  };
  entryChecks?: {
    trend: Phase7CEntryCheck[];
    sideway: Phase7CEntryCheck[];
  };
  gates: {
    trend: Phase7CUiGate;
    sideway: Phase7CUiGate;
    reversalFilter: "BLOCKING" | "CLEAR";
  };
  setup: null | {
    strategy: string;
    side: string | null;
    name: string | null;
    entry: number | null;
    stopLoss: number | null;
    tp1: number | null;
    tp2: number | null;
    finalLot: number | null;
    estimatedRiskPercent: number | null;
  };
  position: null | {
    state: string;
    strategy: string | null;
    ticket: string | null;
    side: string | null;
    volume: number | null;
    entry: number | null;
    stopLoss: number | null;
    tp1: number | null;
    tp2: number | null;
    floatingPnlUsd: number | null;
    floatingPnlPercent: number | null;
  };
  safety: {
    accountMode: "DEMO" | "LIVE";
    demoOnly: boolean;
    readOnly: true;
    orderPermission: "NONE";
    newPositionsOnly: true;
    martingale: false;
    recoveryLotEscalation: false;
  };
}

export interface Phase7CWebStatus {
  panel?: Phase7CPanelStatus;
  ui?: Phase7CUiContract;
  lifecycle?: Phase7CJson;
  accountRisk?: Phase7CJson;
  lotSettings?: Phase7CJson;
  errors: string[];
  usedDirectFallback: boolean;
}

const CONTROL_BASE = "http://127.0.0.1:3711";
const PANEL_STATUS_URL = "/api/v1/phase7c/decision-monitor/mt5?symbol=XAUUSD";
const SEMANTIC_UI_URL = "/api/v1/phase7c-ui?symbol=XAUUSD";
const LIFECYCLE_URL = "/api/v1/phase7c/lifecycle";
const ACCOUNT_RISK_URL = "/api/v1/phase7c/account-risk?riskPercent=1&maxLot=0.3";
const LOT_SETTINGS_URL = "/api/v1/phase7c/lot-settings";
const PERFORMANCE_URL = "/api/v1/mt5/performance?days=90&symbol=XAUUSD";

type FetchResult<T> = { payload: T; usedDirectFallback: boolean };

function unique(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim())));
}

function friendlyHttpMessage(status: number, label: string) {
  if (status === 502) return `${label} chưa phản hồi qua web proxy (HTTP 502).`;
  if (status === 503) return `${label} đang khởi động lại (HTTP 503).`;
  if (status === 504) return `${label} phản hồi quá thời gian (HTTP 504).`;
  return `${label} trả HTTP ${status}.`;
}

async function fetchTextWithFallback(relativeUrl: string, label: string): Promise<FetchResult<string>> {
  const urls = [relativeUrl, `${CONTROL_BASE}${relativeUrl}`];
  const errors: string[] = [];

  for (let index = 0; index < urls.length; index++) {
    try {
      const response = await fetch(urls[index], { cache: "no-store", headers: { accept: "text/plain" } });
      const text = await response.text();
      if (response.ok && text.trim()) return { payload: text, usedDirectFallback: index === 1 };
      errors.push(response.ok ? `${label} trả dữ liệu rỗng.` : friendlyHttpMessage(response.status, label));
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : "không kết nối được"}`);
    }
  }

  throw new Error(unique(errors).join(" "));
}

async function fetchJsonWithFallback<T>(relativeUrl: string, label: string): Promise<FetchResult<T>> {
  const urls = [relativeUrl, `${CONTROL_BASE}${relativeUrl}`];
  const errors: string[] = [];

  for (let index = 0; index < urls.length; index++) {
    try {
      const response = await fetch(urls[index], { cache: "no-store", headers: { accept: "application/json" } });
      const text = await response.text();
      if (!response.ok) {
        errors.push(friendlyHttpMessage(response.status, label));
        continue;
      }
      if (!text.trim()) {
        errors.push(`${label} trả dữ liệu rỗng.`);
        continue;
      }
      return { payload: JSON.parse(text) as T, usedDirectFallback: index === 1 };
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : "không kết nối được"}`);
    }
  }

  throw new Error(unique(errors).join(" "));
}

export function parsePanelStatus(text: string): Phase7CPanelStatus {
  const result: Phase7CPanelStatus = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function validSemanticUi(payload: Phase7CUiContract | undefined) {
  return payload?.version === 2 && ["WAITING", "SETUP_READY", "MANAGING"].includes(payload.uiState);
}

export async function fetchPhase7CPanelStatus(): Promise<Phase7CPanelStatus> {
  const result = await fetchTextWithFallback(PANEL_STATUS_URL, "Decision Monitor");
  const payload = parsePanelStatus(result.payload);
  if (payload.version !== "1") throw new Error("Decision Monitor trả payload chưa hợp lệ. Trang sẽ tự thử lại.");
  return payload;
}

export async function fetchPhase7CPerformance(): Promise<Phase7CPerformanceSnapshot> {
  const result = await fetchJsonWithFallback<Phase7CPerformanceSnapshot>(PERFORMANCE_URL, "Lịch sử MT5");
  const payload = result.payload;
  if (!(["MT5_ACCOUNT_READ_ONLY", "MT5_DEMO_READ_ONLY"] as string[]).includes(payload.source) || !Array.isArray(payload.trades)) {
    throw new Error("Lịch sử MT5 trả payload chưa hợp lệ.");
  }
  return payload;
}

export async function fetchPhase7CWebStatus(): Promise<Phase7CWebStatus> {
  const [panelResult, uiResult, lifecycleResult, accountRiskResult, lotSettingsResult] = await Promise.allSettled([
    fetchTextWithFallback(PANEL_STATUS_URL, "Decision Monitor"),
    fetchJsonWithFallback<Phase7CUiContract>(SEMANTIC_UI_URL, "Semantic UI"),
    fetchJsonWithFallback<Phase7CJson>(LIFECYCLE_URL, "Runtime"),
    fetchJsonWithFallback<Phase7CJson>(ACCOUNT_RISK_URL, "Tài khoản & Risk"),
    fetchJsonWithFallback<Phase7CJson>(LOT_SETTINGS_URL, "Lot settings"),
  ]);

  const errors: string[] = [];
  let usedDirectFallback = false;
  let panel: Phase7CPanelStatus | undefined;
  let ui: Phase7CUiContract | undefined;
  let lifecycle: Phase7CJson | undefined;
  let accountRisk: Phase7CJson | undefined;
  let lotSettings: Phase7CJson | undefined;

  if (panelResult.status === "fulfilled") {
    panel = parsePanelStatus(panelResult.value.payload);
    usedDirectFallback ||= panelResult.value.usedDirectFallback;
  } else errors.push(panelResult.reason instanceof Error ? panelResult.reason.message : "Không đọc được Decision Monitor.");

  if (uiResult.status === "fulfilled" && validSemanticUi(uiResult.value.payload)) {
    ui = uiResult.value.payload;
    usedDirectFallback ||= uiResult.value.usedDirectFallback;
  } else if (uiResult.status === "rejected") errors.push(uiResult.reason instanceof Error ? uiResult.reason.message : "Không đọc được Semantic UI.");
  else errors.push("Semantic UI trả contract chưa hợp lệ.");

  if (lifecycleResult.status === "fulfilled") {
    lifecycle = lifecycleResult.value.payload;
    usedDirectFallback ||= lifecycleResult.value.usedDirectFallback;
  } else errors.push(lifecycleResult.reason instanceof Error ? lifecycleResult.reason.message : "Không đọc được Runtime.");

  if (accountRiskResult.status === "fulfilled") {
    accountRisk = accountRiskResult.value.payload;
    usedDirectFallback ||= accountRiskResult.value.usedDirectFallback;
  } else errors.push(accountRiskResult.reason instanceof Error ? accountRiskResult.reason.message : "Không đọc được Tài khoản & Risk.");

  if (lotSettingsResult.status === "fulfilled") {
    lotSettings = lotSettingsResult.value.payload;
    usedDirectFallback ||= lotSettingsResult.value.usedDirectFallback;
  } else errors.push(lotSettingsResult.reason instanceof Error ? lotSettingsResult.reason.message : "Không đọc được Lot settings.");

  if (!panel && !ui && !lifecycle && !accountRisk && !lotSettings) throw new Error(unique(errors).join(" "));
  return { panel, ui, lifecycle, accountRisk, lotSettings, errors: unique(errors), usedDirectFallback };
}

export function raw(status: Phase7CPanelStatus | undefined, key: string) {
  return status?.[key]?.trim() ?? "";
}

export function isUsablePanelValue(input: string) {
  const normalized = input.trim().toLowerCase();
  return Boolean(normalized) && !["n/a", "null", "undefined", "—", "-"].includes(normalized);
}

export function getTradeUiState(status: Phase7CPanelStatus | undefined, ui?: Phase7CUiContract): TradeUiState {
  if (ui && validSemanticUi(ui)) return ui.uiState;
  const positionCount = Number(raw(status, "positionCount") || "0");
  const positionState = raw(status, "positionState").toUpperCase();
  const approved = raw(status, "approved") === "true";
  const entry = raw(status, "entry");
  const stopLoss = raw(status, "stopLoss");
  if (positionCount > 0 || positionState === "MANAGING" || positionState === "UNMANAGED") return "MANAGING";
  if (approved && isUsablePanelValue(entry) && isUsablePanelValue(stopLoss)) return "SETUP_READY";
  return "WAITING";
}

export function clean(input: unknown, fallback = "—") {
  const text = input === null || input === undefined ? "" : String(input).trim();
  if (!text || text === "n/a" || text === "N/A" || text === "null" || text === "undefined") return fallback;
  if (text === "true") return "Có";
  if (text === "false") return "Chưa";
  return text;
}

export function value(status: Phase7CPanelStatus | undefined, key: string, fallback = "—") {
  return clean(raw(status, key), fallback);
}

export function pickText(...values: unknown[]) {
  for (const item of values) {
    const cleaned = clean(item, "");
    if (cleaned) return cleaned;
  }
  return "—";
}

export function boolText(input: unknown) {
  if (input === true || input === "true") return "Yes";
  if (input === false || input === "false") return "No";
  return clean(input, "—");
}

export function money(input: unknown, currency = "USD") {
  const text = clean(input, "");
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue)) return "—";
  return `${numberValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency || "USD"}`;
}

export function modeDisplay(status: Phase7CPanelStatus | undefined) {
  const active = value(status, "activeMode", "—");
  const effective = value(status, "effectiveStrategy", "—");
  if (active !== "—" && effective !== "—" && active !== effective) return `${active} → ${effective}`;
  return active;
}

export function compactReason(input: string, fallback: string) {
  let text = clean(input, fallback);
  text = text
    .replaceAll("PAUSE chặn mọi lệnh mới; không thay đổi vị thế đang được quản lý.", "PAUSE chặn lệnh mới; không đổi vị thế đang quản lý.")
    .replaceAll("A confirmed CHOCH indicates a possible structural reversal.", "CHOCH xác nhận khả năng đảo chiều cấu trúc.")
    .replaceAll("Bollinger bandwidth is", "Bollinger bandwidth:")
    .replaceAll("panel does not have order permission", "panel chỉ đọc, không gửi lệnh")
    .replaceAll("panel không có quyền gửi lệnh", "panel chỉ đọc, không gửi lệnh")
    .replaceAll("No valid setup", "Chưa có setup hợp lệ")
    .replaceAll(" · ", "\n")
    .replaceAll(" | ", "\n")
    .replaceAll("; ", "\n")
    .replaceAll(" • ", "\n")
    .replaceAll("•", "\n");
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4);
}

export function stageTone(stage: string): "success" | "warning" | "error" | "default" {
  if (["READY", "APPROVED", "MANAGING"].includes(stage)) return "success";
  if (["BLOCKED", "PAUSE", "WAITING", "WAIT_SIGNAL"].includes(stage)) return "warning";
  if (["ERROR", "FAIL", "OFFLINE"].includes(stage)) return "error";
  return "default";
}
