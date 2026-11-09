import {
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { Phase7CAccountMode } from "./phase7c-account-mode.service.js";
import type { Phase7CLiveProfileIdentity } from "./phase7c-live-authorization.service.js";
import { validatePhase7CLotSettings } from "./phase7c-lot-settings.service.js";

function canonicalLotSettingsPath(): string {
  const configured = process.env.PHASE7C_LOT_SETTINGS_FILE?.trim();
  return configured
    ? resolve(configured)
    : resolve(process.cwd(), ".runtime", "phase7c-lot-settings.json");
}

function profilePath(accountMode: Phase7CAccountMode): string {
  const canonical = canonicalLotSettingsPath();
  return resolve(dirname(canonical), `phase7c-lot-settings.${accountMode.toLowerCase()}.json`);
}

function normalizeServer(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

export function activatePhase7CAccountRiskProfile(input: {
  accountMode: Phase7CAccountMode;
  liveIdentity?: Phase7CLiveProfileIdentity | null;
  updatedBy?: string;
}) {
  const filePath = profilePath(input.accountMode);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Không đọc được risk profile ${input.accountMode}: ${filePath}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const configuredMode = String(raw.accountMode ?? "").trim().toUpperCase();
  if (configuredMode && configuredMode !== input.accountMode) {
    throw new Error(`Risk profile accountMode=${configuredMode} không khớp ${input.accountMode}.`);
  }

  const normalized = validatePhase7CLotSettings({
    trendFixedLot: Number(raw.trendFixedLot),
    sidewayRiskPercent: Number(raw.sidewayRiskPercent),
    sidewayMaxLot: Number(raw.sidewayMaxLot),
  });

  if (input.accountMode === "LIVE") {
    const identity = input.liveIdentity;
    if (!identity) throw new Error("LIVE risk profile requires validated LIVE profile identity.");
    if (configuredMode !== "LIVE") {
      throw new Error("LIVE risk profile must be explicitly bound to accountMode LIVE.");
    }
    if (Number(raw.accountLogin) !== identity.accountLogin) {
      throw new Error("LIVE risk profile accountLogin does not match authorized LIVE profile.");
    }
    if (normalizeServer(raw.server) !== normalizeServer(identity.server)) {
      throw new Error("LIVE risk profile server does not match authorized LIVE profile.");
    }
    if (
      String(raw.profileFingerprint ?? "").trim().toLowerCase() !==
      identity.profileFingerprint.toLowerCase()
    ) {
      throw new Error("LIVE risk profile fingerprint does not match authorized LIVE profile.");
    }
    if (String(raw.appliesTo ?? "").trim().toUpperCase() !== "NEW_POSITIONS_ONLY") {
      throw new Error("LIVE risk profile must keep appliesTo=NEW_POSITIONS_ONLY.");
    }
    if (raw.martingale !== false || raw.recoveryLotEscalation !== false) {
      throw new Error("LIVE risk profile must keep martingale/recovery lot escalation disabled.");
    }
  }

  const selected = {
    version: 1 as const,
    ...normalized,
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy?.trim() || `web-auto-detect:${input.accountMode}`,
  };
  writeJsonAtomic(canonicalLotSettingsPath(), selected);
  return selected;
}
