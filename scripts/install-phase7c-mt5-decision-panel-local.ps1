param(
  [string]$BridgeEnv = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$TerminalPath = "",
  [string]$DataPath = "",
  [string]$ApiUrl = "http://127.0.0.1:3711/api/v1/phase7c-ui/mt5?symbol=XAUUSD",
  [switch]$SkipCompile
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $ProjectRoot "mt5\XAUUSD_AI_Master_Decision_Panel.mq5"
if (-not (Test-Path -LiteralPath $Source)) { throw "MT5 decision panel source not found: $Source" }
$SourceText = Get-Content -LiteralPath $Source -Raw
foreach ($forbidden in @("OrderSend", "CTrade", "PositionClose", "PositionModify")) {
  if ($SourceText -match [regex]::Escape($forbidden)) {
    throw "MT5 decision panel must remain read-only; forbidden token detected: $forbidden"
  }
}
foreach ($required in @(
  "ORDER PERMISSION = NONE",
  "DEMO/LIVE",
  'Field(payload, "accountMode")',
  "RuntimeMatchesTerminal",
  'Field(payload, "autoReason1")',
  'Field(payload, "waitReason1")',
  "FirstEntryBlocker",
  "DrawEntryCheckSummary",
  'prefix + "Check" + suffix + "Status"',
  'prefix + "Check" + suffix + "Label"',
  'prefix + "Check" + suffix + "Actual"',
  'Field(payload, "entryReason1")',
  'Field(payload, "holdReason1")',
  'Field(payload, "stopMoveReason1")',
  'Field(payload, "partialReason1")',
  'Field(payload, "exitReason1")'
)) {
  if ($SourceText.IndexOf($required, [System.StringComparison]::Ordinal) -lt 0) {
    throw "MT5 decision panel synchronized semantic marker is missing: $required"
  }
}

if (-not [System.IO.Path]::IsPathRooted($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot $BridgeEnv
}

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    if ($line.Substring(0, $index).Trim().TrimStart([char]0xFEFF) -ne $Name) { continue }
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
  }
  return ""
}

function Normalize-PathForCompare([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $candidate = $Value.Trim().Trim('"').TrimEnd('\', '/')
  try {
    $candidate = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
  } catch {}
  return $candidate.TrimEnd('\', '/')
}

if ([string]::IsNullOrWhiteSpace($TerminalPath)) {
  $TerminalPath = Read-EnvValue $BridgeEnv "MT5_TERMINAL_PATH"
}
if ([string]::IsNullOrWhiteSpace($TerminalPath) -or -not (Test-Path -LiteralPath $TerminalPath)) {
  throw "Cannot resolve MT5 terminal64.exe. Pass -TerminalPath or configure MT5_TERMINAL_PATH in $BridgeEnv"
}
$TerminalPath = (Resolve-Path -LiteralPath $TerminalPath).Path
$terminalInstallDir = Split-Path -Parent $TerminalPath
$terminalPathNormalized = Normalize-PathForCompare $TerminalPath
$terminalDirNormalized = Normalize-PathForCompare $terminalInstallDir

if ([string]::IsNullOrWhiteSpace($DataPath)) {
  $portable = (Read-EnvValue $BridgeEnv "MT5_PORTABLE") -match '^(1|true|yes|on)$'
  if ($portable) {
    $DataPath = $terminalInstallDir
  } else {
    $terminalRoot = Join-Path $env:APPDATA "MetaQuotes\Terminal"
    $matches = @()
    if (Test-Path -LiteralPath $terminalRoot) {
      foreach ($directory in Get-ChildItem -LiteralPath $terminalRoot -Directory -ErrorAction SilentlyContinue) {
        $origin = Join-Path $directory.FullName "origin.txt"
        if (-not (Test-Path -LiteralPath $origin)) { continue }
        try {
          $originPath = (Get-Content -LiteralPath $origin -Raw).Trim().Trim([char]0xFEFF)
          $originNormalized = Normalize-PathForCompare $originPath
          $matchesTerminalExe = [string]::Equals(
            $originNormalized,
            $terminalPathNormalized,
            [System.StringComparison]::OrdinalIgnoreCase
          )
          $matchesInstallDir = [string]::Equals(
            $originNormalized,
            $terminalDirNormalized,
            [System.StringComparison]::OrdinalIgnoreCase
          )
          if ($matchesTerminalExe -or $matchesInstallDir) {
            $matches += $directory.FullName
          }
        } catch {}
      }
    }
    $matches = @($matches | Sort-Object -Unique)
    if ($matches.Count -ne 1) {
      throw "Could not resolve one MT5 data folder for $TerminalPath. Open MT5 > File > Open Data Folder and rerun with -DataPath '<that folder>'. Matches=$($matches.Count)"
    }
    $DataPath = $matches[0]
    Write-Host "PHASE7C_MT5_PANEL_DATA_PATH_AUTODETECT=PASS"
  }
}

if (-not [System.IO.Path]::IsPathRooted($DataPath)) {
  $DataPath = Join-Path $ProjectRoot $DataPath
}
if (-not (Test-Path -LiteralPath $DataPath)) { throw "MT5 data folder not found: $DataPath" }
$DataPath = (Resolve-Path -LiteralPath $DataPath).Path
Write-Host "PHASE7C_MT5_PANEL_DATA_PATH=$DataPath"

$ExpertDir = Join-Path $DataPath "MQL5\Experts\XAUUSD_AI_MASTER"
New-Item -ItemType Directory -Force -Path $ExpertDir | Out-Null
$Destination = Join-Path $ExpertDir "XAUUSD_AI_Master_Decision_Panel.mq5"
Copy-Item -LiteralPath $Source -Destination $Destination -Force

if (-not $SkipCompile) {
  $terminalDir = Split-Path -Parent $TerminalPath
  $MetaEditor = @(
    (Join-Path $terminalDir "MetaEditor64.exe"),
    (Join-Path $terminalDir "metaeditor64.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($MetaEditor)) {
    throw "MetaEditor64.exe was not found beside $TerminalPath. Rerun with -SkipCompile, then compile the panel EA manually."
  }
  $CompileLog = Join-Path $ExpertDir "XAUUSD_AI_Master_Decision_Panel.compile.log"
  $arguments = @(
    ('/compile:"{0}"' -f $Destination),
    ('/log:"{0}"' -f $CompileLog)
  )
  $compileStartedAt = (Get-Date).ToUniversalTime()
  $process = Start-Process -FilePath $MetaEditor -ArgumentList $arguments -Wait -PassThru
  $Compiled = [System.IO.Path]::ChangeExtension($Destination, ".ex5")
  $compiledFresh = (Test-Path -LiteralPath $Compiled) -and
    (Get-Item -LiteralPath $Compiled).LastWriteTimeUtc -ge $compileStartedAt.AddSeconds(-2)
  if (-not $compiledFresh) {
    $detail = if (Test-Path -LiteralPath $CompileLog) { (Get-Content -LiteralPath $CompileLog -Tail 80) -join [Environment]::NewLine } else { "compile log missing" }
    throw "MT5 panel EA compile failed. ExitCode=$($process.ExitCode)`n$detail"
  }
  Write-Host "PHASE7C_MT5_PANEL_COMPILE=PASS"
  Write-Host "PHASE7C_MT5_PANEL_EX5=$Compiled"
} else {
  Write-Host "PHASE7C_MT5_PANEL_COMPILE=SKIPPED"
}

try {
  $probe = Invoke-WebRequest -Uri $ApiUrl -UseBasicParsing -TimeoutSec 8
  if (
    $probe.StatusCode -ne 200 -or
    $probe.Content -notmatch '(?m)^version=2$' -or
    $probe.Content -notmatch '(?m)^accountMode=(DEMO|LIVE)$' -or
    $probe.Content -notmatch '(?m)^autoReason1=' -or
    $probe.Content -notmatch '(?m)^trendWaitReason1=' -or
    $probe.Content -notmatch '(?m)^sidewayWaitReason1=' -or
    $probe.Content -notmatch '(?m)^trendCheck1Status=' -or
    $probe.Content -notmatch '(?m)^trendCheck1Label=' -or
    $probe.Content -notmatch '(?m)^trendCheck1Actual=' -or
    $probe.Content -notmatch '(?m)^sidewayCheck1Status=' -or
    $probe.Content -notmatch '(?m)^sidewayCheck1Label=' -or
    $probe.Content -notmatch '(?m)^sidewayCheck1Actual=' -or
    $probe.Content -notmatch '(?m)^entryReason1=' -or
    $probe.Content -notmatch '(?m)^holdReason1=' -or
    $probe.Content -notmatch '(?m)^stopMoveReason1=' -or
    $probe.Content -notmatch '(?m)^partialReason1=' -or
    $probe.Content -notmatch '(?m)^exitReason1=' -or
    $probe.Content -notmatch '(?m)^mt5OrderPermission=NONE$'
  ) {
    throw "Decision endpoint synchronized semantic safety markers are missing."
  }
  Write-Host "PHASE7C_MT5_PANEL_API=PASS"
  Write-Host "PHASE7C_MT5_PANEL_SEMANTIC_SYNC=PASS"
} catch {
  Write-Warning "Decision endpoint is not ready yet: $($_.Exception.Message)"
  Write-Host "PHASE7C_MT5_PANEL_API=CHECK_AFTER_ACTIVATION"
}

Write-Host "PHASE7C_MT5_PANEL_INSTALL=PASS"
Write-Host "PHASE7C_MT5_PANEL_SOURCE=$Destination"
Write-Host "PHASE7C_MT5_PANEL_WEBREQUEST_ALLOW=http://127.0.0.1:3711"
Write-Host "PHASE7C_MT5_PANEL_API_URL=$ApiUrl"
Write-Host "PHASE7C_MT5_PANEL_CONTRACT=SEMANTIC_UI_V2"
Write-Host "PHASE7C_MT5_PANEL_ORDER_PERMISSION=NONE"
Write-Host "PHASE7C_MT5_PANEL_NEXT=MT5 Tools > Options > Expert Advisors > Allow WebRequest; add http://127.0.0.1:3711; then attach Expert Advisor XAUUSD_AI_MASTER\\XAUUSD_AI_Master_Decision_Panel to the XAUUSD chart."
