// Opt-in integration check. This file is deliberately outside the *.test.mjs glob.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createCodexClient } from '../codex.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, workspace: { type: 'string' }, 'exercise-files': { type: 'boolean', default: false },
} });
if (!values.url || !values.workspace) throw new Error('Supply --url and --workspace.');
const workspace = await realpath(values.workspace);
assert.ok((await stat(workspace)).isDirectory());
const client = createCodexClient({ url: values.url });
let threadId, activeTurnId, completed, usedTool = false;
const eventKinds = new Set();
const off = client.onEvent(e => {
  const p = e.native?.params;
  if (!threadId || p?.threadId !== threadId) return;
  eventKinds.add(`${e.native.method}:${p?.item?.type ?? ''}`);
  if (e.kind === 'request') client.respond(e.requestKey, { error: { code: -32601, message: 'Unsupported by the disposable probe.' } }).catch(() => {});
  if (e.native.method === 'turn/started') activeTurnId = p.turn.id;
  if (e.native.method === 'turn/completed') { completed = p.turn; activeTurnId = null; }
  if (['commandExecution', 'fileChange'].includes(p?.item?.type)) usedTool = true;
});
try {
  const deadline = Date.now() + 10_000;
  while (!client.status().online && Date.now() < deadline) await delay(50);
  assert.ok(client.status().online, 'Native initialization did not finish.');
  const read = async (method, params = {}) => (await client.rpc(method, params)).result;
  const [models, projects, threads, account] = await Promise.all([
    read('model/list'), read('project/list', { limit: 20 }),
    read('thread/list', { limit: 20, modelProviders: [] }), read('account/read', { refreshToken: false }),
  ]);
  const report = { initialized: true, models: models.data.length, projects: projects.data.length,
    threads: threads.data.length, loggedIn: Boolean(account.account) };
  if (values['exercise-files']) {
    const model = models.data.find(m => m.isDefault) ?? models.data[0];
    assert.ok(model, 'No native model is available.');
    const name = `native-probe-${randomUUID()}.txt`, path = join(workspace, name);
    const bytes = `NATIVE_FILESYSTEM_OK:${randomUUID()}\n`;
    const started = await read('thread/start', { cwd: workspace, model: model.model,
      approvalPolicy: 'never', sandbox: 'danger-full-access' });
    threadId = started.thread.id;
    // Native paginated threads acquire durable empty history when named (upstream's own pattern).
    await read('thread/name/set', { threadId, name: 'Disposable native filesystem probe' });
    await client.retainThread(threadId, 'native-probe');
    await read('turn/start', { threadId, model: model.model, effort: 'low', approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: `This is an authorized disposable filesystem integration test. Use your filesystem or command tool to create exactly ${JSON.stringify(path)} with these exact UTF-8 bytes: ${JSON.stringify(bytes)}. Do not modify any other files. After writing, reply NATIVE_FILESYSTEM_OK.`, text_elements: [] }] });
    const turnDeadline = Date.now() + 180_000;
    while (!completed && Date.now() < turnDeadline) await delay(100);
    assert.equal(completed?.status, 'completed', 'The disposable turn did not complete.');
    assert.ok(usedTool, `The model must actually use a filesystem/command tool. Events: ${[...eventKinds].join(', ')}; completed item types: ${completed.items?.map(item => item.type).join(', ')}`);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await read('thread/delete', { threadId });
    threadId = null;
    await unlink(path);
    report.filesystemTool = true; report.exactBytes = true; report.probeThreadDeleted = true;
  }
  console.log(JSON.stringify(report));
} finally {
  if (threadId) {
    if (activeTurnId) await client.rpc('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
    if (!activeTurnId) await client.rpc('thread/delete', { threadId }).catch(() => {});
  }
  off(); client.close();
}
