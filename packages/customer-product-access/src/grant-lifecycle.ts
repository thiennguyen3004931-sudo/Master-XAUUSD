import type { LicenseRecord, LicenseStatus } from "@xauusd/license-service";
import {
  assertCustomerProductGrant,
  authorizeCopyFollowerAccess,
  authorizeSelfManagedAccess,
  type CopyFollowerAccessRequest,
  type CustomerProductAccessDecision,
  type CustomerProductGrant,
  type CustomerProductMode,
  type SelfManagedAccessRequest,
} from "./product-access.js";

export const CUSTOMER_GRANT_LIFECYCLE_STATUSES = ["ACTIVE", "REVOKED"] as const;

export type CustomerGrantLifecycleStatus =
  (typeof CUSTOMER_GRANT_LIFECYCLE_STATUSES)[number];

export type EffectiveCustomerGrantStatus =
  | "NOT_YET_VALID"
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED";

export interface CustomerProductGrantLifecycleRecord {
  readonly version: 1;
  readonly grant: CustomerProductGrant;
  readonly status: CustomerGrantLifecycleStatus;
  readonly revokedAt: number | null;
  readonly revision: number;
}

export type CustomerGrantLifecycleAccessDecision =
  | CustomerProductAccessDecision
  | {
      readonly ok: false;
      readonly code: "INVALID_GRANT_LIFECYCLE" | "GRANT_REVOKED";
      readonly productMode?: CustomerProductMode;
      readonly effectiveLicenseStatus?: LicenseStatus;
    };

const RECORD_KEYS = new Set([
  "version",
  "grant",
  "status",
  "revokedAt",
  "revision",
]);

const BINDING_FAILURE_CODES = new Set([
  "INVALID_LICENSE_RECORD",
  "INVALID_GRANT",
  "INVALID_REQUEST",
  "LICENSE_GRANT_MISMATCH",
  "INSTALLATION_MISMATCH",
  "MT5_LOGIN_NOT_ALLOWED",
  "BROKER_SERVER_NOT_ALLOWED",
  "PRODUCT_MODE_MISMATCH",
  "BOT_MODE_NOT_ALLOWED",
  "SIZING_MODE_NOT_ALLOWED",
]);

function assertSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
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

export function assertCustomerProductGrantLifecycleRecord(
  value: unknown,
): asserts value is CustomerProductGrantLifecycleRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("customer grant lifecycle record must be an object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.has(key)) {
      throw new TypeError(
        `customer grant lifecycle record contains unknown field: ${key}`,
      );
    }
  }
  for (const key of RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TypeError(
        `customer grant lifecycle record is missing field: ${key}`,
      );
    }
  }

  if (record.version !== 1) {
    throw new TypeError("customer grant lifecycle record version must be 1");
  }

  assertCustomerProductGrant(record.grant);

  if (
    !CUSTOMER_GRANT_LIFECYCLE_STATUSES.includes(
      record.status as CustomerGrantLifecycleStatus,
    )
  ) {
    throw new TypeError("customer grant lifecycle status is invalid");
  }

  assertPositiveSafeInteger(record.revision, "revision");

  const grant = record.grant as CustomerProductGrant;
  if (record.status === "ACTIVE") {
    if (record.revokedAt !== null) {
      throw new TypeError("ACTIVE lifecycle record must have revokedAt=null");
    }
    if (record.revision !== 1) {
      throw new TypeError("ACTIVE lifecycle record revision must be 1");
    }
    return;
  }

  if (record.revision < 2) {
    throw new TypeError("REVOKED lifecycle record revision must be at least 2");
  }

  assertSafeInteger(record.revokedAt, "revokedAt");
  if ((record.revokedAt as number) < grant.issuedAt) {
    throw new TypeError("revokedAt must not be earlier than grant issuedAt");
  }
}

export function createCustomerProductGrantLifecycle(
  grant: CustomerProductGrant,
): CustomerProductGrantLifecycleRecord {
  assertCustomerProductGrant(grant);

  const grantSnapshot: CustomerProductGrant = Object.freeze({
    ...grant,
    allowedBotModes: Object.freeze([...grant.allowedBotModes]),
    allowedCopySizingModes: Object.freeze([...grant.allowedCopySizingModes]),
  });

  const record: CustomerProductGrantLifecycleRecord = Object.freeze({
    version: 1,
    grant: grantSnapshot,
    status: "ACTIVE",
    revokedAt: null,
    revision: 1,
  });

  assertCustomerProductGrantLifecycleRecord(record);
  return record;
}

export function revokeCustomerProductGrant(
  record: CustomerProductGrantLifecycleRecord,
  revokedAt: number,
): CustomerProductGrantLifecycleRecord {
  assertCustomerProductGrantLifecycleRecord(record);
  assertSafeInteger(revokedAt, "revokedAt");

  if (record.status === "REVOKED") {
    return record;
  }

  if (revokedAt < record.grant.issuedAt) {
    throw new TypeError("revokedAt must not be earlier than grant issuedAt");
  }

  const revoked: CustomerProductGrantLifecycleRecord = Object.freeze({
    ...record,
    status: "REVOKED",
    revokedAt,
    revision: record.revision + 1,
  });

  assertCustomerProductGrantLifecycleRecord(revoked);
  return revoked;
}

export function effectiveCustomerGrantStatus(
  record: CustomerProductGrantLifecycleRecord,
  now: number,
): EffectiveCustomerGrantStatus {
  assertCustomerProductGrantLifecycleRecord(record);
  assertSafeInteger(now, "now");

  if (now < record.grant.issuedAt) {
    return "NOT_YET_VALID";
  }

  if (
    record.status === "REVOKED" &&
    record.revokedAt !== null &&
    now >= record.revokedAt
  ) {
    return "REVOKED";
  }

  if (now >= record.grant.expiresAt) {
    return "EXPIRED";
  }

  return "ACTIVE";
}

function lifecycleRecordOrFailure(
  record: CustomerProductGrantLifecycleRecord,
): CustomerGrantLifecycleAccessDecision | null {
  try {
    assertCustomerProductGrantLifecycleRecord(record);
    return null;
  } catch {
    return { ok: false, code: "INVALID_GRANT_LIFECYCLE" };
  }
}

function isBindingFailure(decision: CustomerProductAccessDecision): boolean {
  return !decision.ok && BINDING_FAILURE_CODES.has(decision.code);
}

export function authorizeSelfManagedLifecycleAccess(
  license: LicenseRecord,
  record: CustomerProductGrantLifecycleRecord,
  request: SelfManagedAccessRequest,
): CustomerGrantLifecycleAccessDecision {
  const invalidLifecycle = lifecycleRecordOrFailure(record);
  if (invalidLifecycle) return invalidLifecycle;

  const base = authorizeSelfManagedAccess(license, record.grant, request);

  if (request.requestedBotMode === "PAUSE") {
    return base;
  }

  if (isBindingFailure(base)) {
    return base;
  }

  if (effectiveCustomerGrantStatus(record, request.now) === "REVOKED") {
    return {
      ok: false,
      code: "GRANT_REVOKED",
      productMode: record.grant.productMode,
      effectiveLicenseStatus: base.effectiveLicenseStatus,
    };
  }

  return base;
}

export function authorizeCopyFollowerLifecycleAccess(
  license: LicenseRecord,
  record: CustomerProductGrantLifecycleRecord,
  request: CopyFollowerAccessRequest,
): CustomerGrantLifecycleAccessDecision {
  const invalidLifecycle = lifecycleRecordOrFailure(record);
  if (invalidLifecycle) return invalidLifecycle;

  const base = authorizeCopyFollowerAccess(license, record.grant, request);

  if (isBindingFailure(base)) {
    return base;
  }

  if (effectiveCustomerGrantStatus(record, request.now) === "REVOKED") {
    return {
      ok: false,
      code: "GRANT_REVOKED",
      productMode: record.grant.productMode,
      effectiveLicenseStatus: base.effectiveLicenseStatus,
    };
  }

  return base;
}
