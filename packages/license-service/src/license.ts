export const LICENSE_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "REVOKED"
] as const;

export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export interface LicenseRecord {
  readonly licenseId: string;
  readonly status: LicenseStatus;
  readonly customerId: string;
  readonly allowedMt5Logins: readonly number[];
  readonly allowedBrokerServers: readonly string[];
  readonly installationId: string;
  readonly installationPublicKey: string;
  readonly plan: string;
  readonly maxAccounts: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

const REQUIRED_KEYS = new Set([
  "licenseId",
  "status",
  "customerId",
  "allowedMt5Logins",
  "allowedBrokerServers",
  "installationId",
  "installationPublicKey",
  "plan",
  "maxAccounts",
  "issuedAt",
  "expiresAt",
  "revokedAt"
]);

function assertCanonicalNonBlankString(
  value: unknown,
  field: string
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
  field: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function assertUniquePositiveMt5Logins(
  value: unknown
): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("allowedMt5Logins must be a non-empty array");
  }

  const seen = new Set<number>();
  for (const login of value) {
    assertPositiveSafeInteger(login, "allowedMt5Logins entry");
    if (seen.has(login)) {
      throw new TypeError("allowedMt5Logins must not contain duplicate entries");
    }
    seen.add(login);
  }
}

function assertUniqueBrokerServers(
  value: unknown
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("allowedBrokerServers must be a non-empty array");
  }

  const seen = new Set<string>();
  for (const server of value) {
    assertCanonicalNonBlankString(server, "allowedBrokerServers entry");
    if (server.includes("*")) {
      throw new TypeError("allowedBrokerServers must not contain wildcard entries");
    }
    if (seen.has(server)) {
      throw new TypeError("allowedBrokerServers must not contain duplicate entries");
    }
    seen.add(server);
  }
}

export function assertLicenseRecord(value: unknown): asserts value is LicenseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("license record must be an object");
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REQUIRED_KEYS.has(key)) {
      throw new TypeError(`license record contains unknown field: ${key}`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TypeError(`license record is missing field: ${key}`);
    }
  }

  assertCanonicalNonBlankString(record.licenseId, "licenseId");
  if (!LICENSE_STATUSES.includes(record.status as LicenseStatus)) {
    throw new TypeError("status must be a canonical license status");
  }
  assertCanonicalNonBlankString(record.customerId, "customerId");
  assertUniquePositiveMt5Logins(record.allowedMt5Logins);
  assertUniqueBrokerServers(record.allowedBrokerServers);
  assertCanonicalNonBlankString(record.installationId, "installationId");
  assertCanonicalNonBlankString(
    record.installationPublicKey,
    "installationPublicKey"
  );
  assertCanonicalNonBlankString(record.plan, "plan");
  assertPositiveSafeInteger(record.maxAccounts, "maxAccounts");

  if ((record.allowedMt5Logins as readonly number[]).length > (record.maxAccounts as number)) {
    throw new TypeError("maxAccounts must cover all allowedMt5Logins");
  }

  assertSafeInteger(record.issuedAt, "issuedAt");
  assertSafeInteger(record.expiresAt, "expiresAt");
  if ((record.expiresAt as number) <= (record.issuedAt as number)) {
    throw new TypeError("expiresAt must be greater than issuedAt");
  }

  if (record.status === "REVOKED") {
    assertSafeInteger(record.revokedAt, "revokedAt");
    if ((record.revokedAt as number) < (record.issuedAt as number)) {
      throw new TypeError("revokedAt must not be earlier than issuedAt");
    }
  } else if (record.revokedAt !== null) {
    throw new TypeError("revokedAt must be null unless status is REVOKED");
  }
}

export function effectiveLicenseStatus(
  license: LicenseRecord,
  now: number
): LicenseStatus {
  if (!Number.isSafeInteger(now)) {
    throw new TypeError("now must be a safe integer");
  }
  if (license.status === "ACTIVE" && now >= license.expiresAt) {
    return "EXPIRED";
  }
  return license.status;
}
