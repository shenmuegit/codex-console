import { mkdirSync, readdirSync, readFileSync, realpathSync, lstatSync, rmSync, constants } from 'node:fs';
import { mkdir, open, rename, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createHostFilesystem } from './host-filesystem.mjs';
import { ensureRemoteUploadStorage } from './remote-upload-storage.mjs';
import { collectTargets } from './transcript.mjs';
import { formatNativePath } from './public/composer.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(value);
const within = (path, root) => root === '/' || path === root || path.startsWith(root + sep);
const rasterMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function imageMime(head) {
  if (head.length >= 24 && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && head.readUInt32BE(16) && head.readUInt32BE(20)) return 'image/png';
  if (head.length >= 12 && head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  if (head.length >= 14 && ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString()) && head.readUInt16LE(6) && head.readUInt16LE(8)) return 'image/gif';
  if (head.length >= 20 && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
}
function validName(name) {
  return typeof name === 'string' && name.isWellFormed() && name.length > 0 && Buffer.byteLength(name) <= 255 && !['.', '..'].includes(name) && !/[\x00-\x1f\x7f/\\]/.test(name);
}
function targetPath(target, cwd, encoded) {
  try {
    if (/^file:/i.test(target)) return fileURLToPath(target);
    if (/^sandbox:\//i.test(target)) target = target.slice(8);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
    if (encoded) target = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    if (target.includes('\0')) return null;
    return resolve(cwd, target);
  } catch { return null; }
}

export function createFiles({ stateDir, uploadLimitBytes = 33_554_432, generatedRoots = [], remoteHost, codex }) {
  if (!Number.isSafeInteger(uploadLimitBytes) || uploadLimitBytes < 1 || uploadLimitBytes > 1_073_741_824) throw fail(500, 'INVALID_UPLOAD_LIMIT', '上传上限须在 1 字节到 1 GiB 之间。');
  const remoteFs = remoteHost ? createHostFilesystem(codex) : null;
  if (remoteFs) uploadLimitBytes = Math.min(uploadLimitBytes, 24_000_000);
  const hostHref = href => remoteHost ? href + '?host=' + encodeURIComponent(remoteHost.id) : href;
  mkdirSync(join(stateDir, 'uploads'), { recursive: true, mode: 0o700 });
  const root = realpathSync(join(stateDir, 'uploads')), uploads = new Map(), byPath = new Map(), refs = new Map(), refKeys = new Map();
  const generated = remoteFs ? [] : generatedRoots.map(path => { try { return realpathSync(path); } catch { return resolve(path); } });
  for (const id of readdirSync(root)) {
    if (!validId(id)) continue;
    try {
      const dir = join(root, id); if (lstatSync(dir).isSymbolicLink()) continue;
      const metaPath = join(dir, 'metadata.json'); if (lstatSync(metaPath).isSymbolicLink()) continue;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.status !== 'complete') { rmSync(dir, { recursive: true, force: true }); continue; }
      if (meta.id !== id || !validName(meta.name) || !/^content(?:\.[A-Za-z0-9_-]{1,16})?$/.test(meta.storedName)) continue;
      meta.dir = dir; meta.path = join(dir, meta.storedName); uploads.set(id, meta); byPath.set(meta.path, meta); if (meta.remotePath) byPath.set(meta.remotePath, meta);
    } catch { /* Incomplete/corrupt metadata cannot authorize a file reference. */ }
  }
  async function store(meta) {
    const temp = join(meta.dir, 'metadata.' + randomBytes(8).toString('hex'));
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(meta)); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(meta.dir, 'metadata.json'));
    const directory = await open(meta.dir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async function checkedFile(path, roots, pin) {
    let handle;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error();
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const actual = await realpath(`/proc/self/fd/${handle.fd}`), stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || !roots.some(root => within(actual, root)) ||
          (pin && (String(stat.dev) !== pin.dev || String(stat.ino) !== pin.ino))) throw new Error();
      const head = Buffer.alloc(64), { bytesRead } = await handle.read(head, 0, head.length, 0);
      return { handle, actual, stat, imageMime: imageMime(head.subarray(0, bytesRead)) };
    } catch {
      await handle?.close().catch(() => {});
      throw fail(409, 'UNSAFE_REFERENCE', '文件已变化或不在允许的目录中，请刷新会话。');
    }
  }
  async function issue(path, roots, name, target) {
    const opened = await checkedFile(path, roots);
    try {
      const known = byPath.get(opened.actual);
      if (within(opened.actual, root) && !known) throw fail(404, 'UNKNOWN_UPLOAD', '上传文件尚未完成。');
      if (known && (String(opened.stat.dev) !== known.dev || String(opened.stat.ino) !== known.ino)) throw fail(409, 'UNSAFE_REFERENCE', '上传文件已被替换。');
      const key = `${opened.actual}\0${opened.stat.dev}\0${opened.stat.ino}`, existing = refKeys.get(key);
      if (existing && refs.has(existing)) return { ...refs.get(existing).public, target };
      if (refs.size >= 4096) { const oldest = refs.keys().next().value; refKeys.delete(refs.get(oldest).key); refs.delete(oldest); }
      const id = randomBytes(24).toString('base64url');
      const publicRef = { id, name: known?.name ?? name ?? basename(opened.actual), href: hostHref(`/api/files/${id}`),
        ...(opened.imageMime ? { imageHref: hostHref(`/api/images/${id}`), imageMime: opened.imageMime } : {}) };
      refs.set(id, { key, path: opened.actual, roots, dev: String(opened.stat.dev), ino: String(opened.stat.ino), public: publicRef }); refKeys.set(key, id);
      return { ...publicRef, target };
    } finally { await opened.handle.close(); }
  }
  async function checkedRemote(path, roots, pin) {
    try {
      const actual = await remoteFs.checkedPath(path), metadata = await remoteFs.read('fs/getMetadata', { path: actual });
      if (remoteFs.paths().relative(path, actual) !== '' || !roots.some(root => remoteFs.within(actual, root)) || !metadata.isFile || metadata.isSymlink ||
          pin && (metadata.createdAtMs !== pin.createdAtMs || metadata.modifiedAtMs !== pin.modifiedAtMs)) throw new Error();
      return { actual, metadata };
    } catch { throw fail(409, 'UNSAFE_REFERENCE', '远端文件已变化或不在允许的目录中，请刷新会话。'); }
  }
  async function readRemote(path, prefixBytes) {
    const limit = prefixBytes ?? 24_000_000, prefix = prefixBytes !== undefined;
    const input = Buffer.from(JSON.stringify({ path, limit, prefix })).toString('base64');
    const unix = String.raw`import base64, json, os, stat, sys
p = json.loads(base64.b64decode(sys.argv[1]))
fd = os.open(p['path'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd, 'rb') as stream:
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode): raise RuntimeError('Not a regular file')
    if not p['prefix'] and info.st_size > p['limit']:
        print('FILE_TOO_LARGE'); sys.exit(2)
    data = stream.read(p['limit'] + 1)
    if not p['prefix'] and len(data) > p['limit']:
        print('FILE_TOO_LARGE'); sys.exit(2)
    print(json.dumps({'dataBase64': base64.b64encode(data[:p['limit']]).decode()}))
`;
    const windows = String.raw`$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INPUT__')) | ConvertFrom-Json
$item = Get-Item -LiteralPath $p.path -Force
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Not a regular file' }
$stream = [IO.File]::Open($p.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
    if (-not $p.prefix -and $stream.Length -gt $p.limit) { Write-Output 'FILE_TOO_LARGE'; exit 2 }
    [byte[]]$data = ([IO.BinaryReader]::new($stream)).ReadBytes($p.limit + 1)
    if ($null -eq $data) { $data = [byte[]]::new(0) }
    if (-not $p.prefix -and $data.Length -gt $p.limit) { Write-Output 'FILE_TOO_LARGE'; exit 2 }
    @{ dataBase64 = [Convert]::ToBase64String($data, 0, [Math]::Min($p.limit, $data.Length)) } | ConvertTo-Json -Compress
} finally { $stream.Dispose() }
`;
    const command = remoteFs.paths().sep === '\\' ? ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windows.replace('__INPUT__', input), 'utf16le').toString('base64')] : ['python3', '-c', unix, input];
    const { result } = await codex.rpc('command/exec', { command, cwd: remoteFs.paths().dirname(path), timeoutMs: 10_000, outputBytesCap: Math.ceil(limit / 3) * 4 + 1024 });
    if (result.exitCode === 2 && result.stdout.trim() === 'FILE_TOO_LARGE') throw fail(413, 'FILE_TOO_LARGE', '远端下载单文件上限为 24,000,000 字节，请在原主机获取此文件。');
    try {
      if (result.exitCode !== 0) throw new Error();
      const encoded = JSON.parse(result.stdout).dataBase64;
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(limit / 3) * 4) throw new Error();
      const data = Buffer.from(encoded, 'base64');
      if (data.length > limit || data.toString('base64') !== encoded) throw new Error();
      return data;
    } catch { throw fail(409, 'REMOTE_FILE_READ_FAILED', '远端文件读取失败。Unix 需要已安装 Python 3，Windows 需要系统 PowerShell；请检查文件权限和主机沙箱。'); }
  }
  async function issueRemote(path, roots, target) {
    const checked = await checkedRemote(path, roots), key = `remote\0${checked.actual}\0${checked.metadata.createdAtMs}\0${checked.metadata.modifiedAtMs}`;
    const existing = refKeys.get(key);
    if (existing && refs.has(existing)) return { ...refs.get(existing).public, target };
    const id = randomBytes(24).toString('base64url');
    if (refs.size >= 4096) { const oldest = refs.keys().next().value; refKeys.delete(refs.get(oldest).key); refs.delete(oldest); }
    const publicRef = { id, name: byPath.get(path)?.name ?? remoteFs.paths().basename(path), href: hostHref(`/api/files/${id}`) };
    // shortcut: native fs has no atomic no-follow read or inode, recheck scope/timestamps until those RPCs exist.
    const data = await readRemote(checked.actual, 64);
    await checkedRemote(path, roots, checked.metadata);
    const mime = imageMime(data.subarray(0, 64));
    if (mime) Object.assign(publicRef, { imageHref: hostHref(`/api/images/${id}`), imageMime: mime });
    refs.set(id, { remote: true, key, path: checked.actual, roots, ...checked.metadata, public: publicRef }); refKeys.set(key, id);
    return { ...publicRef, target };
  }
  async function transfer(meta, file) {
    const home = await remoteFs.directory(codex.info?.()?.codexHome), paths = remoteFs.paths();
    const base = paths.join(home, 'console-uploads');
    await ensureRemoteUploadStorage(codex, home);
    await remoteFs.directory(base);
    const directory = paths.join(base, meta.id), path = paths.join(directory, meta.storedName);
    const { entries: directories } = await remoteFs.read('fs/readDirectory', { path: base });
    const exists = directories.some(entry => entry.fileName === meta.id);
    if (meta.remotePath || meta.remoteTransferPath) {
      if ((meta.remotePath ?? meta.remoteTransferPath) !== path) throw fail(409, 'UNSAFE_REFERENCE', '远端上传目录已变化。');
    } else {
      if (exists) throw fail(409, 'UNSAFE_REFERENCE', '远端上传目录已存在。');
      // Persist ownership before the first mutation so an uncertain mkdir/write can be reconciled.
      meta.remoteTransferPath = path; await store(meta);
    }
    if (!exists) {
      if (meta.remotePath) throw fail(409, 'UNSAFE_REFERENCE', '远端附件已变化，请重新上传。');
      await remoteFs.read('fs/createDirectory', { path: directory, recursive: false });
    }
    if (paths.relative(directory, await remoteFs.directory(directory)) !== '' || !remoteFs.within(directory, home)) throw fail(409, 'UNSAFE_REFERENCE', '远端上传目录已变化。');
    const { entries } = await remoteFs.read('fs/readDirectory', { path: directory });
    if (entries.some(entry => entry.fileName !== meta.storedName) || entries.length > 1) throw fail(409, 'UNSAFE_REFERENCE', '远端附件目标已存在。');
    await ensureRemoteUploadStorage(codex, home, path, true);
    const expected = await file.handle.readFile();
    if (entries.length) {
      const checked = await checkedRemote(path, [directory]);
      const data = await readRemote(checked.actual);
      await checkedRemote(path, [directory], checked.metadata);
      if (!data.equals(expected)) throw fail(409, 'UNSAFE_REFERENCE', '远端附件已变化，请重新上传。');
    } else {
      if (meta.remotePath) throw fail(409, 'UNSAFE_REFERENCE', '远端附件已变化，请重新上传。');
      await remoteFs.read('fs/writeFile', { path, dataBase64: expected.toString('base64') });
      await checkedRemote(path, [directory]);
    }
    await ensureRemoteUploadStorage(codex, home, path);
    meta.remotePath = path; delete meta.remoteTransferPath; await store(meta); byPath.set(path, meta);
    return path;
  }
  async function describeUpload(id, threadId) {
    const meta = uploads.get(id);
    if (!meta) throw fail(404, 'UNKNOWN_UPLOAD', '上传标识不存在。');
    if (threadId != null && meta.threadId !== threadId) throw fail(403, 'UPLOAD_THREAD_MISMATCH', '附件属于其他会话。');
    if (meta.status !== 'complete') throw fail(409, 'UPLOAD_NOT_COMPLETE', '请等待附件上传完成。');
    const reference = await issue(meta.path, [root], meta.name);
    return { id, name: meta.name, size: meta.size, mime: meta.mime, status: 'complete', refId: reference.id,
      href: reference.href, ...(reference.imageHref ? { imageHref: reference.imageHref, imageMime: reference.imageMime } : {}) };
  }
  return {
    uploadLimitBytes,
    async beginUpload({ threadId, name, size, mime }) {
      if (!validName(name)) throw fail(400, 'INVALID_FILENAME', '文件名不能包含路径或控制字符。');
      if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || !Number.isSafeInteger(size) || size < 0 ||
          typeof mime !== 'string' || mime.length > 128 || /[\r\n\0]/.test(mime)) throw fail(400, 'INVALID_UPLOAD', '文件信息不正确。');
      if (size > uploadLimitBytes) throw fail(413, 'FILE_TOO_LARGE', `单文件上限为 ${uploadLimitBytes.toLocaleString()} 字节。`);
      const id = randomBytes(24).toString('base64url'), dir = join(root, id), ext = extname(name);
      const storedName = 'content' + (/^\.[A-Za-z0-9_-]{1,16}$/.test(ext) ? ext : '');
      const meta = { id, dir, path: join(dir, storedName), storedName, threadId, name, size, mime, status: 'pending', createdAt: Date.now() };
      try { await mkdir(dir, { mode: 0o700 }); await store(meta); uploads.set(id, meta); }
      catch (e) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw e.code === 'ENOSPC' ? fail(507, 'STORAGE_FULL', '磁盘空间不足，无法上传。') : e; }
      return { id, name, size, status: 'pending' };
    },
    async receiveUpload(id, readable) {
      const meta = uploads.get(id);
      if (!meta) throw fail(404, 'UNKNOWN_UPLOAD', '上传标识不存在。');
      if (meta.status !== 'pending' || meta.receiving) throw fail(409, 'UPLOAD_BUSY', '此上传已完成或正在接收。');
      meta.receiving = true; const partial = join(meta.dir, 'upload.part'); let handle, count = 0, head = Buffer.alloc(0);
      try {
        const declared = readable.headers?.['content-length'];
        if (declared != null && (!/^\d+$/.test(declared) || Number(declared) !== meta.size)) throw fail(400, 'UPLOAD_LENGTH_MISMATCH', '上传长度与文件信息不符。');
        handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        if (!within(await realpath(`/proc/self/fd/${handle.fd}`), root)) throw fail(409, 'UNSAFE_REFERENCE', '上传目录已变化。');
        for await (const value of readable.iterator({ destroyOnReturn: false })) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); count += chunk.length;
          if (count > uploadLimitBytes) throw fail(413, 'FILE_TOO_LARGE', '实际上传内容超过单文件上限。');
          if (count > meta.size) throw fail(400, 'UPLOAD_LENGTH_MISMATCH', '实际上传长度超过声明长度。');
          if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
          for (let offset = 0; offset < chunk.length;) { const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset); if (!bytesWritten) throw new Error('Short write'); offset += bytesWritten; }
        }
        if (count !== meta.size) throw fail(400, 'UPLOAD_LENGTH_MISMATCH', '上传未完成。');
        meta.imageMime = imageMime(head);
        if (rasterMimes.has(meta.mime) && !meta.imageMime) throw fail(415, 'INVALID_IMAGE', '照片格式无效，请选择 PNG、JPEG、WebP 或 GIF。');
        await handle.sync(); const stat = await handle.stat({ bigint: true }); await handle.close(); handle = null;
        await rename(partial, meta.path); meta.status = 'complete'; delete meta.receiving; meta.dev = String(stat.dev); meta.ino = String(stat.ino);
        await store(meta); byPath.set(meta.path, meta);
        return await describeUpload(id);
      } catch (e) {
        await handle?.close().catch(() => {}); uploads.delete(id); byPath.delete(meta.path); await rm(meta.dir, { recursive: true, force: true }).catch(() => {});
        if (e.code === 'ENOSPC') throw fail(507, 'STORAGE_FULL', '磁盘空间不足，草稿及已完成附件已保留。');
        throw e.status ? e : fail(400, 'UPLOAD_INTERRUPTED', '上传未完成，草稿及已完成附件已保留。');
      }
    },
    describeUpload,
    async attachmentInputs(ids, threadId) {
      if (!Array.isArray(ids) || ids.length > 256 || new Set(ids).size !== ids.length) throw fail(400, 'INVALID_UPLOAD_IDS', '附件标识不正确。');
      const input = [];
      for (const id of ids) {
        await describeUpload(id, threadId); const meta = uploads.get(id), file = await checkedFile(meta.path, [root], meta);
        let path;
        try {
          if (meta.imageMime && file.imageMime !== meta.imageMime) throw fail(409, 'UNSAFE_REFERENCE', '照片内容已变化，请重新上传。');
          path = remoteFs ? await transfer(meta, file) : meta.path;
        } finally { await file.handle.close(); }
        if (meta.imageMime) input.push({ type: 'localImage', path });
        else { const text = formatNativePath(path); input.push({ type: 'text', text,
          text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(text) }, placeholder: meta.name }] }); }
      }
      return input;
    },
    async issueTranscriptRefs(thread, turns) {
      const result = new Map(); let cwd, images;
      try { cwd = remoteFs ? await remoteFs.checkedPath(thread.cwd) : await realpath(thread.cwd); if (remoteFs ? remoteFs.paths().relative(thread.cwd, cwd) !== '' : cwd !== resolve(thread.cwd)) cwd = null; } catch {}
      try {
        const home = codex?.info?.()?.codexHome;
        if (home) {
          const path = remoteFs ? remoteFs.paths().join(home, 'generated_images') : join(home, 'generated_images');
          const actual = remoteFs ? await remoteFs.directory(path) : await realpath(path);
          if (remoteFs ? remoteFs.paths().relative(path, actual) === '' : actual === resolve(path)) images = actual;
        }
      } catch { /* Only the native host's existing, unchanged image directory is admitted. */ }
      const roots = [...(cwd ? [cwd] : []), ...(images ? [images] : []), ...(remoteFs ? [...uploads.values()].filter(meta => meta.remotePath).map(meta => remoteFs.paths().dirname(meta.remotePath)) : [...generated, root])];
      for (const turn of turns) for (const item of turn.items ?? []) {
        const candidates = collectTargets(item);
        if (item.type === 'userMessage') for (const part of item.content ?? []) {
          if (part.type === 'localImage') candidates.push({ target: part.path, encoded: false });
          if (part.type === 'text') {
            const path = part.text.startsWith('"') && part.text.endsWith('"') ? part.text.slice(1, -1) : part.text; if (byPath.has(path)) candidates.push({ target: path, encoded: false });
            for (const element of part.text_elements ?? []) {
              const raw = Buffer.from(part.text).subarray(element.byteRange.start, element.byteRange.end).toString('utf8');
              const path = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
              if (remoteFs ? remoteFs.valid(path) : path.startsWith('/')) candidates.push({ target: path, encoded: false });
            }
          }
        }
        const issued = [], seen = new Set();
        for (const candidate of candidates) {
          let path;
          if (remoteFs) {
            try {
              let target = candidate.target;
              if (/^file:/i.test(target)) { const url = new URL(target); if (url.hostname && url.hostname !== 'localhost') throw new Error(); target = decodeURIComponent(url.pathname); if (remoteFs.paths().sep === '\\' && /^\/[A-Za-z]:/.test(target)) target = target.slice(1); }
              else { if (/^sandbox:\//i.test(target)) target = target.slice(8); else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) throw new Error(); if (candidate.encoded) target = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
              if (target.includes('\0') || !cwd && !remoteFs.valid(target)) throw new Error();
              path = remoteFs.paths().resolve(cwd ?? remoteFs.paths().parse(target).root, target);
            } catch { continue; }
          } else path = targetPath(candidate.target, cwd ?? '/', candidate.encoded);
          if (!path || seen.has(path) || !roots.some(root => remoteFs ? remoteFs.within(path, root) : within(path, root))) continue;
          try { const ref = remoteFs ? await issueRemote(path, roots, candidate.target) : await issue(path, roots, undefined, candidate.target); issued.push(ref); seen.add(path); } catch { /* Unsafe/missing targets remain plain text. */ }
        }
        result.set(item.id, issued);
      }
      return result;
    },
    async openReference(id) {
      const ref = validId(id) && refs.get(id);
      if (!ref) throw fail(404, 'UNKNOWN_REFERENCE', '文件链接已失效，请重新打开会话。');
      if (ref.remote) {
        const checked = await checkedRemote(ref.path, ref.roots, ref);
        const data = await readRemote(checked.actual);
        await checkedRemote(ref.path, ref.roots, ref);
        return { name: ref.public.name, size: data.length, imageMime: imageMime(data.subarray(0, 64)), handle: { async close() {}, async readFile() { return data; }, createReadStream() { return Readable.from([data]); } } };
      }
      const file = await checkedFile(ref.path, ref.roots, ref);
      return { ...file, name: ref.public.name, size: Number(file.stat.size) };
    },
  };
}
