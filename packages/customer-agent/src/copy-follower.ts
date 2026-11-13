import {
  assertCopyCommandBody,
  verifyCopyCommandSignature,
  type SignedCopyCommand,
} from "@xauusd/copy-protocol";

export interface CustomerCopyCommandClock {
  now(): number;
}

export interface CustomerCopyCommandBinding {
  readonly licenseId: string;
  readonly installationId: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly allowedSymbols: readonly string[];
}

export type CustomerCopyCommandDecision =
  | {
      readonly ok: true;
      readonly code: "ACCEPTED";
      readonly command: SignedCopyCommand;
    }
  | {
      readonly ok: false;
      readonly code:
        | "INVALID_COMMAND"
        | "INVALID_CLOCK"
        | "BINDING_MISMATCH"
        | "SYMBOL_NOT_ALLOWED"
        | "NOT_YET_VALID"
        | "EXPIRED"
        | "SIGNATURE_DENIED"
        | "REPLAYED_COMMAND"
        | "SEQUENCE_NOT_MONOTONIC";
    };

function canonicalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

function assertBinding(binding: CustomerCopyCommandBinding): void {
  if (
    !canonicalString(binding.licenseId) ||
    !canonicalString(binding.installationId) ||
    !canonicalString(binding.brokerServer) ||
    !Number.isSafeInteger(binding.mt5Login) ||
    binding.mt5Login <= 0 ||
    !Array.isArray(binding.allowedSymbols) ||
    binding.allowedSymbols.length === 0
  ) {
    throw new TypeError("copy command binding is invalid");
  }

  const seen = new Set<string>();
  for (const symbol of binding.allowedSymbols) {
    if (!canonicalString(symbol) || seen.has(symbol)) {
      throw new TypeError("allowedSymbols must contain unique canonical symbols");
    }
    seen.add(symbol);
  }
}

function toBody(command: SignedCopyCommand) {
  return {
    version: command.version,
    commandId: command.commandId,
    sequence: command.sequence,
    licenseId: command.licenseId,
    installationId: command.installationId,
    mt5Login: command.mt5Login,
    brokerServer: command.brokerServer,
    symbol: command.symbol,
    action: command.action,
    payload: command.payload,
    masterPositionRef: command.masterPositionRef,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    keyId: command.keyId,
  };
}

export class CustomerCopyCommandVerifier {
  private readonly seenCommandIds = new Set<string>();
  private lastSequence = 0;

  constructor(
    private readonly binding: CustomerCopyCommandBinding,
    private readonly trustedPublicKeys: ReadonlyMap<string, string>,
    private readonly clock: CustomerCopyCommandClock,
  ) {
    assertBinding(binding);
    if (!(trustedPublicKeys instanceof Map) || trustedPublicKeys.size === 0) {
      throw new TypeError("trustedPublicKeys must be a non-empty Map");
    }
  }

  accept(value: unknown): CustomerCopyCommandDecision {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, code: "INVALID_COMMAND" };
    }

    const raw = value as Record<string, unknown>;
    if (!canonicalString(raw.signature)) {
      return { ok: false, code: "INVALID_COMMAND" };
    }

    const command = value as SignedCopyCommand;
    try {
      assertCopyCommandBody(toBody(command));
    } catch {
      return { ok: false, code: "INVALID_COMMAND" };
    }

    let now: number;
    try {
      now = this.clock.now();
    } catch {
      return { ok: false, code: "INVALID_CLOCK" };
    }
    if (!Number.isSafeInteger(now)) {
      return { ok: false, code: "INVALID_CLOCK" };
    }

    if (
      command.licenseId !== this.binding.licenseId ||
      command.installationId !== this.binding.installationId ||
      command.mt5Login !== this.binding.mt5Login ||
      command.brokerServer !== this.binding.brokerServer
    ) {
      return { ok: false, code: "BINDING_MISMATCH" };
    }

    if (!this.binding.allowedSymbols.includes(command.symbol)) {
      return { ok: false, code: "SYMBOL_NOT_ALLOWED" };
    }

    if (now < command.issuedAt) {
      return { ok: false, code: "NOT_YET_VALID" };
    }
    if (now >= command.expiresAt) {
      return { ok: false, code: "EXPIRED" };
    }

    let signature;
    try {
      signature = verifyCopyCommandSignature(command, this.trustedPublicKeys);
    } catch {
      return { ok: false, code: "SIGNATURE_DENIED" };
    }
    if (!signature.ok) {
      return { ok: false, code: "SIGNATURE_DENIED" };
    }

    if (this.seenCommandIds.has(command.commandId)) {
      return { ok: false, code: "REPLAYED_COMMAND" };
    }

    if (command.sequence <= this.lastSequence) {
      return { ok: false, code: "SEQUENCE_NOT_MONOTONIC" };
    }

    this.seenCommandIds.add(command.commandId);
    this.lastSequence = command.sequence;

    return {
      ok: true,
      code: "ACCEPTED",
      command: Object.freeze({ ...command }),
    };
  }
}
