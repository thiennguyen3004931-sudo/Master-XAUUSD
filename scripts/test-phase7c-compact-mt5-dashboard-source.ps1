$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Read-Source([string]$Path) {
  $full = Join-Path $ProjectRoot $Path
  if (-not (Test-Path -LiteralPath $full)) { throw "Missing source file: $Path" }
  return Get-Content -LiteralPath $full -Raw
}

function Assert-Text([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -notmatch $Pattern) { throw "Compact MT5 dashboard assertion failed: $Message" }
}

function Assert-NotText([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -match $Pattern) { throw "Compact MT5 dashboard negative assertion failed: $Message" }
}

$mq5 = Read-Source "mt5\XAUUSD_AI_Master_Decision_Panel.mq5"
$ui = Read-Source "apps\api\src\services\phase7c-ui-contract.service.ts"

# Option B base dimensions remain spacious.
Assert-Text $mq5 'PANEL_MIN_WIDTH\s*=\s*620' "Option B panel minimum width must remain 620px"
Assert-Text $mq5 'PANEL_MAX_WIDTH\s*=\s*760' "Option B panel maximum width must remain 760px"
Assert-Text $mq5 'chart_width\s*\*\s*0\.40' "Option B panel should use about 40 percent of chart width"

# Readable DPI-stable typography.
Assert-Text $mq5 'BODY_FONT_SIZE\s*=\s*13' "body text must use a readable 13px physical font"
Assert-Text $mq5 'SECTION_FONT_SIZE\s*=\s*15' "section titles must use a readable 15px physical font"
Assert-Text $mq5 'TITLE_FONT_SIZE\s*=\s*20' "panel title must use a readable 20px physical font"
Assert-Text $mq5 'REASON_ROW_HEIGHT\s*=\s*64' "reason rows must retain contained 64px geometry"
Assert-Text $mq5 'REASON_ROW_GAP\s*=\s*6' "reason rows must retain explicit visual gaps"
Assert-Text $mq5 'void\s+VerticalDivider\s*\(' "dashboard must provide vertical dividers"
Assert-Text $mq5 'void\s+DrawReasonRowCard\s*\(' "each decision reason must render in its own contained row card"
Assert-Text $mq5 'Card\(x,\s*y,\s*width,\s*REASON_ROW_HEIGHT' "reason row helper must draw its own card"
Assert-Text $mq5 'WrapTextTwoLines\(ReasonVi\(reason,\s*fallback\),\s*content_width,\s*BODY_FONT_SIZE' "reason content must wrap inside its own column"
Assert-Text $mq5 'DrawReasonRowCard\(' "reason summary must use contained row cards"
Assert-NotText $mq5 'void\s+DrawReasonLine\s*\(' "legacy free-floating reason line renderer must be removed"

# DPI root-cause fix must remain intact.
Assert-Text $mq5 'g_canvas\.FontSet\("Segoe UI",\s*px\)' "MT5 font must use positive pixel size independent of Windows font scaling"
Assert-NotText $mq5 'g_canvas\.FontSet\("Segoe UI",\s*-px\s*\*\s*10\)' "negative logical-point font sizing must stay removed"
Assert-Text $mq5 'int\s+TextHeightPx\s*\(' "panel must measure live canvas text height"
Assert-Text $mq5 'g_canvas\.TextHeight\("Ag"\)' "text-height helper must use CCanvas TextHeight"
Assert-Text $mq5 'int\s+CenteredTextY\s*\(' "panel must provide metric-based vertical centering"
Assert-Text $mq5 'TextHeightPx\(px\)' "vertical centering must derive from measured font height"
Assert-Text $mq5 'int\s+ReasonLabelColumnWidth\s*\(' "reason label column must be measured dynamically"
Assert-Text $mq5 'g_canvas\.TextWidth\("ĐÓNG TOÀN BỘ"\)' "reason label width must include the longest operator label"
Assert-Text $mq5 'int\s+EntryStrategyColumnWidth\s*\(' "entry strategy column must be measured dynamically"
Assert-Text $mq5 'g_canvas\.TextWidth\("SIDEWAY"\)' "entry strategy width must fit SIDEWAY without truncation"
Assert-Text $mq5 'CenteredTextY\(' "text-bearing cells must use measured vertical centering"

# System status remains a four-column grid.
Assert-Text $mq5 'STATUS_COLUMN_COUNT\s*=\s*4' "system status must define four equal columns"
Assert-Text $mq5 'for\(int divider\s*=\s*1;\s*divider\s*<\s*STATUS_COLUMN_COUNT;\s*divider\+\+\)' "system status must draw dividers between columns"
Assert-Text $mq5 'VerticalDivider\(' "system status must use the shared divider helper"

# Existing geometry stays compact; metric centering must contain the larger text.
Assert-Text $mq5 'HEADER_HEIGHT\s*=\s*104' "header card geometry must stay compact"
Assert-Text $mq5 'STATUS_HEIGHT\s*=\s*86' "status card geometry must stay compact"
Assert-Text $mq5 'STATE_STRIP_HEIGHT\s*=\s*58' "state strip geometry must stay compact"
Assert-Text $mq5 'ENTRY_CHECK_HEIGHT\s*=\s*112' "entry blocker geometry must stay compact"
Assert-Text $mq5 'WAITING_HEIGHT\s*=\s*590' "waiting canvas must stay compact"
Assert-Text $mq5 'SETUP_HEIGHT\s*=\s*590' "setup canvas must stay compact"
Assert-Text $mq5 'MANAGING_HEIGHT\s*=\s*780' "managing canvas must stay compact"

# Legacy rule-oriented blocks must stay removed from the MQL panel.
Assert-NotText $mq5 'void\s+DrawFooter\s*\(' "legacy rule footer must stay removed"
Assert-NotText $mq5 'void\s+DrawGateCard\s*\(' "verbose legacy gate card must stay removed"
Assert-NotText $mq5 'breakEvenTriggerDistance' "strategy-rule trigger must not be rendered by panel"
Assert-NotText $mq5 'partialTriggerDistance' "partial-close rule trigger must not be rendered by panel"

# Required operator information remains bound to canonical fields.
Assert-Text $mq5 'Field\(payload,\s*.setupEntry.' "panel must show setup entry"
Assert-Text $mq5 'Field\(payload,\s*.setupStopLoss.' "panel must show setup stoploss"
Assert-Text $mq5 'Field\(payload,\s*.setupTp2.' "panel must show setup take profit"
Assert-Text $mq5 'Field\(payload,\s*.entryReason1.' "panel must show entry reason"
Assert-Text $mq5 'Field\(payload,\s*.holdReason1.' "panel must show hold reason"
Assert-Text $mq5 'Field\(payload,\s*.exitReason1.' "panel must show latest exit reason"
Assert-Text $mq5 'Field\(payload,\s*.floatingPnlUsd.' "panel must show floating profit/loss"

# Entry blocker rows stay compact semantically.
Assert-Text $mq5 'string\s+CompactEntryCheckLabel\s*\(' "entry blocker labels must have a compact formatter"
Assert-Text $mq5 'StringReplace\(out,\s*.Mode / Regime.,\s*.Mode/Regime.' "Mode / Regime label must be compacted"
Assert-Text $mq5 'string\s+CompactEntryCheckActual\s*\(' "entry blocker actual value must have a compact formatter"
Assert-Text $mq5 'StringReplace\(out,\s*"PAUSE[^\"]*PAUSE",\s*"PAUSE"' "duplicate PAUSE transition must collapse"
Assert-Text $mq5 'EntryCheckStatusVi\(status\)\s*\+\s*"[^"]*"\s*\+\s*CompactEntryCheckLabel\(label\)' "blocker row must render compact status and label"
Assert-Text $mq5 'CompactEntryCheckActual\(actual\)' "blocker row must use compact actual values"
Assert-NotText $mq5 'trend_label\s*\+\s*"[^"]*"\s*\+\s*trend_actual' "legacy verbose Trend blocker concatenation must stay removed"
Assert-NotText $mq5 'sideway_label\s*\+\s*"[^"]*"\s*\+\s*sideway_actual' "legacy verbose Sideway blocker concatenation must stay removed"

# System status truth remains canonical.
Assert-Text $mq5 'FillCircle' "system status must use visible status dots"
Assert-Text $mq5 'on\s*\?\s*.ON.\s*:\s*.OFF.' "status dots must be paired with ON/OFF text"
Assert-Text $mq5 'BoolField\(payload,\s*.mt5Connected.' "panel must show MT5 connection status"
Assert-Text $mq5 'BoolField\(payload,\s*.accountGuardValid.' "panel must show account safety status"
Assert-Text $mq5 'BoolField\(payload,\s*.trendOn.' "panel must show bot Trend permission status"
Assert-Text $mq5 'BoolField\(payload,\s*.sidewayOn.' "panel must show bot Sideway permission status"

Assert-Text $ui 'status:\s*\{' "UI contract must expose a status section"
Assert-Text $ui 'mt5Connected:\s*snapshot\.account\.reachable\s*===\s*true' "MT5 status must come from telemetry reachability"
Assert-Text $ui 'accountGuardValid:\s*snapshot\.safety\.accountGuardValid\s*===\s*true' "account safety status must come from canonical safety state"
Assert-Text $ui 'trendOn:\s*trendGate\s*===\s*.ALLOWED.' "bot Trend ON must reflect canonical gate"
Assert-Text $ui 'sidewayOn:\s*sidewayGate\s*===\s*.ALLOWED.' "bot Sideway ON must reflect canonical gate"
Assert-Text $ui 'function\s+exitReasons\s*\(' "UI contract must derive exit reasons"
Assert-Text $ui 'snapshot\.recentDecisions' "exit reason must come from canonical decision journal"
Assert-Text $ui 'exitReason1' "MT5 payload must include exit reason"

# Preserve read-only MT5 behavior.
Assert-Text $mq5 'WebRequest\(.GET.' "MT5 dashboard must remain GET-only"
Assert-NotText $mq5 'WebRequest\(.POST.' "MT5 dashboard must never POST controls"
Assert-NotText $mq5 'OrderSend\s*\(' "MT5 dashboard must not send orders"
Assert-Text $mq5 'ORDER PERMISSION = NONE' "read-only safety marker must remain"
Assert-Text $ui 'orderPermission:\s*.NONE.' "UI contract must remain read-only"

Write-Host "PHASE7C_COMPACT_MT5_DASHBOARD_SOURCE_TEST=PASS"
