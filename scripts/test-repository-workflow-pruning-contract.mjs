import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const workflowsDir = path.join(root, ".github", "workflows");

const retiredWorkflows = [
  "phase7b-live-runtime-status-ci.yml",
  "phase7b-pattern-rule-v2-apply.yml",
  "phase7b-pattern-rule-v2-recovery-ci.yml",
  "phase7c-demo-target-live-env-disabled-ci.yml",
  "phase7c-switch-position-array-ci.yml",
  "phase7c-stale-port-ownership-ci.yml",
  "phase7c-scheduled-task-ownership-ci.yml",
  "phase7c-live-capability-ci.yml",
  "phase7c-live-readonly-probe-ci.yml",
  "phase7c-live-activation-preflight-ci.yml",
  "phase7c-live-arm-guard-ci.yml",
  "phase7c-live-risk-profile-ci.yml",
  "phase7c-dual-account-mode-ci.yml",
  "phase7c-startup-runner-guard-ci.yml",
  "phase7c-web-account-switch-ci.yml",
  "phase7c-web-live-start-guard-ci.yml",
  "phase7c-web-mt5-sync-demo-e2e-ci.yml",
];

function stripYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => stripYamlScalar(item))
    .filter(Boolean);
}

function parseFilterValues(lines, key) {
  const keyPattern = new RegExp(`^ {4}${key}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern);
    if (!match) continue;

    const inline = match[1].trim();
    if (inline) {
      const inlineList = parseInlineList(inline);
      return inlineList ?? [stripYamlScalar(inline)];
    }

    const values = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= 4) break;
      const item = line.match(/^ {6,}-\s*(.+)$/);
      if (item) values.push(stripYamlScalar(item[1]));
    }
    return values;
  }
  return null;
}

function simpleGlobMatchesMain(pattern) {
  const clean = stripYamlScalar(pattern);
  if (clean === "main") return true;
  if (clean === "*" || clean === "**") return true;

  // Support the common GitHub branch-filter glob subset. For more complex
  // extglob/character-class syntax, fail open (KEEP) rather than falsely
  // classifying a workflow as dead.
  if (/[[\]{}()+@]/.test(clean)) return true;

  const escaped = clean
    .replace(/[.+^$|\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test("main");
}

function orderedBranchPatternsMatchMain(patterns) {
  let matched = false;
  for (const rawPattern of patterns) {
    const pattern = stripYamlScalar(rawPattern);
    const negative = pattern.startsWith("!");
    const candidate = negative ? pattern.slice(1) : pattern;
    if (!simpleGlobMatchesMain(candidate)) continue;
    matched = !negative;
  }
  return matched;
}

function branchIgnoreExcludesMain(patterns) {
  for (const rawPattern of patterns) {
    const pattern = stripYamlScalar(rawPattern);
    if (pattern.startsWith("!")) {
      // Complex negation ordering in branches-ignore is unusual; fail open.
      return false;
    }
    if (simpleGlobMatchesMain(pattern)) return true;
  }
  return false;
}

function branchScopedEventIsReachable(eventName, eventLines) {
  const branches = parseFilterValues(eventLines, "branches");
  const branchesIgnore = parseFilterValues(eventLines, "branches-ignore");

  if (eventName === "push") {
    const tags = parseFilterValues(eventLines, "tags");
    const tagsIgnore = parseFilterValues(eventLines, "tags-ignore");
    if ((tags && tags.length > 0) || (tagsIgnore && tagsIgnore.length > 0)) {
      return true;
    }
  }

  if (branches) {
    return orderedBranchPatternsMatchMain(branches);
  }

  if (branchesIgnore && branchIgnoreExcludesMain(branchesIgnore)) {
    return false;
  }

  return true;
}

function workflowHasReachableTrigger(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => /^['"]?on['"]?:\s*/.test(line));
  if (onIndex < 0) return true;

  const onMatch = lines[onIndex].match(/^['"]?on['"]?:\s*(.*)$/);
  const inlineOn = onMatch?.[1]?.trim() ?? "";
  if (inlineOn) {
    const inlineEvents = parseInlineList(inlineOn) ?? [stripYamlScalar(inlineOn)];
    return inlineEvents.length > 0;
  }

  const onBlock = [];
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line) && !line.trimStart().startsWith("#")) break;
    onBlock.push(line);
  }

  const events = [];
  for (let index = 0; index < onBlock.length; index += 1) {
    const match = onBlock[index].match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const eventName = match[1];
    const inlineEvent = match[2].trim();
    const eventLines = [];
    for (let next = index + 1; next < onBlock.length; next += 1) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*/.test(onBlock[next])) break;
      eventLines.push(onBlock[next]);
    }
    events.push({ eventName, inlineEvent, eventLines });
  }

  if (events.length === 0) return true;

  for (const { eventName, inlineEvent, eventLines } of events) {
    if (inlineEvent && inlineEvent !== "{}") return true;

    if (["push", "pull_request", "pull_request_target"].includes(eventName)) {
      if (branchScopedEventIsReachable(eventName, eventLines)) return true;
      continue;
    }

    // Manual, scheduled, reusable and other non-branch-scoped events are
    // intentionally treated as reachable. The audit only proves branch-dead
    // workflows; it must not over-delete workflows with another valid role.
    return true;
  }

  return false;
}

test("canonical PR gate remains present after workflow pruning", () => {
  assert.equal(
    fs.existsSync(path.join(workflowsDir, "phase7c-canonical-pr-gate.yml")),
    true,
    "canonical PR gate must never be removed by workflow pruning",
  );
});

test("proven-dead workflows stay retired", () => {
  for (const workflow of retiredWorkflows) {
    assert.equal(
      fs.existsSync(path.join(workflowsDir, workflow)),
      false,
      `RED_TARGET: retired workflow must be absent: ${workflow}`,
    );
  }
});

test("every remaining workflow has a reachable trigger in main-only topology", () => {
  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();

  const unreachable = workflowFiles.filter(
    (name) => !workflowHasReachableTrigger(path.join(workflowsDir, name)),
  );

  assert.deepEqual(
    unreachable,
    [],
    `RED_TARGET: branch-dead workflows remain: ${unreachable.join(", ")}`,
  );
});
