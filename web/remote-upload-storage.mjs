const marker = 'codex-console-private-v1';
const unix = String.raw`import os, stat, sys
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
uid = os.geteuid()
fd = os.open('/', flags)
try:
    for name in sys.argv[1].split('/'):
        if not name: continue
        child = os.open(name, flags, dir_fd=fd)
        os.close(fd); fd = child
        info = os.fstat(fd)
        if info.st_uid not in (0, uid) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise RuntimeError('Unsafe storage ancestor')
    try: os.mkdir('console-uploads', 0o700, dir_fd=fd)
    except FileExistsError: pass
    child = os.open('console-uploads', flags, dir_fd=fd)
    os.close(fd); fd = child
    info = os.fstat(fd)
    if info.st_uid != uid or info.st_mode & 0o077:
        raise RuntimeError('Storage must be owned by this user and private (0700)')
    if len(sys.argv) > 2:
        parts = os.path.relpath(sys.argv[2], sys.argv[1]).split('/')
        if len(parts) != 3 or parts[0] != 'console-uploads' or '..' in parts:
            raise RuntimeError('Unexpected attachment path')
        child = os.open(parts[1], flags, dir_fd=fd)
        os.close(fd); fd = child
        child = os.open(parts[2], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        os.close(fd); fd = child
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1:
            raise RuntimeError('Attachment owner/type/link count is unsafe')
    print('codex-console-private-v1')
finally:
    os.close(fd)
`;

const windows = String.raw`$ErrorActionPreference = 'Stop'
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INPUT__')) | ConvertFrom-Json
$homePath = $inputData.home
$basePath = [IO.Path]::Combine($homePath, 'console-uploads')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
function Get-Security($path) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }
  return Get-Acl -LiteralPath $path
}
function Assert-Private($path) {
  $acl = Get-Security $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Storage owner mismatch' }
  $ownerAccess = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'Storage allows another principal' }
      if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $ownerAccess = $true }
    }
  }
  if (-not $ownerAccess) { throw 'Storage owner access missing' }
  return $acl
}
$ancestor = [IO.DirectoryInfo]::new($homePath)
while ($null -ne $ancestor) {
  $acl = Get-Security $ancestor.FullName
  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Untrusted ancestor owner' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)) -ne 0) { throw 'Writable storage ancestor' }
  }
  $ancestor = $ancestor.Parent
}
if (-not [IO.Directory]::Exists($basePath)) {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  ([IO.DirectoryInfo]::new($basePath)).Create($security)
}
$baseAcl = Assert-Private $basePath
if (-not $baseAcl.AreAccessRulesProtected) { throw 'Storage DACL must be protected' }
if ($inputData.path) {
  $directory = [IO.Path]::GetDirectoryName($inputData.path)
  if ([IO.Path]::GetDirectoryName($directory) -ne $basePath) { throw 'Unexpected attachment path' }
  $null = Assert-Private $directory
  $null = Assert-Private $inputData.path
}
Write-Output 'codex-console-private-v1'
`;

/** Fixed permission preparation only; inherit native sandbox and never install host runtimes. */
export async function ensureRemoteUploadStorage(codex, home, path) {
  try {
    const family = codex.info?.()?.platformFamily;
    let command;
    if (family === 'unix') command = ['python3', '-c', unix, home, ...(path ? [path] : [])];
    else if (family === 'windows') {
      const input = Buffer.from(JSON.stringify({ home, path })).toString('base64');
      command = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windows.replace('__INPUT__', input), 'utf16le').toString('base64')];
    } else throw new Error('Unsupported platform');
    const { result } = await codex.rpc('command/exec', { command, cwd: home, timeoutMs: 10_000, outputBytesCap: 1024 });
    if (result.exitCode !== 0 || result.stdout.trim() !== marker) throw new Error('Private storage verification failed');
  } catch {
    throw Object.assign(new Error('无法核验远端附件私有存储。Unix 需要已安装 Python 3，Windows 需要系统 PowerShell；主机现有沙箱必须允许准备和检查目录，且目录权限必须私有。传输已暂停，草稿和服务器暂存已保留。'), { status: 409, code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  }
}
