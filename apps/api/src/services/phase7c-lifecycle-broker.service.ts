import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Phase7CLifecycleBrokerAction = "START" | "STOP" | "RESTART";
export type Phase7CLifecycleBrokerReason =
  | "USER_START"
  | "USER_STOP"
  | "LOT_SETTINGS_CHANGED"
  | "RECOVERY_START";
export type Phase7CLifecycleBrokerRequestSource =
  | "WEB_CONTROL_CENTER"
  | "LOCAL_LIFECYCLE_API";

export type Phase7CLifecycleBrokerResult = {
  version: 1;
  requestId: string;
  action: Phase7CLifecycleBrokerAction;
  status: "SUCCEEDED" | "REJECTED" | "FAILED" | "NOOP";
  reasonCode: string;
  message: string;
  startedAt: number;
  completedAt: number;
  supervisorPid?: number | null;
  accountMode?: "DEMO" | "LIVE" | null;
  appliedLotProfile?: {
    trendFixedLot: number;
    sidewayRiskPercent: number;
    sidewayMaxLot: number;
  } | null;
};

type BrokerHeartbeat = {
  version?: number;
  brokerPid?: number;
  state?: string;
  desiredExecutorState?: string;
  updatedAt?: number;
};

type BrokerStatus = BrokerHeartbeat & {
  supervisorPid?: number | null;
  inFlightRequestId?: string | null;
  inFlightAction?: Phase7CLifecycleBrokerAction | null;
  lastHandledRequestId?: string | null;
  lastHandledAction?: Phase7CLifecycleBrokerAction | null;
  lastResult?: string | null;
  lastReasonCode?: string | null;
  accountMode?: "DEMO" | "LIVE" | null;
};

const HEARTBEAT_STALE_MS = 5_000;
const REQUEST_RESULT_TIMEOUT_MS = 35_000;
const POLL_MS = 100;

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return path.resolve(demoDir, "..");
  return path.resolve(process.cwd(), ".runtime");
}

function brokerRoot(): string {
  return path.join(runtimeRoot(), "phase7c-lifecycle-broker");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function brokerOwnershipReady(
  heartbeat: BrokerHeartbeat | null,
  status: BrokerStatus | null,
  heartbeatAgeMs: number | null,
): boolean {
  return Boolean(
    heartbeat?.version === 1 &&
    status?.version === 1 &&
    Number.isInteger(heartbeat?.brokerPid) &&
    (heartbeat?.brokerPid ?? 0) > 0 &&
    Number.isInteger(status?.brokerPid) &&
    status?.brokerPid === heartbeat?.brokerPid &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs >= 0 &&
    heartbeatAgeMs <= HEARTBEAT_STALE_MS &&
    isPidAlive(heartbeat?.brokerPid),
  );
}

function assertBrokerHeartbeat(): BrokerHeartbeat {
  const root = brokerRoot();
  const heartbeat = readJson<BrokerHeartbeat>(path.join(root, "state", "heartbeat.json"));
  const status = readJson<BrokerStatus>(path.join(root, "state", "status.json"));
  const updatedAt = Number(heartbeat?.updatedAt ?? 0);
  const heartbeatAgeMs = updatedAt > 0 ? Date.now() - updatedAt : null;
  if (!brokerOwnershipReady(heartbeat, status, heartbeatAgeMs)) {
    throw new Error("Lifecycle broker SYSTEM chưa READY hoặc ownership/heartbeat không hợp lệ; Bot giữ PAUSE.");
  }
  return heartbeat as BrokerHeartbeat;
}

function publishRequestAtomic(request: {
  version: 1;
  requestId: string;
  action: Phase7CLifecycleBrokerAction;
  requestedAt: number;
  source: Phase7CLifecycleBrokerRequestSource;
  reason: Phase7CLifecycleBrokerReason;
}): void {
  const root = brokerRoot();
  const inbox = path.join(root, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const requestPath = path.join(inbox, "request.json");
  if (fs.existsSync(requestPath)) {
    throw new Error("REJECT_BROKER_BUSY: lifecycle broker đang xử lý một request khác.");
  }

  const tempPath = path.join(inbox, `request.${request.requestId}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      // Creating the final name as a hard link is atomic and fails rather than replacing
      // an existing active inbox request.
      fs.linkSync(tempPath, requestPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") {
        throw new Error("REJECT_BROKER_BUSY: lifecycle broker inbox đã có request đang hoạt động.");
      }
      throw error;
    }
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* best-effort temp cleanup */ }
  }
}

export function getPhase7CLifecycleBrokerClientStatus() {
  const root = brokerRoot();
  const heartbeat = readJson<BrokerHeartbeat>(path.join(root, "state", "heartbeat.json"));
  const status = readJson<BrokerStatus>(path.join(root, "state", "status.json"));
  const updatedAt = Number(heartbeat?.updatedAt ?? 0);
  const heartbeatAgeMs = updatedAt > 0 ? Date.now() - updatedAt : null;
  const ready = brokerOwnershipReady(heartbeat, status, heartbeatAgeMs);
  return { ready, heartbeatAgeMs, heartbeat, status };
}

export async function submitPhase7CLifecycleBrokerRequest(
  action: Phase7CLifecycleBrokerAction,
  reason: Phase7CLifecycleBrokerReason,
  source: Phase7CLifecycleBrokerRequestSource,
): Promise<Phase7CLifecycleBrokerResult> {
  assertBrokerHeartbeat();
  const requestId = randomUUID();
  publishRequestAtomic({
    version: 1,
    requestId,
    action,
    requestedAt: Date.now(),
    source,
    reason,
  });

  const resultPath = path.join(brokerRoot(), "results", `${requestId}.json`);
  const deadline = Date.now() + REQUEST_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = readJson<Phase7CLifecycleBrokerResult>(resultPath);
    if (result?.version === 1 && result.requestId === requestId && result.action === action) {
      if (result.status === "SUCCEEDED" || result.status === "NOOP") return result;
      throw new Error(`${result.reasonCode}: ${result.message || "Lifecycle broker rejected the request."}`);
    }
    await sleep(POLL_MS);
  }

  throw new Error(`FAIL_INTERNAL: lifecycle broker did not publish a matching ${action} result within ${REQUEST_RESULT_TIMEOUT_MS / 1000}s.`);
}
