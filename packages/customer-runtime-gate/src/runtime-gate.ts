import {
  activateCopyFollowerCustomer,
  activateSelfManagedCustomer,
  type CopyFollowerActivationRequest,
  type CustomerActivationDecision,
  type SelfManagedActivationRequest,
} from "@xauusd/customer-activation";
import type { CustomerGrantRegistryRepository } from "@xauusd/customer-grant-registry";
import {
  COPY_FOLLOWER_SIZING_MODES,
  SELF_MANAGED_BOT_MODES,
  assertCustomerProductGrantLifecycleRecord,
  effectiveCustomerGrantStatus,
  type CustomerProductGrantLifecycleRecord,
} from "@xauusd/customer-product-access";
import {
  assertLicenseRecord,
  effectiveLicenseStatus,
  type LicenseRecord,
} from "@xauusd/license-service";

export interface CustomerLicenseResolver {
  get(licenseId: string): Promise<unknown | null>;
}

export type SelfManagedRuntimeActivationRequest = Omit<
  SelfManagedActivationRequest,
  "now" | "consumeOnce"
> & {
  readonly grantId: string;
};

export type CopyFollowerRuntimeActivationRequest = Omit<
  CopyFollowerActivationRequest,
  "now" | "consumeOnce"
> & {
  readonly grantId: string;
};

export interface CustomerRuntimeSecurityServices {
  readonly now: () => number;
  readonly consumeOnce: SelfManagedActivationRequest["consumeOnce"];
}

type RuntimeContextFailure = {
  readonly ok: false;
  readonly code:
    | "GRANT_NOT_FOUND"
    | "INVALID_GRANT_SOURCE"
    | "PRODUCT_MODE_MISMATCH"
    | "LICENSE_NOT_FOUND"
    | "INVALID_LICENSE_SOURCE"
    | "INVALID_RUNTIME_SECURITY_CONTEXT"
    | "RUNTIME_STATE_CHANGED";
};

export type CustomerRuntimeActivationDecision =
  | CustomerActivationDecision
  | RuntimeContextFailure
  | {
      readonly ok: false;
      readonly code: "INVALID_RUNTIME_REQUEST";
    };

type ProductMode = "SELF_MANAGED" | "COPY_FOLLOWER";

const SELF_MANAGED_KEYS = new Set([
  "grantId",
  "installationId",
  "mt5Login",
  "brokerServer",
  "requestedBotMode",
  "proof",
]);

const COPY_FOLLOWER_KEYS = new Set([
  "grantId",
  "installationId",
  "mt5Login",
  "brokerServer",
  "requestedSizingMode",
  "proof",
]);

function isCanonicalNonBlankString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  if (keys.length !== required.size) return false;
  return keys.every((key) => required.has(key));
}

function isValidBaseRequest(
  request: Record<string, unknown>,
  required: ReadonlySet<string>,
): boolean {
  return (
    hasExactKeys(request, required) &&
    isCanonicalNonBlankString(request.grantId) &&
    isCanonicalNonBlankString(request.installationId) &&
    isPositiveSafeInteger(request.mt5Login) &&
    isCanonicalNonBlankString(request.brokerServer)
  );
}

function isSelfManagedRuntimeRequest(
  value: unknown,
): value is SelfManagedRuntimeActivationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const request = value as Record<string, unknown>;
  return (
    isValidBaseRequest(request, SELF_MANAGED_KEYS) &&
    SELF_MANAGED_BOT_MODES.includes(
      request.requestedBotMode as (typeof SELF_MANAGED_BOT_MODES)[number],
    )
  );
}

function isCopyFollowerRuntimeRequest(
  value: unknown,
): value is CopyFollowerRuntimeActivationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const request = value as Record<string, unknown>;
  return (
    isValidBaseRequest(request, COPY_FOLLOWER_KEYS) &&
    COPY_FOLLOWER_SIZING_MODES.includes(
      request.requestedSizingMode as (typeof COPY_FOLLOWER_SIZING_MODES)[number],
    )
  );
}

function resolveRuntimeSecurity(
  value: unknown,
): CustomerRuntimeSecurityServices | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<CustomerRuntimeSecurityServices>;
  if (
    typeof candidate.now !== "function" ||
    typeof candidate.consumeOnce !== "function"
  ) {
    return null;
  }

  return candidate as CustomerRuntimeSecurityServices;
}

function readServerNow(
  security: CustomerRuntimeSecurityServices,
): number | null {
  try {
    const now = security.now();
    return isSafeInteger(now) ? now : null;
  } catch {
    return null;
  }
}

async function loadCurrentRuntimeContext(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  grantId: string,
  expectedMode: ProductMode,
): Promise<
  | {
      readonly ok: true;
      readonly lifecycle: CustomerProductGrantLifecycleRecord;
      readonly license: LicenseRecord;
    }
  | RuntimeContextFailure
> {
  let lifecycle: CustomerProductGrantLifecycleRecord | null;
  try {
    lifecycle = await registry.get(grantId);
  } catch {
    return { ok: false, code: "INVALID_GRANT_SOURCE" };
  }

  if (!lifecycle) {
    return { ok: false, code: "GRANT_NOT_FOUND" };
  }

  try {
    assertCustomerProductGrantLifecycleRecord(lifecycle);
  } catch {
    return { ok: false, code: "INVALID_GRANT_SOURCE" };
  }

  if (lifecycle.grant.productMode !== expectedMode) {
    return { ok: false, code: "PRODUCT_MODE_MISMATCH" };
  }

  let rawLicense: unknown | null;
  try {
    rawLicense = await licenses.get(lifecycle.grant.licenseId);
  } catch {
    return { ok: false, code: "INVALID_LICENSE_SOURCE" };
  }

  if (rawLicense === null) {
    return { ok: false, code: "LICENSE_NOT_FOUND" };
  }

  try {
    assertLicenseRecord(rawLicense);
  } catch {
    return { ok: false, code: "INVALID_LICENSE_SOURCE" };
  }

  if (rawLicense.licenseId !== lifecycle.grant.licenseId) {
    return { ok: false, code: "INVALID_LICENSE_SOURCE" };
  }

  return {
    ok: true,
    lifecycle,
    license: rawLicense,
  };
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumberArray(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameGrantSnapshot(
  left: CustomerProductGrantLifecycleRecord,
  right: CustomerProductGrantLifecycleRecord,
): boolean {
  return (
    left.grant.version === right.grant.version &&
    left.grant.grantId === right.grant.grantId &&
    left.grant.licenseId === right.grant.licenseId &&
    left.grant.customerId === right.grant.customerId &&
    left.grant.productMode === right.grant.productMode &&
    left.grant.installationId === right.grant.installationId &&
    sameStringArray(left.grant.allowedBotModes, right.grant.allowedBotModes) &&
    sameStringArray(
      left.grant.allowedCopySizingModes,
      right.grant.allowedCopySizingModes,
    ) &&
    left.grant.issuedAt === right.grant.issuedAt &&
    left.grant.expiresAt === right.grant.expiresAt
  );
}

function sameLicenseSnapshot(
  left: LicenseRecord,
  right: LicenseRecord,
): boolean {
  return (
    left.licenseId === right.licenseId &&
    left.status === right.status &&
    left.customerId === right.customerId &&
    sameNumberArray(left.allowedMt5Logins, right.allowedMt5Logins) &&
    sameStringArray(left.allowedBrokerServers, right.allowedBrokerServers) &&
    left.installationId === right.installationId &&
    left.installationPublicKey === right.installationPublicKey &&
    left.plan === right.plan &&
    left.maxAccounts === right.maxAccounts &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.revokedAt === right.revokedAt
  );
}

async function exposureStateRemainsCurrent(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  lifecycle: CustomerProductGrantLifecycleRecord,
  license: LicenseRecord,
  now: number,
): Promise<boolean> {
  let currentLifecycle: CustomerProductGrantLifecycleRecord | null;
  try {
    currentLifecycle = await registry.get(lifecycle.grant.grantId);
  } catch {
    return false;
  }

  if (!currentLifecycle) return false;

  try {
    assertCustomerProductGrantLifecycleRecord(currentLifecycle);
  } catch {
    return false;
  }

  if (
    currentLifecycle.revision !== lifecycle.revision ||
    currentLifecycle.status !== lifecycle.status ||
    currentLifecycle.revokedAt !== lifecycle.revokedAt ||
    !sameGrantSnapshot(lifecycle, currentLifecycle)
  ) {
    return false;
  }

  let rawCurrentLicense: unknown | null;
  try {
    rawCurrentLicense = await licenses.get(license.licenseId);
  } catch {
    return false;
  }

  if (rawCurrentLicense === null) return false;

  try {
    assertLicenseRecord(rawCurrentLicense);
  } catch {
    return false;
  }

  if (!sameLicenseSnapshot(license, rawCurrentLicense)) {
    return false;
  }

  if (effectiveCustomerGrantStatus(currentLifecycle, now) !== "ACTIVE") {
    return false;
  }

  return effectiveLicenseStatus(rawCurrentLicense, now) === "ACTIVE";
}

export async function activateSelfManagedRuntime(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  securityInput: unknown,
  request: unknown,
): Promise<CustomerRuntimeActivationDecision> {
  if (!isSelfManagedRuntimeRequest(request)) {
    return { ok: false, code: "INVALID_RUNTIME_REQUEST" };
  }

  const security = resolveRuntimeSecurity(securityInput);
  const now = security ? readServerNow(security) : null;
  if (!security || now === null) {
    return { ok: false, code: "INVALID_RUNTIME_SECURITY_CONTEXT" };
  }

  const context = await loadCurrentRuntimeContext(
    registry,
    licenses,
    request.grantId,
    "SELF_MANAGED",
  );

  if (!context.ok) {
    return context;
  }

  const decision = await activateSelfManagedCustomer(
    context.license,
    context.lifecycle,
    {
      installationId: request.installationId,
      mt5Login: request.mt5Login,
      brokerServer: request.brokerServer,
      now,
      requestedBotMode: request.requestedBotMode,
      proof: request.proof,
      consumeOnce: security.consumeOnce,
    },
  );

  if (decision.ok && decision.exposureAllowed) {
    const finalNow = readServerNow(security);
    if (
      finalNow === null ||
      finalNow < now ||
      !(await exposureStateRemainsCurrent(
        registry,
        licenses,
        context.lifecycle,
        context.license,
        finalNow,
      ))
    ) {
      return { ok: false, code: "RUNTIME_STATE_CHANGED" };
    }
  }

  return decision;
}

export async function activateCopyFollowerRuntime(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  securityInput: unknown,
  request: unknown,
): Promise<CustomerRuntimeActivationDecision> {
  if (!isCopyFollowerRuntimeRequest(request)) {
    return { ok: false, code: "INVALID_RUNTIME_REQUEST" };
  }

  const security = resolveRuntimeSecurity(securityInput);
  const now = security ? readServerNow(security) : null;
  if (!security || now === null) {
    return { ok: false, code: "INVALID_RUNTIME_SECURITY_CONTEXT" };
  }

  const context = await loadCurrentRuntimeContext(
    registry,
    licenses,
    request.grantId,
    "COPY_FOLLOWER",
  );

  if (!context.ok) {
    return context;
  }

  const decision = await activateCopyFollowerCustomer(
    context.license,
    context.lifecycle,
    {
      installationId: request.installationId,
      mt5Login: request.mt5Login,
      brokerServer: request.brokerServer,
      now,
      requestedSizingMode: request.requestedSizingMode,
      proof: request.proof,
      consumeOnce: security.consumeOnce,
    },
  );

  if (decision.ok && decision.exposureAllowed) {
    const finalNow = readServerNow(security);
    if (
      finalNow === null ||
      finalNow < now ||
      !(await exposureStateRemainsCurrent(
        registry,
        licenses,
        context.lifecycle,
        context.license,
        finalNow,
      ))
    ) {
      return { ok: false, code: "RUNTIME_STATE_CHANGED" };
    }
  }

  return decision;
}
