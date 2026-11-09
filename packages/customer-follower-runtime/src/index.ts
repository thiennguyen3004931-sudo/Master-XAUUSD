import {
  CustomerMt5FollowerExecutor,
  type CustomerMt5FollowerExecutorConfig,
} from "@xauusd/customer-agent";
import { FileCustomerFollowerPositionRegistry } from "@xauusd/customer-follower-state";
import { CustomerMt5BrokerPortAdapter } from "@xauusd/customer-mt5-broker-port-adapter";
import type { IMt5BridgeClient } from "@xauusd/mt5-broker";

export interface CustomerFollowerRuntimeOptions {
  readonly client: IMt5BridgeClient;
  readonly stateFile: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly executor?: Partial<
    Pick<
      CustomerMt5FollowerExecutorConfig,
      | "deviationPoints"
      | "magicNumber"
      | "comment"
      | "requireTradingEnabled"
      | "reconcileAttempts"
      | "reconcileDelayMs"
    >
  >;
}

export interface CustomerFollowerRuntime {
  readonly bridge: CustomerMt5BrokerPortAdapter;
  readonly registry: FileCustomerFollowerPositionRegistry;
  readonly executor: CustomerMt5FollowerExecutor;
}

function canonical(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export function createCustomerFollowerRuntime(
  options: CustomerFollowerRuntimeOptions,
): CustomerFollowerRuntime {
  if (!options.client || typeof options.client.health !== "function") {
    throw new TypeError("client must implement IMt5BridgeClient");
  }
  if (!canonical(options.stateFile)) {
    throw new TypeError("stateFile must be a canonical non-blank string");
  }
  if (!Number.isSafeInteger(options.mt5Login) || options.mt5Login <= 0) {
    throw new TypeError("mt5Login must be a positive safe integer");
  }
  if (!canonical(options.brokerServer)) {
    throw new TypeError("brokerServer must be a canonical non-blank string");
  }

  const bridge = new CustomerMt5BrokerPortAdapter(options.client);
  const registry = new FileCustomerFollowerPositionRegistry(options.stateFile);
  const executor = new CustomerMt5FollowerExecutor(bridge, registry, {
    expectedMt5Login: options.mt5Login,
    expectedBrokerServer: options.brokerServer,
    ...options.executor,
  });

  return { bridge, registry, executor };
}
