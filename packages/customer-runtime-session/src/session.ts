import type { CustomerGrantRegistryRepository } from "@xauusd/customer-grant-registry";
import {
  assertCustomerProductGrantLifecycleRecord,
  type CustomerProductMode,
} from "@xauusd/customer-product-access";
import {
  activateCopyFollowerRuntime,
  activateSelfManagedRuntime,
  type CopyFollowerRuntimeActivationRequest,
  type CustomerLicenseResolver,
  type CustomerRuntimeActivationDecision,
  type SelfManagedRuntimeActivationRequest,
} from "@xauusd/customer-runtime-gate";
import {
  createInstallationChallenge,
  type InstallationChallenge,
} from "@xauusd/installation-proof";
import {
  assertLicenseRecord,
  type LicenseRecord,
} from "@xauusd/license-service";

export const CUSTOMER_RUNTIME_CHALLENGE_TTL_MS = 60_000;

export interface CustomerRuntimeSessionClock {
  now(): number;
}

export interface CustomerRuntimeChallengeStore {
  put(challenge: InstallationChallenge): Promise<boolean>;
  consume(challengeId: string, now: number): Promise<boolean>;
}

export class InMemoryCustomerRuntimeChallengeStore
  implements CustomerRuntimeChallengeStore
{
  private readonly challenges = new Map<string, InstallationChallenge>();
  private readonly consumed = new Set<string>();

  async put(challenge: InstallationChallenge): Promise<boolean> {
    if (
      this.challenges.has(challenge.challengeId) ||
      this.consumed.has(challenge.challengeId)
    ) {
      return false;
    }
    this.challenges.set(challenge.challengeId, Object.freeze({ ...challenge }));
    return true;
  }

  async consume(challengeId: string, now: number): Promise<boolean> {
    if (
      typeof challengeId !== "string" ||
      challengeId.length === 0 ||
      !Number.isSafeInteger(now) ||
      this.consumed.has(challengeId)
    ) {
      return false;
    }

    const challenge = this.challenges.get(challengeId);
    if (!challenge) return false;

    this.challenges.delete(challengeId);
    this.consumed.add(challengeId);

    if (now < challenge.issuedAt || now > challenge.expiresAt) {
      return false;
    }

    return true;
  }
}

export type CustomerRuntimeChallengeDecision =
  | {
      readonly ok: true;
      readonly code: "CHALLENGE_ISSUED";
      readonly productMode: CustomerProductMode;
      readonly challenge: InstallationChallenge;
    }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_CHALLENGE_REQUEST"
        | "INVALID_SESSION_CONTEXT"
        | "GRANT_NOT_FOUND"
        | "INVALID_GRANT_SOURCE"
        | "PRODUCT_MODE_MISMATCH"
        | "LICENSE_NOT_FOUND"
        | "INVALID_LICENSE_SOURCE"
        | "INSTALLATION_MISMATCH"
        | "CHALLENGE_STORE_REJECTED";
    };

const CHALLENGE_KEYS = new Set(["grantId", "installationId"]);

function canonicalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

function safeNow(clock: CustomerRuntimeSessionClock): number | null {
  try {
    const now = clock.now();
    return Number.isSafeInteger(now) ? now : null;
  } catch {
    return null;
  }
}

function validChallengeRequest(
  value: unknown,
): value is { readonly grantId: string; readonly installationId: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === CHALLENGE_KEYS.size &&
    keys.every((key) => CHALLENGE_KEYS.has(key)) &&
    canonicalString(record.grantId) &&
    canonicalString(record.installationId)
  );
}

async function loadBoundContext(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  request: { readonly grantId: string; readonly installationId: string },
  expectedMode: CustomerProductMode,
): Promise<
  | { readonly ok: true; readonly license: LicenseRecord }
  | Exclude<CustomerRuntimeChallengeDecision, { readonly ok: true }>
> {
  let lifecycle;
  try {
    lifecycle = await registry.get(request.grantId);
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

  if (
    rawLicense.licenseId !== lifecycle.grant.licenseId ||
    rawLicense.customerId !== lifecycle.grant.customerId ||
    rawLicense.installationId !== lifecycle.grant.installationId ||
    request.installationId !== lifecycle.grant.installationId
  ) {
    return { ok: false, code: "INSTALLATION_MISMATCH" };
  }

  return { ok: true, license: rawLicense };
}

async function issueChallenge(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  store: CustomerRuntimeChallengeStore,
  clock: CustomerRuntimeSessionClock,
  expectedMode: CustomerProductMode,
  request: unknown,
): Promise<CustomerRuntimeChallengeDecision> {
  if (!validChallengeRequest(request)) {
    return { ok: false, code: "INVALID_CHALLENGE_REQUEST" };
  }

  const now = safeNow(clock);
  if (now === null) {
    return { ok: false, code: "INVALID_SESSION_CONTEXT" };
  }

  const context = await loadBoundContext(
    registry,
    licenses,
    request,
    expectedMode,
  );
  if (!context.ok) return context;

  const challenge = createInstallationChallenge({
    purpose: "RECONNECT",
    licenseId: context.license.licenseId,
    installationId: context.license.installationId,
    now,
    ttlMs: CUSTOMER_RUNTIME_CHALLENGE_TTL_MS,
  });

  let stored = false;
  try {
    stored = await store.put(challenge);
  } catch {
    stored = false;
  }

  if (!stored) {
    return { ok: false, code: "CHALLENGE_STORE_REJECTED" };
  }

  return {
    ok: true,
    code: "CHALLENGE_ISSUED",
    productMode: expectedMode,
    challenge,
  };
}

export function issueSelfManagedReconnectChallenge(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  store: CustomerRuntimeChallengeStore,
  clock: CustomerRuntimeSessionClock,
  request: unknown,
): Promise<CustomerRuntimeChallengeDecision> {
  return issueChallenge(
    registry,
    licenses,
    store,
    clock,
    "SELF_MANAGED",
    request,
  );
}

export function issueCopyFollowerReconnectChallenge(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  store: CustomerRuntimeChallengeStore,
  clock: CustomerRuntimeSessionClock,
  request: unknown,
): Promise<CustomerRuntimeChallengeDecision> {
  return issueChallenge(
    registry,
    licenses,
    store,
    clock,
    "COPY_FOLLOWER",
    request,
  );
}

function runtimeSecurity(
  store: CustomerRuntimeChallengeStore,
  clock: CustomerRuntimeSessionClock,
) {
  return {
    now: () => clock.now(),
    consumeOnce: async (challengeId: string) => {
      const now = safeNow(clock);
      if (now === null) return false;
      try {
        return await store.consume(challengeId, now);
      } catch {
        return false;
      }
    },
  };
}

export function activateSelfManagedSession(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  store: CustomerRuntimeChallengeStore,
  clock: CustomerRuntimeSessionClock,
  request: unknown,
): Promise<CustomerRuntimeActivationDecision> {
  return activateSelfManagedRuntime(
    registry,
    licenses,
    runtimeSecurity(store, clock),
    request as SelfManagedRuntimeActivationRequest,
  );
}

export function activateCopyFollowerSession(
  registry: CustomerGrantRegistryRepository,
  licenses: CustomerLicenseResolver,
  store: CustomerRuntimeChallengeStore,
  clock: CustomerRuntimeSessionClock,
  request: unknown,
): Promise<CustomerRuntimeActivationDecision> {
  return activateCopyFollowerRuntime(
    registry,
    licenses,
    runtimeSecurity(store, clock),
    request as CopyFollowerRuntimeActivationRequest,
  );
}
