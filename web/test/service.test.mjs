import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod, stat, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { renderUserUnits, validateConfig, assertPrivate, unitCommand, initialize, statusSummary } from '../service.mjs';
import { httpsFixture } from './helpers.mjs';

async function configFixture(t) {
  const f = await httpsFixture(); t.after(() => f.close());
  const root = join(f.dir, '目录 % dollar$ paths'), repoDir = join(root, 'repo'), bin = join(root, 'bin'), backendHome = join(root, 'native-home'), workspace = join(root, 'work');
  for (const path of [root, repoDir, join(repoDir, 'web'), bin, backendHome, workspace]) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(repoDir, 'web/server.mjs'), 'process.exit(0);\n');
  const backendExecutable = join(bin, 'codex-app-server');
  for (const path of [backendExecutable, join(bin, 'codex-code-mode-host')]) { await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); }
  const environmentFile = join(root, 'runtime.env'); await writeFile(environmentFile, '', { mode: 0o600 });
  const configPath = join(root, 'config.json'); await writeFile(configPath, '{}', { mode: 0o600 }); await chmod(f.config.tlsCert, 0o600);
  const config = { ...f.config, port: Number(new URL(f.config.origin).port), repoDir, nodePath: process.execPath, backendExecutable, backendHome, workspace, environmentFile };
  return { ...f, root, config, configPath };
}

test('unit paths quote spaces/Unicode and escape systemd percent/dollar without a shell or fallback backend', async t => {
  const f = await configFixture(t), units = renderUserUnits({ ...f.config, configPath: f.configPath });
  assert.match(units.backend, /codex-app-server/); assert.match(units.backend, /CODEX_HOME=/); assert.match(units.backend, /UMask=0077/);
  assert.match(units.web, /server\.mjs/); assert.match(units.web, /Restart=on-failure/);
  assert.ok(units.backend.includes('目录 %% dollar$ paths')); assert.ok(units.web.includes('目录 %% dollar$ paths'));
  assert.match(units.backend, /ExecStart=:/); assert.match(units.web, /ExecStart=:/);
  for (const value of [units.backend, units.web]) assert.doesNotMatch(value, /console\.sh|Xpra|xpra|bash -c|codex app-server|\.cache\//);
  const unitDir = join(f.dir, 'units'); await mkdir(unitDir);
  for (const [name, value] of [['codex-console-native-backend.service', units.backend], ['codex-console-native-web.service', units.web]]) await writeFile(join(unitDir, name), value);
  execFileSync('systemd-analyze', ['--user', 'verify', join(unitDir, 'codex-console-native-backend.service'), join(unitDir, 'codex-console-native-web.service')], { stdio: 'pipe' });
});

test('bootstrap requires explicit existing source binary, companion, private cert and isolated native home', async t => {
  const f = await configFixture(t); await validateConfig(f.config, f.configPath);
  await assert.rejects(validateConfig({ ...f.config, backendExecutable: join(f.root, 'missing') }, f.configPath));
  await assert.rejects(validateConfig({ ...f.config, tlsCert: join(f.root, 'missing.pem') }, f.configPath));
  await assert.rejects(validateConfig({ ...f.config, backendHome: join(homedir(), '.codex') }, f.configPath), { code: 'ORIGINAL_HOME_REFUSED' });
  await chmod(f.configPath, 0o644); await assert.rejects(validateConfig(f.config, f.configPath), { code: 'PRIVATE_FILE_REQUIRED' });
  assert.throws(() => assertPrivate({ uid: process.getuid() + 1, mode: 0o600 }), { code: 'OWNER_REQUIRED' });
});

test('stop/start/status commands target only the two owned units and status excludes secrets', () => {
  assert.deepEqual(unitCommand('stop'), ['--user', 'stop', 'codex-console-native-web.service', 'codex-console-native-backend.service']);
  assert.equal(unitCommand('start').includes('ChatGPT'), false);
  const value = statusSummary({ origin: 'https://127.0.0.1:8443', passwordHash: 'PRIVATE_HASH', tlsKey: '/private/key', apiKey: 'PRIVATE_KEY' }, { backend: 'inactive', web: 'active' }, { nativeOnline: false, httpsAvailable: true });
  assert.equal(value.nativeOnline, false); assert.equal(JSON.stringify(value).includes('PRIVATE_'), false); assert.equal(JSON.stringify(value).includes('/private'), false);
});

test('initialization generates private owner/TLS config and never overwrites existing credentials', async t => {
  const f = await configFixture(t), configPath = join(f.root, 'fresh', 'config.json');
  const result = await initialize({ configPath, origin: 'https://127.0.0.1:8443', backendExecutable: f.config.backendExecutable, backendHome: f.config.backendHome,
    workspace: f.config.workspace, repoDir: f.config.repoDir, stateDir: join(f.root, 'state'), environment: { HTTPS_PROXY: 'http://127.0.0.1:9000', OPENAI_API_KEY: 'NEVER_FORWARD', CODEX_APP_SERVER_FORCE_CLI: 'NEVER_FORWARD' } });
  for (const path of [configPath, result.passwordFile, result.config.tlsKey, result.config.tlsCert, result.config.environmentFile]) assert.equal((await stat(path)).mode & 0o077, 0);
  const content = await readFile(configPath, 'utf8'), password = await readFile(result.passwordFile, 'utf8');
  assert.equal(content.includes(password.trim()), false); assert.equal((await readFile(result.config.environmentFile, 'utf8')).includes('NEVER_FORWARD'), false);
  await assert.rejects(initialize({ configPath, origin: 'https://127.0.0.1:8443' }), { code: 'CONFIG_EXISTS' });
  assert.equal(await readFile(result.passwordFile, 'utf8'), password);
});

test('refusing the original home happens before any filesystem or permission changes', async t => {
  const f = await configFixture(t), original = join(f.root, 'original-home'); await mkdir(original, { mode: 0o755 }); await chmod(original, 0o755);
  const before = process.env.CODEX_HOME; process.env.CODEX_HOME = original;
  try { await assert.rejects(initialize({ configPath: join(f.root, 'rejected', 'config.json'), backendHome: original, repoDir: f.config.repoDir }), { code: 'ORIGINAL_HOME_REFUSED' }); }
  finally { if (before == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; }
  assert.equal((await stat(original)).mode & 0o777, 0o755);
});

test('initialization rejects symlinked repository ancestors before writing private material', async t => {
  const f = await configFixture(t), alias = join(f.root, 'outside');
  await symlink(f.config.repoDir, alias);
  await assert.rejects(initialize({ configPath: join(alias, 'new-private', 'config.json'), origin: 'https://127.0.0.1:8443',
    backendExecutable: f.config.backendExecutable, backendHome: f.config.backendHome, workspace: f.config.workspace,
    repoDir: f.config.repoDir, stateDir: join(f.root, 'new-state') }), { code: 'PRIVATE_PATH_IN_REPO' });
  await assert.rejects(stat(join(f.config.repoDir, 'new-private')), { code: 'ENOENT' });
});

test('configuration validation rejects canonical private files inside the repository', async t => {
  const f = await configFixture(t), alias = join(f.root, 'outside');
  await symlink(f.config.repoDir, alias);
  await writeFile(join(f.config.repoDir, 'private-config.json'), '{}', { mode: 0o600 });
  await assert.rejects(validateConfig(f.config, join(alias, 'private-config.json')), { code: 'PRIVATE_PATH_IN_REPO' });
});
