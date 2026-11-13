$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot '..\customer-release\bin\customer-key-ntfs-acl-policy.ps1'
. $module

$me = 'S-1-5-21-111-222-333-1000'
$goodRules = @(
  [pscustomobject]@{ Sid=$me; Type='Allow'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::FullControl; Inherited=$false },
  [pscustomobject]@{ Sid='S-1-5-18'; Type='Allow'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::FullControl; Inherited=$false },
  [pscustomobject]@{ Sid='S-1-5-32-544'; Type='Allow'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::FullControl; Inherited=$false }
)

function Assert-AclPolicy {
  param(
    [string]$Name,
    [bool]$Expected,
    [string]$Owner=$me,
    [bool]$Protected=$true,
    [object[]]$Rules=$goodRules
  )
  $result = [bool](Test-CustomerKeyAclRuleSet -OwnerSid $Owner -CurrentUserSid $me -InheritanceProtected $Protected -Rules $Rules)
  if ($result -ne $Expected) { throw "ACL_TEST_FAILED=$Name" }
}
Assert-AclPolicy -Name 'allow-listed-sids' -Expected $true
Assert-AclPolicy -Name 'admins-own-safe-key' -Expected $true -Owner 'S-1-5-32-544'
Assert-AclPolicy -Name 'inherited-insecure' -Expected $false -Protected $false
Assert-AclPolicy -Name 'unknown-owner' -Expected $false -Owner 'S-1-5-21-999-888-777-500'
foreach ($sid in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-7', 'S-1-5-4')) {
  $bad = @($goodRules) + @([pscustomobject]@{
    Sid=$sid; Type='Allow'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::ReadData; Inherited=$false
  })
  Assert-AclPolicy -Name "broad-principal-$sid" -Expected $false -Rules $bad
}
$inherited = @($goodRules[0], $goodRules[1]) + @([pscustomobject]@{
  Sid='S-1-5-32-544'; Type='Allow'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::FullControl; Inherited=$true
})
Assert-AclPolicy -Name 'inherited-entry' -Expected $false -Rules $inherited
$deny = @($goodRules) + @([pscustomobject]@{
  Sid=$me; Type='Deny'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::ReadData; Inherited=$false
})
Assert-AclPolicy -Name 'deny-owner' -Expected $false -Rules $deny
$onlyOther = @($goodRules[1], $goodRules[2])
Assert-AclPolicy -Name 'missing-current-user-read' -Expected $false -Rules $onlyOther
$noRead = @([pscustomobject]@{
  Sid=$me; Type='Allow'; Rights=[int64][System.Security.AccessControl.FileSystemRights]::WriteData; Inherited=$false
})
Assert-AclPolicy -Name 'write-only-is-not-read' -Expected $false -Rules $noRead

$policySource = Get-Content -LiteralPath $module -Raw
if ($policySource -notmatch 'DirectoryInfo' -or
    $policySource -notmatch 'FileInfo' -or
    $policySource -notmatch '\.GetAccessControl\(' -or
    $policySource -match '\bGet-Acl\s+-LiteralPath|\.SetAccessControl\(|\bSet-Acl\b') {
  throw 'NTFS_POLICY_READ_ONLY_NATIVE_API_CONTRACT_FAILED'
}

$cli = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\customer-release\bin\audit-customer-key-ntfs-acl.ps1') -Raw
if ($cli -notmatch 'CUSTOMER_RELEASE_APPROVAL=NOT_VERIFIED' -or
    $cli -notmatch 'CUSTOMER_ACL_MODIFICATIONS=NONE' -or
    $cli -match 'Set-Acl|icacls\s+[^\r\n]+/grant|Remove-Item|Set-Content|WriteAllBytes') {
  throw 'AUDIT_CLI_SAFETY_BOUNDARY_FAILED'
}
Write-Host 'CUSTOMER_KEY_ACL_SYNTHETIC_REGRESSION=PASS'
Write-Host 'CUSTOMER_REAL_HOST_ACL_ACCEPTANCE=NOT_VERIFIED'
Write-Host 'CUSTOMER_PRODUCTION_MUTATION=NONE'
