import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, symlink, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAttestation, verifyAttestation, verifyExpectedReleaseAttestation, assertStableReleaseZipSnapshot, assertExternalReleaseSigningKeyPath } from "./customer-release-attestation.mjs";

const SCHEMA = "xauusd-customer-release-attestation/v1";
const sha = "197803efee5ab2c718c65076d1a9dcb16fe1319f";
const publicCommit = "bdf6dd163afed23d3e5d2079ab5fc94132b2c0bd";
const keyId = "test-ed25519-2026";
const issueDate = "2026-10-25T15:40:00.000Z";

test("signed package verifies only with pinned publisher key and exact bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "release-attestation-test-"));
  try {
    const zipPath = path.join(root, "customer-agent.zip");
    await writeFile(zipPath, Buffer.from("test-zip-fixture-not-for-distribution"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trusted = {
      schema: SCHEMA, signers: [{
        keyId,
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString()
      }]
    };
    const args = {
      zipPath, releaseId: "customer-agent-v1.0.0-rc1",
      sourceCommit: sha, publicContractCommit: publicCommit,
      signerKeyId: keyId, signedAt: issueDate,
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    };
    const attestation = await createAttestation(args);
    const result = await verifyAttestation({ zipPath, attestation, trust: trusted });
    assert.equal(result.sourceCommit, sha);
    assert.equal(result.releaseId, args.releaseId);
    assert.equal(result.zipSha256, attestation.zipSha256);

    await assert.rejects(
      verifyAttestation({ zipPath, attestation, trust: { schema: SCHEMA, signers: [] } }),
      /RELEASE_SIGNER_NOT_TRUSTED/
    );
    await assert.rejects(
      verifyAttestation({ zipPath, attestation, trust: { ...trusted, signers: [...trusted.signers, ...trusted.signers] } }),
      /RELEASE_TRUST_SIGNER_INVALID/
    );
    await assert.rejects(
      verifyAttestation({ zipPath, attestation: { ...attestation, sourceCommit: "0".repeat(40) }, trust: trusted }),
      /RELEASE_SIGNATURE_INVALID/
    );
    await assert.rejects(
      verifyAttestation({ zipPath, attestation: { ...attestation, signerKeyId: "other" }, trust: trusted }),
      /RELEASE_SIGNER_NOT_TRUSTED/
    );
    await assert.rejects(
      verifyAttestation({ zipPath, attestation: { ...attestation, signatureBase64: "not base64" }, trust: trusted }),
      /RELEASE_SIGNATURE_FORMAT_INVALID/
    );
    await assert.rejects(
      verifyAttestation({ zipPath, attestation: { ...attestation, unexpected: true }, trust: trusted }),
      /RELEASE_ATTESTATION_FIELDS_INVALID/
    );
    const wrong = path.join(root, "other.zip");
    await writeFile(wrong, Buffer.from("tampered"));
    await assert.rejects(
      verifyAttestation({ zipPath: wrong, attestation, trust: trusted }),
      /RELEASE_ZIP_CHECKSUM_MISMATCH/
    );
    const altered = await createAttestation({ ...args, publicContractCommit: "f".repeat(40) });
    await assert.rejects(
      verifyAttestation({ zipPath, attestation: { ...altered, publicContractCommit: publicCommit }, trust: trusted }),
      /RELEASE_SIGNATURE_INVALID/
    );
    assert.ok((await readFile(zipPath)).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid release IDs, source SHAs and timestamps fail before any signing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "release-invalid-test-"));
  try {
    const zipPath = path.join(root, "test.zip");
    await writeFile(zipPath, Buffer.from("test"));
    const { privateKey } = generateKeyPairSync("ed25519");
    const base = {
      zipPath, releaseId: "customer-agent-v1.0.0",
      sourceCommit: sha, publicContractCommit: publicCommit,
      signerKeyId: keyId, signedAt: issueDate,
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    };
    await assert.rejects(createAttestation({ ...base, sourceCommit: "latest" }), /RELEASE_BODY_INVALID/);
    await assert.rejects(createAttestation({ ...base, releaseId: "../package" }), /RELEASE_BODY_INVALID/);
    await assert.rejects(createAttestation({ ...base, signedAt: "yesterday" }), /RELEASE_BODY_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signer key custody rejects repo paths independently of process cwd", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const outside = await mkdtemp(path.join(tmpdir(), "release-signer-path-test-"));
  const savedCwd = process.cwd();
  try {
    const tempKey = path.join(outside, "synthetic.pem");
    await writeFile(tempKey, "SYNTHETIC_TEST_KEY_NOT_FOR_SIGNATURE");
    assert.equal(await assertExternalReleaseSigningKeyPath(tempKey), await realpath(tempKey));
    process.chdir(outside);
    await assert.rejects(
      assertExternalReleaseSigningKeyPath(path.join(repositoryRoot, "package.json")),
      /RELEASE_SIGNING_KEY_MUST_BE_OUTSIDE_REPOSITORY/,
    );
    // On Windows creating symlinks may require developer privileges. Other
    // platforms validate that realpath resolves a symlink into the repository.
    if (process.platform !== "win32") {
      const linked = path.join(outside, "symlink-to-repo-key");
      await symlink(path.join(repositoryRoot, "package.json"), linked);
      await assert.rejects(
        assertExternalReleaseSigningKeyPath(linked),
        /RELEASE_SIGNING_KEY_MUST_BE_OUTSIDE_REPOSITORY/,
      );
    }
  } finally {
    process.chdir(savedCwd);
    await rm(outside, { recursive: true, force: true });
  }
});

test("production expectations reject a valid but different signed release and trust substitution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "release-approved-id-test-"));
  try {
    const zipPath = path.join(root, "candidate.zip");
    await writeFile(zipPath, "SYNTHETIC_ZIP_BYTES_ONLY");
    const pair = generateKeyPairSync("ed25519");
    const signerKeyId = "synthetic-operator";
    const trust = { schema: SCHEMA, signers: [{
      keyId: signerKeyId,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString()
    }] };
    const attestation = await createAttestation({
      zipPath, releaseId: "customer-agent-v1.0.0-rc1",
      sourceCommit: sha, publicContractCommit: publicCommit,
      signerKeyId, signedAt: issueDate,
      privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    });
    const accepted = {
      zipPath, attestation, trust,
      expectedReleaseId: attestation.releaseId,
      expectedSourceCommit: sha,
      expectedPublicContractCommit: publicCommit
    };
    assert.equal((await verifyExpectedReleaseAttestation(accepted)).sourceCommit, sha);
    await assert.rejects(
      verifyExpectedReleaseAttestation({ ...accepted, expectedReleaseId: "customer-agent-v1.0.1" }),
      /RELEASE_EXPECTED_IDENTITY_MISMATCH/
    );
    await assert.rejects(
      verifyExpectedReleaseAttestation({ ...accepted, expectedSourceCommit: "f".repeat(40) }),
      /RELEASE_EXPECTED_IDENTITY_MISMATCH/
    );
    await assert.rejects(
      verifyExpectedReleaseAttestation({ ...accepted, expectedPublicContractCommit: "f".repeat(40) }),
      /RELEASE_EXPECTED_IDENTITY_MISMATCH/
    );
    await assert.rejects(
      verifyExpectedReleaseAttestation({ ...accepted, expectedSourceCommit: "latest" }),
      /RELEASE_EXPECTATIONS_INVALID/
    );
    await assert.rejects(
      verifyExpectedReleaseAttestation({ ...accepted, trust: { schema: SCHEMA, signers: [] } }),
      /RELEASE_SIGNER_NOT_TRUSTED/
    );
    const attacker = generateKeyPairSync("ed25519");
    await assert.rejects(
      verifyExpectedReleaseAttestation({ ...accepted, trust: { schema: SCHEMA, signers: [{
        keyId: signerKeyId,
        publicKeyPem: attacker.publicKey.export({ format: "pem", type: "spki" }).toString()
      }] } }),
      /RELEASE_SIGNATURE_INVALID/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release CLI cannot accept --trust override or claim customer acceptance", async () => {
  const cli = await readFile(new URL("./customer-release-attestation.mjs", import.meta.url), "utf8");
  assert.match(cli, /const required = \["--zip", "--attestation", "--expected-release-id", "--expected-source", "--expected-public"\]/);
  assert.doesNotMatch(cli, /flags\["--trust"\]/);
  assert.doesNotMatch(cli, /CUSTOMER_RELEASE_SIGNATURE=PASS/);
  assert.match(cli, /CUSTOMER_RELEASE_CUSTOMER_ACCEPTANCE=NOT_VERIFIED/);
});


test("stable handle snapshot rejects same-size edits, replacement and truncation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "release-zip-stability-test-"));
  try {
    const zipPath = path.join(root, "candidate.zip");
    await writeFile(zipPath, "SYNTHETIC_STABLE_ZIP");
    const info = await stat(zipPath);
    const valid = { ...info, isFile: () => true };
    assert.doesNotThrow(() => assertStableReleaseZipSnapshot(valid, valid, valid, valid, valid.size));
    assert.throws(() => assertStableReleaseZipSnapshot(valid, valid, { ...valid, mtimeMs: valid.mtimeMs + 2000 }, valid, valid.size), /RELEASE_ZIP_CHANGED_DURING_READ/);
    // Windows file indexes may be above Number.MAX_SAFE_INTEGER, where ino + 1 rounds back to ino.
    // Use an unambiguously distinct synthetic identity regardless of host filesystem representation.
    assert.throws(() => assertStableReleaseZipSnapshot(valid, { ...valid, ino: Symbol('synthetic-replacement-inode') }, valid, valid, valid.size), /RELEASE_ZIP_CHANGED_DURING_READ/);
    assert.throws(() => assertStableReleaseZipSnapshot(valid, valid, valid, valid, valid.size - 1), /RELEASE_ZIP_CHANGED_DURING_READ/);
    assert.throws(() => assertStableReleaseZipSnapshot(valid, valid, valid, null, valid.size), /RELEASE_ZIP_CHANGED_DURING_READ/);
    if (process.platform !== "win32") {
      const aliasPath = path.join(root, "alias.zip");
      await symlink(zipPath, aliasPath);
      const { privateKey } = generateKeyPairSync("ed25519");
      await assert.rejects(createAttestation({
        zipPath: aliasPath, releaseId: "customer-agent-v1.0.0",
        sourceCommit: sha, publicContractCommit: publicCommit, signerKeyId: keyId,
        signedAt: issueDate,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      }), /RELEASE_ZIP_NOT_REGULAR/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
