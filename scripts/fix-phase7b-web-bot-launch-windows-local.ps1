param(
  [switch]$SkipRefresh
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Route = Join-Path $Root "apps\api\src\routes\phase7b-ops.route.ts"
if (-not (Test-Path $Route)) { throw "Missing Phase 7B ops route: $Route" }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($Route)

$startMarker = 'function launchPowerShellLogged(script: string, args: string[], logPath: string): number {'
$endMarker = 'async function waitForBotRuntime('
$start = $text.IndexOf($startMarker)
$end = $text.IndexOf($endMarker)
if ($start -lt 0 -or $end -le $start) {
  throw "Cannot locate launchPowerShellLogged block in Phase 7B ops route."
}

$newBlock = @'
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function launchPowerShellLogged(script: string, args: string[], logPath: string): number {
  // Windows PowerShell 5.1 + detached Node spawn can lose inherited file
  // descriptors. Use a tiny PowerShell launcher that owns the redirection
  // itself, so stdout/stderr are always captured and the API can diagnose a
  // failed controller start instead of returning a false success.
  const launcherPath = path.join(
    path.dirname(logPath),
    `phase7b-web-launch-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`,
  );
  const argText = args.map(psSingleQuote).join(" ");
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${psSingleQuote(script)}`,
    `$log = ${psSingleQuote(logPath)}`,
    "try {",
    `  & $target ${argText} *>> $log`,
    "  $code = $LASTEXITCODE",
    "  if ($null -eq $code) { $code = 0 }",
    "  Add-Content -LiteralPath $log -Value (\"PHASE7B_WEB_LAUNCH_EXIT=\" + $code)",
    "  exit $code",
    "} catch {",
    "  ($_ | Out-String) | Add-Content -LiteralPath $log",
    "  Add-Content -LiteralPath $log -Value 'PHASE7B_WEB_LAUNCH_EXIT=1'",
    "  exit 1",
    "}",
  ].join("\r\n");
  fs.writeFileSync(launcherPath, launcher, "utf8");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
  child.unref();
  return child.pid ?? 0;
}

'@

$text = $text.Substring(0, $start) + $newBlock + $text.Substring($end)
[System.IO.File]::WriteAllText($Route, $text, $Utf8NoBom)

$verify = [System.IO.File]::ReadAllText($Route)
foreach ($token in @(
  'function psSingleQuote',
  'phase7b-web-launch-',
  'PHASE7B_WEB_LAUNCH_EXIT=',
  'stdio: "ignore"'
)) {
  if (-not $verify.Contains($token)) { throw "Launch fix verification failed: missing $token" }
}

Write-Host "PHASE7B_WEB_BOT_LAUNCH_FIX=PASS"
Write-Host "PHASE7B_WEB_BOT_LAUNCH_MODE=POWERSHELL_SELF_REDIRECT"
Write-Host "PHASE7B_WEB_BOT_LAUNCH_STDIO=NO_INHERITED_FD"
Write-Host "PHASE7B_WEB_BOT_START_VERIFICATION=RUNTIME_PID_AND_HEARTBEAT"
Write-Host "PHASE7B_WEB_BOT_REAL_ACCOUNT_ALLOWED=False"

Push-Location $Root
try {
  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed after web bot launch fix: $LASTEXITCODE" }
} finally {
  Pop-Location
}
Write-Host "PHASE7B_WEB_BOT_LAUNCH_BUILD=PASS"

if (-not $SkipRefresh) {
  $refresh = Join-Path $PSScriptRoot "refresh-phase7b-demo-console-local.ps1"
  if (-not (Test-Path $refresh)) { throw "Missing console refresh helper: $refresh" }
  & $refresh
}
