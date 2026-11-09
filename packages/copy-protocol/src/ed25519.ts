import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import type { CopyCommandBody, SignedCopyCommand } from "./command.js";
import { copyCommandSigningBytes } from "./canonical-json.js";

export type CopyCommandSignatureVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "UNKNOWN_KEY_ID"
        | "MALFORMED_SIGNATURE"
        | "INVALID_SIGNATURE";
    };

function toSignedBody(command: SignedCopyCommand): CopyCommandBody {
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
    keyId: command.keyId
  };
}

function decodeCanonicalBase64UrlSignature(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) {
    return null;
  }
  return decoded;
}

export function signCopyCommand(
  body: CopyCommandBody,
  privateKeyPem: string
): SignedCopyCommand {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("private key must be Ed25519");
  }

  const signature = cryptoSign(
    null,
    copyCommandSigningBytes(body),
    privateKey
  ).toString("base64url");

  return { ...body, signature };
}

export function verifyCopyCommandSignature(
  command: SignedCopyCommand,
  trustedPublicKeys: ReadonlyMap<string, string>
): CopyCommandSignatureVerification {
  const publicKeyPem = trustedPublicKeys.get(command.keyId);
  if (publicKeyPem === undefined) {
    return { ok: false, code: "UNKNOWN_KEY_ID" };
  }

  const signature = decodeCanonicalBase64UrlSignature(command.signature);
  if (signature === null) {
    return { ok: false, code: "MALFORMED_SIGNATURE" };
  }

  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return { ok: false, code: "INVALID_SIGNATURE" };
    }

    const body = toSignedBody(command);
    const valid = cryptoVerify(
      null,
      copyCommandSigningBytes(body),
      publicKey,
      signature
    );

    return valid ? { ok: true } : { ok: false, code: "INVALID_SIGNATURE" };
  } catch {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }
}
