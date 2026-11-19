import type {
  CustomerFollowerExecutionRequest,
  CustomerFollowerExecutor,
} from "./follower-execution.js";

export interface CustomerMt5BridgePort {
  health(): Promise<{
    connected: boolean;
    tradingEnabled: boolean;
    terminalTradeAllowed: boolean;
    expertTradeAllowed: boolean;
    accountLogin?: number;
    server?: string;
  }>;
  quote(symbol: string): Promise<{ bid: number; ask: number }>;
  placeOrder(request: {
    symbol: string;
    side: "BUY" | "SELL";
    orderType: "MARKET";
    timeInForce: "GTC";
    volume: number;
    requestedPrice: number;
    stopLoss: number;
    takeProfit: number;
    deviationPoints: number;
    magicNumber: number;
    comment: string;
    clientOrderId: string;
    idempotencyKey: string;
  }): Promise<{
    accepted: boolean;
    status: string;
    ticket?: string;
    position?: { ticket: string };
    message?: string;
  }>;
  modifyPosition(
    ticket: string,
    stopLoss: number,
    takeProfit: number | undefined,
    commandId: string,
  ): Promise<{ success: boolean; message?: string }>;
  closePosition(
    ticket: string,
    volume: number,
    commandId: string,
  ): Promise<{ success: boolean; message?: string }>;
  openPositions(symbol?: string): Promise<
    Array<{
      ticket: string;
      symbol: string;
      volume: number;
      stopLoss: number;
      takeProfit: number;
      side?: "LONG" | "SHORT";
    }>
  >;
}

export interface CustomerFollowerPositionRegistry {
  get(masterPositionRef: string): Promise<string | undefined>;
  set(masterPositionRef: string, followerTicket: string): Promise<void>;
  delete(masterPositionRef: string): Promise<void>;
}

export class InMemoryCustomerFollowerPositionRegistry
  implements CustomerFollowerPositionRegistry
{
  private readonly tickets = new Map<string, string>();

  async get(masterPositionRef: string): Promise<string | undefined> {
    return this.tickets.get(masterPositionRef);
  }

  async set(masterPositionRef: string, followerTicket: string): Promise<void> {
    this.tickets.set(masterPositionRef, followerTicket);
  }

  async delete(masterPositionRef: string): Promise<void> {
    this.tickets.delete(masterPositionRef);
  }
}

export interface CustomerMt5FollowerExecutorConfig {
  readonly deviationPoints: number;
  readonly magicNumber: number;
  readonly comment: string;
  readonly requireTradingEnabled: boolean;
  readonly expectedMt5Login: number;
  readonly expectedBrokerServer: string;
  readonly reconcileAttempts: number;
  readonly reconcileDelayMs: number;
}

type CustomerMt5FollowerExecutorInputConfig = Pick<
  CustomerMt5FollowerExecutorConfig,
  "expectedMt5Login" | "expectedBrokerServer"
> &
  Partial<
    Omit<
      CustomerMt5FollowerExecutorConfig,
      "expectedMt5Login" | "expectedBrokerServer"
    >
  >;

const DEFAULT_CONFIG = Object.freeze({
  deviationPoints: 30,
  magicNumber: 770701,
  comment: "xauusd-copy-follower",
  requireTradingEnabled: true,
  reconcileAttempts: 4,
  reconcileDelayMs: 250,
});

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function volumeMatches(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-8;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class CustomerMt5FollowerExecutor implements CustomerFollowerExecutor {
  private readonly config: CustomerMt5FollowerExecutorConfig;

  constructor(
    private readonly bridge: CustomerMt5BridgePort,
    private readonly registry: CustomerFollowerPositionRegistry,
    config: CustomerMt5FollowerExecutorInputConfig,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (
      !Number.isInteger(this.config.deviationPoints) ||
      this.config.deviationPoints < 0
    ) {
      throw new TypeError("deviationPoints must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.config.magicNumber) || this.config.magicNumber <= 0) {
      throw new TypeError("magicNumber must be a positive safe integer");
    }
    if (!this.config.comment.trim()) {
      throw new TypeError("comment must be non-blank");
    }
    if (
      !Number.isSafeInteger(this.config.expectedMt5Login) ||
      this.config.expectedMt5Login <= 0
    ) {
      throw new TypeError("expectedMt5Login must be a positive safe integer");
    }
    if (
      !this.config.expectedBrokerServer ||
      this.config.expectedBrokerServer.trim() !==
        this.config.expectedBrokerServer
    ) {
      throw new TypeError(
        "expectedBrokerServer must be a canonical non-blank string",
      );
    }
    if (
      !Number.isInteger(this.config.reconcileAttempts) ||
      this.config.reconcileAttempts < 1
    ) {
      throw new TypeError("reconcileAttempts must be a positive integer");
    }
    if (
      !Number.isInteger(this.config.reconcileDelayMs) ||
      this.config.reconcileDelayMs < 0
    ) {
      throw new TypeError("reconcileDelayMs must be a non-negative integer");
    }
  }

  async execute(request: CustomerFollowerExecutionRequest): Promise<void> {
    await this.assertBridgeReady();

    switch (request.action) {
      case "POSITION_OPEN":
        await this.open(request);
        return;
      case "STOP_LOSS_UPDATE":
        await this.updateStopLoss(request);
        return;
      case "TAKE_PROFIT_UPDATE":
        await this.updateTakeProfit(request);
        return;
      case "PARTIAL_CLOSE":
        await this.partialClose(request);
        return;
      case "POSITION_CLOSE":
        await this.fullClose(request);
        return;
      case "POSITION_SNAPSHOT":
        await this.resolveOpenPosition(request.masterPositionRef, request.symbol);
        return;
    }
  }

  private async assertBridgeReady(): Promise<void> {
    const health = await this.bridge.health();
    if (health.connected !== true) fail("FOLLOWER_MT5_DISCONNECTED");
    if (
      this.config.requireTradingEnabled &&
      health.tradingEnabled !== true
    ) {
      fail("FOLLOWER_MT5_TRADING_DISABLED");
    }
    if (health.terminalTradeAllowed !== true) {
      fail("FOLLOWER_MT5_TERMINAL_TRADE_NOT_ALLOWED");
    }
    if (health.expertTradeAllowed !== true) {
      fail("FOLLOWER_MT5_EXPERT_TRADE_NOT_ALLOWED");
    }
    if (health.accountLogin !== this.config.expectedMt5Login) {
      fail("FOLLOWER_MT5_ACCOUNT_MISMATCH");
    }
    if (health.server !== this.config.expectedBrokerServer) {
      fail("FOLLOWER_MT5_SERVER_MISMATCH");
    }
  }

  private async open(
    request: Extract<CustomerFollowerExecutionRequest, { action: "POSITION_OPEN" }>,
  ): Promise<void> {
    if (await this.registry.get(request.masterPositionRef)) {
      fail("FOLLOWER_POSITION_ALREADY_BOUND");
    }

    const quote = await this.bridge.quote(request.symbol);
    const requestedPrice =
      request.entry ?? (request.side === "BUY" ? quote.ask : quote.bid);

    const response = await this.bridge.placeOrder({
      symbol: request.symbol,
      side: request.side,
      orderType: "MARKET",
      timeInForce: "GTC",
      volume: request.volume,
      requestedPrice,
      stopLoss: request.stopLoss ?? 0,
      takeProfit: request.takeProfit ?? 0,
      deviationPoints: this.config.deviationPoints,
      magicNumber: this.config.magicNumber,
      comment: this.config.comment,
      clientOrderId: request.commandId,
      idempotencyKey: request.commandId,
    });

    if (!response.accepted) {
      fail("FOLLOWER_POSITION_OPEN_REJECTED", response.message);
    }

    const ticket = response.position?.ticket ?? response.ticket;
    if (!ticket) fail("FOLLOWER_POSITION_OPEN_TICKET_MISSING");

    // The broker has accepted a concrete ticket. Persist ownership before
    // reconciliation so a temporarily invisible live position is never orphaned.
    await this.registry.set(request.masterPositionRef, ticket);

    const reconciliation = await this.waitForPositionVolume(
      ticket,
      request.symbol,
      request.volume,
    );
    if (!reconciliation.position) {
      if (reconciliation.seen) {
        fail("FOLLOWER_POSITION_OPEN_VOLUME_MISMATCH");
      }
      fail("FOLLOWER_POSITION_OPEN_NOT_CONFIRMED");
    }
  }

  private async updateStopLoss(
    request: Extract<CustomerFollowerExecutionRequest, { action: "STOP_LOSS_UPDATE" }>,
  ): Promise<void> {
    const position = await this.resolveOpenPosition(
      request.masterPositionRef,
      request.symbol,
    );
    // Protective stops must never be loosened by a follower command.
    // Trust the current broker-side direction, not the signed command payload.
    if (!finitePositive(request.stopLoss)) fail("FOLLOWER_STOP_LOSS_INVALID");
    if (
      (position.side !== "LONG" && position.side !== "SHORT") ||
      !Number.isFinite(position.stopLoss) ||
      position.stopLoss < 0
    ) {
      fail("FOLLOWER_STOP_LOSS_RISK_UNKNOWN");
    }
    if (
      position.stopLoss > 0 &&
      (position.side === "LONG"
        ? request.stopLoss < position.stopLoss
        : request.stopLoss > position.stopLoss)
    ) {
      fail("FOLLOWER_STOP_LOSS_RISK_INCREASE");
    }
    const result = await this.bridge.modifyPosition(
      position.ticket,
      request.stopLoss,
      position.takeProfit || undefined,
      request.commandId,
    );
    if (!result.success) fail("FOLLOWER_STOP_LOSS_UPDATE_FAILED", result.message);
  }

  private async updateTakeProfit(
    request: Extract<CustomerFollowerExecutionRequest, { action: "TAKE_PROFIT_UPDATE" }>,
  ): Promise<void> {
    const position = await this.resolveOpenPosition(
      request.masterPositionRef,
      request.symbol,
    );
    const result = await this.bridge.modifyPosition(
      position.ticket,
      position.stopLoss,
      request.takeProfit,
      request.commandId,
    );
    if (!result.success) fail("FOLLOWER_TAKE_PROFIT_UPDATE_FAILED", result.message);
  }

  private async partialClose(
    request: Extract<CustomerFollowerExecutionRequest, { action: "PARTIAL_CLOSE" }>,
  ): Promise<void> {
    const position = await this.resolveOpenPosition(
      request.masterPositionRef,
      request.symbol,
    );
    if (!finitePositive(request.volume) || request.volume >= position.volume) {
      fail("FOLLOWER_PARTIAL_CLOSE_VOLUME_INVALID");
    }
    const expectedVolume = position.volume - request.volume;
    const result = await this.bridge.closePosition(
      position.ticket,
      request.volume,
      request.commandId,
    );
    if (!result.success) fail("FOLLOWER_PARTIAL_CLOSE_FAILED", result.message);
    const reconciliation = await this.waitForPositionVolume(
      position.ticket,
      request.symbol,
      expectedVolume,
    );
    if (!reconciliation.position) {
      if (reconciliation.seen) {
        fail("FOLLOWER_PARTIAL_CLOSE_VOLUME_MISMATCH");
      }
      fail("FOLLOWER_PARTIAL_CLOSE_NOT_CONFIRMED");
    }
  }

  private async fullClose(
    request: Extract<CustomerFollowerExecutionRequest, { action: "POSITION_CLOSE" }>,
  ): Promise<void> {
    const position = await this.resolveOpenPosition(
      request.masterPositionRef,
      request.symbol,
    );
    const result = await this.bridge.closePosition(
      position.ticket,
      position.volume,
      request.commandId,
    );
    if (!result.success) fail("FOLLOWER_POSITION_CLOSE_FAILED", result.message);

    const closed = await this.waitUntilPositionClosed(
      position.ticket,
      request.symbol,
    );
    if (!closed) fail("FOLLOWER_POSITION_CLOSE_NOT_CONFIRMED");

    await this.registry.delete(request.masterPositionRef);
  }

  private async resolveOpenPosition(masterPositionRef: string, symbol: string) {
    const ticket = await this.registry.get(masterPositionRef);
    if (!ticket) fail("FOLLOWER_POSITION_BINDING_MISSING");
    const position = await this.findOpenPosition(ticket, symbol);
    if (!position) fail("FOLLOWER_POSITION_NOT_OPEN");
    return position;
  }

  private async findOpenPosition(ticket: string, symbol: string) {
    for (let attempt = 1; attempt <= this.config.reconcileAttempts; attempt += 1) {
      const positions = await this.bridge.openPositions(symbol);
      const position = positions.find(
        (candidate) =>
          candidate.ticket === ticket && candidate.symbol === symbol,
      );
      if (position) return position;
      if (attempt < this.config.reconcileAttempts) {
        await delay(this.config.reconcileDelayMs);
      }
    }
    return undefined;
  }

  private async waitForPositionVolume(
    ticket: string,
    symbol: string,
    expectedVolume: number,
  ): Promise<{ position: Awaited<ReturnType<CustomerMt5BridgePort["openPositions"]>>[number] | undefined; seen: boolean }> {
    let seen = false;
    for (let attempt = 1; attempt <= this.config.reconcileAttempts; attempt += 1) {
      const positions = await this.bridge.openPositions(symbol);
      const position = positions.find(
        (candidate) =>
          candidate.ticket === ticket && candidate.symbol === symbol,
      );
      if (position) {
        seen = true;
        if (volumeMatches(position.volume, expectedVolume)) {
          return { position, seen };
        }
      }
      if (attempt < this.config.reconcileAttempts) {
        await delay(this.config.reconcileDelayMs);
      }
    }
    return { position: undefined, seen };
  }

  private async waitUntilPositionClosed(
    ticket: string,
    symbol: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.config.reconcileAttempts; attempt += 1) {
      const positions = await this.bridge.openPositions(symbol);
      const position = positions.find(
        (candidate) =>
          candidate.ticket === ticket && candidate.symbol === symbol,
      );
      if (!position) return true;
      if (attempt < this.config.reconcileAttempts) {
        await delay(this.config.reconcileDelayMs);
      }
    }
    return false;
  }
}
