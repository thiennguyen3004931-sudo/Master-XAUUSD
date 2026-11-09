# Synthetic-only Windows runner fixture. NEVER use against a real customer directory.
# The only ACL modifications this helper can make are under a tightly named
# temporary directory created by a test. It does not read any key file content.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$InjectEveryone
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$stage = 'WINDOWS'
try {
if ($env:OS -ne 'Windows_NT') { throw 'SYNTHETIC_ACL_WINDOWS_ONLY' }
$stage = 'GUARD'

$rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\','/'))
$tempFull = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]@('\','/'))
$leaf = Split-Path -Path $rootFull -Leaf
$parent = Split-Path -Path $rootFull -Parent
if ($parent -ine $tempFull -or $leaf -notmatch '^xauusd-offline-positive-[A-Za-z0-9]+$') {
  throw 'SYNTHETIC_ACL_FIXTURE_ROOT_REQUIRED'
}

$keys = Join-Path $rootFull 'keys'
$dpapi = Join-Path $keys 'installation-private.dpapi'
$public = Join-Path $keys 'installation-public.txt'
$installationId = Join-Path $keys 'installation-id.txt'
$stage = 'FIXTURE_FILES'
foreach ($itemPath in @($rootFull, $keys, $dpapi, $public, $installationId)) {
  $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'SYNTHETIC_ACL_REPARSE_PATH_FORBIDDEN'
  }
}
if (-not (Get-Item -LiteralPath $keys).PSIsContainer -or
    (Get-Item -LiteralPath $dpapi).PSIsContainer -or
    (Get-Item -LiteralPath $public).PSIsContainer -or
    (Get-Item -LiteralPath $installationId).PSIsContainer) {
  throw 'SYNTHETIC_ACL_FIXTURE_SHAPE_INVALID'
}

$stage = 'CURRENT_USER_SID'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $currentSid -or [string]::IsNullOrWhiteSpace($currentSid.Value)) {
  throw 'SYNTHETIC_ACL_CURRENT_USER_MISSING'
}

# All four fixture resources must remain readable by the same synthetic runner
# identity. Resetting inheritance on the keys directory while omitting the
# two metadata files can leave their inherited DACLs inaccessible to Node.
# These are NEW temporary test files only, never production customer files.
# Only the *test fixture*, never the customer CLI, may mutate ACLs.
# Use the standard Windows native ACL utility because SetAccessControl()
# throws on our self-hosted test runner; all output is suppressed.
$stage = 'ACL_TOOL'
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
if (-not [System.IO.File]::Exists($icacls)) {
  throw 'SYNTHETIC_ACL_TOOL_UNAVAILABLE'
}
$full = @(
  ('*' + $currentSid.Value + ':(F)'),
  '*S-1-5-18:(F)',
  '*S-1-5-32-544:(F)'
)

foreach ($itemPath in @($keys, $dpapi, $public, $installationId)) {
  # A fresh temp fixture is owned by the current user. Refuse a foreign
  # owner instead of taking ownership or changing any other user's files.
  $stage = 'ACL_GET'
  $item = if ($itemPath -eq $keys) {
    [System.IO.DirectoryInfo]::new($itemPath)
  } else {
    [System.IO.FileInfo]::new($itemPath)
  }
  # PowerShell 7/.NET surfaces NTFS access via static extension methods.
  # PowerShell 5.1/.NET Framework uses instance GetAccessControl().
  $stage = 'ACL_TYPE_CHECK'
  $extensions = [System.Type]::GetType(
    'System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl', $false
  )
  if ($null -ne $extensions) {
    $stage = 'ACL_EXTENSION_READ'
    if ($itemPath -eq $keys) {
      $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]$item)
    } else {
      $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]$item)
    }
  } else {
    $stage = 'ACL_INSTANCE_READ'
    $acl = $item.GetAccessControl()
  }
  $stage = 'ACL_OWNER_CHECK'
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  # Default Windows administrative tokens can assign newly-created TEMP files
  # to built-in Administrators; production's conservative policy ALREADY
  # permits current user or this specific built-in owner (S-1-5-32-544).
  if ($ownerSid -cne $currentSid.Value -and $ownerSid -cne 'S-1-5-32-544') {
    throw 'SYNTHETIC_ACL_FOREIGN_OWNER'
  }

  $stage = 'ACL_RESET'
  & $icacls $itemPath '/reset' 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_ACL_RESET_FAILED' }

  $stage = 'ACL_NO_INHERITANCE'
  & $icacls $itemPath '/inheritance:r' 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_ACL_INHERITANCE_FAILED' }

  $stage = 'ACL_GRANT'
  & $icacls $itemPath '/grant:r' $full[0] $full[1] $full[2] 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_ACL_GRANT_FAILED' }

  if ($InjectEveryone.IsPresent -and $itemPath -eq $dpapi) {
    $stage = 'ACL_EVERYONE'
    & $icacls $itemPath '/grant' '*S-1-1-0:(R)' 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_ACL_EVERYONE_FAILED' }
  }

  # Immediate readback is mandatory; the production checker performs the
  # strict SID and inheritance assertions later in the end-to-end test.
  $stage = 'ACL_READBACK'
  if ($null -ne $extensions) {
    if ($itemPath -eq $keys) {
      $after = [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]$item)
    } else {
      $after = [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]$item)
    }
  } else {
    $after = $item.GetAccessControl()
  }
  if (-not $after.AreAccessRulesProtected) {
    throw 'SYNTHETIC_ACL_INHERITANCE_NOT_REMOVED'
  }
}
Write-Output 'SYNTHETIC_TEMP_ONLY_ACL_FIXTURE=PASS'
} catch {
  # Stage-only sanitized diagnostics: no absolute paths, account SIDs or Windows errors.
  [Console]::Error.WriteLine('SYNTHETIC_ACL_FIXTURE_BLOCKED_STAGE=' + $stage)
  # Diagnostic enumeration ONLY, never raw exception messages: PowerShell
  # exception text can contain the local Windows account or absolute path.
  $category = [string]$_.CategoryInfo.Category
  if ($category -cnotin @('ObjectNotFound','PermissionDenied','InvalidOperation','SecurityError','ResourceUnavailable','MetadataError','InvalidArgument','NotSpecified','ParserError')) { $category = 'OTHER' }
  $type = $_.Exception.GetType().Name
  if ($type -cnotin @('CommandNotFoundException','UnauthorizedAccessException','ItemNotFoundException','FileNotFoundException','DirectoryNotFoundException','ArgumentException','InvalidOperationException','MethodInvocationException','RuntimeException','SecurityException','NotSupportedException','IOException','ProviderInvocationException','PSInvalidOperationException')) { $type = 'OTHER' }
  [Console]::Error.WriteLine('SYNTHETIC_ACL_FIXTURE_BLOCKED_CATEGORY=' + $category)
  [Console]::Error.WriteLine('SYNTHETIC_ACL_FIXTURE_BLOCKED_EXCEPTION_TYPE=' + $type)
  exit 2
}