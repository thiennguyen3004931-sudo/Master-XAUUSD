import {
  createCustomerFollowerRuntime,
  type CustomerFollowerRuntime,
} from "@xauusd/customer-follower-runtime";
import type { IMt5BridgeClient } from "@xauusd/mt5-broker";

export interface CustomerMt5BindingSpec {
  readonly bridgeBaseUrl: string;
  readonly credentialRef: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly stateFile: string;
}

export interface CustomerMt5BridgeClientFactory {
  create(spec: {
    readonly bridgeBaseUrl: string;
    readonly credentialRef: string;
  }): IMt5BridgeClient;
}

function canonical(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function validateLoopbackBridgeUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("bridgeBaseUrl must be a valid URL");
  }

  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";

  if (!loopback) {
    throw new TypeError("bridgeBaseUrl must target loopback only");
  }
  if (url.username || url.password) {
    throw new TypeError("bridgeBaseUrl must not embed credentials");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("bridgeBaseUrl must use http or https");
  }
}

export function bindCustomerFollowerRuntime(
  spec: CustomerMt5BindingSpec,
  factory: CustomerMt5BridgeClientFactory,
): CustomerFollowerRuntime {
  if (!canonical(spec.credentialRef)) {
    throw new TypeError("credentialRef must be a canonical non-blank string");
  }
  if (!Number.isSafeInteger(spec.mt5Login) || spec.mt5Login <= 0) {
    throw new TypeError("mt5Login must be a positive safe integer");
  }
  if (!canonical(spec.brokerServer)) {
    throw new TypeError("brokerServer must be a canonical non-blank string");
  }
  if (!canonical(spec.stateFile)) {
    throw new TypeError("stateFile must be a canonical non-blank string");
  }

  validateLoopbackBridgeUrl(spec.bridgeBaseUrl);

  const client = factory.create({
    bridgeBaseUrl: spec.bridgeBaseUrl,
    credentialRef: spec.credentialRef,
  });

  return createCustomerFollowerRuntime({
    client,
    stateFile: spec.stateFile,
    mt5Login: spec.mt5Login,
    brokerServer: spec.brokerServer,
  });
}
