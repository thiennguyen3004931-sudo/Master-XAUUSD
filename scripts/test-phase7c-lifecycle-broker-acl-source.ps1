$ErrorActionPreference = "Stop"

$Register = Join-Path $PSScriptRoot "register-phase7c-executor-task-local.ps1"
function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}
function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) { throw "PowerShell syntax error in ${Path}: $($errors[0].Message)" }
}

Assert-True (Test-Path -LiteralPath $Register) "Missing lifecycle broker installer: $Register"
Assert-PowerShellSyntax $Register
$text = Get-Content -LiteralPath $Register -Raw

Assert-True ($text -match 'ApiUserSid') "installer must require/configure the Web/API Windows user SID"
Assert-True ($text -match 'phase7c-lifecycle-broker') "installer must own the dedicated broker directory"
foreach ($token in @('inbox', 'state', 'results', 'logs')) {
  Assert-True ($text -match $token) "installer must configure broker directory: $token"
}
Assert-True ($text -match 'SecurityIdentifier') "installer must validate SID values"
Assert-True ($text -match 'SetAccessRuleProtection') "installer must protect broker ACLs from broad inherited writes"
Assert-True ($text -match 'FileSystemAccessRule') "installer must create explicit filesystem ACL rules"
Assert-True ($text -match 'FullControl') "SYSTEM/Administrators must retain Full Control"
Assert-True ($text -match 'Modify') "Web/API SID must receive Modify on inbox"
Assert-True ($text -match 'ReadAndExecute|Read') "Web/API SID must receive read-only state/result/log access"
Assert-True ($text -match 'api-user-sid\.txt') "installer must record configured API SID for capability checks"
Assert-True ($text -match 'heartbeat\.json') "installer must verify broker heartbeat after registration/migration"
Assert-True ($text -match 'Start-ScheduledTask') "installer must start the canonical SYSTEM broker task for post-install verification"
Assert-True ($text -match '(?i)SYSTEM') "canonical Scheduled Task must remain SYSTEM"
Assert-True ($text -match '(?i)ServiceAccount') "canonical Scheduled Task must use ServiceAccount logon semantics"
Assert-True ($text -match 'RunLevel\s+Highest') "canonical Scheduled Task must remain Highest"
Assert-True ($text -match 'New-ScheduledTaskTrigger\s+-AtStartup') "canonical Scheduled Task must remain AtStartup"
Assert-True (-not ($text -match '(?is)(Authenticated Users|BUILTIN\\Users).*?(Modify|FullControl)')) "generic users must not receive broker write access"

Write-Host "PHASE7C_LIFECYCLE_BROKER_ACL_SOURCE_TEST=PASS"
