import { posix, win32 } from 'node:path';

export const absoluteHostPath = value => typeof value === 'string' && value.length <= 8192 && !/[\x00-\x1f]/.test(value) &&
  (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) && !value.split(/[\\/]/).includes('..');

/** Path operations must use the selected native host, never the server platform. */
export function createHostFilesystem(codex) {
  const fail = () => Object.assign(new Error('远端路径不可用或已变化。'), { status: 409, code: 'UNSAFE_REFERENCE' });
  const paths = () => {
    const family = codex.info?.()?.platformFamily;
    if (family === 'windows') return win32;
    if (family === 'unix') return posix;
    throw fail();
  };
  const valid = path => absoluteHostPath(path) && (paths() === win32 ? /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path) : path.startsWith('/'));
  const read = async (method, params) => (await codex.rpc(method, params)).result;
  const within = (path, root) => {
    if (!valid(path) || !valid(root)) return false;
    const relative = paths().relative(root, path);
    return relative === '' || !relative.startsWith('..' + paths().sep) && relative !== '..' && !paths().isAbsolute(relative);
  };
  async function checkedPath(path) {
    if (!valid(path)) throw fail();
    const normalized = paths().normalize(path), ancestors = [];
    for (let current = normalized;; current = paths().dirname(current)) {
      ancestors.unshift(current); if (paths().dirname(current) === current) break;
    }
    // fs/watch currently echoes its input; metadata on every ancestor rejects symlink traversal.
    for (const [index, ancestor] of ancestors.entries()) {
      const metadata = await read('fs/getMetadata', { path: ancestor });
      if (metadata.isSymlink !== false || index < ancestors.length - 1 && !metadata.isDirectory) throw fail();
    }
    return normalized;
  }
  return { paths, valid, within, checkedPath, read,
    async directory(path) {
      const actual = await checkedPath(path), metadata = await read('fs/getMetadata', { path: actual });
      if (!metadata.isDirectory) throw fail(); return actual;
    },
  };
}
