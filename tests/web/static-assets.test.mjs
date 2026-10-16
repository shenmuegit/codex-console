import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { httpsFixture } from './helpers.mjs';

test('every browser module and stylesheet is public with the correct MIME type', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const files = await readdir(new URL('../../web/public/', import.meta.url));
  for (const file of files.filter(name => /\.(js|css)$/.test(name))) {
    for (const method of ['GET', 'HEAD']) {
      const response = await f.request('/' + file, { method, origin: null });
      assert.equal(response.status, 200, `${method} /${file} before login`);
      assert.equal(response.headers['content-type'], file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      if (method === 'HEAD') assert.equal(response.text, '');
      else assert.ok(response.text.length);
    }
  }
});

test('the browser favicon is the existing project icon and needs no login', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const icon = await readFile(new URL('../../assets/codex-console-icon.png', import.meta.url));
  for (const method of ['GET', 'HEAD']) {
    const response = await f.request('/favicon.ico', { method, origin: null });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.text, method === 'HEAD' ? '' : icon.toString());
  }
  assert.match((await f.request('/')).text, /<link\b[^>]*rel="icon"[^>]*href="\/favicon.ico"/);
});
