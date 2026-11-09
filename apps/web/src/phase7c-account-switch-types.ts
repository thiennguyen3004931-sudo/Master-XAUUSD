export type Phase7CAccountMode = "DEMO" | "LIVE";
export type Phase7CAccountSwitchStatusValue = "RUNNING" | "PASS" | "FAIL";
export type Phase7CAccountSwitchChecks = Record<string, boolean>;

export interface Phase7CAccountSwitchCapability {
  localOnly: true;
  elevatedTaskName: string;
  taskInstalled: boolean;
  currentAccountMode: Phase7CAccountMode;
  currentBotMode: string;
  liveArmFilePresent: boolean;
  webCanSwitchAccount: true;
  webCanArmLive: false;
  policy: {
    explicitPauseRequired: true;
    zeroPositionsRequired: true;
    flatManagedStateRequired: true;
    typedConfirmationRequired: true;
    finalBotMode: "PAUSE";
    finalLiveArmStatus: "DISARMED";
    armAfterLiveSwitch: false;
  };
}

export interface Phase7CAccountSwitchPreflight {
  approved: boolean;
  currentMode: Phase7CAccountMode;
  targetMode: Phase7CAccountMode;
  currentBotMode: string;
  openXauusdPositions: number;
  liveArmFilePresent: boolean;
  checks: Phase7CAccountSwitchChecks;
  note: string;
  preflightToken: string | null;
  expiresAt: number | null;
}

export interface Phase7CAccountSwitchExecuteResponse {
  accepted: true;
  requestId: string;
  targetMode: Phase7CAccountMode;
  status: "RUNNING";
  message: string;
}

export interface Phase7CAccountSwitchStatus {
  version: 1;
  requestId: string;
  targetMode: Phase7CAccountMode;
  status: Phase7CAccountSwitchStatusValue;
  phase: string;
  message: string;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  finalAccountMode: string;
  finalBotMode: string;
  liveArmFilePresent: boolean;
}

export interface Phase7CSameModeAccountChangeReadiness {
  approved: boolean;
  currentMode: Phase7CAccountMode;
  currentBotMode: string;
  accountLogin: number | null;
  server: string | null;
  openXauusdPositions: number;
  liveArmFilePresent: boolean;
  checks: {
    accountStateValid: boolean;
    botPaused: boolean;
    runtimeReady: boolean;
    bridgeMatchesSelectedAccount: boolean;
    zeroXauusdPositions: boolean;
    noTrendManagedTicket: boolean;
    noSidewayManagedTicket: boolean;
    noTrendPendingPullback: boolean;
    noSidewayPendingEntry: boolean;
    noExecutionLock: boolean;
    liveDisarmed: boolean;
    noSwitchRunning: boolean;
  };
  note: string;
}
