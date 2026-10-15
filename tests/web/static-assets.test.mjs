import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
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
