import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMasterCoreAcceptance,
  evaluateMasterCoreAcceptance,
  hasPublicContractDependencyEvidence,
} from "./accept-master-core-split.mjs";

test("M7 private acceptance fails closed on contract drift or tracked signing key", () => {
  const verdicts = evaluateMasterCoreAcceptance({
    buildPassed: true,
    masterRegressionPassed: true,
    publicContractLockPassed: false,
    privateSigningKeyTracked: true,
    privateDependsOnPublicContracts: true,
    publicDependsOnPrivateSource: false,
    productionCutoverPerformed: false,
  });

  assert.equal(verdicts.PUBLIC_CONTRACT_LOCK, "FAIL");
  assert.equal(verdicts.PRIVATE_SIGNING_KEY_TRACKED, "TRUE");
  assert.throws(() => assertMasterCoreAcceptance(verdicts), /M7_PRIVATE_ACCEPTANCE_FAILED/);
});

test("M7 private acceptance refuses to claim source completion after production cutover", () => {
  const verdicts = evaluateMasterCoreAcceptance({
    buildPassed: true,
    masterRegressionPassed: true,
    publicContractLockPassed: true,
    privateSigningKeyTracked: false,
    privateDependsOnPublicContracts: true,
    publicDependsOnPrivateSource: false,
    productionCutoverPerformed: true,
  });

  assert.equal(verdicts.PRODUCTION_CUTOVER, "PERFORMED");
  assert.throws(
    () => assertMasterCoreAcceptance(verdicts),
    /M7_PRIVATE_ACCEPTANCE_FAILED:PRODUCTION_CUTOVER=PERFORMED/,
  );
});

test("M7 treats a verified M6 contract lock as private dependency evidence", () => {
  assert.equal(
    hasPublicContractDependencyEvidence({
      publicContractLockVerified: true,
      directReferencePresent: false,
    }),
    true,
  );
});

test("M7 dependency evidence fails closed without lock proof or a direct reference", () => {
  assert.equal(
    hasPublicContractDependencyEvidence({
      publicContractLockVerified: false,
      directReferencePresent: false,
    }),
    false,
  );
});

test("M7 private acceptance emits the exact required GREEN verdicts", () => {
  const verdicts = evaluateMasterCoreAcceptance({
    buildPassed: true,
    masterRegressionPassed: true,
    publicContractLockPassed: true,
    privateSigningKeyTracked: false,
    privateDependsOnPublicContracts: true,
    publicDependsOnPrivateSource: false,
    productionCutoverPerformed: false,
  });

  assert.deepEqual(verdicts, {
    PRIVATE_BUILD: "PASS",
    MASTER_REGRESSION: "PASS",
    PUBLIC_CONTRACT_LOCK: "PASS",
    PRIVATE_SIGNING_KEY_TRACKED: "FALSE",
    PRIVATE_DEPENDS_ON_PUBLIC_CONTRACTS: "TRUE",
    PUBLIC_DEPENDS_ON_PRIVATE_SOURCE: "FALSE",
    PRODUCTION_CUTOVER: "NOT_PERFORMED",
  });
  assert.doesNotThrow(() => assertMasterCoreAcceptance(verdicts));
});
