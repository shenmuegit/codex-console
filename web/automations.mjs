import { execFile } from 'node:child_process';
import { lstatSync, watch } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./automations.py', import.meta.url));
const failure = (code, status, message) => Object.assign(new Error(message), { code, status });

function safeDirectory(path) {
  if (!isAbsolute(path)) return false;
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (dirname(current) === current) return true;
  }
}

/** Native Codex owns discovery, schedule interpretation and execution. */
export function createNativeAutomations({ home, onChange } = {}) {
  let closed = false, watcher, parentWatcher, runtimeWatcher, debounce;
  const children = new Set(), writes = new Map();
  function changed() {
    if (closed || !onChange) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (!closed) try { onChange(); } catch {} }, 150);
    debounce.unref();
  }
  function observe() {
    if (closed || !home) return;
    if (!watcher) try {
      const root = join(home, 'automations');
      if (safeDirectory(root)) {
        watcher = watch(root, { recursive: true, persistent: false }, changed);
        watcher.on('error', () => { watcher?.close(); watcher = null; });
      }
    } catch { /* Reads remain available when filesystem notifications are unavailable. */ }
    if (!runtimeWatcher) try {
      const root = join(home, 'sqlite');
      if (safeDirectory(root)) {
        runtimeWatcher = watch(root, { persistent: false }, (_event, name) => {
          // SQLite readers update -shm too; watching it makes list reads trigger another refresh.
          if (/^codex(?:-dev)?\.db(?:-(?:wal|journal))?$/.test(String(name))) changed();
        });
        runtimeWatcher.on('error', () => { runtimeWatcher?.close(); runtimeWatcher = null; });
      }
    } catch { /* Native runtime state is still read on the next API request. */ }
  }
  if (home) try {
    if (safeDirectory(home)) {
      parentWatcher = watch(home, { persistent: false }, (_event, name) => {
        if (['automations', 'sqlite'].includes(String(name))) { observe(); changed(); }
      });
      parentWatcher.on('error', () => { parentWatcher?.close(); parentWatcher = null; });
      observe();
    }
  } catch { /* The adapter reports unavailable homes through its API. */ }
  function run(action, args = {}) {
    if (closed) return Promise.reject(failure('AUTOMATION_UNAVAILABLE', 503, 'Native automations are unavailable.'));
    return new Promise((resolve, reject) => {
      const child = execFile('python3', [helper], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        children.delete(child);
        if (error) return reject(failure('AUTOMATION_UNAVAILABLE', 503, 'Native automations are unavailable.'));
        let response;
        try { response = JSON.parse(stdout); }
        catch { return reject(failure('AUTOMATION_UNAVAILABLE', 503, 'Native automations are unavailable.')); }
        if (response.error) return reject(failure(response.error.code, response.error.status, response.error.message));
        observe(); resolve(response.result);
      });
      children.add(child);
      child.stdin.on('error', () => {});
      try { child.stdin.end(JSON.stringify({ home, action, ...args })); }
      catch { child.kill(); reject(failure('AUTOMATION_INVALID', 400, 'Invalid automation data.')); }
    });
  }
  function write(id, action, args) {
    const previous = writes.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => run(action, args));
    writes.set(id, pending);
    pending.then(changed, () => {}).finally(() => { if (writes.get(id) === pending) writes.delete(id); });
    return pending;
  }
  return {
    list: () => run('list'),
    read: id => run('read', { id }),
    create: item => write(null, 'create', { item }),
    update: (id, expectedUpdatedAt, patch) => write(id, 'update', { id, expectedUpdatedAt, patch }),
    delete: (id, expectedUpdatedAt, confirmed) => write(id, 'delete', { id, expectedUpdatedAt, confirmed }),
    close() {
      closed = true; clearTimeout(debounce); watcher?.close(); parentWatcher?.close(); runtimeWatcher?.close();
      for (const child of children) child.kill();
      children.clear();
    },
  };
}
