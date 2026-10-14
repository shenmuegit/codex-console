import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('plugin build requires a canonical backend and emits relocatable licensed assets', async t => {
  const cwd = fileURLToPath(new URL('../../web/', import.meta.url));
  const output = await mkdtemp(join(tmpdir(), 'console-plugin-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const build = backend => spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', output], {
    cwd, encoding: 'utf8', env: { ...process.env, VITE_CODEX_CONSOLE_BACKEND_URL: backend },
  });
  for (const backend of ['', 'http://codex.example.test', 'https://codex.example.test/path']) {
    const result = build(backend);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VITE_CODEX_CONSOLE_BACKEND_URL/);
  }
  const result = build('https://codex.example.test');
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const urls = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1]);
  assert.ok(urls.length >= 2);
  for (const url of urls) { assert.ok(url.startsWith('./assets/'), url); assert.ok((await readFile(join(output, url))).length); }
  const licenses = await readFile(join(output, '.vite/license.md'), 'utf8');
  assert.match(licenses, /@isola\/plugin/); assert.match(licenses, /MIT/); assert.match(licenses, /react-dom/);
});
