import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// RED contract: activation preflight diagnostics must not masquerade as active AUTO status.
const sourcePath = resolve(
  process.cwd(),
  "apps/web/src/ui/Phase7CExecutionAuthorizationCard.tsx",
);
const source = readFileSync(sourcePath, "utf8");

function requireMatch(pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
}

requireMatch(
  /const\s+isAutoActive\s*=\s*botMode\s*===\s*["']AUTO["']\s*;/,
  "AUTO active state must be derived from the canonical bot mode.",
);

requireMatch(
  /const\s+showAutoActivationDiagnostics\s*=\s*!isAutoActive\s*;/,
  "AUTO activation diagnostics must be hidden once AUTO is already active.",
);

requireMatch(
  /const\s+autoStatusLabel\s*=\s*isAutoActive\s*\?\s*["']ĐANG HOẠT ĐỘNG["']\s*:/,
  "AUTO active state must display ĐANG HOẠT ĐỘNG instead of activation BLOCKED.",
);

requireMatch(
  /showAutoActivationDiagnostics\s*\?\s*\([\s\S]*?autoCount\.passed[\s\S]*?autoCount\.total[\s\S]*?\)\s*:\s*null/,
  "Activation preflight count must only be rendered before AUTO activation.",
);

requireMatch(
  /showAutoActivationDiagnostics\s*&&\s*autoBlockedBy\.length/,
  "Activation blockedBy reasons must not describe an already-active AUTO runtime.",
);

requireMatch(
  /showAutoActivationDiagnostics\s*&&\s*showAutoChecks/,
  "Activation preflight detail rows must not be rendered while AUTO is active.",
);

console.log("PHASE7C_AUTO_ACTIVE_UI_AUTHORIZATION_SEMANTICS=PASS");
