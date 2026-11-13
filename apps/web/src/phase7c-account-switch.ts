import type { Mt5TelemetrySnapshot } from "./types";
import type { Phase7CAccountMode, Phase7CSameModeAccountChangeReadiness } from "./phase7c-account-switch-types";

export const SAME_MODE_ACCOUNT_CHANGE_POLICY = {
  credentialInput: "NONE",
  manualLoginInMt5: true,
  autoArmAfterVerification: false,
  autoAutoAfterVerification: false,
  liveSameModeVerificationRequiresCanonicalProfile: true,
} as const;

export type Mt5AccountIdentity = {
  accountLogin: number | null;
  server: string | null;
  accountMode: Phase7CAccountMode | null;
};

export type SameModeMt5AccountVerificationState =
  | "WAITING_FOR_IDENTITY_CHANGE"
  | "IDENTITY_CHANGED_BUT_CANONICAL_PROFILE_UNVERIFIED"
  | "VERIFIED"
  | "BLOCKED";

function normalizeAccountMode(value: string | null | undefined): Phase7CAccountMode | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "real") return "LIVE";
  if (normalized === "demo") return "DEMO";
  return null;
}

export function captureMt5AccountIdentity(snapshot: Mt5TelemetrySnapshot | null | undefined): Mt5AccountIdentity {
  if (!snapshot) {
    return { accountLogin: null, server: null, accountMode: null };
  }
  const accountLogin = Number(snapshot.accountLogin);
  return {
    accountLogin: Number.isFinite(accountLogin) && accountLogin > 0 ? accountLogin : null,
    server: snapshot.health?.server?.trim() || null,
    accountMode: normalizeAccountMode(snapshot.health?.accountMode),
  };
}

export function hasMt5AccountIdentityChanged(
  baseline: Mt5AccountIdentity | null | undefined,
  current: Mt5AccountIdentity | null | undefined,
): boolean {
  if (!baseline?.accountLogin || !current?.accountLogin) return false;
  return baseline.accountLogin !== current.accountLogin;
}

export function getSameModeMt5AccountVerificationState(input: {
  baseline: Mt5AccountIdentity | null | undefined;
  telemetry: Mt5TelemetrySnapshot | null | undefined;
  readiness: Phase7CSameModeAccountChangeReadiness | null | undefined;
}): SameModeMt5AccountVerificationState {
  const { baseline, telemetry, readiness } = input;
  if (!baseline || !telemetry || !readiness) return "BLOCKED";

  const current = captureMt5AccountIdentity(telemetry);
  const identityChanged = hasMt5AccountIdentityChanged(baseline, current);
  if (!identityChanged) return "WAITING_FOR_IDENTITY_CHANGE";

  const bridgeIdentitySafe = Boolean(
    readiness.approved &&
      readiness.currentMode === baseline.accountMode &&
      current.accountMode === baseline.accountMode &&
      telemetry.reachable &&
      telemetry.health?.connected === true &&
      telemetry.health?.tradingEnabled === true &&
      telemetry.health?.terminalTradeAllowed === true &&
      telemetry.health?.expertTradeAllowed === true &&
      telemetry.positions.length === 0,
  );

  if (!bridgeIdentitySafe) return "BLOCKED";

  // LIVE A -> LIVE B is deliberately detect-only here. Canonical LIVE execution also
  // binds MT5_LOGIN / MT5_ALLOWED_LOGINS and the LIVE risk profile to the account.
  // The existing same-mode Web flow has no canonical writer/rebind operation, so a
  // changed bridge login can never by itself prove that it is safe to reactivate LIVE.
  if (baseline.accountMode === "LIVE") {
    return "IDENTITY_CHANGED_BUT_CANONICAL_PROFILE_UNVERIFIED";
  }

  return "VERIFIED";
}

export function isSameModeMt5AccountVerified(input: {
  baseline: Mt5AccountIdentity | null | undefined;
  telemetry: Mt5TelemetrySnapshot | null | undefined;
  readiness: Phase7CSameModeAccountChangeReadiness | null | undefined;
}): boolean {
  return getSameModeMt5AccountVerificationState(input) === "VERIFIED";
}

export function maskMt5AccountLogin(accountLogin: number | null | undefined): string {
  if (!Number.isFinite(accountLogin)) return "—";
  const text = String(Math.trunc(Number(accountLogin)));
  return text.length <= 4 ? `••••${text}` : `••••${text.slice(-4)}`;
}
