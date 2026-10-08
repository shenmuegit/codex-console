import { mkdirSync, readdirSync, readFileSync, realpathSync, lstatSync, rmSync, constants } from 'node:fs';
import { mkdir, open, rename, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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

export function createFiles({ stateDir, uploadLimitBytes = 33_554_432, generatedRoots = [] }) {
  if (!Number.isSafeInteger(uploadLimitBytes) || uploadLimitBytes < 1 || uploadLimitBytes > 1_073_741_824) throw fail(500, 'INVALID_UPLOAD_LIMIT', '上传上限须在 1 字节到 1 GiB 之间。');
  mkdirSync(join(stateDir, 'uploads'), { recursive: true, mode: 0o700 });
  const root = realpathSync(join(stateDir, 'uploads')), uploads = new Map(), byPath = new Map(), refs = new Map(), refKeys = new Map();
  const generated = generatedRoots.map(path => { try { return realpathSync(path); } catch { return resolve(path); } });
  for (const id of readdirSync(root)) {
    if (!validId(id)) continue;
    try {
      const dir = join(root, id); if (lstatSync(dir).isSymbolicLink()) continue;
      const metaPath = join(dir, 'metadata.json'); if (lstatSync(metaPath).isSymbolicLink()) continue;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.status !== 'complete') { rmSync(dir, { recursive: true, force: true }); continue; }
      if (meta.id !== id || !validName(meta.name) || !/^content(?:\.[A-Za-z0-9_-]{1,16})?$/.test(meta.storedName)) continue;
      meta.dir = dir; meta.path = join(dir, meta.storedName); uploads.set(id, meta); byPath.set(meta.path, meta);
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
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
      const publicRef = { id, name: known?.name ?? name ?? basename(opened.actual), href: `/api/files/${id}`,
        ...(opened.imageMime ? { imageHref: `/api/images/${id}`, imageMime: opened.imageMime } : {}) };
      refs.set(id, { key, path: opened.actual, roots, dev: String(opened.stat.dev), ino: String(opened.stat.ino), public: publicRef }); refKeys.set(key, id);
      return { ...publicRef, target };
    } finally { await opened.handle.close(); }
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
        await file.handle.close();
        if (meta.imageMime && file.imageMime !== meta.imageMime) throw fail(409, 'UNSAFE_REFERENCE', '照片内容已变化，请重新上传。');
        if (meta.imageMime) input.push({ type: 'localImage', path: meta.path });
        else { const text = formatNativePath(meta.path); input.push({ type: 'text', text,
          text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(text) }, placeholder: meta.name }] }); }
      }
      return input;
    },
    async issueTranscriptRefs(thread, turns) {
      const result = new Map(); let cwd;
      try { cwd = await realpath(thread.cwd); if (cwd !== resolve(thread.cwd)) cwd = null; } catch {}
      const roots = [...(cwd ? [cwd] : []), ...generated, root];
      for (const turn of turns) for (const item of turn.items ?? []) {
        const candidates = collectTargets(item);
        if (item.type === 'userMessage') for (const part of item.content ?? []) {
          if (part.type === 'localImage') candidates.push({ target: part.path, encoded: false });
          if (part.type === 'text') { const path = part.text.startsWith('"') && part.text.endsWith('"') ? part.text.slice(1, -1) : part.text; if (byPath.has(path)) candidates.push({ target: path, encoded: false }); }
        }
        const issued = [], seen = new Set();
        for (const candidate of candidates) {
          const path = targetPath(candidate.target, cwd ?? '/', candidate.encoded);
          if (!path || seen.has(path) || !roots.some(root => within(path, root))) continue;
          try { const ref = await issue(path, roots, undefined, candidate.target); issued.push(ref); seen.add(path); } catch { /* Unsafe/missing targets remain plain text. */ }
        }
        result.set(item.id, issued);
      }
      return result;
    },
    async openReference(id) {
      const ref = validId(id) && refs.get(id);
      if (!ref) throw fail(404, 'UNKNOWN_REFERENCE', '文件链接已失效，请重新打开会话。');
      const file = await checkedFile(ref.path, ref.roots, ref);
      return { ...file, name: ref.public.name, size: Number(file.stat.size) };
    },
  };
}
