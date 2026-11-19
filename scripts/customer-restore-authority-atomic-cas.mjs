import { validateAuthorityTransition } from "./customer-restore-authority-transition.mjs";

const deny = (reasonCode) => Object.freeze({ ok: false, reasonCode });

/**
 * Reference atomic CAS coordinator for an operator-controlled authority store.
 * Adapter MUST implement a durable linearizable transaction outside customer-restorable media.
 * This module does not implement a database, transport, signing, or production gateway gate.
 */
export async function commitAuthorityTransition({ adapter, bindingKey, next, expectedAuditHighWater }) {
  if (!adapter || typeof adapter.transact !== "function" ||
      typeof bindingKey !== "string" || !bindingKey ||
      !Number.isSafeInteger(expectedAuditHighWater) || expectedAuditHighWater < 0) {
    return deny("AUTHORITY_ADAPTER_INVALID");
  }
  try {
    const result = await adapter.transact(bindingKey, async (previous) => {
      const decision = validateAuthorityTransition({ previous, next, expectedAuditHighWater });
      if (!decision.ok) return { commit: false, decision };
      return { commit: true, next, decision };
    });
    if (!result || result.committed !== true || result.decision?.ok !== true) {
      return deny(result?.decision?.reasonCode ?? "AUTHORITY_TRANSACTION_NOT_COMMITTED");
    }
    return Object.freeze({ ok: true, reasonCode: "AUTHORITY_TRANSITION_COMMITTED" });
  } catch {
    return deny("AUTHORITY_TRANSACTION_UNAVAILABLE");
  }
}
