# Read-only conservative NTFS ACL policy for customer installation key material.
# This is an *advisory preflight*, NOT a complete effective-permissions proof.
# No filesystem ACLs are modified by any function in this file.
function Test-CustomerKeyAclRuleSet {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$OwnerSid,
    [Parameter(Mandatory = $true)][string]$CurrentUserSid,
    [Parameter(Mandatory = $true)][bool]$InheritanceProtected,
    [Parameter(Mandatory = $true)][object[]]$Rules
  )

  if (-not $InheritanceProtected) { return $false }
  if ($OwnerSid -cne $CurrentUserSid -and $OwnerSid -cne 'S-1-5-32-544') {
    return $false
  }

  # Only the current user, SYSTEM and built-in Administrators may have any
  # explicit allow grants. Unknown, inherited or translated broad groups
  # cause a conservative fail-closed result.
  $allowedSids = @($CurrentUserSid, 'S-1-5-18', 'S-1-5-32-544')
  $sawUserRead = $false
  foreach ($entry in $Rules) {
    if ($null -eq $entry) { return $false }
    $sid = [string]$entry.Sid
    $type = [string]$entry.Type
    $rights = [int64]$entry.Rights
    if ($entry.Inherited -eq $true -or [string]::IsNullOrWhiteSpace($sid)) {
      return $false
    }
    if ($type -ceq 'Allow') {
      if ($sid -cnotin $allowedSids) { return $false }
      if ($sid -ceq $CurrentUserSid -and
          (($rights -band [int64][System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0)) {
        $sawUserRead = $true
      }
    } elseif ($type -ceq 'Deny') {
      # Denial applying to this user might block recovery/activation.
      if ($sid -ceq $CurrentUserSid -or $sid -ceq 'S-1-1-0' -or $sid -ceq 'S-1-5-11') {
        return $false
      }
    } else {
      return $false
    }
  }
  return $sawUserRead
}

# Windows PowerShell 5.1 exposes instance methods; some PowerShell 7/.NET
# installations expose the same NTFS APIs only as FileSystemAclExtensions.
# Never fall back to textual ACL parsing or permissive acceptance.
function Get-CustomerNtfsSecurityDescriptor {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Item)
  $extensions = [System.Type]::GetType(
    'System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl', $false
  )
  if ($null -ne $extensions) {
    if ($Item -is [System.IO.DirectoryInfo]) {
      return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]$Item)
    }
    if ($Item -is [System.IO.FileInfo]) {
      return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]$Item)
    }
    throw 'CUSTOMER_NTFS_ACL_TYPE_UNSUPPORTED'
  }
  # No extension type on older .NET Framework: native instance methods.
  return $Item.GetAccessControl()
}

function Test-CustomerKeyAclPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$CurrentUserSid,
    [Parameter(Mandatory = $true)][bool]$ExpectDirectory
  )
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  if ([bool]$item.PSIsContainer -ne $ExpectDirectory) { return $false }

  # Read NTFS security via Windows PowerShell 5.1 / .NET Framework APIs.
  # Get-Acl may not be discoverable on minimal/self-hosted runners; there is
  # NO permissive fallback. Any .NET permission/read error fails closed.
  $ntfsItem = if ($ExpectDirectory) {
    [System.IO.DirectoryInfo]::new([System.IO.Path]::GetFullPath($Path))
  } else {
    [System.IO.FileInfo]::new([System.IO.Path]::GetFullPath($Path))
  }
  $acl = Get-CustomerNtfsSecurityDescriptor -Item $ntfsItem
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
    ForEach-Object {
      [pscustomobject]@{
        Sid = $_.IdentityReference.Value
        Type = $_.AccessControlType.ToString()
        Rights = [int64]$_.FileSystemRights
        Inherited = [bool]$_.IsInherited
      }
    })
  return Test-CustomerKeyAclRuleSet -OwnerSid $ownerSid -CurrentUserSid $CurrentUserSid `
    -InheritanceProtected ([bool]$acl.AreAccessRulesProtected) -Rules $rules
}
