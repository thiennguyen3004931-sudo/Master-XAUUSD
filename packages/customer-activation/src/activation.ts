import {
  authorizeCopyFollowerLifecycleAccess,
  authorizeSelfManagedLifecycleAccess,
  type CopyFollowerAccessRequest,
  type CustomerGrantLifecycleAccessDecision,
  type CustomerProductGrantLifecycleRecord,
  type SelfManagedAccessRequest,
} from "@xauusd/customer-product-access";
import {
  verifyReconnectProof,
  type ConsumeInstallationChallengeOnce,
  type InstallationProofFailureCode,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";

type CustomerActivationAccessDeniedCode = Extract<
  CustomerGrantLifecycleAccessDecision,
  { readonly ok: false }
>["code"];

export type CustomerActivationFailureCode =
  | "ACCESS_DENIED"
  | "INSTALLATION_PROOF_DENIED";

export type CustomerActivationDecision =
  | {
      readonly ok: true;
      readonly code: "ACTIVATED";
      readonly productMode: "SELF_MANAGED" | "COPY_FOLLOWER";
      readonly exposureAllowed: boolean;
      readonly accessCode: "AUTHORIZED" | "AUTHORIZED_SAFE_PAUSE";
    }
  | {
      readonly ok: false;
      readonly code: CustomerActivationFailureCode;
      readonly accessCode?: CustomerActivationAccessDeniedCode;
      readonly installationProofCode?: InstallationProofFailureCode;
    };

export interface SelfManagedActivationRequest
  extends SelfManagedAccessRequest {
  readonly proof: unknown;
  readonly consumeOnce: ConsumeInstallationChallengeOnce;
}

export interface CopyFollowerActivationRequest
  extends CopyFollowerAccessRequest {
  readonly proof: unknown;
  readonly consumeOnce: ConsumeInstallationChallengeOnce;
}

async function verifyBoundInstallation(
  license: LicenseRecord,
  proof: unknown,
  now: number,
  consumeOnce: ConsumeInstallationChallengeOnce,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly code: InstallationProofFailureCode }
> {
  const proofDecision = await verifyReconnectProof({
    proof,
    expectedLicenseId: license.licenseId,
    expectedInstallationId: license.installationId,
    expectedInstallationPublicKey: license.installationPublicKey,
    now,
    consumeOnce,
  });

  if (!proofDecision.ok) {
    return { ok: false, code: proofDecision.code };
  }

  return { ok: true };
}

export async function activateSelfManagedCustomer(
  license: LicenseRecord,
  lifecycle: CustomerProductGrantLifecycleRecord,
  request: SelfManagedActivationRequest,
): Promise<CustomerActivationDecision> {
  const access = authorizeSelfManagedLifecycleAccess(license, lifecycle, {
    installationId: request.installationId,
    mt5Login: request.mt5Login,
    brokerServer: request.brokerServer,
    now: request.now,
    requestedBotMode: request.requestedBotMode,
  });

  if (!access.ok) {
    return {
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: access.code,
    };
  }

  const proof = await verifyBoundInstallation(
    license,
    request.proof,
    request.now,
    request.consumeOnce,
  );

  if (!proof.ok) {
    return {
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
      installationProofCode: proof.code,
    };
  }

  return {
    ok: true,
    code: "ACTIVATED",
    productMode: "SELF_MANAGED",
    exposureAllowed: access.exposureAllowed,
    accessCode: access.code,
  };
}

export async function activateCopyFollowerCustomer(
  license: LicenseRecord,
  lifecycle: CustomerProductGrantLifecycleRecord,
  request: CopyFollowerActivationRequest,
): Promise<CustomerActivationDecision> {
  const access = authorizeCopyFollowerLifecycleAccess(license, lifecycle, {
    installationId: request.installationId,
    mt5Login: request.mt5Login,
    brokerServer: request.brokerServer,
    now: request.now,
    requestedSizingMode: request.requestedSizingMode,
  });

  if (!access.ok) {
    return {
      ok: false,
      code: "ACCESS_DENIED",
      accessCode: access.code,
    };
  }

  const proof = await verifyBoundInstallation(
    license,
    request.proof,
    request.now,
    request.consumeOnce,
  );

  if (!proof.ok) {
    return {
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
      installationProofCode: proof.code,
    };
  }

  return {
    ok: true,
    code: "ACTIVATED",
    productMode: "COPY_FOLLOWER",
    exposureAllowed: access.exposureAllowed,
    accessCode: access.code,
  };
}
