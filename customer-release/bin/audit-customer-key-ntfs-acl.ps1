# Read-only Windows installation DPAPI key NTFS ACL advisory.
# This CLI never changes ACL, reads private key bytes or touches MT5.
param(
  [string]$InstallationRoot = "."
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
  $root = [System.IO.Path]::GetFullPath($InstallationRoot)
  $keys = Join-Path $root 'keys'
  $privateFile = Join-Path $keys 'installation-private.dpapi'
  $legacyFile = Join-Path $keys 'installation-private.pem'
  if ((Test-Path -LiteralPath $legacyFile) -or
      -not (Test-Path -LiteralPath $keys) -or
      -not (Test-Path -LiteralPath $privateFile)) {
    throw 'KEY_MISSING_OR_LEGACY_PRESENT'
  }
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  . (Join-Path $scriptDir 'customer-key-ntfs-acl-policy.ps1')
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $dirSafe = Test-CustomerKeyAclPath -Path $keys -CurrentUserSid $currentSid -ExpectDirectory $true
  $fileSafe = Test-CustomerKeyAclPath -Path $privateFile -CurrentUserSid $currentSid -ExpectDirectory $false
  if (-not $dirSafe -or -not $fileSafe) { throw 'ACL_RULES_NOT_PROVEN' }
  Write-Output 'CUSTOMER_DPAPI_KEY_ACL_CONSERVATIVE_PREFLIGHT=PASS'
  Write-Output 'CUSTOMER_DPAPI_KEY_ACL_EFFECTIVE_HOST_ACCEPTANCE=NOT_VERIFIED'
  Write-Output 'CUSTOMER_RELEASE_APPROVAL=NOT_VERIFIED'
  Write-Output 'CUSTOMER_PRIVATE_KEY_BYTES_READ=NO'
  Write-Output 'CUSTOMER_ACL_MODIFICATIONS=NONE'
  exit 0
} catch {
  # Do not leak local paths, user identifiers or key material into workflow logs.
  [Console]::Error.WriteLine('CUSTOMER_DPAPI_KEY_ACL_CONSERVATIVE_PREFLIGHT=BLOCKED')
  [Console]::Error.WriteLine('CUSTOMER_ACL_MODIFICATIONS=NONE')
  exit 2
}
