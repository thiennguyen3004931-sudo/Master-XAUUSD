import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getPhase7CAccountModeState,
  type Phase7CAccountMode,
} from "./phase7c-account-mode.service.js";

export interface Phase7CLotSettingsState {
  version: 2;
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
  updatedAt: string;
  updatedBy: string;
}

export interface Phase7CActiveLotSettings {
  version: 2;
  accountMode: Phase7CAccountMode;
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
  armed: boolean;
  supervisorPid: number;
  appliedAt: string;
}

export interface Phase7CLotSettingsInput {
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled?: boolean;
  trendFixedTpDistance?: number;
  sidewayFixedTpEnabled?: boolean;
  sidewayFixedTpDistance?: number;
}

export interface Phase7CNormalizedLotSettings {
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
}

export const PHASE7C_LOT_LIMITS = {
  minManagedLot: 0.03,
  maxDemoLot: 1.2,
  maxManagedLot: 1.2,
  maxTrendLot: 1.2,
  maxSidewayLot: 1.2,
  lotStep: 0.01,
  managedLotIncrement: 0.03,
  minRiskPercent: 0.01,
  maxRiskPercent: 1,
} as const;

function round(value: number, digits = 8): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function defaultState(): Phase7CLotSettingsState {
  return {
    version: 2,
    trendFixedLot: 0.03,
    sidewayRiskPercent: 0.25,
    sidewayMaxLot: 0.03,
    trendFixedTpEnabled: false,
    trendFixedTpDistance: 0,
    sidewayFixedTpEnabled: false,
    sidewayFixedTpDistance: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "safe-default",
  };
}

function isManagedLot(value: number, maxLot: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < PHASE7C_LOT_LIMITS.minManagedLot - 1e-9) return false;
  if (value > maxLot + 1e-9) return false;
  const units = value / PHASE7C_LOT_LIMITS.managedLotIncrement;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function isSidewayCap(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < PHASE7C_LOT_LIMITS.minManagedLot - 1e-9) return false;
  if (value > PHASE7C_LOT_LIMITS.maxSidewayLot + 1e-9) return false;
  const units = value / PHASE7C_LOT_LIMITS.managedLotIncrement;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function normalizeFixedTp(
  enabledValue: unknown,
  distanceValue: unknown,
  label: "Trend" | "Sideway",
): { enabled: boolean; distance: number } {
  const enabled = enabledValue === true;
  const distance = distanceValue === undefined || distanceValue === null || distanceValue === ""
    ? 0
    : Number(distanceValue);

  if (enabled && (!Number.isFinite(distance) || distance <= 0)) {
    throw new Error(`${label} fixed TP distance must be positive when Fixed TP is enabled.`);
  }
  if (!enabled && (!Number.isFinite(distance) || distance < 0)) {
    throw new Error(`${label} fixed TP distance must be finite and non-negative when Fixed TP is disabled.`);
  }

  return { enabled, distance: round(distance, 8) };
}

export function validatePhase7CLotSettings(
  input: Phase7CLotSettingsInput,
): Phase7CNormalizedLotSettings {
  const trendFixedLot = Number(input.trendFixedLot);
  const sidewayRiskPercent = Number(input.sidewayRiskPercent);
  const sidewayMaxLot = Number(input.sidewayMaxLot);

  if (!isManagedLot(trendFixedLot, PHASE7C_LOT_LIMITS.maxTrendLot)) {
    throw new Error(
      "Trend fixed lot must be between 0.03 and 1.20 and use 0.03 increments so +10 can close exactly one-third.",
    );
  }
  if (!isSidewayCap(sidewayMaxLot)) {
    throw new Error(
      "Sideway max lot must be between 0.03 and 1.20 and use 0.03 increments so +10 can close exactly one-third.",
    );
  }
  if (
    !Number.isFinite(sidewayRiskPercent) ||
    sidewayRiskPercent < PHASE7C_LOT_LIMITS.minRiskPercent - 1e-9 ||
    sidewayRiskPercent > PHASE7C_LOT_LIMITS.maxRiskPercent + 1e-9
  ) {
    throw new Error("Sideway risk percent must be between 0.01% and 1.00%.");
  }

  const trendFixedTp = normalizeFixedTp(
    input.trendFixedTpEnabled,
    input.trendFixedTpDistance,
    "Trend",
  );
  const sidewayFixedTp = normalizeFixedTp(
    input.sidewayFixedTpEnabled,
    input.sidewayFixedTpDistance,
    "Sideway",
  );

  return {
    trendFixedLot: round(trendFixedLot, 2),
    sidewayRiskPercent: round(sidewayRiskPercent, 2),
    sidewayMaxLot: round(sidewayMaxLot, 2),
    trendFixedTpEnabled: trendFixedTp.enabled,
    trendFixedTpDistance: trendFixedTp.distance,
    sidewayFixedTpEnabled: sidewayFixedTp.enabled,
    sidewayFixedTpDistance: sidewayFixedTp.distance,
  };
}

type PersistedSettings = Partial<Phase7CLotSettingsState> & { version?: unknown };

function parseState(value: unknown): Phase7CLotSettingsState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as PersistedSettings;
  const version = Number(raw.version ?? 1);
  if (version !== 1 && version !== 2) return null;
  try {
    const normalized = validatePhase7CLotSettings({
      trendFixedLot: Number(raw.trendFixedLot),
      sidewayRiskPercent: Number(raw.sidewayRiskPercent),
      sidewayMaxLot: Number(raw.sidewayMaxLot),
      trendFixedTpEnabled: version >= 2 ? raw.trendFixedTpEnabled === true : false,
      trendFixedTpDistance: version >= 2 ? Number(raw.trendFixedTpDistance ?? 0) : 0,
      sidewayFixedTpEnabled: version >= 2 ? raw.sidewayFixedTpEnabled === true : false,
      sidewayFixedTpDistance: version >= 2 ? Number(raw.sidewayFixedTpDistance ?? 0) : 0,
    });
    return {
      version: 2,
      ...normalized,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof raw.updatedBy === "string" && raw.updatedBy.trim()
        ? raw.updatedBy.trim()
        : "unknown",
    };
  } catch {
    return null;
  }
}

type PersistedActiveSettings = Partial<Phase7CActiveLotSettings> & {
  version?: unknown;
  accountMode?: unknown;
};

function parseActive(value: unknown): Phase7CActiveLotSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as PersistedActiveSettings;
  const version = Number(raw.version ?? 1);
  if (version !== 1 && version !== 2) return null;
  try {
    const normalized = validatePhase7CLotSettings({
      trendFixedLot: Number(raw.trendFixedLot),
      sidewayRiskPercent: Number(raw.sidewayRiskPercent),
      sidewayMaxLot: Number(raw.sidewayMaxLot),
      trendFixedTpEnabled: version >= 2 ? raw.trendFixedTpEnabled === true : false,
      trendFixedTpDistance: version >= 2 ? Number(raw.trendFixedTpDistance ?? 0) : 0,
      sidewayFixedTpEnabled: version >= 2 ? raw.sidewayFixedTpEnabled === true : false,
      sidewayFixedTpDistance: version >= 2 ? Number(raw.sidewayFixedTpDistance ?? 0) : 0,
    });
    const supervisorPid = Number(raw.supervisorPid);
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) return null;
    const accountModeText = String(raw.accountMode ?? "DEMO").trim().toUpperCase();
    if (accountModeText !== "DEMO" && accountModeText !== "LIVE") return null;
    return {
      version: 2,
      accountMode: accountModeText,
      ...normalized,
      armed: raw.armed === true,
      supervisorPid,
      appliedAt: typeof raw.appliedAt === "string" ? raw.appliedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isCanonicalSupervisorAlive(activeFilePath: string, supervisorPid: number): boolean {
  try {
    const canonicalPid = Number(
      readFileSync(resolve(dirname(activeFilePath), "supervisor.pid"), "utf8").trim(),
    );
    if (!Number.isInteger(canonicalPid) || canonicalPid <= 0) return false;
    if (canonicalPid !== supervisorPid) return false;
    return isProcessAlive(supervisorPid);
  } catch {
    return false;
  }
}

function writeJsonAtomic(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

export class Phase7CLotSettingsService {
  private readonly filePath: string;
  private readonly activeFilePath: string;

  constructor(
    filePath = process.env.PHASE7C_LOT_SETTINGS_FILE,
    activeFilePath = process.env.PHASE7C_ACTIVE_LOT_SETTINGS_FILE,
  ) {
    this.filePath = filePath?.trim()
      ? resolve(filePath)
      : resolve(process.cwd(), ".runtime", "phase7c-lot-settings.json");
    this.activeFilePath = activeFilePath?.trim()
      ? resolve(activeFilePath)
      : resolve(process.cwd(), ".runtime", "phase7c-executors", "active-lot-settings.json");
  }

  private profilePath(accountMode: Phase7CAccountMode): string {
    return resolve(dirname(this.filePath), `phase7c-lot-settings.${accountMode.toLowerCase()}.json`);
  }

  getState(): Phase7CLotSettingsState {
    try {
      return parseState(JSON.parse(readFileSync(this.filePath, "utf8"))) ?? defaultState();
    } catch {
      return defaultState();
    }
  }

  getActive(): Phase7CActiveLotSettings | null {
    try {
      return parseActive(JSON.parse(readFileSync(this.activeFilePath, "utf8")));
    } catch {
      return null;
    }
  }

  get() {
    const state = this.getState();
    const active = this.getActive();
    const accountModeState = getPhase7CAccountModeState();
    const activeAlive = active
      ? isCanonicalSupervisorAlive(this.activeFilePath, active.supervisorPid)
      : false;
    const restartRequired =
      !accountModeState.valid ||
      !active ||
      !activeAlive ||
      !active.armed ||
      active.accountMode !== accountModeState.accountMode ||
      active.trendFixedLot !== state.trendFixedLot ||
      active.sidewayRiskPercent !== state.sidewayRiskPercent ||
      active.sidewayMaxLot !== state.sidewayMaxLot ||
      active.trendFixedTpEnabled !== state.trendFixedTpEnabled ||
      active.trendFixedTpDistance !== state.trendFixedTpDistance ||
      active.sidewayFixedTpEnabled !== state.sidewayFixedTpEnabled ||
      active.sidewayFixedTpDistance !== state.sidewayFixedTpDistance;

    return {
      state,
      active,
      activeAlive,
      restartRequired,
      accountMode: accountModeState,
      appliesTo: "NEW_POSITIONS_ONLY" as const,
      safety: {
        accountMode: accountModeState.accountMode,
        demoOnly: accountModeState.accountMode === "DEMO",
        requiresPause: true,
        requiresZeroXauusdPositions: true,
        existingPositionMutation: false,
        martingale: false,
        recoveryLotEscalation: false,
      },
      limits: PHASE7C_LOT_LIMITS,
    };
  }

  set(input: Phase7CLotSettingsInput, updatedBy = "operator") {
    const accountModeState = getPhase7CAccountModeState();
    if (!accountModeState.valid) {
      throw new Error(`Account-mode state is invalid; lot settings fail closed. ${accountModeState.error ?? ""}`.trim());
    }
    const normalized = validatePhase7CLotSettings(input);
    const state: Phase7CLotSettingsState = {
      version: 2,
      ...normalized,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy.trim() || "operator",
    };

    writeJsonAtomic(this.filePath, state);
    writeJsonAtomic(this.profilePath(accountModeState.accountMode), {
      ...state,
      accountMode: accountModeState.accountMode,
      appliesTo: "NEW_POSITIONS_ONLY",
      martingale: false,
      recoveryLotEscalation: false,
    });
    return this.get();
  }
}

export const phase7CLotSettingsService = new Phase7CLotSettingsService();
