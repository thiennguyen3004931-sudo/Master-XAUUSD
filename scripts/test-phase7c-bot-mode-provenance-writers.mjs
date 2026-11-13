import { execFileSync } from "node:child_process";
import fs from "node:fs";

const allowedWriter = "apps/api/src/services/phase7c-bot-mode.service.ts";
const provenanceWorkflow = ".github/workflows/phase7c-bot-mode-provenance-ci.yml";
const testFixtures = new Set([
  "scripts/test-phase7c-bot-mode-provenance.ts",
  "scripts/test-phase7c-bot-mode-provenance-writers.mjs",
]);
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((file) => /\.(?:ts|tsx|js|mjs|cjs|ps1)$/i.test(file));

const pathNeedles = ["phase7c-bot-mode.json", "PHASE7C_BOT_MODE_FILE"];
const writerPatterns = [
  /\b(?:writeFileSync|appendFileSync|renameSync|writeFile|appendFile|rename)\s*\(/,
  /\b(?:Set-Content|Add-Content|Out-File|Move-Item|Rename-Item)\b/i,
  /\[System\.IO\.File\]::(?:WriteAllText|AppendAllText|Move)/i,
  /\[IO\.File\]::(?:WriteAllText|AppendAllText|Move)/i,
];

const suspicious = [];
const references = [];

for (const file of tracked) {
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }

  if (!pathNeedles.some((needle) => source.includes(needle))) continue;
  references.push(file);
  if (file === allowedWriter || testFixtures.has(file)) continue;

  if (writerPatterns.some((pattern) => pattern.test(source))) {
    suspicious.push(file);
  }
}

if (!references.includes(allowedWriter)) {
  throw new Error(`Canonical bot-mode writer is not discoverable at ${allowedWriter}`);
}

if (suspicious.length > 0) {
  throw new Error(
    `Potential direct bot-mode state writer(s) bypass provenance service: ${suspicious.join(", ")}`,
  );
}

const workflowSource = fs.readFileSync(provenanceWorkflow, "utf8");
const protectsMainPullRequests = /pull_request:\s*\r?\n\s+branches:\s*\r?\n\s+- main(?:\r?\n|$)/.test(
  workflowSource,
);
if (!protectsMainPullRequests) {
  throw new Error("Bot Mode Provenance CI must protect pull requests targeting main");
}
if (workflowSource.includes("- fix/phase7c-legacy-background-cleanup")) {
  throw new Error("Bot Mode Provenance CI must not target the retired legacy integration branch");
}

console.log(`PHASE7C_BOT_MODE_PROVENANCE_WRITER_AUDIT=PASS|REFERENCES=${references.length}`);
