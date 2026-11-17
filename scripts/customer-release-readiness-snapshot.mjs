// Read-only report only. NEVER a customer release authorization or production activation gate.
// GitHub Actions may show SUCCESS when this reporting job completes while release remains BLOCKED.
import { writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const REQUIRED_WORKFLOWS = Object.freeze([
  "Phase7C Canonical PR Gate",
  "Private Master Core Self-Hosted CI",
  "Customer Handoff Final Production Acceptance Read-Only",
  "Customer Authenticated API Gateway CI",
]);
const STATUS = "BLOCKED";
export function evaluateCustomerReleaseSnapshot({ sha, issues, workflowRuns }) {
  const cleanSha = typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  const blockers = [];
  if (!cleanSha) blockers.push("SOURCE_SHA_MISSING");
  for (const issue of [166, 176]) {
    const record = issues?.[issue];
    if (record !== "closed") blockers.push("ISSUE_" + issue + "_NOT_CLOSED");
  }
  const workflows = REQUIRED_WORKFLOWS.map(name => {
    const matching = Array.isArray(workflowRuns)
      ? workflowRuns.filter(x => x && x.name === name && x.head_sha === cleanSha)
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
  blockers.push("INDEPENDENT_AUTHORITY_HOST_AND_PUBLISHER_APPROVAL_NOT_ATTESTED");
  return {
    schemaVersion: 1,
    sourceSha: cleanSha,
    status: STATUS,
    releaseAuthorized: false,
    scope: "READ_ONLY_GITHUB_SOFTWARE_EVIDENCE",
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
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !token) {
    throw new Error("GITHUB_EVIDENCE_UNAVAILABLE");
  }
  const issues = {};
  for (const issue of [166, 176]) {
    const result = await githubJson("/repos/" + repo + "/issues/" + issue, token);
    issues[issue] = result.state;
  }
  const runs = await githubJson(
    "/repos/" + repo + "/actions/runs?head_sha=" + encodeURIComponent(sha) + "&per_page=100",
    token,
  );
  const report = evaluateCustomerReleaseSnapshot({
    sha,
    issues,
    workflowRuns: runs.workflow_runs,
  });
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
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write("CUSTOMER_RELEASE_EVIDENCE_UNAVAILABLE\n");
    process.exitCode = 1;
  });
}
