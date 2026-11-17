import {
  assertLicenseRecord,
  effectiveLicenseStatus,
  type LicenseRecord,
} from "@xauusd/license-service";
import {
  COPY_FOLLOWER_SIZING_MODES,
  SELF_MANAGED_BOT_MODES,
  assertCustomerProductGrant,
  type CopyFollowerSizingMode,
  type CustomerProductGrant,
  type SelfManagedBotMode,
} from "./product-access.js";

export interface SelfManagedProvisionRequest {
  readonly grantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly allowedBotModes: readonly SelfManagedBotMode[];
}

export interface CopyFollowerProvisionRequest {
  readonly grantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly allowedCopySizingModes: readonly CopyFollowerSizingMode[];
}

const SELF_MANAGED_REQUEST_KEYS = new Set([
  "grantId",
  "issuedAt",
  "expiresAt",
  "allowedBotModes",
]);

const COPY_FOLLOWER_REQUEST_KEYS = new Set([
  "grantId",
  "issuedAt",
  "expiresAt",
  "allowedCopySizingModes",
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

function assertSafeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function assertExactObjectKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unknown field: ${key}`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TypeError(`${label} is missing field: ${key}`);
    }
  }
}

function normalizeEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowlist: readonly T[],
  options: { readonly requireNonEmpty: boolean },
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  if (options.requireNonEmpty && value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }

  const allowed = new Set<string>(allowlist);
  const seen = new Set<string>();
  const normalized: T[] = [];

  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new TypeError(`${field} contains an invalid value`);
    }
    if (seen.has(item)) {
      throw new TypeError(`${field} must not contain duplicate entries`);
    }
    seen.add(item);
    normalized.push(item as T);
  }

  return normalized;
}

function assertIssuanceWindow(
  license: LicenseRecord,
  issuedAt: number,
  expiresAt: number,
): void {
  assertSafeInteger(issuedAt, "issuedAt");
  assertSafeInteger(expiresAt, "expiresAt");

  if (expiresAt <= issuedAt) {
    throw new TypeError("expiresAt must be greater than issuedAt");
  }
  if (issuedAt < license.issuedAt || expiresAt > license.expiresAt) {
    throw new TypeError(
      "grant validity must be fully contained inside parent license validity",
    );
  }

  if (effectiveLicenseStatus(license, issuedAt) !== "ACTIVE") {
    throw new TypeError("parent license must be ACTIVE at grant issuance");
  }
}

function assertProvisionableLicense(
  license: LicenseRecord,
  issuedAt: number,
  expiresAt: number,
): void {
  assertLicenseRecord(license);
  assertIssuanceWindow(license, issuedAt, expiresAt);
}

export function issueSelfManagedGrant(
  license: LicenseRecord,
  request: SelfManagedProvisionRequest,
): CustomerProductGrant {
  assertExactObjectKeys(
    request,
    SELF_MANAGED_REQUEST_KEYS,
    "self-managed provision request",
  );
  assertCanonicalNonBlankString(request.grantId, "grantId");
  assertProvisionableLicense(license, request.issuedAt, request.expiresAt);

  const requestedModes = normalizeEnumArray(
    request.allowedBotModes,
    "allowedBotModes",
    SELF_MANAGED_BOT_MODES,
    { requireNonEmpty: false },
  );

  const allowedBotModes: SelfManagedBotMode[] = [
    "PAUSE",
    ...requestedModes.filter((mode) => mode !== "PAUSE"),
  ];

  const grant: CustomerProductGrant = {
    version: 1,
    grantId: request.grantId,
    licenseId: license.licenseId,
    customerId: license.customerId,
    productMode: "SELF_MANAGED",
    installationId: license.installationId,
    allowedBotModes,
    allowedCopySizingModes: [],
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
  };

  assertCustomerProductGrant(grant);
  return grant;
}

export function issueCopyFollowerGrant(
  license: LicenseRecord,
  request: CopyFollowerProvisionRequest,
): CustomerProductGrant {
  assertExactObjectKeys(
    request,
    COPY_FOLLOWER_REQUEST_KEYS,
    "copy-follower provision request",
  );
  assertCanonicalNonBlankString(request.grantId, "grantId");
  assertProvisionableLicense(license, request.issuedAt, request.expiresAt);

  const allowedCopySizingModes = normalizeEnumArray(
    request.allowedCopySizingModes,
    "allowedCopySizingModes",
    COPY_FOLLOWER_SIZING_MODES,
    { requireNonEmpty: true },
  );

  const grant: CustomerProductGrant = {
    version: 1,
    grantId: request.grantId,
    licenseId: license.licenseId,
    customerId: license.customerId,
    productMode: "COPY_FOLLOWER",
    installationId: license.installationId,
    allowedBotModes: [],
    allowedCopySizingModes,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
  };

  assertCustomerProductGrant(grant);
  return grant;
}
