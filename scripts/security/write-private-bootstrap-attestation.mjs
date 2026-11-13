import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_REPOSITORY,
  PRIVATE_REPOSITORY,
  verifyBootstrap,
} from "./verify-private-bootstrap.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export function buildBootstrapAttestation({
  publicCommit,
  publicTree,
  privateBootstrapCommit,
  privateBootstrapTree,
  recordedAt,
  operator,
  importMethod = "verified-identical-public-private-commit-tree",
}) {
  const attestation = {
    version: 1,
    publicRepository: PUBLIC_REPOSITORY,
    publicCommit,
    publicTree,
    privateRepository: PRIVATE_REPOSITORY,
    privateBootstrapCommit,
    privateBootstrapTree,
    importMethod,
    recordedAt,
    operator,
  };

  verifyBootstrap(attestation);
  return attestation;
}

function writeAttestation(attestation) {
  const outputPath = path.join(repoRoot, "security/private-bootstrap-attestation.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [publicCommit, publicTree, privateBootstrapCommit, privateBootstrapTree] =
    process.argv.slice(2);

  try {
    if (!publicCommit || !publicTree || !privateBootstrapCommit || !privateBootstrapTree) {
      throw new Error(
        "USAGE: node scripts/security/write-private-bootstrap-attestation.mjs <publicCommit> <publicTree> <privateCommit> <privateTree>",
      );
    }

    const attestation = buildBootstrapAttestation({
      publicCommit,
      publicTree,
      privateBootstrapCommit,
      privateBootstrapTree,
      recordedAt: new Date().toISOString(),
      operator:
        process.env.GITHUB_ACTOR || process.env.USERNAME || process.env.USER || "unknown",
    });

    const outputPath = writeAttestation(attestation);
    console.log(
      `PRIVATE_BOOTSTRAP_ATTESTATION_WRITTEN=${path.relative(repoRoot, outputPath).replaceAll("\\", "/")}`,
    );
  } catch (error) {
    console.error(`PRIVATE_BOOTSTRAP_ATTESTATION_WRITE=FAIL:${error.message}`);
    process.exitCode = 1;
  }
}
