import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, chmod, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureRemoteUploadStorage } from '../remote-upload-storage.mjs';
const execute = promisify(execFile);
async function unixFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'private-upload-')); t.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o755); const calls = [];
  const codex = { info: () => ({ platformFamily: 'unix' }), async rpc(method, params) {
    calls.push({ method, params }); assert.equal(method, 'command/exec');
    assert.deepEqual(Object.keys(params).sort(), ['command', 'cwd', 'outputBytesCap', 'timeoutMs']);
    try { const { stdout, stderr } = await execute(params.command[0], params.command.slice(1), { cwd: params.cwd }); return { result: { exitCode: 0, stdout, stderr } }; }
    catch (error) { return { result: { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }; }
  } };
  return { codex, home, calls, base: join(home, 'console-uploads') };
}
test('Unix native permission argv creates 0700 storage under umask 022 and safely resumes lost preparation replies', async t => {
  const f = await unixFixture(t), before = process.umask(0o022); t.after(() => process.umask(before));
  const rpc = f.codex.rpc; let replyLost = true;
  f.codex.rpc = async (...args) => { const result = await rpc(...args); if (replyLost) { replyLost = false; throw new Error('Reply lost'); } return result; };
  await assert.rejects(ensureRemoteUploadStorage(f.codex, f.home), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  assert.equal((await stat(f.base)).mode & 0o777, 0o700);
  await ensureRemoteUploadStorage(f.codex, f.home); assert.equal((await stat(f.base)).mode & 0o777, 0o700);
  const directory = join(f.base, 'upload-id'); await mkdir(directory, { mode: 0o755 });
  const file = join(directory, 'content.txt'); await writeFile(file, 'private', { mode: 0o644 });
  await ensureRemoteUploadStorage(f.codex, f.home, file);
});
test('Unix refuses unsafe existing storage and writable ancestors without changing them', async t => {
  const f = await unixFixture(t); await mkdir(f.base, { mode: 0o755 }); await chmod(f.base, 0o755);
  await assert.rejects(ensureRemoteUploadStorage(f.codex, f.home), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  assert.equal((await stat(f.base)).mode & 0o777, 0o755);
  await rm(f.base, { recursive: true }); await chmod(f.home, 0o777);
  await assert.rejects(ensureRemoteUploadStorage(f.codex, f.home), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  await assert.rejects(stat(f.base), { code: 'ENOENT' });
});
test('Unix refuses symlink storage and command syntax in a home path is treated only as data', async t => {
  const f = await unixFixture(t), outside = join(f.home, 'outside'); await mkdir(outside); await symlink(outside, f.base);
  await assert.rejects(ensureRemoteUploadStorage(f.codex, f.home), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  await rm(f.base); const home = join(f.home, "quote'$(touch SHOULD_NOT_EXIST)"); await mkdir(home, { mode: 0o755 });
  await ensureRemoteUploadStorage(f.codex, home); assert.equal((await stat(join(home, 'console-uploads'))).mode & 0o777, 0o700);
  await assert.rejects(stat(join(home, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
});
test('permission verification rejects unavailable runtimes, malformed results and unknown platforms without policy override or fallback', async () => {
  for (const family of ['unix', 'windows', 'unknown']) {
    const calls = [], codex = { info: () => ({ platformFamily: family }), async rpc(method, params) { calls.push({ method, params }); throw new Error('Runtime missing or sandbox denied'); } };
    await assert.rejects(ensureRemoteUploadStorage(codex, family === 'windows' ? 'C:\\Users\\owner\\.codex' : '/home/owner/.codex'), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
    for (const call of calls) { assert.equal(call.method, 'command/exec'); assert.deepEqual(Object.keys(call.params).sort(), ['command', 'cwd', 'outputBytesCap', 'timeoutMs']); }
    assert.equal(calls.length, family === 'unknown' ? 0 : 1);
  }
});

test('a zero-exit result must still contain the exact private-storage proof marker', async () => {
  for (const result of [{ exitCode: 0, stdout: 'not a proof' }, { exitCode: 1, stdout: 'codex-console-private-v1' }, { exitCode: 0 }, null]) {
    const codex = { info: () => ({ platformFamily: 'unix' }), rpc: async () => ({ result }) };
    await assert.rejects(ensureRemoteUploadStorage(codex, '/home/owner/.codex'), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  }
});

test('Unix attachment verification rejects a file aliased outside its private storage', async t => {
  const f = await unixFixture(t); await ensureRemoteUploadStorage(f.codex, f.home);
  const directory = join(f.base, 'upload-id'); await mkdir(directory);
  const file = join(directory, 'content.txt'); await writeFile(file, 'fixture bytes');
  await link(file, join(f.home, 'public-alias.txt'));
  await assert.rejects(ensureRemoteUploadStorage(f.codex, f.home, file), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
});

test('prewrite directory proof allows an absent file but postwrite file proof still requires it', async t => {
  const f = await unixFixture(t); await ensureRemoteUploadStorage(f.codex, f.home);
  const directory = join(f.base, 'upload-id'); await mkdir(directory);
  const file = join(directory, 'content.txt');
  await ensureRemoteUploadStorage(f.codex, f.home, file, true);
  await assert.rejects(ensureRemoteUploadStorage(f.codex, f.home, file), { code: 'REMOTE_STORAGE_NOT_PRIVATE' });
  await writeFile(file, 'private'); await ensureRemoteUploadStorage(f.codex, f.home, file);
});
