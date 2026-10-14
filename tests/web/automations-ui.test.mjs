import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setMaxListeners } from 'node:events';
import { domFixture } from './dom.mjs';

const task = (extra = {}) => ({ id: 'native-task', kind: 'heartbeat', name: '每日检查', prompt: '完整的原生提示词', promptPreview: '完整的原生…', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', targetThreadId: 'current', updatedAt: 10, nextRunAt: null, lastRunAt: null, ...extra });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const dom = domFixture(), calls = [], opened = [];
  let state = { ready: true, online: true, generation: 1, threadId: 'current', thread: { name: '当前空会话' }, draft: '保留我的输入', settings: { model: 'chat-model', effort: 'high' } };
  let tasks = options.items ?? [task()];
  const api = async (path, body) => {
    calls.push({ path, body });
    const handled = await options.api?.(path, body);
    if (handled !== undefined) return handled;
    if (path === '/api/rpc') return { result: { data: body.method === 'project/list' ? [{ id: 'project', name: '已有项目', roots: [{ path: '/private/work' }] }] : body.method === 'model/list' ? [{ model: 'native-model', displayName: '原生模型', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] : [{ id: 'other', name: '其他会话' }], nextCursor: null } };
    if (path.endsWith('/list')) return { items: tasks.map(({ prompt, ...item }) => item), unavailable: [], timeZone: 'Asia/Shanghai', now: 1791936000000 };
    if (path.endsWith('/read')) return { item: tasks.find(item => item.id === body.id) };
    if (path.endsWith('/create')) { const item = task({ ...body.item, id: 'created', updatedAt: 11 }); tasks.push(item); return { item }; }
    if (path.endsWith('/update')) { const item = tasks.find(item => item.id === body.id); Object.assign(item, body.patch, { updatedAt: item.updatedAt + 1 }); return { item }; }
    if (path.endsWith('/delete')) { tasks = tasks.filter(item => item.id !== body.id); return { deleted: true, id: body.id }; }
    assert.fail('Unexpected API call ' + path);
  };
  let mountAutomations;
  try { ({ mountAutomations } = await import('../../web/public/automations.js')); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('The native automation controller has not been implemented'); throw error; }
  assert.equal(typeof mountAutomations, 'function');
  const panel = mountAutomations({ api, viewId: 'view', selectedHost: options.host, getState: () => state, onOpenThread: id => opened.push(id) });
  t.after(() => { panel.dispose(); dom.restore(); });
  return { dom, calls, opened, panel, get state() { return state; }, setState(value) { state = value; },
    async open() { dom.get('show-automations').click(); await delay(0); },
    async create() { dom.get('new-automation').click(); await delay(0); },
    async edit(name = '每日检查') { this.button('编辑 ' + name).click(); await delay(0); },
    button(label) { return dom.get('automation-list').querySelectorAll('button').find(node => node.getAttribute('aria-label') === label); },
    fill(name = '新的任务') { dom.get('automation-name').value = name; dom.get('automation-prompt').value = '定时检查，不发送当前草稿'; },
    async save() { dom.event('automation-form', 'submit'); await delay(0); },
    async menu(name = '每日检查') { this.button(name + ' 的选项').click(); await delay(0); },
  };
}

// AbortController owns all controller listeners; this fixture creates more than Node's browser-like default limit.
setMaxListeners(0);

test('native tasks are local only, and reopening reads the native list again', async t => {
  const f = await fixture(t);
  assert.equal(f.dom.get('show-automations').hidden, false); assert.equal(f.calls.length, 0);
  await f.open(); assert.match(f.dom.get('automation-list').textContent, /每日检查/);
  assert.match(f.dom.get('automation-list').textContent, /下一次：未知/);
  f.dom.get('close-automations').click(); await f.open();
  assert.equal(f.calls.filter(call => call.path.endsWith('/list')).length, 2);
  f.panel.dispose();
  const remote = await fixture(t, { host: 'another-device' });
  assert.equal(remote.dom.get('show-automations').hidden, true); await remote.open();
  remote.panel.onEvent({ native: { method: 'automation/changed' } }); assert.equal(remote.calls.length, 0);
});

test('explicit heartbeat selection binds the current empty conversation and explains native desktop preparation', async t => {
  const f = await fixture(t); await f.open(); await f.create();
  f.dom.get('automation-kind').value = 'heartbeat'; f.dom.event('automation-kind', 'change');
  assert.equal(f.dom.get('automation-kind').value, 'heartbeat');
  assert.match(f.dom.get('automation-thread-hint').textContent, /Codex 桌面打开该会话.*保持客户端运行/);
  assert.equal(f.dom.get('automation-thread').value, 'current');
  assert.ok(f.dom.get('automation-thread').children.some(node => node.value === 'current'));
  f.fill(); f.dom.get('automation-schedule').value = 'hours'; f.dom.get('automation-interval').value = '2'; await f.save();
  const created = f.calls.find(call => call.path.endsWith('/create')).body;
  assert.equal(created.viewId, 'view'); assert.equal(created.item.targetThreadId, 'current'); assert.equal(created.item.rrule, 'FREQ=HOURLY;INTERVAL=2');
  assert.equal(created.item.name, '新的任务'); assert.equal(created.item.model, undefined);
  assert.equal(f.state.draft, '保留我的输入'); assert.equal(f.state.settings.model, 'chat-model');
  assert.ok(f.calls.every(call => call.path.startsWith('/api/automations/') || call.path === '/api/rpc'));
  assert.ok(f.calls.filter(call => call.path === '/api/rpc').every(call => ['thread/list', 'project/list', 'model/list'].includes(call.body.method) && call.body.params.limit <= 100));
});

test('preset plans use readable schedule labels while unknown native rules remain editable', async t => {
  const rules = ['FREQ=MINUTELY;INTERVAL=30', 'FREQ=HOURLY;INTERVAL=2', 'FREQ=DAILY;BYHOUR=6;BYMINUTE=0;BYSECOND=0', 'FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=9;BYMINUTE=30;BYSECOND=0', 'DTSTART;TZID=Asia/Shanghai:20261015T100000\nRRULE:FREQ=DAILY;COUNT=1', 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=15'];
  const f = await fixture(t, { items: rules.map((rrule, index) => task({ id: 'plan-' + index, rrule })) }); await f.open();
  const labels = f.dom.get('automation-list').children.map(row => row.children[0].children[3]);
  assert.deepEqual(labels.map(node => node.textContent), ['每 30 分钟', '每 2 小时', '每天 06:00', '每周一、周二 09:30', '一次 · 2026/10/15 10:00', '自定义计划']);
  assert.deepEqual(labels.map(node => node.title), rules);
  assert.equal(f.dom.get('automation-list').textContent.includes('FREQ='), false);
});

test('cron binds only a registered project and optional native model settings, never an arbitrary cwd', async t => {
  const f = await fixture(t); await f.open(); await f.create(); f.fill('独立任务');
  assert.equal(f.dom.get('automation-kind').value, 'cron', 'Ready web-only conversations do not imply native heartbeat eligibility');
  assert.equal(f.dom.get('automation-heartbeat-fields').hidden, true); assert.equal(f.dom.get('automation-cron-fields').hidden, false);
  f.dom.get('automation-project').value = 'project'; f.dom.get('automation-model').value = 'native-model'; f.dom.event('automation-model', 'change');
  f.dom.get('automation-effort').value = 'high'; f.dom.get('automation-schedule').value = 'weekly';
  f.dom.get('automation-time').value = '06:30'; f.dom.get('automation-day-MO').checked = true; f.dom.get('automation-day-TU').checked = true;
  await f.save(); const item = f.calls.find(call => call.path.endsWith('/create')).body.item;
  assert.equal(item.kind, 'cron'); assert.equal(item.projectId, 'project'); assert.equal(item.executionEnvironment, 'local'); assert.equal(item.model, 'native-model'); assert.equal(item.reasoningEffort, 'high');
  assert.equal(item.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=6;BYMINUTE=30;BYSECOND=0');
  assert.equal(item.cwds, undefined); assert.equal(item.targetThreadId, undefined);
  await f.create(); f.fill('无项目任务'); await f.save();
  const empty = f.calls.findLast(call => call.path.endsWith('/create')).body.item;
  assert.equal(empty.kind, 'cron'); assert.equal(empty.projectId, null); assert.equal(empty.model, null); assert.equal(empty.reasoningEffort, null); assert.equal(empty.targetThreadId, undefined);
});

test('once schedules encode the host timezone and custom native rules survive editing unchanged', async t => {
  const f = await fixture(t, { items: [task({ rrule: 'DTSTART;TZID=Asia/Shanghai:20261015T100000\nRRULE:FREQ=DAILY;COUNT=1' })] });
  await f.open(); await f.create(); f.fill(); f.dom.get('automation-schedule').value = 'once'; f.dom.get('automation-once').value = '2026-10-15T10:00'; await f.save();
  assert.equal(f.calls.find(call => call.path.endsWith('/create')).body.item.rrule, 'DTSTART;TZID=Asia/Shanghai:20261015T100000\nRRULE:FREQ=DAILY;COUNT=1');
  await f.edit(); assert.equal(f.dom.get('automation-prompt').value, '完整的原生提示词'); assert.equal(f.dom.get('automation-kind').disabled, true);
  f.dom.get('automation-name').value = '改名后的任务'; await f.save();
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/update')).body, { viewId: 'view', id: 'native-task', expectedUpdatedAt: 10, patch: { name: '改名后的任务' } });
});

test('editing a task name preserves untouched prompt formatting and native recurrence whitespace', async t => {
  const f = await fixture(t, { items: [task({ prompt: '\n  保留原生提示词格式\n\n', rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0\n' })] });
  await f.open(); await f.edit(); f.dom.get('automation-name').value = '只改名称'; await f.save();
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/update')).body.patch, { name: '只改名称' });
});

test('pause, resume, open original conversation and delete use native optimistic versions and confirmation', async t => {
  const f = await fixture(t); await f.open(); await f.menu(); f.dom.get('automation-menu-toggle').click(); await delay(0);
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/update')).body.patch, { status: 'PAUSED' });
  await f.menu(); assert.equal(f.dom.get('automation-menu-toggle').textContent, '恢复任务'); f.dom.get('automation-menu-toggle').click(); await delay(0);
  assert.equal(f.calls.findLast(call => call.path.endsWith('/update')).body.expectedUpdatedAt, 11);
  await f.menu(); f.dom.get('automation-menu-open').click(); await delay(0); assert.deepEqual(f.opened, ['current']);
  await f.open(); let confirmation;
  window.confirm = text => { confirmation = text; return false; };
  await f.menu(); f.dom.get('automation-menu-delete').click(); await delay(0); assert.equal(f.calls.some(call => call.path.endsWith('/delete')), false);
  window.confirm = () => true; await f.menu(); f.dom.get('automation-menu-delete').click(); await delay(0);
  assert.match(confirmation, /会话.*保留/); assert.deepEqual(f.calls.find(call => call.path.endsWith('/delete')).body, { viewId: 'view', id: 'native-task', expectedUpdatedAt: 12, confirmed: true });
});

test('native refresh preserves keyed row focus and the complete composing edit on conflict', async t => {
  let conflict = false;
  const f = await fixture(t, { api(path) { if (conflict && path.endsWith('/update')) throw Object.assign(new Error('Native file changed'), { status: 409 }); } });
  await f.open(); const row = f.dom.get('automation-list').children[0], control = f.button('编辑 每日检查'); control.focus();
  f.panel.onEvent({ native: { method: 'automation/changed' } }); await delay(0);
  assert.equal(f.dom.get('automation-list').children[0], row); assert.equal(document.activeElement, control);
  await f.edit(); const prompt = f.dom.get('automation-prompt'); prompt.value = '正在编辑，保留 😀'; prompt.focus(); prompt.setSelectionRange(3, 3);
  f.dom.event('automation-form', 'compositionstart'); f.panel.onEvent({ native: { method: 'automation/changed' } }); await delay(0);
  assert.equal(prompt.value, '正在编辑，保留 😀'); assert.equal(prompt.selectionStart, 3); assert.equal(document.activeElement, prompt);
  await f.save(); assert.equal(f.calls.some(call => call.path.endsWith('/update')), false, 'IME does not submit');
  f.dom.event('automation-form', 'compositionend'); conflict = true; await f.save();
  assert.equal(prompt.value, '正在编辑，保留 😀'); assert.match(f.dom.get('automation-form-error').textContent, /重新打开/); assert.equal(f.dom.get('save-automation').disabled, true);
});

test('closed, replaced and disposed forms ignore late reads and saves and cannot submit twice', async t => {
  const read = deferred(), save = deferred(); let slowRead = true;
  const f = await fixture(t, { api(path) { if (slowRead && path.endsWith('/read')) return read.promise; if (path.endsWith('/create')) return save.promise; } });
  await f.open(); f.button('编辑 每日检查').click(); f.dom.get('cancel-automation').click(); await f.create(); f.fill('保留新的表单');
  read.resolve({ item: task({ name: '迟到的编辑' }) }); await delay(0); assert.equal(f.dom.get('automation-name').value, '保留新的表单');
  slowRead = false; f.dom.event('automation-form', 'submit'); f.dom.event('automation-form', 'submit'); await delay(0);
  assert.equal(f.calls.filter(call => call.path.endsWith('/create')).length, 1);
  f.dom.get('close-automations').click(); await f.open(); await f.create(); f.fill('下一次打开');
  save.resolve({ item: task({ name: '迟到的保存' }) }); await delay(0); assert.equal(f.dom.get('automation-name').value, '下一次打开');
  f.panel.dispose(); const count = f.calls.length; f.dom.get('new-automation').click(); f.panel.onEvent({ native: { method: 'automation/changed' } });
  assert.equal(f.calls.length, count); assert.equal(f.dom.get('show-automations').hidden, true);
});

test('catalog paging and delayed model discovery never block text entry or rewrite user target selection', async t => {
  const models = deferred();
  const f = await fixture(t, { api(path, body) {
    if (path !== '/api/rpc') return;
    if (body.method === 'model/list') return models.promise;
    if (body.method === 'thread/list') return { result: body.params.cursor ? { data: [{ id: 'last', name: '后页会话' }], nextCursor: null } : { data: [{ id: 'first', name: '首页会话' }], nextCursor: 'second' } };
  } });
  await f.open(); await f.create(); f.fill('目录慢也能输入');
  f.dom.get('automation-kind').value = 'heartbeat'; f.dom.event('automation-kind', 'change');
  f.dom.get('automation-thread').value = 'last'; assert.equal(f.dom.get('automation-name').disabled, false);
  models.resolve({ result: { data: [], nextCursor: null } }); await delay(0);
  assert.equal(f.dom.get('automation-name').value, '目录慢也能输入'); assert.equal(f.dom.get('automation-thread').value, 'last');
  await f.save(); assert.equal(f.calls.find(call => call.path.endsWith('/create')).body.item.targetThreadId, 'last');
});

test('navigation invalidates late native responses without altering the new conversation', async t => {
  const read = deferred(); const f = await fixture(t, { api(path) { if (path.endsWith('/read')) return read.promise; } });
  await f.open(); f.button('编辑 每日检查').click();
  const next = { ...f.state, threadId: 'next', draft: '下一页的草稿' }; f.setState(next);
  read.resolve({ item: task({ name: '旧页面回复' }) }); await delay(0);
  assert.notEqual(f.dom.get('automation-name').value, '旧页面回复'); assert.equal(next.draft, '下一页的草稿');
});

test('remounting after a reconnect replaces old task rows and their listeners', async t => {
  const f = await fixture(t); await f.open(); f.panel.dispose();
  const { mountAutomations } = await import('../../web/public/automations.js');
  const panel = mountAutomations({ api: async () => ({ items: [task({ id: 'reconnected', name: '重连后的任务' })], unavailable: [], timeZone: 'Asia/Shanghai' }), viewId: 'new-view', getState: () => f.state });
  t.after(() => panel.dispose()); await f.open();
  assert.equal(f.dom.get('automation-list').children.length, 1); assert.equal(f.dom.get('automation-list').children[0].dataset.automationId, 'reconnected');
});

test('a queued native close event cannot invalidate an already reopened dialog', async t => {
  const f = await fixture(t); await f.open(); f.dom.get('close-automations').click(); await f.open(); await f.create(); f.fill();
  f.dom.event('automations-dialog', 'close'); await f.save();
  assert.equal(f.calls.filter(call => call.path.endsWith('/create')).length, 1);
});
