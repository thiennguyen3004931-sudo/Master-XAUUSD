# TEST-ONLY read-only NTFS policy probe for synthetic Windows TEMP fixture.
# No raw exception text, key contents, paths, SIDs or account names emitted.
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
try {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_ONLY' }
  $r = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\','/'))
  $t = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]@('\','/'))
  if ((Split-Path -Path $r -Parent) -ine $t -or
      (Split-Path -Path $r -Leaf) -notmatch '^xauusd-offline-positive-[A-Za-z0-9]+$') {
    throw 'SYNTHETIC_TEMP_ONLY'
  }
  $dir = Join-Path $r 'keys'
  $file = Join-Path $dir 'installation-private.dpapi'
  foreach ($p in @($r, $dir, $file)) {
    $f = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    if (($f.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'SYNTHETIC_REPARSE_REJECTED'
    }
  }
  . (Join-Path $PSScriptRoot '..\customer-release\bin\customer-key-ntfs-acl-policy.ps1')
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $safeDir = $false
  $safeFile = $false
  try {
    $safeDir = [bool](Test-CustomerKeyAclPath -Path $dir -CurrentUserSid $current -ExpectDirectory $true)
  } catch { $safeDir = $false }
  try {
    $safeFile = [bool](Test-CustomerKeyAclPath -Path $file -CurrentUserSid $current -ExpectDirectory $false)
  } catch { $safeFile = $false }
  Write-Output ('SYNTHETIC_ACL_DIRECTORY=' + $(if ($safeDir) { 'PASS' } else { 'BLOCKED' }))
  Write-Output ('SYNTHETIC_ACL_PRIVATE_FILE=' + $(if ($safeFile) { 'PASS' } else { 'BLOCKED' }))
  exit 0
} catch {
  Write-Output 'SYNTHETIC_ACL_DIRECTORY=UNKNOWN'
  Write-Output 'SYNTHETIC_ACL_PRIVATE_FILE=UNKNOWN'
  exit 2
}