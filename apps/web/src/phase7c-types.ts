export type Phase7BSide = "BUY" | "SELL";

export interface Phase7BDemoSnapshot {
  readOnly: true;
  botStatus: string;
  generatedAt: number;
  runtime: {
    status?: string;
    armed?: boolean;
    alive?: boolean;
    heartbeatAgeMs?: number | null;
  } | null;
  entryDiagnostics: {
    closeTime: number;
    nextCloseTime: number;
    bar: { open: number; high: number; low: number; close: number };
    pattern: {
      matched: boolean;
      name: "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE" | null;
      side: Phase7BSide | null;
      extreme: number | null;
    };
    trend: {
      ma20: number;
      ma50: number;
      ma200: number;
      buyAligned: boolean;
      sellAligned: boolean;
      matchedPatternSide: boolean;
      m15Supertrend: Phase7BSide | null;
      m5Supertrend: Phase7BSide | null;
      m5FlipAgeBars: number | null;
      m15SupertrendLine: number | null;
      m5SupertrendLine: number | null;
      m15TrendlineDistance: number | null;
      m5TrendlineDistance: number | null;
      m15TrendlineReaction: boolean;
      m5TrendlineReaction: boolean;
      confidenceSide: Phase7BSide | null;
      confidenceM5Supertrend: Phase7BSide | null;
      confidenceScore: number | null;
      confidenceLevel: "CHƯA_ĐÁNH_GIÁ" | "TIÊU_CHUẨN" | "CAO" | "RẤT_CAO";
    };
    fvg: {
      buyConfirmed: boolean;
      sellConfirmed: boolean;
      sameDirectionConfirmed: boolean;
      requiredForEntry: false;
    };
    entry: {
      eligible: boolean;
      side: Phase7BSide | null;
      referenceEntry: number;
      structuralStopDistance: number | null;
      stopDistance: number | null;
      action: "WAIT_SIGNAL" | "ENTRY_IMMEDIATE" | "WAIT_PULLBACK";
      reason: string;
    };
  } | null;
  state: {
    accountLogin: number | null;
    lastEvaluatedM15Close: number;
    lastEvaluatedM5Close?: number;
    pendingPullback?: {
      signalId: string;
      side: Phase7BSide;
      pattern: string;
      signalTimestamp: number;
      expiresAt: number;
      structuralStopPrice: number;
      structuralStopDistanceAtSignal: number;
      maxStopDistancePrice: number;
    } | null;
    managed: {
      ticket: string;
      side: Phase7BSide;
      pattern: string;
      signalTimestamp: number;
      signalEntry: number;
      entry: number;
      initialVolume: number;
      expectedRemainingVolume: number;
      stopDistance: number;
      breakEvenApplied: boolean;
      partialApplied: boolean;
      lastStructuralStop: number | null;
    } | null;
  } | null;
  recentEvents: Array<Record<string, unknown> & { timestamp?: string; type?: string }>;
  mt5: {
    reachable: boolean;
    status: string;
    health: {
      accountMode?: string;
      server?: string;
      tradingEnabled?: boolean;
      terminalTradeAllowed?: boolean;
      expertTradeAllowed?: boolean;
    } | null;
    quote: { bid: number; ask: number; spread: number; timestamp: number } | null;
    spec: {
      tickSize: number;
      point?: number;
      effectiveTickValuePerLot?: number;
      cashPerPriceUnitPerLot?: number;
      contractSize?: number;
      digits: number;
      minVolume: number;
      maxVolume: number;
      volumeStep: number;
      maxSpread: number;
      stopsLevelTicks: number;
    } | null;
    managedPosition: {
      ticket: string;
      side: "LONG" | "SHORT";
      volume: number;
      entry: number;
      stopLoss: number;
      profit: number;
    } | null;
  };
}

export interface Phase7CAccountRiskSnapshot {
  source: "MT5_DEMO_READ_ONLY";
  generatedAt: number;
  safety: {
    mode: "AUTO_LOT_SHADOW";
    executionMutation: false;
    phase7bFixedVolumeUnchanged: true;
    liveUnlockAvailable: false;
  };
  account: {
    connected: boolean;
    accountLogin: number | null;
    accountMode: string | null;
    accountBalance: number | null;
    accountEquity: number | null;
    accountMargin: number | null;
    accountFreeMargin: number | null;
    accountProfit: number | null;
    accountLeverage: number | null;
    accountCurrency: string | null;
    server: string | null;
    terminalVersion: string | null;
    tradingEnabled: boolean;
    terminalTradeAllowed: boolean;
    expertTradeAllowed: boolean;
  };
  quote: {
    bid: number;
    ask: number;
    spread: number;
    timestamp: number;
  };
  spec: {
    brokerSymbol: string;
    tickSize: number;
    point: number;
    effectiveTickValuePerLot: number;
    cashPerPriceUnitPerLot: number;
    riskValueSource: string;
    contractSize: number;
    digits: number;
    minVolume: number;
    maxVolume: number;
    volumeStep: number;
    maxSpread: number;
    stopsLevelTicks: number;
    freezeLevelTicks: number;
    fillingMode: number;
    executionMode: number;
  };
  configuration: {
    riskPercent: number;
    maxLot: number;
    currentFixedVolume: number;
    configuredTrendFixedLot: number;
    activeTrendFixedLot: number | null;
    configuredSidewayRiskPercent: number;
    configuredSidewayMaxLot: number;
    lotSettingsRestartRequired: boolean;
    targetRiskUsd: number;
    managementCompatibility: "EXACT_ONE_THIRD_PARTIAL_ONLY";
    previewOrderPermission: "NONE";
    sidewayExecutionOwner: "SIDEWAY_EXECUTOR_FINAL_GATE";
  };
  rows: Array<{
    stopDistance: number;
    targetRiskUsd: number;
    lossAtSlOneLot: number;
    rawLot: number;
    recommendedLot: number;
    estimatedRiskUsd: number;
    estimatedRiskPercent: number;
    approved: boolean;
    reason: string;
  }>;
}

export type Phase7CBotExecutionMode =
  | "AUTO"
  | "TREND"
  | "SIDEWAY"
  | "SEMI"
  | "PAUSE";

export interface Phase7CSourceSafetySnapshot {
  version: 1;
  source: "PHASE7C_SOURCE_SAFETY_CONTRACT";
  generatedAt: number;
  performanceAttribution: {
    liveMagic: {
      status: "ENFORCED";
      trendMagicNumber: number;
      sidewayMagicNumber: number;
      policy: "FAIL_CLOSED_ON_DRIFT";
    };
    validationIsolation: {
      status: "ENFORCED";
      policy: "EXCLUDE_FROM_SYSTEM_SUMMARY";
    };
    mixedOpeningProvenance: {
      status: "ENFORCED";
      policy: "FAIL_CLOSED_TO_NON_SYSTEM";
    };
  };
}

export interface Phase7CLifecycleSnapshot {
  controlEnabled: boolean;
  running: boolean;
  ready: boolean;
  actionInProgress: boolean;
  telegramConfigured: boolean;
  telegramReady: boolean;
  telegramStatus: string;
  telegramHeartbeatAgeMs: number | null;
  mode: {
    mode: Phase7CBotExecutionMode;
    updatedAt: string;
    updatedBy: string;
  };
  processes: Record<"supervisor" | "trend" | "sideway" | "telegram" | "regimeNotifier", {
    pid: number | null;
    alive: boolean;
  }>;
  lotSettings: {
    configured: Phase7CLotSettingsState;
    active: (Phase7CLotSettingsState & {
      armed: boolean;
      supervisorPid: number;
      appliedAt: string;
    }) | null;
    activeAlive: boolean;
    restartRequired: boolean;
  };
  bridge: {
    reachable: boolean;
    accountMode: string | null;
    server: string | null;
    tradingEnabled: boolean | null;
    terminalTradeAllowed: boolean | null;
    expertTradeAllowed: boolean | null;
    liveExecutionArmed: boolean | null;
    liveArmStatus: "ARMED" | "DISARMED" | "NOT_REQUIRED" | null;
    liveArmReason: string | null;
    liveArmScope: "BRIDGE_SESSION" | "LEGACY_TTL" | null;
    liveRiskReductionAllowedWhenDisarmed: boolean | null;
    openXauusdPositions: number;
  };
  safety: {
    localhostOnly: true;
    demoOnly: true;
    realAccountAllowed: false;
    startMode: "PAUSE_THEN_AUTO_AFTER_READY";
    stopBlockedWithOpenPosition: true;
    mt5PanelOrderPermission: "NONE";
  };
}

export interface Phase7CLifecycleActionResponse {
  action: "STARTED" | "ALREADY_RUNNING" | "STOPPED";
  message: string;
  mode: Phase7CLifecycleSnapshot["mode"];
  lifecycle: Omit<Phase7CLifecycleSnapshot, "bridge" | "actionInProgress">;
}

export interface Phase7CLiveRegimeSnapshot {
  symbol: string;
  timeframe: string;
  regime: string;
  confidence: number;
  recommendedMode:
    | "TREND"
    | "SIDEWAY"
    | "PAUSE";
  activeMode: Phase7CBotExecutionMode;
  modeMatchesRecommendation: boolean;
  reasons: string[];
  lastCandleCloseTime: number;
  checkedAt: number;
}

export interface Phase7CDailyRecoverySnapshot {
  source: "MT5_DEMO_READ_ONLY";
  readOnly: true;
  generatedAt: number;
  symbol: string;
  dayStartTime: number;
  historyEndTime: number;
  dealCount: number;
  dailyNetPnl: number;
  dailyMode:
    | "NORMAL"
    | "RECOVERY_TP";
  nextEntryManagement:
    | "REGIME_NATIVE"
    | "FULL_POSITION_ADAPTIVE_TP_6_TO_10";
  preview: {
    volume: number;
    cashPerPriceUnitPerLot:
      | number
      | null;
    requiredUsd: number;
    rawTpDistance:
      | number
      | null;
    tpDistance:
      | number
      | null;
    canRecoverInOneTrade: boolean;
  };
  strategy: {
    trendMagicNumber: number;
    sidewayMagicNumber: number;
    targetNetUsd: number;
    minTpDistance: number;
    maxTpDistance: number;
    lotEscalation: false;
    forcedEntry: false;
    forceRegime: false;
    newPositionsOnly: true;
  };
}

export interface Phase7CBacktestRequest {
  from: string;
  to: string;
  fixedVolume: number;
}

export interface Phase7CBacktestSlice {
  trades: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
}

export interface Phase7CBacktestResult {
  source: "PHASE7C_MT5_BROKER_HISTORY";
  replayMode: "CLOSED_M15_WITH_M5_EXECUTION_APPROXIMATION";
  productionEquivalent: false;
  generatedAt: number;
  range: {
    from: string;
    to: string;
    days: number;
    tradingDays: number;
    m15Bars: number;
    m5Bars: number;
  };
  account: {
    login: number | null;
    mode: string | null;
    server: string | null;
    currency: string | null;
  };
  broker: {
    symbol: string;
    tickSize: number;
    cashPerPriceUnitPerLot: number;
    minVolume: number;
    volumeStep: number;
    fixedVolume: number;
  };
  rules: Record<string, string | number>;
  metrics: {
    signals: number;
    trades: number;
    skippedWhilePositionOpen: number;
    tradesPerTradingDay: number;
    winRatePercent: number;
    netPnl: number;
    profitFactor: number | null;
    expectancy: number;
    averageR: number;
    maxDrawdownUsd: number;
    averageHoldHours: number;
    breakEvenApplied: number;
    partialApplied: number;
    structuralTrailUpdates: number;
    exitReasons: Record<string, number>;
  };
  breakdown: {
    buy: Phase7CBacktestSlice;
    sell: Phase7CBacktestSlice;
    engulfing: Phase7CBacktestSlice;
    twoCandle: Phase7CBacktestSlice;
  };
  equityCurve: Array<{ timestamp: number; pnl: number; drawdown: number }>;
  trades: Array<{
    side: Phase7BSide;
    pattern: string;
    signalTimestamp: number;
    entryTime: number;
    entry: number;
    stopLoss: number;
    stopDistance: number;
    volume: number;
    exitTime: number;
    exit: number;
    pnl: number;
    rMultiple: number;
    holdHours: number;
    breakEvenApplied: boolean;
    partialApplied: boolean;
    partialVolume: number;
    partialPnl: number;
    structuralTrailUpdates: number;
    exitReason: string;
    fvgConfirmedAtEntry: boolean;
  }>;
  notes: string[];
}
export interface Phase7CLotSettingsState {
  version: 2;
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
  updatedAt: string;
  updatedBy: string;
}

export interface Phase7CActiveLotSettings {
  version: 2;
  accountMode: "DEMO" | "LIVE";
  trendFixedLot: number;
  sidewayRiskPercent: number;
  sidewayMaxLot: number;
  trendFixedTpEnabled: boolean;
  trendFixedTpDistance: number;
  sidewayFixedTpEnabled: boolean;
  sidewayFixedTpDistance: number;
  armed: boolean;
  supervisorPid: number;
  appliedAt: string;
}

export interface Phase7CLotSettingsSnapshot {
  state: Phase7CLotSettingsState;
  active: Phase7CActiveLotSettings | null;
  activeAlive: boolean;
  restartRequired: boolean;
  appliesTo: "NEW_POSITIONS_ONLY";
  safety: {
    demoOnly: true;
    requiresPause: true;
    requiresZeroXauusdPositions: true;
    existingPositionMutation: false;
    martingale: false;
    recoveryLotEscalation: false;
  };
  limits: {
    minManagedLot: number;
    maxDemoLot: number;
    lotStep: number;
    managedLotIncrement: number;
    minRiskPercent: number;
    maxRiskPercent: number;
  };
}

export interface Phase7CDecisionAuditRow {
  timestamp: number;
  timestampIso?: string;
  strategy: "TREND" | "SIDEWAY";
  event: string;
  stage: string;
  reason: string;
  setup?: {
    side?: string | null;
    pattern?: string | null;
  };
  sizing?: {
    rawLot?: number | null;
    finalLot?: number | null;
    maxLot?: number | null;
    riskPercent?: number | null;
    estimatedRiskUsd?: number | null;
    estimatedRiskPercent?: number | null;
    limitReason?: string | null;
  };
  plan?: {
    entry?: number | null;
    stopLoss?: number | null;
    stopDistance?: number | null;
    tp1?: number | null;
    tp2?: number | null;
  };
}

export interface Phase7CDecisionMonitorSnapshot {
  version: 1;
  source: "PHASE7C_CANONICAL_DECISION_OBSERVABILITY";
  generatedAt: number;
  symbol: string;
  engine: {
    source: "MarketRegimeClassifier";
    timeframe: string;
    regime: string;
    confidence: number;
    recommendedMode: "TREND" | "SIDEWAY" | "PAUSE";
    reasons: string[];
    checkedAt: number;
    lastCandleCloseTime: number;
  };
  mode: {
    active: Phase7CBotExecutionMode;
    effectiveStrategy: "TREND" | "SIDEWAY" | "PAUSE";
    matchesRecommendation: boolean;
  };
  account: {
    reachable: boolean;
    accountMode: string | null;
    server: string | null;
    currency: string | null;
    balance: number | null;
    equity: number | null;
    openXauusdPositions: number;
  };
  position: {
    state: "FLAT" | "MANAGING" | "UNMANAGED";
    count: number;
    strategy: "TREND" | "SIDEWAY" | null;
    ticket: string | null;
    side: string | null;
    setup: string | null;
    volume: number | null;
    entry: number | null;
    currentPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    tp1: number | null;
    tp2: number | null;
    floatingPnlUsd: number | null;
    floatingPnlPercent: number | null;
    favorableDistance: number | null;
    breakEvenApplied: boolean;
    partialApplied: boolean;
    openedAt: number | null;
    entryReason: string;
    holdReasonCode: string | null;
    holdReason: string;
  };
  lotSettings: Phase7CLotSettingsSnapshot;
  preTrade: {
    strategy: "TREND" | "SIDEWAY" | "PAUSE";
    stage: string;
    approved: boolean;
    side: string | null;
    setup: string | null;
    confidenceScore: number | null;
    confidenceLabel: string | null;
    entry: number | null;
    stopLoss: number | null;
    stopDistance: number | null;
    breakEvenPrice: number | null;
    breakEvenTriggerDistance: number;
    tp1: number | null;
    tp2: number | null;
    partialTriggerDistance: number;
    partialFraction: "1/3";
    rawLot: number | null;
    finalLot: number | null;
    lotCap: number | null;
    riskTargetPercent: number | null;
    estimatedRiskUsd: number | null;
    estimatedRiskPercent: number | null;
    limitReason: string;
    decisionReason: string;
    source: string;
    updatedAt: number;
  };
  recentDecisions: Phase7CDecisionAuditRow[];
  safety: {
    readOnlyEndpoint: true;
    demoOnly: true;
    mt5PanelOrderPermission: "NONE";
    newPositionsOnly: true;
    existingPositionMutation: false;
    martingale: false;
    recoveryLotEscalation: false;
  };
}
