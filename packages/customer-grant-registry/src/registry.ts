import {
  assertCustomerProductGrantLifecycleRecord,
  effectiveCustomerGrantStatus,
  revokeCustomerProductGrant,
  type CopyFollowerSizingMode,
  type CustomerGrantLifecycleStatus,
  type CustomerProductGrant,
  type CustomerProductGrantLifecycleRecord,
  type CustomerProductMode,
  type EffectiveCustomerGrantStatus,
  type SelfManagedBotMode,
} from "@xauusd/customer-product-access";

export interface CustomerGrantRegistryRepository {
  get(
    grantId: string,
  ): Promise<CustomerProductGrantLifecycleRecord | null>;

  compareAndSet(
    grantId: string,
    expectedRevision: number | null,
    next: CustomerProductGrantLifecycleRecord,
  ): Promise<boolean>;

  list(): Promise<readonly CustomerProductGrantLifecycleRecord[]>;
}

export interface CustomerGrantAdminQuery {
  readonly customerId?: string;
  readonly licenseId?: string;
  readonly installationId?: string;
  readonly productMode?: CustomerProductMode;
  readonly lifecycleStatus?: CustomerGrantLifecycleStatus;
}

export interface CustomerGrantAdminView {
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
  readonly lifecycleStatus: CustomerGrantLifecycleStatus;
  readonly revokedAt: number | null;
  readonly revision: number;
  readonly effectiveStatus: EffectiveCustomerGrantStatus;
}

export type RegisterCustomerGrantDecision =
  | {
      readonly ok: true;
      readonly code: "REGISTERED" | "ALREADY_REGISTERED";
      readonly record: CustomerProductGrantLifecycleRecord;
    }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_LIFECYCLE"
        | "INVALID_INITIAL_STATE"
        | "GRANT_ID_CONFLICT"
        | "REVISION_CONFLICT";
    };

export type RevokeRegisteredCustomerGrantDecision =
  | {
      readonly ok: true;
      readonly code: "REVOKED" | "ALREADY_REVOKED";
      readonly record: CustomerProductGrantLifecycleRecord;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "REVISION_CONFLICT";
    };

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

function cloneGrant(grant: CustomerProductGrant): CustomerProductGrant {
  return Object.freeze({
    ...grant,
    allowedBotModes: Object.freeze([...grant.allowedBotModes]),
    allowedCopySizingModes: Object.freeze([...grant.allowedCopySizingModes]),
  });
}

function cloneLifecycle(
  record: CustomerProductGrantLifecycleRecord,
): CustomerProductGrantLifecycleRecord {
  assertCustomerProductGrantLifecycleRecord(record);

  return Object.freeze({
    version: 1,
    grant: cloneGrant(record.grant),
    status: record.status,
    revokedAt: record.revokedAt,
    revision: record.revision,
  });
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function grantsEqual(
  left: CustomerProductGrant,
  right: CustomerProductGrant,
): boolean {
  return (
    left.version === right.version &&
    left.grantId === right.grantId &&
    left.licenseId === right.licenseId &&
    left.customerId === right.customerId &&
    left.productMode === right.productMode &&
    left.installationId === right.installationId &&
    stringArraysEqual(left.allowedBotModes, right.allowedBotModes) &&
    stringArraysEqual(
      left.allowedCopySizingModes,
      right.allowedCopySizingModes,
    ) &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt
  );
}

function lifecycleRecordsEqual(
  left: CustomerProductGrantLifecycleRecord,
  right: CustomerProductGrantLifecycleRecord,
): boolean {
  return (
    left.version === right.version &&
    grantsEqual(left.grant, right.grant) &&
    left.status === right.status &&
    left.revokedAt === right.revokedAt &&
    left.revision === right.revision
  );
}

function toAdminView(
  record: CustomerProductGrantLifecycleRecord,
  now: number,
): CustomerGrantAdminView {
  assertCustomerProductGrantLifecycleRecord(record);
  assertSafeInteger(now, "now");

  return Object.freeze({
    version: 1,
    grantId: record.grant.grantId,
    licenseId: record.grant.licenseId,
    customerId: record.grant.customerId,
    productMode: record.grant.productMode,
    installationId: record.grant.installationId,
    allowedBotModes: Object.freeze([...record.grant.allowedBotModes]),
    allowedCopySizingModes: Object.freeze([
      ...record.grant.allowedCopySizingModes,
    ]),
    issuedAt: record.grant.issuedAt,
    expiresAt: record.grant.expiresAt,
    lifecycleStatus: record.status,
    revokedAt: record.revokedAt,
    revision: record.revision,
    effectiveStatus: effectiveCustomerGrantStatus(record, now),
  });
}

function assertAdminQuery(query: CustomerGrantAdminQuery): void {
  const allowedKeys = new Set([
    "customerId",
    "licenseId",
    "installationId",
    "productMode",
    "lifecycleStatus",
  ]);

  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`customer grant admin query contains unknown field: ${key}`);
    }
  }

  if (query.customerId !== undefined) {
    assertCanonicalNonBlankString(query.customerId, "customerId");
  }
  if (query.licenseId !== undefined) {
    assertCanonicalNonBlankString(query.licenseId, "licenseId");
  }
  if (query.installationId !== undefined) {
    assertCanonicalNonBlankString(query.installationId, "installationId");
  }
  if (
    query.productMode !== undefined &&
    query.productMode !== "SELF_MANAGED" &&
    query.productMode !== "COPY_FOLLOWER"
  ) {
    throw new TypeError("productMode is invalid");
  }
  if (
    query.lifecycleStatus !== undefined &&
    query.lifecycleStatus !== "ACTIVE" &&
    query.lifecycleStatus !== "REVOKED"
  ) {
    throw new TypeError("lifecycleStatus is invalid");
  }
}

function matchesQuery(
  record: CustomerProductGrantLifecycleRecord,
  query: CustomerGrantAdminQuery,
): boolean {
  return (
    (query.customerId === undefined ||
      record.grant.customerId === query.customerId) &&
    (query.licenseId === undefined ||
      record.grant.licenseId === query.licenseId) &&
    (query.installationId === undefined ||
      record.grant.installationId === query.installationId) &&
    (query.productMode === undefined ||
      record.grant.productMode === query.productMode) &&
    (query.lifecycleStatus === undefined ||
      record.status === query.lifecycleStatus)
  );
}

export class InMemoryCustomerGrantRegistryRepository
  implements CustomerGrantRegistryRepository
{
  private readonly records = new Map<
    string,
    CustomerProductGrantLifecycleRecord
  >();

  async get(
    grantId: string,
  ): Promise<CustomerProductGrantLifecycleRecord | null> {
    assertCanonicalNonBlankString(grantId, "grantId");
    const record = this.records.get(grantId);
    return record ? cloneLifecycle(record) : null;
  }

  async compareAndSet(
    grantId: string,
    expectedRevision: number | null,
    next: CustomerProductGrantLifecycleRecord,
  ): Promise<boolean> {
    assertCanonicalNonBlankString(grantId, "grantId");
    assertCustomerProductGrantLifecycleRecord(next);

    if (next.grant.grantId !== grantId) {
      throw new TypeError("repository grantId must match lifecycle grantId");
    }

    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
    ) {
      throw new TypeError(
        "expectedRevision must be null or a positive safe integer",
      );
    }

    const existing = this.records.get(grantId);

    if (expectedRevision === null) {
      if (existing) return false;
    } else if (!existing || existing.revision !== expectedRevision) {
      return false;
    }

    this.records.set(grantId, cloneLifecycle(next));
    return true;
  }

  async list(): Promise<readonly CustomerProductGrantLifecycleRecord[]> {
    return Object.freeze(
      [...this.records.values()]
        .sort((left, right) =>
          left.grant.grantId.localeCompare(right.grant.grantId),
        )
        .map(cloneLifecycle),
    );
  }
}

export async function registerCustomerGrant(
  repository: CustomerGrantRegistryRepository,
  lifecycle: CustomerProductGrantLifecycleRecord,
): Promise<RegisterCustomerGrantDecision> {
  try {
    assertCustomerProductGrantLifecycleRecord(lifecycle);
  } catch {
    return { ok: false, code: "INVALID_LIFECYCLE" };
  }

  if (
    lifecycle.status !== "ACTIVE" ||
    lifecycle.revokedAt !== null ||
    lifecycle.revision !== 1
  ) {
    return { ok: false, code: "INVALID_INITIAL_STATE" };
  }

  const grantId = lifecycle.grant.grantId;
  const existing = await repository.get(grantId);

  if (existing) {
    if (lifecycleRecordsEqual(existing, lifecycle)) {
      return {
        ok: true,
        code: "ALREADY_REGISTERED",
        record: cloneLifecycle(existing),
      };
    }

    return { ok: false, code: "GRANT_ID_CONFLICT" };
  }

  const saved = await repository.compareAndSet(grantId, null, lifecycle);
  if (!saved) {
    const concurrent = await repository.get(grantId);
    if (concurrent && lifecycleRecordsEqual(concurrent, lifecycle)) {
      return {
        ok: true,
        code: "ALREADY_REGISTERED",
        record: cloneLifecycle(concurrent),
      };
    }

    return {
      ok: false,
      code: concurrent ? "GRANT_ID_CONFLICT" : "REVISION_CONFLICT",
    };
  }

  return {
    ok: true,
    code: "REGISTERED",
    record: cloneLifecycle(lifecycle),
  };
}

export async function revokeRegisteredCustomerGrant(
  repository: CustomerGrantRegistryRepository,
  grantId: string,
  revokedAt: number,
): Promise<RevokeRegisteredCustomerGrantDecision> {
  try {
    assertCanonicalNonBlankString(grantId, "grantId");
    assertSafeInteger(revokedAt, "revokedAt");
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const existing = await repository.get(grantId);
  if (!existing) {
    return { ok: false, code: "NOT_FOUND" };
  }

  if (existing.status === "REVOKED") {
    return {
      ok: true,
      code: "ALREADY_REVOKED",
      record: cloneLifecycle(existing),
    };
  }

  let revoked: CustomerProductGrantLifecycleRecord;
  try {
    revoked = revokeCustomerProductGrant(existing, revokedAt);
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const saved = await repository.compareAndSet(
    grantId,
    existing.revision,
    revoked,
  );

  if (!saved) {
    return { ok: false, code: "REVISION_CONFLICT" };
  }

  return {
    ok: true,
    code: "REVOKED",
    record: cloneLifecycle(revoked),
  };
}

export async function getCustomerGrantAdminView(
  repository: CustomerGrantRegistryRepository,
  grantId: string,
  now: number,
): Promise<CustomerGrantAdminView | null> {
  assertCanonicalNonBlankString(grantId, "grantId");
  assertSafeInteger(now, "now");

  const record = await repository.get(grantId);
  return record ? toAdminView(record, now) : null;
}

export async function listCustomerGrantAdminViews(
  repository: CustomerGrantRegistryRepository,
  query: CustomerGrantAdminQuery,
  now: number,
): Promise<readonly CustomerGrantAdminView[]> {
  assertAdminQuery(query);
  assertSafeInteger(now, "now");

  const records = await repository.list();
  return Object.freeze(
    records
      .filter((record) => matchesQuery(record, query))
      .map((record) => toAdminView(record, now)),
  );
}
