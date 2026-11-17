import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectTrackedContent,
  inspectTrackedPath,
} from "./check-private-secrets.mjs";

test("tracked private-key, credential, and secret filenames are rejected", () => {
  for (const filePath of [
    "keys/master-signing.pem",
    "keys/device-private.key",
    "config/prod.env",
    ".env",
    ".env.production",
    "certs/customer.p12",
    "certs/customer.pfx",
    "ssh/id_rsa",
    "ssh/id_ed25519",
    "config/private-key.json",
    "config/signing-key.json",
    "config/customer-credential.json",
    "config/client-secret.json",
    "config/customer-secrets.yaml",
  ]) {
    assert.equal(inspectTrackedPath(filePath), "REJECT", filePath);
  }
});

test("safe documentation, env templates, remediation metadata, and checker source are allowed", () => {
  for (const filePath of [
    "docs/public/SECURITY-BOUNDARY.md",
    "docs/private/SELF-HOSTED-CI.md",
    "config/app.env.example",
    ".env.phase7b-telegram.example",
    "packages/mt5-broker/bridge/.env.phase7b-demo.example",
    "packages/mt5-broker/bridge/.env.phase7b-live.example",
    "config/app.env.sample",
    ".env.local.sample",
    "scripts/security/check-private-secrets.mjs",
    "scripts/security/check-private-secrets.test.mjs",
    "scripts/security/validate-credential-remediation.mjs",
    "scripts/security/validate-credential-remediation.test.mjs",
    "security/credential-remediation.json",
  ]) {
    assert.equal(inspectTrackedPath(filePath), "ALLOW", filePath);
  }
});

test("high-confidence secret content signatures are rejected", () => {
  const classicGitHubToken = "ghp_" + "A".repeat(36);
  const fineGrainedGitHubToken = "github_pat_" + "B".repeat(82);
  const privateKeyBlock = [
    "-----BEGIN " + "PRIVATE KEY-----",
    "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB",
    "-----END " + "PRIVATE KEY-----",
  ].join("\n");

  for (const content of [
    classicGitHubToken,
    fineGrainedGitHubToken,
    privateKeyBlock,
  ]) {
    assert.equal(
      inspectTrackedContent("config/safe-name.txt", content),
      "REJECT",
    );
  }
});

test("allowed env template paths do not bypass content signature scanning", () => {
  const classicGitHubToken = "ghp_" + "C".repeat(36);

  assert.equal(inspectTrackedPath(".env.phase7b-demo.example"), "ALLOW");
  assert.equal(
    inspectTrackedContent(".env.phase7b-demo.example", classicGitHubToken),
    "REJECT",
  );
});

test("documentation that mentions token prefixes without real values is allowed", () => {
  assert.equal(
    inspectTrackedContent(
      "docs/private/SELF-HOSTED-CI.md",
      "Never commit ghp_ or github_pat_ credentials.",
    ),
    "ALLOW",
  );
});
