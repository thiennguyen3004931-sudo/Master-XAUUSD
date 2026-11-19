import {
  COPY_COMMAND_ACTIONS,
  type CopyCommandAction
} from "@xauusd/copy-protocol";
import {
  assertLicenseRecord,
  effectiveLicenseStatus,
  type LicenseRecord,
  type LicenseStatus
} from "./license.js";

export type PositionSide = "BUY" | "SELL";

export interface ExistingPositionContext {
  readonly masterPositionRef: string;
  readonly side: PositionSide;
  readonly currentStopLoss: number | null;
  readonly requestedStopLoss?: number;
}

export interface LicenseActionRequest {
  readonly installationId: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly action: CopyCommandAction;
  readonly masterPositionRef: string;
  readonly now: number;
  readonly existingPosition?: ExistingPositionContext;
}

export type LicenseAuthorizationCode =
  | "AUTHORIZED"
  | "INVALID_LICENSE_RECORD"
  | "INVALID_REQUEST"
  | "LICENSE_NOT_YET_VALID"
  | "INSTALLATION_MISMATCH"
  | "MT5_LOGIN_NOT_ALLOWED"
  | "BROKER_SERVER_NOT_ALLOWED"
  | "LICENSE_NOT_ACTIVE"
  | "ACTION_NOT_ALLOWED_FOR_LICENSE_STATE"
  | "EXISTING_POSITION_REQUIRED"
  | "POSITION_MISMATCH"
  | "STOP_LOSS_CONTEXT_REQUIRED"
  | "STOP_LOSS_NOT_RISK_REDUCING";

export type LicenseAuthorizationDecision =
  | {
      readonly ok: true;
      readonly code: "AUTHORIZED";
      readonly effectiveStatus: LicenseStatus;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<LicenseAuthorizationCode, "AUTHORIZED">;
      readonly effectiveStatus?: LicenseStatus;
    };

const REQUEST_KEYS = new Set([
  "installationId",
  "mt5Login",
  "brokerServer",
  "action",
  "masterPositionRef",
  "now",
  "existingPosition"
]);

const POSITION_KEYS = new Set([
  "masterPositionRef",
  "side",
  "currentStopLoss",
  "requestedStopLoss"
]);

function assertCanonicalNonBlankString(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError("expected canonical non-blank string");
  }
}

function assertPositiveSafeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError("expected positive safe integer");
  }
}

function assertPositiveFiniteNumber(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("expected positive finite number");
  }
}

function assertExistingPosition(
  value: unknown
): asserts value is ExistingPositionContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("existingPosition must be an object");
  }

  const position = value as Record<string, unknown>;
  for (const key of Object.keys(position)) {
    if (!POSITION_KEYS.has(key)) {
      throw new TypeError(`existingPosition contains unknown field: ${key}`);
    }
  }

  for (const key of ["masterPositionRef", "side", "currentStopLoss"]) {
    if (!Object.prototype.hasOwnProperty.call(position, key)) {
      throw new TypeError(`existingPosition is missing field: ${key}`);
    }
  }

  assertCanonicalNonBlankString(position.masterPositionRef);
  if (position.side !== "BUY" && position.side !== "SELL") {
    throw new TypeError("existingPosition.side must be BUY or SELL");
  }

  if (position.currentStopLoss !== null) {
    assertPositiveFiniteNumber(position.currentStopLoss);
  }

  if (Object.prototype.hasOwnProperty.call(position, "requestedStopLoss")) {
    if (position.requestedStopLoss === undefined) {
      throw new TypeError("requestedStopLoss must be omitted or positive finite");
    }
    assertPositiveFiniteNumber(position.requestedStopLoss);
  }
}

function assertRequest(value: unknown): asserts value is LicenseActionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request must be an object");
  }

  const request = value as Record<string, unknown>;
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new TypeError(`request contains unknown field: ${key}`);
    }
  }

  for (const key of [
    "installationId",
    "mt5Login",
    "brokerServer",
    "action",
    "masterPositionRef",
    "now"
  ]) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) {
      throw new TypeError(`request is missing field: ${key}`);
    }
  }

  assertCanonicalNonBlankString(request.installationId);
  assertPositiveSafeInteger(request.mt5Login);
  assertCanonicalNonBlankString(request.brokerServer);
  if (!COPY_COMMAND_ACTIONS.includes(request.action as CopyCommandAction)) {
    throw new TypeError("action must be a V1 allowlisted copy action");
  }
  assertCanonicalNonBlankString(request.masterPositionRef);
  if (!Number.isSafeInteger(request.now)) {
    throw new TypeError("now must be a safe integer");
  }

  if (request.existingPosition !== undefined) {
    assertExistingPosition(request.existingPosition);
  }
}

function isNonLooseningStopUpdate(
  position: ExistingPositionContext
): boolean {
  const next = position.requestedStopLoss;
  if (next === undefined || !Number.isFinite(next) || next <= 0) {
    return false;
  }
  if (position.currentStopLoss === null) {
    return true;
  }
  if (!Number.isFinite(position.currentStopLoss) || position.currentStopLoss <= 0) {
    return false;
  }
  return position.side === "BUY"
    ? next >= position.currentStopLoss
    : next <= position.currentStopLoss;
}

export function authorizeLicenseAction(
  license: LicenseRecord,
  request: LicenseActionRequest
): LicenseAuthorizationDecision {
  try {
    assertLicenseRecord(license);
  } catch {
    return { ok: false, code: "INVALID_LICENSE_RECORD" };
  }

  try {
    assertRequest(request);
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  if (request.now < license.issuedAt) {
    return { ok: false, code: "LICENSE_NOT_YET_VALID" };
  }

  if (request.installationId !== license.installationId) {
    return { ok: false, code: "INSTALLATION_MISMATCH" };
  }

  if (!license.allowedMt5Logins.includes(request.mt5Login)) {
    return { ok: false, code: "MT5_LOGIN_NOT_ALLOWED" };
  }

  if (!license.allowedBrokerServers.includes(request.brokerServer)) {
    return { ok: false, code: "BROKER_SERVER_NOT_ALLOWED" };
  }

  const effectiveStatus = effectiveLicenseStatus(license, request.now);
  if (effectiveStatus === "ACTIVE") {
    return { ok: true, code: "AUTHORIZED", effectiveStatus };
  }

  if (request.action === "POSITION_OPEN") {
    return { ok: false, code: "LICENSE_NOT_ACTIVE", effectiveStatus };
  }

  if (request.action === "TAKE_PROFIT_UPDATE") {
    return {
      ok: false,
      code: "ACTION_NOT_ALLOWED_FOR_LICENSE_STATE",
      effectiveStatus
    };
  }

  const position = request.existingPosition;
  if (position === undefined) {
    return {
      ok: false,
      code: "EXISTING_POSITION_REQUIRED",
      effectiveStatus
    };
  }

  if (position.masterPositionRef !== request.masterPositionRef) {
    return { ok: false, code: "POSITION_MISMATCH", effectiveStatus };
  }

  if (request.action === "STOP_LOSS_UPDATE") {
    if (position.requestedStopLoss === undefined) {
      return {
        ok: false,
        code: "STOP_LOSS_CONTEXT_REQUIRED",
        effectiveStatus
      };
    }

    if (!isNonLooseningStopUpdate(position)) {
      return {
        ok: false,
        code: "STOP_LOSS_NOT_RISK_REDUCING",
        effectiveStatus
      };
    }
  }

  return { ok: true, code: "AUTHORIZED", effectiveStatus };
}
