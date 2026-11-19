export type Phase7CRuntimeSourceComponentName =
  | "api"
  | "lifecycle-broker"
  | "supervisor"
  | "trend"
  | "sideway"
  | "telegram"
  | "regime-notifier";

export type Phase7CRuntimeSourceVerdict =
  | "EXACT_MATCH"
  | "MISMATCH"
  | "STALE"
  | "UNKNOWN";

export type Phase7CRuntimeSourceDeploymentManifest = {
  version: 1;
  deploymentId: string;
  sourceCommit: string;
  sourceTree: string;
  branch: "main";
  worktreeClean: true;
  createdAt: number;
  configFingerprint: string;
};

export type Phase7CRuntimeSourceComponentResult = {
  component: Phase7CRuntimeSourceComponentName;
  verdict: Phase7CRuntimeSourceVerdict;
  pid: number | null;
  alive: boolean | null;
  sourceCommit: string | null;
  deploymentId: string | null;
  reasonCodes: string[];
};

export type Phase7CRuntimeSourceAttestationSnapshot = {
  version: 1;
  source: "PHASE7C_RUNTIME_SOURCE_ATTESTATION";
  generatedAt: number;
  readOnly: true;
  deployment: Phase7CRuntimeSourceDeploymentManifest | null;
  overall: Phase7CRuntimeSourceVerdict;
  components: Phase7CRuntimeSourceComponentResult[];
  safety: {
    readOnly: true;
    modeMutation: false;
    armMutation: false;
    autoGate: false;
    lifecycleGate: false;
    orderMutation: false;
    positionMutation: false;
    strategyMutation: false;
    autoRetune: false;
  };
};
