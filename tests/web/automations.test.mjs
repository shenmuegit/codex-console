import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeAutomations } from '../../web/automations.mjs';

const cron = { kind: 'cron', name: 'Daily review', prompt: 'Review this project.\nReport findings.',
  rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30', cwds: ['/tmp/project'] };
const nativeToml = `version = 1
id = "native-task"
kind = "cron"
name = "Native task"
prompt = "Native prompt"
status = "ACTIVE"
rrule = "FREQ=HOURLY;INTERVAL=2;BYMINUTE=0"
execution_environment = "worktree"
target = { type = "project", project_id = "project-1", future_flag = true }
cwds = ["/tmp/native-project"]
model = "fixture-model"
reasoning_effort = "medium"
notification_policy = "failed_runs_only"
auto_archive = true
plugin_template_id = "native-template"
local_environment_config_path = "/tmp/native-environment.toml"
created_at = 1700000000000
updated_at = 1700000000001
future_date = 2026-10-14
[future]
secret = "not for the browser"
matrix = [[1, 2], [3, 4]]
[[future.rules]]
enabled = true
`;

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codex-native-automations-'));
  const store = createNativeAutomations({ home, ...options });
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  return { home, store, path: id => join(home, 'automations', id, 'automation.toml') };
}

async function nativeFile(f, source = nativeToml, id = 'native-task') {
  await mkdir(join(f.home, 'automations', id), { recursive: true });
  await writeFile(f.path(id), source);
}

function parsed(path) {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb")),default=str))', path], { encoding: 'utf8' }));
}

function database(home, name = 'codex.db') {
  const path = join(home, 'sqlite', name);
  execFileSync('python3', ['-c', `import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]); p.parent.mkdir(exist_ok=True)
c=sqlite3.connect(p)
c.executescript("""CREATE TABLE automations (id TEXT PRIMARY KEY, next_run_at INTEGER, last_run_at INTEGER,
 account_id TEXT, user_id TEXT, installation_id TEXT, legacy_automation_id TEXT, status TEXT, rrule TEXT);
CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT);
CREATE TABLE threads (id TEXT PRIMARY KEY, content TEXT);
INSERT INTO automations VALUES ('native-task',1800000000000,1700000000020,NULL,NULL,NULL,NULL,'ACTIVE','FREQ=HOURLY;INTERVAL=2;BYMINUTE=0');
INSERT INTO automations VALUES ('cloud-task',1900000000000,NULL,'private-account','private-user','private-install','legacy-task','ACTIVE','FREQ=DAILY');
INSERT INTO automations VALUES ('unrelated',1800000000001,NULL,NULL,NULL,NULL,NULL,'ACTIVE','FREQ=DAILY');
INSERT INTO automation_runs VALUES ('thread-1','native-task');
INSERT INTO threads VALUES ('thread-1','Keep my conversation');""")
c.commit(); c.close()`, path]);
  return path;
}

function rows(path, table) {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("SELECT * FROM "+sys.argv[2]+" ORDER BY 1").fetchall()))',
    path, table], { encoding: 'utf8' }));
}

test('native automations round trip create, list, pause, resume, edit and confirmed delete', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.list(), { items: [], unavailable: [] });
  const { item } = await f.store.create(cron);
  assert.equal(item.id, 'daily-review');
  assert.equal(item.executionEnvironment, 'local');
  assert.equal(item.status, 'ACTIVE');
  assert.equal(item.nextRunAt, null);
  assert.equal(item.lastRunAt, null);
  assert.equal((await stat(f.path(item.id))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.home, 'automations'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.home, 'automations', item.id))).mode & 0o777, 0o700);
  assert.deepEqual((await f.store.read(item.id)).item, item);
  const { items } = await f.store.list();
  assert.equal(items[0].prompt, undefined);
  assert.equal(items[0].promptPreview, 'Review this project. Report findings.');
  const { item: paused } = await f.store.update(item.id, item.updatedAt, { status: 'PAUSED' });
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.createdAt, item.createdAt);
  assert.ok(paused.updatedAt > item.updatedAt);
  const { item: edited } = await f.store.update(item.id, paused.updatedAt, { status: 'ACTIVE', name: 'Renamed', prompt: 'A new prompt', projectId: 'project-2' });
  assert.equal(edited.id, item.id);
  assert.equal(edited.status, 'ACTIVE');
  assert.equal(edited.projectId, 'project-2');
  assert.deepEqual(parsed(f.path(item.id)).target, { type: 'project', project_id: 'project-2' });
  await assert.rejects(f.store.delete(item.id, edited.updatedAt, false), { status: 400 });
  assert.deepEqual(await f.store.delete(item.id, edited.updatedAt, true), { deleted: true, id: item.id });
  await assert.rejects(f.store.read(item.id), { status: 404 });
  assert.equal((await f.store.create(cron)).item.id, 'daily-review');
  assert.equal((await f.store.create(cron)).item.id, 'daily-review-2');
});

test('editing preserves every native unknown field and created_at without exposing them', async t => {
  const f = await fixture(t); await nativeFile(f);
  const before = parsed(f.path('native-task'));
  const { item } = await f.store.read('native-task');
  assert.equal(item.projectId, 'project-1');
  assert.equal(item.executionEnvironment, 'worktree');
  assert.equal(item.future, undefined);
  assert.equal(item.notificationPolicy, undefined);
  await f.store.update(item.id, item.updatedAt, { status: 'PAUSED', projectId: null, model: null });
  const after = parsed(f.path(item.id));
  for (const key of ['future', 'future_date', 'notification_policy', 'auto_archive', 'plugin_template_id', 'local_environment_config_path', 'created_at'])
    assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.target, { type: 'projectless', future_flag: true });
  assert.equal(after.model, undefined);
  assert.equal(after.rrule, before.rrule);
  assert.equal(JSON.stringify(await f.store.list()).includes('not for the browser'), false);
});

test('same-task web writes serialize and stale update or delete reports a conflict', async t => {
  const f = await fixture(t); const { item } = await f.store.create(cron);
  const writes = await Promise.allSettled([
    f.store.update(item.id, item.updatedAt, { name: 'First writer' }),
    f.store.update(item.id, item.updatedAt, { name: 'Second writer' }),
  ]);
  assert.equal(writes[0].status, 'fulfilled');
  assert.equal(writes[1].reason.status, 409);
  await assert.rejects(f.store.delete(item.id, item.updatedAt, true), { status: 409 });
  assert.equal((await f.store.read(item.id)).item.name, 'First writer');
});

test('native schedules accept intervals, weekdays, custom monthly and explicit one-time DTSTART', async t => {
  const f = await fixture(t);
  for (const rrule of ['FREQ=MINUTELY;INTERVAL=5', 'RRULE:FREQ=HOURLY;INTERVAL=3;BYMINUTE=0',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;BYHOUR=9;BYMINUTE=0',
    'DTSTART:20991015T020000Z\nRRULE:FREQ=DAILY;COUNT=1',
    'DTSTART;TZID=Asia/Shanghai:20991015T100000\nRRULE:FREQ=DAILY;COUNT=1',
    'RDATE:20991015T020000Z']) {
    const { item } = await f.store.create({ ...cron, rrule });
    assert.equal(item.rrule, rrule);
    assert.equal(item.nextRunAt, null);
  }
  const { item } = await f.store.create({ kind: 'heartbeat', name: 'Check in', prompt: 'Check in', rrule: 'FREQ=MINUTELY;INTERVAL=30', targetThreadId: 'thread-1' });
  assert.equal(item.targetThreadId, 'thread-1');
  assert.equal(parsed(f.path(item.id)).target_thread_id, 'thread-1');
});

test('invalid modified schedules and fields never overwrite the native file', async t => {
  const f = await fixture(t); await nativeFile(f);
  const { item } = await f.store.read('native-task'), before = await readFile(f.path('native-task'), 'utf8');
  for (const patch of [{ rrule: 'not-a-rule' }, { rrule: 'FREQ=DAILY;BYHOUR=24' }, { rrule: 'FREQ=MINUTELY;INTERVAL=0' },
    { rrule: 'FREQ=DAILY;COUNT=1' }, { rrule: 'FREQ=DAILY;FREQ=WEEKLY' }, { rrule: 'FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31' },
    { rrule: 'DTSTART:20000101T010000Z\nRRULE:FREQ=DAILY;COUNT=1' },
    { rrule: 'DTSTART;TZID=Unknown/Place:20991015T100000\nRRULE:FREQ=DAILY;COUNT=1' },
    { name: '' }, { prompt: 42 }, { cwds: '/tmp' }, { cwds: [true] }, { status: 'DELETED' }, { executionEnvironment: 'remote' },
    { targetThreadId: 'thread-2' }, { kind: 'heartbeat' }, { id: 'other' }, { createdAt: 1 }, { account_id: 'account' }]) {
    await assert.rejects(f.store.update(item.id, item.updatedAt, patch), { status: 400 });
    assert.equal(await readFile(f.path(item.id), 'utf8'), before);
  }
  await assert.rejects(f.store.update(item.id, null, { status: 'PAUSED' }), { status: 400 });
  await assert.rejects(f.store.create({ ...cron, kind: 'heartbeat' }), { status: 400 });
  await assert.rejects(f.store.create({ ...cron, prompt: 'x'.repeat(300000) }), { status: 413 });
  await nativeFile(f, nativeToml.replace('FREQ=HOURLY;INTERVAL=2;BYMINUTE=0', 'FREQ=FUTURE_NATIVE_RULE'));
  const original = (await f.store.read('native-task')).item;
  const paused = (await f.store.update(original.id, original.updatedAt, { status: 'PAUSED', rrule: original.rrule })).item;
  assert.equal(paused.rrule, 'FREQ=FUTURE_NATIVE_RULE');
});

test('expired simple UNTIL and past-only RDATE plans are rejected without replacing native files', async t => {
  const f = await fixture(t); await nativeFile(f);
  const { item } = await f.store.read('native-task');
  for (const rrule of ['RRULE:FREQ=DAILY;UNTIL=20000101T000000Z',
    'DTSTART:19990101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20000101T000000Z',
    'RDATE:20000101T000000Z,20000102T000000Z',
    'RDATE;TZID=Asia/Shanghai:20000101T080000\nRDATE:20000102T000000Z']) {
    await assert.rejects(f.store.create({ ...cron, rrule }), { status: 400 });
    await assert.rejects(f.store.update(item.id, item.updatedAt, { rrule }), { status: 400 });
    assert.equal(await readFile(f.path(item.id), 'utf8'), nativeToml);
  }
  for (const rrule of ['FREQ=DAILY;UNTIL=20000101T000000Z', 'RDATE:20000101T000000Z']) {
    await nativeFile(f, nativeToml.replace('FREQ=HOURLY;INTERVAL=2;BYMINUTE=0', rrule));
    const existing = (await f.store.read('native-task')).item;
    const { item: edited } = await f.store.update(existing.id, existing.updatedAt, { name: 'Still editable', rrule });
    assert.equal(edited.rrule, rrule);
  }
});

test('future date sources and compound recurrence sets remain native-compatible', async t => {
  const f = await fixture(t);
  for (const rrule of ['RRULE:FREQ=DAILY;UNTIL=20991015T000000Z',
    'RDATE:20000101T000000Z,20991015T000000Z',
    'RDATE;TZID=Asia/Shanghai:20000101T080000,20991015T080000',
    'RRULE:FREQ=DAILY;UNTIL=20000101T000000Z\nRDATE:20991015T000000Z',
    'RRULE:FREQ=DAILY;UNTIL=20000101T000000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1']) {
    const { item } = await f.store.create({ ...cron, rrule });
    assert.equal(item.rrule, rrule);
    assert.equal(item.nextRunAt, null);
  }
});

test('native root metadata and retained task memory are not listed as broken tasks', async t => {
  const f = await fixture(t); await nativeFile(f);
  await writeFile(join(f.home, 'automations', '.run-jitter-salt'), 'native-salt');
  await mkdir(join(f.home, 'automations', 'retained-memory'));
  await writeFile(join(f.home, 'automations', 'retained-memory', 'memory.md'), 'Retained');
  const listed = await f.store.list();
  assert.deepEqual(listed.items.map(item => item.id), ['native-task']);
  assert.deepEqual(listed.unavailable, []);
});

test('path traversal, links and special files cannot be read, edited or deleted', async t => {
  const f = await fixture(t); await nativeFile(f);
  for (const id of ['', '.', '..', '../outside', '/tmp', 'a/b', 'a\\b', '\0']) {
    await assert.rejects(f.store.read(id), { status: 400 });
    await assert.rejects(f.store.update(id, 1, { name: 'bad' }), { status: 400 });
    await assert.rejects(f.store.delete(id, 1, true), { status: 400 });
  }
  const outside = join(f.home, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'automation.toml'), nativeToml);
  await symlink(outside, join(f.home, 'automations', 'directory-link'));
  await mkdir(join(f.home, 'automations', 'file-link'));
  await symlink(join(outside, 'automation.toml'), f.path('file-link'));
  await mkdir(join(f.home, 'automations', 'fifo'));
  execFileSync('mkfifo', [f.path('fifo')]);
  for (const id of ['directory-link', 'file-link', 'fifo']) {
    await assert.rejects(f.store.read(id), error => error.status >= 400 && error.status < 500);
    await assert.rejects(f.store.update(id, 1, { name: 'bad' }), error => error.status >= 400 && error.status < 500);
    await assert.rejects(f.store.delete(id, 1, true), error => error.status >= 400 && error.status < 500);
  }
  const listed = await f.store.list();
  assert.deepEqual(listed.items.map(i => i.id), ['native-task']);
  assert.equal(listed.unavailable.length, 3);
  assert.equal(await readFile(join(outside, 'automation.toml'), 'utf8'), nativeToml);
});

test('missing homes and linked roots are unavailable without creating or changing HOME', async t => {
  const f = await fixture(t), missing = join(f.home, 'missing');
  const absent = createNativeAutomations({ home: missing }); t.after(() => absent.close());
  assert.equal((await absent.list()).unavailable.length, 1);
  await assert.rejects(absent.create(cron), { status: 503 });
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  const target = join(f.home, 'outside'); await mkdir(target);
  await symlink(target, join(f.home, 'automations'));
  assert.equal((await f.store.list()).unavailable.length, 1);
  await assert.rejects(f.store.create(cron), error => error.status >= 400);
  assert.equal((await stat(target)).isDirectory(), true);
});

test('invalid or oversized TOML is reported safely while valid native tasks remain visible', async t => {
  const f = await fixture(t); await nativeFile(f);
  await nativeFile(f, 'secret_private_prompt = "do not print"\ninvalid = [', 'broken');
  await nativeFile(f, nativeToml.replace('version = 1', 'version = 2').replace('id = "native-task"', 'id = "new-format"'), 'new-format');
  await nativeFile(f, 'x'.repeat(300000), 'oversized');
  const listed = await f.store.list();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.unavailable.length, 3);
  assert.equal(JSON.stringify(listed).includes('secret_private_prompt'), false);
  assert.equal(JSON.stringify(listed).includes(f.home), false);
  await assert.rejects(f.store.read('oversized'), { status: 413 });
});

test('reads native runtime state and deletes only the matching local cache, preserving sessions and task memory', async t => {
  const f = await fixture(t); await nativeFile(f);
  const db = database(f.home);
  await writeFile(join(f.home, 'automations', 'native-task', 'memory.md'), 'Keep this task memory');
  const { item } = await f.store.read('native-task');
  assert.equal(item.nextRunAt, 1800000000000);
  assert.equal(item.lastRunAt, 1700000000020);
  assert.equal(JSON.stringify(await f.store.list()).includes('private-account'), false);
  await f.store.delete(item.id, item.updatedAt, true);
  assert.deepEqual(rows(db, 'automations').map(row => row[0]), ['cloud-task', 'unrelated']);
  assert.deepEqual(rows(db, 'automation_runs'), [['thread-1', 'native-task']]);
  assert.deepEqual(rows(db, 'threads'), [['thread-1', 'Keep my conversation']]);
  assert.equal(await readFile(join(f.home, 'automations', 'native-task', 'memory.md'), 'utf8'), 'Keep this task memory');
});

test('paused tasks and schedules not yet observed by native Codex have no stale nextRunAt', async t => {
  const f = await fixture(t); await nativeFile(f); database(f.home);
  const { item } = await f.store.read('native-task');
  const { item: paused } = await f.store.update(item.id, item.updatedAt, { status: 'PAUSED' });
  assert.equal(paused.nextRunAt, null);
  assert.equal((await f.store.read(item.id)).item.nextRunAt, null);
  assert.equal(paused.lastRunAt, 1700000000020);
  const { item: changed } = await f.store.update(item.id, paused.updatedAt, { status: 'ACTIVE', rrule: 'FREQ=MINUTELY;INTERVAL=5' });
  assert.equal(changed.nextRunAt, null);
  assert.equal((await f.store.list()).items[0].nextRunAt, null);
  assert.equal(changed.lastRunAt, 1700000000020);
});

test('unsafe runtime database paths never read outside storage or overwrite the task', async t => {
  const f = await fixture(t); await nativeFile(f);
  const before = await readFile(f.path('native-task'), 'utf8');
  await mkdir(join(f.home, 'sqlite'));
  await symlink(f.path('native-task'), join(f.home, 'sqlite', 'codex.db'));
  await assert.rejects(f.store.update('native-task', 1700000000001, { status: 'PAUSED' }), error => error.status >= 400);
  await assert.rejects(f.store.delete('native-task', 1700000000001, true), error => error.status >= 400);
  assert.equal(await readFile(f.path('native-task'), 'utf8'), before);
});

test('cache cleanup cannot cascade through triggers into other native records', async t => {
  const f = await fixture(t); await nativeFile(f); const db = database(f.home);
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("CREATE TRIGGER unrelated_cache AFTER DELETE ON automations BEGIN DELETE FROM automations WHERE id='unrelated'; END")
c.commit(); c.close()`, db]);
  await assert.rejects(f.store.delete('native-task', 1700000000001, true), { status: 503 });
  assert.deepEqual(rows(db, 'automations').map(row => row[0]), ['cloud-task', 'native-task', 'unrelated']);
  assert.equal(await readFile(f.path('native-task'), 'utf8'), nativeToml);
});

test('cloud-owned and migrated native records cannot be changed through local files', async t => {
  const f = await fixture(t); database(f.home, 'codex-dev.db');
  for (const id of ['cloud-task', 'legacy-task']) {
    const source = nativeToml.replace('id = "native-task"', `id = "${id}"`);
    await nativeFile(f, source, id);
    await assert.rejects(f.store.update(id, 1700000000001, { status: 'PAUSED' }), { status: 409 });
    await assert.rejects(f.store.delete(id, 1700000000001, true), { status: 409 });
    assert.equal(await readFile(f.path(id), 'utf8'), source);
  }
  const listed = await f.store.list();
  assert.equal(listed.items.length, 0);
  assert.ok(listed.unavailable.some(entry => entry.code === 'AUTOMATION_LOCAL_ONLY'));
});

test('configuration changes notify listeners and close stops further work', async t => {
  let changes = 0;
  const f = await fixture(t, { onChange() { changes++; } });
  const { item } = await f.store.create(cron);
  await delay(250); const before = changes;
  await writeFile(f.path(item.id), (await readFile(f.path(item.id), 'utf8')).replace('Daily review', 'Native client edit'));
  for (let attempts = 0; attempts < 30 && changes === before; attempts++) await delay(50);
  assert.ok(changes > before);
  assert.equal((await f.store.read(item.id)).item.name, 'Native client edit');
  f.store.close(); const closedAt = changes;
  await writeFile(f.path(item.id), nativeToml);
  await delay(250); assert.equal(changes, closedAt);
  await assert.rejects(f.store.list(), { status: 503 });
});

test('native runtime database updates notify listeners without watching conversation databases', async t => {
  let changes = 0;
  const f = await fixture(t, { onChange() { changes++; } });
  await nativeFile(f); const db = database(f.home);
  await f.store.list(); await delay(250);
  const before = changes;
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE automations SET next_run_at=1800000000999 WHERE id=\\\'native-task\\\'"); c.commit(); c.close()', db]);
  for (let attempts = 0; attempts < 30 && changes === before; attempts++) await delay(50);
  assert.ok(changes > before);
  assert.equal((await f.store.read('native-task')).item.nextRunAt, 1800000000999);
  await delay(250); const unchanged = changes;
  await writeFile(join(f.home, 'sqlite', 'thread_history.sqlite'), 'unrelated');
  await delay(250); assert.equal(changes, unchanged);
});

for (const name of ['codex.db', 'codex-dev.db']) test(`reading ${name} in WAL mode does not trigger a refresh loop`, async t => {
  let changes = 0;
  const f = await fixture(t, { onChange() { changes++; } });
  await nativeFile(f); const db = database(f.home, name);
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.close()', db]);
  await f.store.list(); await delay(250);
  const before = changes;
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await f.store.list()).items[0].nextRunAt, 1800000000000);
    assert.equal((await f.store.read('native-task')).item.lastRunAt, 1700000000020);
    await delay(250);
    assert.equal(changes, before, 'Read-only SQLite shared-memory updates must not notify the browser');
  }
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE automations SET next_run_at=1800000000999, last_run_at=1700000000999 WHERE id=\'native-task\'"); c.commit(); c.close()', db]);
  for (let attempt = 0; attempt < 30 && changes === before; attempt++) await delay(50);
  assert.ok(changes > before, 'Committed runtime updates must still notify the browser');
  const { item } = await f.store.read('native-task');
  assert.equal(item.nextRunAt, 1800000000999); assert.equal(item.lastRunAt, 1700000000999);
});
