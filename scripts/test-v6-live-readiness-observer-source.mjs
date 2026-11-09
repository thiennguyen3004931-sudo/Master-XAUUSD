import fs from 'node:fs';
import assert from 'node:assert/strict';

const workflow = fs.readFileSync('.github/workflows/v6-live-readiness-readonly.yml', 'utf8');
const broker = fs.readFileSync('scripts/mt5-direct-probe.py', 'utf8');
const host = workflow.split('  windows-host-observation:')[1];
assert.ok(host, 'host diagnostic job must exist');
assert.match(workflow, /name: V6 LIVE Readiness Evidence \(read-only; NOT authorization\)/);
assert.match(workflow, /pull_request:\s*\n\s*branches: \[main\]/);
assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
assert.match(workflow, /contents: read/);
assert.match(workflow, /runs-on: windows-latest/);
assert.match(host, /runs-on: \[self-hosted, Windows, X64, xauusd-core-ci\]/);
assert.match(host, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main' && github\.repository == 'thiennguyen3004931-sudo\/Master-XAUUSD'/);
assert.doesNotMatch(host, /actions\/checkout|\bGITHUB_TOKEN\b|\bsecrets\.|\bcredentials\b|\bpassword\b/i);
assert.match(host, /V6_READINESS_READ_ONLY=TRUE/);
assert.match(host, /V6_LIVE_READINESS_RESULT=BLOCKED_NOT_AUTHORIZED/);
assert.match(host, /exit 2\b/);
assert.match(host, /V6_VERIFIED_MT5_ACCOUNT_TYPE=NO/);
assert.match(host, /V6_VERIFIED_DAILY_LOSS_KILL_SWITCH=NO/);
assert.match(host, /V6_VERIFIED_OPERATING_SOURCE_SHA=NO/);
assert.match(host, /V6_VERIFIED_TELEGRAM_ROTATION=NO/);
assert.match(host, /V6_VERIFIED_EMERGENCY_STOP=NO/);
assert.match(host, /V6_BROKER_ORDER_SEND=NONE/);
assert.match(host, /V6_ACCOUNT_SWITCH=NONE/);
assert.match(broker, /live_permission = False/);
assert.match(broker, /\("order", "dca_plus", "manage_positions", "breakeven", "close"\)/);
for (const [regex, label] of [
  [/mt5\.order_send\b|\border_send\s*\(/i, 'broker orders'],
  [/\b(?:Invoke-RestMethod|Invoke-WebRequest|curl(?:\.exe)?)\b/i, 'unauthorized web calls'],
  [/\b(?:Set-Content|Remove-Item|Move-Item|Rename-Item|New-Item|Set-Item|Add-Content)\b/i, 'filesystem mutation'],
  [/\b(?:git\s+(?:checkout|pull|reset|clean|fetch)|Start-Process|Stop-Process)\b/i, 'process or checkout mutation'],
  [/\b(?:ACCOUNT_LOGIN|MT5_PASSWORD|ZIQ_V6_CONTROL_TOKEN)\b/i, 'sensitive identifiers'],
  [/\b(?:workflow_dispatch.*notify|issue.*patch)\b/i, 'unrelated issue updates'],
]) assert.doesNotMatch(host, regex, label + ' must be absent from host diagnostic');
console.log('V6_READINESS_SOURCE_SAFETY_CONTRACT=PASS');
console.log('V6_LIVE_AUTHORIZATION=NOT_GRANTED');
