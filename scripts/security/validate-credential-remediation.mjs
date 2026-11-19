import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_STATUSES = new Set([
  "ROTATED",
  "REVOKED",
  "FALSE_POSITIVE_REVIEWED",
]);

const FORBIDDEN_FIELD_NAMES = new Set([
  "secret",
  "value",
  "token",
  "password",
  "privatekey",
  "credentialvalue",
]);

function nonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function rejectForbiddenFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) {
      throw new Error(`FORBIDDEN_REMEDIATION_FIELD:${key}`);
    }
    rejectForbiddenFields(nested);
  }
}

function assertGitleaksFinding(finding) {
  if (
    !finding ||
    typeof finding !== "object" ||
    !nonBlankString(finding.Fingerprint) ||
    !nonBlankString(finding.RuleID) ||
    !nonBlankString(finding.File) ||
    !nonBlankString(finding.Commit)
  ) {
    throw new Error("INVALID_GITLEAKS_FINDING");
  }
}

function assertLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || ledger.version !== 1 || !Array.isArray(ledger.findings)) {
    throw new Error("INVALID_REMEDIATION_LEDGER");
  }
  rejectForbiddenFields(ledger);
}

export function validateRemediation(report, ledger) {
  if (!Array.isArray(report)) throw new Error("INVALID_GITLEAKS_REPORT");
  assertLedger(ledger);

  const reportByFingerprint = new Map();
  for (const finding of report) {
    assertGitleaksFinding(finding);
    if (reportByFingerprint.has(finding.Fingerprint)) {
      throw new Error(`DUPLICATE_GITLEAKS_FINGERPRINT:${finding.Fingerprint}`);
    }
    reportByFingerprint.set(finding.Fingerprint, finding);
  }

  const ledgerByFingerprint = new Map();
  for (const entry of ledger.findings) {
    if (!entry || typeof entry !== "object" || !nonBlankString(entry.fingerprint)) {
      throw new Error("INVALID_REMEDIATION_ENTRY");
    }
    if (ledgerByFingerprint.has(entry.fingerprint)) {
      throw new Error(`DUPLICATE_REMEDIATION_FINGERPRINT:${entry.fingerprint}`);
    }
    if (!ALLOWED_STATUSES.has(entry.status)) {
      throw new Error(`INVALID_REMEDIATION_STATUS:${entry.status}`);
    }
    if (
      !nonBlankString(entry.ruleId) ||
      !nonBlankString(entry.path) ||
      !nonBlankString(entry.commit)
    ) {
      throw new Error(`INVALID_REMEDIATION_ENTRY:${entry.fingerprint}`);
    }
    ledgerByFingerprint.set(entry.fingerprint, entry);
  }

  for (const [fingerprint, finding] of reportByFingerprint) {
    const entry = ledgerByFingerprint.get(fingerprint);
    if (!entry) throw new Error(`UNREMEDIATED_SECRET_FINDING:${fingerprint}`);

    const expected = {
      ruleId: finding.RuleID,
      path: finding.File,
      commit: finding.Commit,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (entry[field] !== value) {
        throw new Error(`REMEDIATION_METADATA_MISMATCH:${fingerprint}:${field}`);
      }
    }
  }

  for (const fingerprint of ledgerByFingerprint.keys()) {
    if (!reportByFingerprint.has(fingerprint)) {
      throw new Error(`REMEDIATION_WITHOUT_FINDING:${fingerprint}`);
    }
  }

  return {
    totalFindings: reportByFingerprint.size,
    remediatedFindings: ledgerByFingerprint.size,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const [reportPath, ledgerPath] = process.argv.slice(2);
  if (!reportPath || !ledgerPath) {
    console.error(
      "USAGE: node scripts/security/validate-credential-remediation.mjs <redacted-gitleaks.json> <credential-remediation.json>",
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = validateRemediation(
      readJson(resolve(reportPath)),
      readJson(resolve(ledgerPath)),
    );
    console.log("SECRET_HISTORY_REMEDIATION=PASS");
    console.log(`SECRET_FINDING_COUNT=${result.totalFindings}`);
    console.log(`REMEDIATED_FINDING_COUNT=${result.remediatedFindings}`);
    console.log("SECRET_VALUES_PRINTED=FALSE");
  } catch (error) {
    console.error("SECRET_HISTORY_REMEDIATION=FAIL");
    console.error(`REASON=${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`);
    console.error("SECRET_VALUES_PRINTED=FALSE");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
