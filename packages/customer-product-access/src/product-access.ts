import {
  assertLicenseRecord,
  effectiveLicenseStatus,
  type LicenseRecord,
  type LicenseStatus,
} from "@xauusd/license-service";

export const CUSTOMER_PRODUCT_MODES = [
  "SELF_MANAGED",
  "COPY_FOLLOWER",
] as const;

export type CustomerProductMode = (typeof CUSTOMER_PRODUCT_MODES)[number];

export const SELF_MANAGED_BOT_MODES = [
  "PAUSE",
  "AUTO",
  "SEMI",
  "TREND",
  "SIDEWAY",
] as const;

export type SelfManagedBotMode = (typeof SELF_MANAGED_BOT_MODES)[number];

export const COPY_FOLLOWER_SIZING_MODES = [
  "EQUITY_RATIO",
  "LOT_MULTIPLIER",
  "FIXED_LOT",
] as const;

export type CopyFollowerSizingMode =
  (typeof COPY_FOLLOWER_SIZING_MODES)[number];

export interface CustomerProductGrant {
  readonly version: 1;
  readonly grantId: string;
  readonly licenseId: string;
  readonly customerId: string;
  readonly productMode: CustomerProductMode;
  readonly installationId: string;
  readonly allowedBotModes: readonly SelfManagedBotMode[];
  readonly allowedCopySizingModes: readonly CopyFollowerSizingMode[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CustomerAccessBaseRequest {
  readonly installationId: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly now: number;
}

export interface SelfManagedAccessRequest extends CustomerAccessBaseRequest {
  readonly requestedBotMode: SelfManagedBotMode;
}

export interface CopyFollowerAccessRequest extends CustomerAccessBaseRequest {
  readonly requestedSizingMode: CopyFollowerSizingMode;
}

export type CustomerProductAccessCode =
  | "AUTHORIZED"
  | "AUTHORIZED_SAFE_PAUSE"
  | "INVALID_LICENSE_RECORD"
  | "INVALID_GRANT"
  | "INVALID_REQUEST"
  | "LICENSE_GRANT_MISMATCH"
  | "INSTALLATION_MISMATCH"
  | "MT5_LOGIN_NOT_ALLOWED"
  | "BROKER_SERVER_NOT_ALLOWED"
  | "PRODUCT_MODE_MISMATCH"
  | "BOT_MODE_NOT_ALLOWED"
  | "SIZING_MODE_NOT_ALLOWED"
  | "LICENSE_NOT_ACTIVE"
  | "GRANT_NOT_YET_VALID"
  | "GRANT_EXPIRED";

export type CustomerProductAccessDecision =
  | {
      readonly ok: true;
      readonly code: "AUTHORIZED" | "AUTHORIZED_SAFE_PAUSE";
      readonly productMode: CustomerProductMode;
      readonly effectiveLicenseStatus: LicenseStatus;
      readonly exposureAllowed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<
        CustomerProductAccessCode,
        "AUTHORIZED" | "AUTHORIZED_SAFE_PAUSE"
      >;
      readonly productMode?: CustomerProductMode;
      readonly effectiveLicenseStatus?: LicenseStatus;
    };

const GRANT_KEYS = new Set([
  "version",
  "grantId",
  "licenseId",
  "customerId",
  "productMode",
  "installationId",
  "allowedBotModes",
  "allowedCopySizingModes",
  "issuedAt",
  "expiresAt",
]);

const BASE_REQUEST_KEYS = new Set([
  "installationId",
  "mt5Login",
  "brokerServer",
  "now",
]);

function assertCanonicalNonBlankString(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a canonical non-blank string`);
  }
}

function assertPositiveSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function assertExactEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowlist: readonly T[],
): asserts value is readonly T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }

  const allowed = new Set<string>(allowlist);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new TypeError(`${field} contains an invalid value`);
    }
    if (seen.has(item)) {
      throw new TypeError(`${field} must not contain duplicate entries`);
    }
    seen.add(item);
  }
}

export function assertCustomerProductGrant(
  value: unknown,
): asserts value is CustomerProductGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("customer product grant must be an object");
  }

  const grant = value as Record<string, unknown>;
  for (const key of Object.keys(grant)) {
    if (!GRANT_KEYS.has(key)) {
      throw new TypeError(`customer product grant contains unknown field: ${key}`);
    }
  }
  for (const key of GRANT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(grant, key)) {
      throw new TypeError(`customer product grant is missing field: ${key}`);
    }
  }

  if (grant.version !== 1) {
    throw new TypeError("customer product grant version must be 1");
  }

  assertCanonicalNonBlankString(grant.grantId, "grantId");
  assertCanonicalNonBlankString(grant.licenseId, "licenseId");
  assertCanonicalNonBlankString(grant.customerId, "customerId");
  assertCanonicalNonBlankString(grant.installationId, "installationId");

  if (!CUSTOMER_PRODUCT_MODES.includes(grant.productMode as CustomerProductMode)) {
    throw new TypeError("productMode must be SELF_MANAGED or COPY_FOLLOWER");
  }

  assertExactEnumArray(
    grant.allowedBotModes,
    "allowedBotModes",
    SELF_MANAGED_BOT_MODES,
  );
  assertExactEnumArray(
    grant.allowedCopySizingModes,
    "allowedCopySizingModes",
    COPY_FOLLOWER_SIZING_MODES,
  );

  if (grant.productMode === "SELF_MANAGED") {
    if ((grant.allowedBotModes as readonly string[]).length === 0) {
      throw new TypeError("SELF_MANAGED grant must allow at least one bot mode");
    }
    if (!(grant.allowedBotModes as readonly string[]).includes("PAUSE")) {
      throw new TypeError("SELF_MANAGED grant must always allow PAUSE");
    }
    if ((grant.allowedCopySizingModes as readonly string[]).length !== 0) {
      throw new TypeError(
        "SELF_MANAGED grant must not contain copy follower sizing modes",
      );
    }
  }

  if (grant.productMode === "COPY_FOLLOWER") {
    if ((grant.allowedBotModes as readonly string[]).length !== 0) {
      throw new TypeError("COPY_FOLLOWER grant must not contain bot modes");
    }
    if ((grant.allowedCopySizingModes as readonly string[]).length === 0) {
      throw new TypeError(
        "COPY_FOLLOWER grant must allow at least one sizing mode",
      );
    }
  }

  assertSafeInteger(grant.issuedAt, "issuedAt");
  assertSafeInteger(grant.expiresAt, "expiresAt");
  if ((grant.expiresAt as number) <= (grant.issuedAt as number)) {
    throw new TypeError("grant expiresAt must be greater than issuedAt");
  }
}

function assertBaseRequest(
  value: unknown,
  extraKey: string,
): asserts value is CustomerAccessBaseRequest & Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("customer access request must be an object");
  }

  const request = value as Record<string, unknown>;
  const allowed = new Set([...BASE_REQUEST_KEYS, extraKey]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) {
      throw new TypeError(`customer access request contains unknown field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) {
      throw new TypeError(`customer access request is missing field: ${key}`);
    }
  }

  assertCanonicalNonBlankString(request.installationId, "installationId");
  assertPositiveSafeInteger(request.mt5Login, "mt5Login");
  assertCanonicalNonBlankString(request.brokerServer, "brokerServer");
  assertSafeInteger(request.now, "now");
}

function validateCommon(
  license: LicenseRecord,
  grant: CustomerProductGrant,
  request: CustomerAccessBaseRequest,
): CustomerProductAccessDecision | null {
  try {
    assertLicenseRecord(license);
  } catch {
    return { ok: false, code: "INVALID_LICENSE_RECORD" };
  }

  try {
    assertCustomerProductGrant(grant);
  } catch {
    return { ok: false, code: "INVALID_GRANT" };
  }

  const licenseStatus = effectiveLicenseStatus(license, request.now);

  if (
    grant.licenseId !== license.licenseId ||
    grant.customerId !== license.customerId ||
    grant.installationId !== license.installationId ||
    grant.issuedAt < license.issuedAt ||
    grant.expiresAt > license.expiresAt
  ) {
    return {
      ok: false,
      code: "LICENSE_GRANT_MISMATCH",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (
    request.installationId !== grant.installationId ||
    request.installationId !== license.installationId
  ) {
    return {
      ok: false,
      code: "INSTALLATION_MISMATCH",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (!license.allowedMt5Logins.includes(request.mt5Login)) {
    return {
      ok: false,
      code: "MT5_LOGIN_NOT_ALLOWED",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (!license.allowedBrokerServers.includes(request.brokerServer)) {
    return {
      ok: false,
      code: "BROKER_SERVER_NOT_ALLOWED",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  return null;
}

function safePauseDecision(
  grant: CustomerProductGrant,
  license: LicenseRecord,
  now: number,
): CustomerProductAccessDecision {
  return {
    ok: true,
    code: "AUTHORIZED_SAFE_PAUSE",
    productMode: grant.productMode,
    effectiveLicenseStatus: effectiveLicenseStatus(license, now),
    exposureAllowed: false,
  };
}

export function authorizeSelfManagedAccess(
  license: LicenseRecord,
  grant: CustomerProductGrant,
  request: SelfManagedAccessRequest,
): CustomerProductAccessDecision {
  try {
    assertBaseRequest(request, "requestedBotMode");
    if (!SELF_MANAGED_BOT_MODES.includes(request.requestedBotMode)) {
      throw new TypeError("requestedBotMode is invalid");
    }
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const common = validateCommon(license, grant, request);
  if (common) return common;

  const licenseStatus = effectiveLicenseStatus(license, request.now);

  if (grant.productMode !== "SELF_MANAGED") {
    return {
      ok: false,
      code: "PRODUCT_MODE_MISMATCH",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (!grant.allowedBotModes.includes(request.requestedBotMode)) {
    return {
      ok: false,
      code: "BOT_MODE_NOT_ALLOWED",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (request.requestedBotMode === "PAUSE") {
    return safePauseDecision(grant, license, request.now);
  }

  if (request.now < grant.issuedAt) {
    return {
      ok: false,
      code: "GRANT_NOT_YET_VALID",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (request.now >= grant.expiresAt) {
    return {
      ok: false,
      code: "GRANT_EXPIRED",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (licenseStatus !== "ACTIVE") {
    return {
      ok: false,
      code: "LICENSE_NOT_ACTIVE",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  return {
    ok: true,
    code: "AUTHORIZED",
    productMode: grant.productMode,
    effectiveLicenseStatus: licenseStatus,
    exposureAllowed: true,
  };
}

export function authorizeCopyFollowerAccess(
  license: LicenseRecord,
  grant: CustomerProductGrant,
  request: CopyFollowerAccessRequest,
): CustomerProductAccessDecision {
  try {
    assertBaseRequest(request, "requestedSizingMode");
    if (!COPY_FOLLOWER_SIZING_MODES.includes(request.requestedSizingMode)) {
      throw new TypeError("requestedSizingMode is invalid");
    }
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const common = validateCommon(license, grant, request);
  if (common) return common;

  const licenseStatus = effectiveLicenseStatus(license, request.now);

  if (grant.productMode !== "COPY_FOLLOWER") {
    return {
      ok: false,
      code: "PRODUCT_MODE_MISMATCH",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (!grant.allowedCopySizingModes.includes(request.requestedSizingMode)) {
    return {
      ok: false,
      code: "SIZING_MODE_NOT_ALLOWED",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (request.now < grant.issuedAt) {
    return {
      ok: false,
      code: "GRANT_NOT_YET_VALID",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (request.now >= grant.expiresAt) {
    return {
      ok: false,
      code: "GRANT_EXPIRED",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  if (licenseStatus !== "ACTIVE") {
    return {
      ok: false,
      code: "LICENSE_NOT_ACTIVE",
      productMode: grant.productMode,
      effectiveLicenseStatus: licenseStatus,
    };
  }

  return {
    ok: true,
    code: "AUTHORIZED",
    productMode: grant.productMode,
    effectiveLicenseStatus: licenseStatus,
    exposureAllowed: true,
  };
}
