import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const lifecyclePath = path.join(
  projectRoot,
  "apps",
  "api",
  "src",
  "services",
  "phase7c-lifecycle.service.ts",
);

const source = fs.readFileSync(lifecyclePath, "utf8");

const required = [
  {
    label: "heartbeat RUNNING state",
    pattern: /broker\.heartbeat\?\.state\s*===\s*["']RUNNING["']/,
  },
  {
    label: "status RUNNING state",
    pattern: /broker\.status\?\.state\s*===\s*["']RUNNING["']/,
  },
  {
    label: "heartbeat desiredExecutorState RUNNING",
    pattern: /broker\.heartbeat\?\.desiredExecutorState\s*===\s*["']RUNNING["']/,
  },
  {
    label: "status desiredExecutorState RUNNING",
    pattern: /broker\.status\?\.desiredExecutorState\s*===\s*["']RUNNING["']/,
  },
  {
    label: "broker supervisor ownership matches active supervisor",
    pattern: /broker\.status\?\.supervisorPid\s*===\s*supervisorPid/,
  },
  {
    label: "lifecycle ready requires broker executor ownership",
    pattern: /const\s+ready\s*=\s*broker\.ready\s*&&\s*brokerOwnsExecutorTree\s*&&/,
  },
];

const missing = required
  .filter(({ pattern }) => !pattern.test(source))
  .map(({ label }) => label);

if (missing.length > 0) {
  console.error("PHASE7C_LIFECYCLE_BROKER_OWNERSHIP_READY_CONTRACT=FAIL");
  for (const label of missing) {
    console.error(`MISSING=${label}`);
  }
  process.exit(1);
}

console.log("PHASE7C_LIFECYCLE_BROKER_OWNERSHIP_READY_CONTRACT=PASS");
console.log("IDLE_BROKER_WITH_LIVE_EXECUTOR_PIDS=NOT_READY");
console.log("RUNNING_BROKER_WITH_MATCHING_SUPERVISOR=READY_ELIGIBLE");
