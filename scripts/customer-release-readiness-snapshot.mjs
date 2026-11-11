// Read-only report only. NEVER a customer release authorization or production activation gate.
// GitHub Actions may show SUCCESS when this reporting job completes while release remains BLOCKED.
import { writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const REQUIRED_WORKFLOWS = Object.freeze([
  "Phase7C Canonical PR Gate",
  "V6 Isolated Source Package (NO DEPLOY)",
  "Public Runtime Tracking Boundary",
]);
const STATUS = "BLOCKED";
export function evaluateCustomerReleaseSnapshot({ sha, issues, workflowRuns }) {
  const cleanSha = typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  const blockers = [];
  if (!cleanSha) blockers.push("SOURCE_SHA_MISSING");
  for (const issue of [7]) {
    const record = issues?.[issue];
    if (record !== "closed") blockers.push("ISSUE_7_V6_LIVE_BLOCKERS_NOT_CLOSED");
  }
  const workflows = REQUIRED_WORKFLOWS.map(name => {
    const matching = Array.isArray(workflowRuns)
      ? workflowRuns.filter(x => x && x.name === name && x.head_sha === cleanSha && (x.event === "push" || x.event === "workflow_dispatch"))
      : [];
    // A later failed or queued rerun on the same SHA invalidates older green evidence.
    // Use GitHub's monotonic run ID rather than trusting array order.
    const latest = matching.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
    const passed = Boolean(latest && latest.status === "completed" && latest.conclusion === "success");
    if (!passed) blockers.push("WORKFLOW_NOT_VERIFIED_" + name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase());
    return { name, exactShaVerified: passed };
  });
  // GitHub cannot attest local Windows host acceptance, KMS, publisher enrollment,
  // independent operator approval or pilot execution from software CI.
  blockers.push("INDEPENDENT_V6_HOST_BROKER_AND_OPERATOR_ACCEPTANCE_NOT_ATTESTED");
  return {
    schemaVersion: 1,
    sourceSha: cleanSha,
    status: STATUS,
    releaseAuthorized: false,
    scope: "INDEPENDENT_V6_READ_ONLY_GITHUB_SOURCE_EVIDENCE",
    workflows,
    blockers: [...new Set(blockers)],
  };
}

async function githubJson(path, token) {
  const response = await fetch("https://api.github.com" + path, {
    headers: {
      authorization: "Bearer " + token,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("GITHUB_EVIDENCE_UNAVAILABLE");
  return response.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const sha = process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  // Only collect evidence for the independent public V6 repository. Never
  // treat inherited private-core issue IDs or CI as V6 release evidence.
  const issues = {};
  let workflowRuns = [];
  let evidenceUnavailable = false;
  try {
    if (repo !== "thiennguyen3004931-sudo/Master-XAUUSD" || !token || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error("GITHUB_EVIDENCE_UNAVAILABLE");
    }
    const issue = await githubJson("/repos/" + repo + "/issues/7", token);
    issues[7] = issue.state;
    const runs = await githubJson(
      "/repos/" + repo + "/actions/runs?head_sha=" + encodeURIComponent(sha) + "&per_page=100",
      token,
    );
    workflowRuns = Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [];
    if (!Array.isArray(runs.workflow_runs)) throw new Error("GITHUB_EVIDENCE_UNAVAILABLE");
  } catch {
    evidenceUnavailable = true;
  }
  const report = evaluateCustomerReleaseSnapshot({ sha, issues, workflowRuns });
  if (evidenceUnavailable) {
    report.blockers.push("GITHUB_EVIDENCE_UNAVAILABLE");
  }
  const path = "customer-release-readiness.json";
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "## Customer release: BLOCKED (read-only evidence)\n\n" +
      "Exact commit: " + (report.sourceSha ?? "UNKNOWN") + "\n\n" +
      report.blockers.map(x => "- " + x).join("\n") + "\n\n" +
      "**This reporting job cannot authorize distribution or LIVE trading.**\n");
  }
  process.stdout.write("CUSTOMER_RELEASE_AUTHORIZATION=BLOCKED\nCUSTOMER_RELEASE_READINESS_REPORT=" + path + "\n");
  // Preserve the sanitized BLOCKED artifact even on external evidence errors;
  // fail the reporter run rather than falsely producing a green evidence check.
  if (evidenceUnavailable) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write("CUSTOMER_RELEASE_EVIDENCE_UNAVAILABLE\n");
    process.exitCode = 1;
  });
}
