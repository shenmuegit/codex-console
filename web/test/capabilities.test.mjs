import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsFixture, resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';
import { insertSelection, encodeComposer } from '../public/composer.js';

const skill = (path = '/work/review/SKILL.md') => ({ kind: 'skill', name: 'review', path, label: '$review', displayName: '代码审查', description: '检查代码和回归风险', source: 'Ponytail 插件', status: '可用', disabled: false, pluginId: 'pony@market', keywords: ['审查'] });
const plugin = () => ({ kind: 'plugin', id: 'pony@market', name: 'pony', label: '@pony', displayName: 'Ponytail', description: '代码质量工具', source: '已安装插件', status: '可用', disabled: false, keywords: ['代码'], skills: [skill()] });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t, api = async (_path, body) => ({ items: body.section === 'apps' ? [] : [skill(), plugin()], unavailable: [] }), host = 'local') {
  const dom = domFixture(), state = { ready: true, online: true, generation: 1, threadId: 't', draft: '请检查 😀 后文', selections: [], settings: { cwd: '/work' } };
  const draft = dom.get('draft'); draft.value = state.draft; draft.setSelectionRange(4, 4);
  const { mountCapabilities } = await import('../public/capabilities.js');
  const changes = [], picker = mountCapabilities({ api, viewId: 'view', selectedHost: host, getState: () => state, onChange: value => changes.push(value.draft) });
  picker.render(); t.after(() => { picker.dispose(); dom.restore(); });
  const buttons = () => dom.get('capability-results').querySelectorAll('button');
  return { dom, state, draft, picker, changes, async open() { dom.get('show-capabilities').click(); await delay(0); },
    choose(name = '代码审查') { buttons().find(node => !node.disabled && node.getAttribute('aria-label') === '选择 ' + name)?.click(); },
    button(label) { return buttons().find(node => node.getAttribute('aria-label') === label); } };
}

async function catalogFixture(t, results = {}) {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  t.after(() => stream.req.destroy());
  const answered = new Set(), timer = setInterval(() => {
    for (const call of f.peer.sent) if (!answered.has(call.id)) {
      let result;
      if (call.method === 'thread/resume') { result = resumeFixture('t'); result.cwd = result.thread.cwd = f.dir; }
      else if (call.method === 'skills/list') result = results.skills ?? { data: [{ cwd: f.dir, skills: [{ name: 'review', description: '检查回归', path: f.dir + '/SKILL.md', scope: 'user', enabled: true, pluginId: 'pony@market', interface: { displayName: '代码审查' } }], errors: [] }] };
      else if (call.method === 'plugin/installed') result = results.plugins ?? { marketplaces: [{ plugins: [{ id: 'pony@market', name: 'pony', installed: true, enabled: true, availability: 'AVAILABLE', keywords: ['代码'], interface: { displayName: 'Ponytail', shortDescription: '代码质量工具' } }] }] };
      else if (call.method === 'app/list') result = results.apps ? results.apps(call.params) : { data: [{ id: 'app-1', name: 'GitHub', description: '仓库和代码', isEnabled: true, isAccessible: true }], nextCursor: null };
      else if (call.method === 'app/installed') result = { apps: [{ id: 'app-1', enabled: true, callable: true }] };
      else if (call.method === 'turn/start') result = { turn: { id: 'accepted', status: 'inProgress', items: [] } };
      if (result !== undefined) { answered.add(call.id); f.peer.emit(result instanceof Error ? { id: call.id, error: { code: -32601, message: result.message } } : { id: call.id, result }); }
    }
  }, 5); t.after(() => clearInterval(timer));
  await f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  return { ...f, cookie, viewId, catalog: (options = {}) => f.request('/api/capabilities', { method: 'POST', cookie, body: { viewId, threadId: 't', ...options } }) };
}

test('catalog uses the opened native workspace, includes metadata and plugin skills, and excludes file/thread searches', async t => {
  const f = await catalogFixture(t), response = await f.catalog(); assert.equal(response.status, 200);
  const asset = await f.request('/capabilities.js'); assert.equal(asset.status, 200); assert.match(asset.headers['content-type'], /javascript/);
  const item = response.json.items.find(item => item.kind === 'skill');
  assert.equal(item.displayName, '代码审查'); assert.equal(item.description, '检查回归'); assert.match(item.source, /Ponytail/);
  assert.equal(response.json.items.find(item => item.kind === 'plugin').skills[0].path, f.dir + '/SKILL.md');
  assert.equal(response.json.items.find(item => item.kind === 'app').disabled, false);
  for (const method of ['skills/list', 'plugin/installed']) assert.deepEqual(f.peer.sent.findLast(call => call.method === method).params.cwds, [f.dir]);
  assert.equal(f.peer.sent.some(call => ['fs/readDirectory', 'fuzzyFileSearch', 'thread/list'].includes(call.method)), false);
  assert.equal((await f.request('/api/capabilities', { method: 'POST', cookie: f.cookie, body: { viewId: f.viewId, threadId: 'other' } })).status, 403);
  assert.equal((await f.request('/api/capabilities', { method: 'POST', cookie: f.cookie, body: { viewId: f.viewId, threadId: 't', cwd: '/other' } })).status, 400);
});

test('catalog preserves usable sources on partial failure and loads connector pages beyond the first hundred', async t => {
  const f = await catalogFixture(t, { skills: new Error('Skills offline'), apps: params => params.cursor ? { data: [{ id: 'last', name: 'Last app', isEnabled: false, isAccessible: true }], nextCursor: null } : { data: Array.from({ length: 100 }, (_, i) => ({ id: 'app-' + i, name: 'App ' + i, isEnabled: true, isAccessible: true })), nextCursor: 'next' } });
  const response = await f.catalog(); assert.equal(response.status, 200);
  assert.equal(response.json.items.filter(item => item.kind === 'app').length, 101);
  assert.equal(response.json.items.find(item => item.id === 'last').status, '未启用');
  assert.ok(response.json.unavailable.some(issue => issue.kind === '技能' && issue.message.includes('Skills offline')));
});

test('explicit catalog refresh forces native discovery and preserves native skill/marketplace errors', async t => {
  const f = await catalogFixture(t, { skills: { data: [{ skills: [{ name: 'okay', path: '/skills/okay/SKILL.md', enabled: true }], errors: [{ path: '/skills/bad', message: 'Unreadable skill' }] }] }, plugins: { marketplaces: [], marketplaceLoadErrors: [{ message: 'Unreadable marketplace' }] } });
  const response = await f.catalog({ refresh: true }); assert.equal(response.status, 200); assert.ok(response.json.items.some(item => item.name === 'okay'));
  assert.ok(response.json.unavailable.some(issue => issue.message.includes('Unreadable skill')));
  assert.ok(response.json.unavailable.some(issue => issue.message.includes('Unreadable marketplace')));
  assert.equal(f.peer.sent.findLast(call => call.method === 'skills/list').params.forceReload, true);
  assert.equal(f.peer.sent.findLast(call => call.method === 'app/list').params.forceRefetch, true);
  assert.equal(f.peer.sent.findLast(call => call.method === 'app/installed').params.forceRefresh, true);
});

test('workspace capabilities return without reading the external app catalog', async t => {
  const f = await catalogFixture(t), response = await f.catalog({ section: 'workspace' }); assert.equal(response.status, 200);
  assert.ok(response.json.items.some(item => item.kind === 'skill')); assert.ok(response.json.items.some(item => item.kind === 'plugin'));
  assert.equal(f.peer.sent.some(call => ['app/list', 'app/installed'].includes(call.method)), false);
  assert.notEqual(f.peer.sent.findLast(call => call.method === 'skills/list').params.forceReload, true);
});

test('apps can load separately and normal catalog reads do not force native refetches', async t => {
  const f = await catalogFixture(t), response = await f.catalog({ section: 'apps' }); assert.equal(response.status, 200);
  assert.deepEqual(response.json.items.map(item => item.kind), ['app']);
  assert.equal(f.peer.sent.some(call => ['skills/list', 'plugin/installed'].includes(call.method)), false);
  assert.notEqual(f.peer.sent.findLast(call => call.method === 'app/list').params.forceRefetch, true);
  assert.notEqual(f.peer.sent.findLast(call => call.method === 'app/installed').params.forceRefresh, true);
  for (const options of [{ section: 'all' }, { refresh: 'true' }]) assert.equal((await f.catalog(options)).status, 400);
});

test('a later connector page failure retains usable entries from successful pages', async t => {
  const f = await catalogFixture(t, { apps: params => params.cursor ? new Error('Second app page offline') : { data: [{ id: 'app-1', name: 'GitHub', isEnabled: true, isAccessible: true }], nextCursor: 'second' } });
  const response = await f.catalog(); assert.equal(response.status, 200);
  assert.equal(response.json.items.find(item => item.id === 'app-1')?.disabled, false);
  assert.ok(response.json.unavailable.some(issue => issue.message.includes('Second app page offline')));
});

test('inserting before existing bound text preserves both native identities even when tokens share a prefix', () => {
  for (const token of ['$documents', '$review']) {
    const state = { draft: '$review 后文', selections: [{ kind: 'skill', path: '/old/SKILL.md', start: 0, end: 7, token: '$review' }] };
    insertSelection(state, { kind: 'skill', name: token.slice(1), path: '/new/SKILL.md', label: token }, { start: 0, end: 0 });
    assert.equal(state.selections.length, 2); assert.equal(state.selections.find(item => item.path === '/old/SKILL.md').start, token.length + 1);
    const encoded = encodeComposer({ text: state.draft, selections: state.selections, uploads: [], threadId: 't', mode: 'start' });
    assert.deepEqual(new Set(encoded.input.filter(item => item.type === 'skill').map(item => item.path)), new Set(['/old/SKILL.md', '/new/SKILL.md']));
  }
});

test('picker identities are resolved to native typed inputs at send time and newly disabled skills are rejected', async t => {
  const f = await catalogFixture(t), token = '$review @pony', path = f.dir + '/SKILL.md';
  const draft = { text: token, selections: [{ kind: 'skill', path, token: '$review', start: 0, end: 7 }, { kind: 'plugin', id: 'pony@market', token: '@pony', start: 8, end: 13 }] };
  const response = await f.request('/api/thread/send', { method: 'POST', cookie: f.cookie, body: { viewId: f.viewId, threadId: 't', clientUserMessageId: 'picker-send', mode: 'start', draft } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.peer.sent.findLast(call => call.method === 'turn/start').params.input.slice(1), [{ type: 'skill', name: 'review', path }, { type: 'mention', name: 'pony', path: 'plugin://pony@market' }]);
  const disabled = await catalogFixture(t, { skills: { data: [{ skills: [{ name: 'review', path: f.dir + '/SKILL.md', enabled: false }] }] } });
  assert.equal((await disabled.request('/api/thread/send', { method: 'POST', cookie: disabled.cookie, body: { viewId: disabled.viewId, threadId: 't', clientUserMessageId: 'disabled-picker-send', mode: 'start', draft: { text: '$review', selections: [{ kind: 'skill', path: f.dir + '/SKILL.md', token: '$review', start: 0, end: 7 }] } } })).status, 422);
  assert.equal(disabled.peer.sent.some(call => call.method === 'turn/start'), false);
});

test('picker inserts distinct native bindings at the caret, prevents duplicates and removes only the selected token', async t => {
  const f = await fixture(t); await f.open(); f.choose();
  assert.match(f.state.draft, /\$review/); assert.match(f.state.draft, /😀 后文/); assert.equal(f.state.selections.length, 1);
  f.choose(); assert.equal(f.state.selections.length, 1);
  f.dom.get('capability-tab-plugins').click(); f.choose('Ponytail'); assert.equal(f.state.selections.length, 2);
  const before = f.state.draft; f.dom.get('selected-capabilities').querySelectorAll('button').find(node => node.getAttribute('aria-label') === '移除 代码审查').click();
  assert.equal(f.state.draft, before.replace('$review', '')); assert.equal(f.state.selections[0].id, 'pony@market');
  assert.equal(f.state.draft.slice(f.state.selections[0].start, f.state.selections[0].end), '@pony');
  assert.equal(f.changes.length, 3);
});

test('purpose search, favorites, recent selections and plugin details remain discoverable', async t => {
  const f = await fixture(t); await f.open();
  f.dom.get('capability-search').value = '回归'; f.dom.event('capability-search', 'input'); assert.ok(f.button('选择 代码审查'));
  f.button('收藏 代码审查').click(); f.choose();
  f.dom.get('capability-search').value = ''; f.dom.event('capability-search', 'input'); f.dom.get('capability-filter-favorites').click(); assert.ok(f.button('取消收藏 代码审查'));
  f.dom.get('capability-filter-recent').click(); assert.match(f.dom.get('capability-results').textContent, /代码审查/);
  f.dom.get('capability-filter-all').click(); f.dom.get('capability-tab-plugins').click(); f.button('查看 Ponytail 详情').click();
  assert.match(f.dom.get('capability-details').textContent, /包含.*技能/); assert.match(f.dom.get('capability-details').textContent, /代码审查/);
});

test('picker invalidates delayed responses on close, reconnection and workspace change', async t => {
  for (const reason of ['close', 'generation', 'cwd']) await t.test(reason, async t => {
    const response = deferred(), f = await fixture(t, () => response.promise); await f.open();
    if (reason === 'close') f.picker.close(); else { if (reason === 'generation') f.state.generation++; else f.state.settings.cwd = '/other'; f.picker.render(); }
    response.resolve({ items: [skill()], unavailable: [] }); await delay(0);
    assert.equal(f.dom.get('capabilities-dialog').open, false); assert.equal(f.state.selections.length, 0);
  });
});

test('disabled choices explain their state and keyboard Enter during IME never selects', async t => {
  const f = await fixture(t, async () => ({ items: [{ ...skill(), disabled: true, status: '未启用' }], unavailable: [] })); await f.open();
  assert.match(f.dom.get('capability-results').textContent, /未启用/); assert.equal(f.button('选择 代码审查').disabled, true);
  assert.equal(f.dom.event('capability-search', 'keydown', { key: 'Enter', isComposing: true }).defaultPrevented, false);
  f.dom.event('capability-search', 'keydown', { key: 'Enter' }); assert.equal(f.state.selections.length, 0);
  f.dom.event('capabilities-dialog', 'cancel'); assert.equal(f.dom.get('capabilities-dialog').open, false);
});

test('favorites and recent selections survive remounts but do not cross hosts or workspaces', async t => {
  const f = await fixture(t); await f.open(); f.button('收藏 代码审查').click(); f.choose(); f.picker.dispose();
  const { mountCapabilities } = await import('../public/capabilities.js');
  for (const host of ['local', 'other-host']) {
    const picker = mountCapabilities({ api: async () => ({ items: [skill()], unavailable: [] }), viewId: 'view', selectedHost: host, getState: () => f.state, onChange() {} });
    picker.render(); f.dom.get('show-capabilities').click(); await delay(0); f.dom.get('capability-filter-favorites').click();
    assert.equal(f.dom.get('capability-results').textContent.includes('代码审查'), host === 'local');
    f.dom.get('capability-filter-recent').click(); assert.equal(f.dom.get('capability-results').textContent.includes('代码审查'), host === 'local');
    if (host === 'local') { f.state.settings.cwd = '/another-workspace'; picker.render(); f.dom.get('show-capabilities').click(); await delay(0); f.dom.get('capability-filter-favorites').click(); assert.equal(f.dom.get('capability-results').textContent.includes('代码审查'), false); f.state.settings.cwd = '/work'; }
    picker.dispose();
  }
});

test('blocked or corrupted browser storage never prevents selection', async t => {
  for (const reason of ['blocked', 'corrupt']) await t.test(reason, async t => {
    const f = await fixture(t);
    if (reason === 'blocked') { localStorage.getItem = () => { throw new Error('Storage denied'); }; localStorage.setItem = () => { throw new Error('Storage denied'); }; }
    else localStorage.setItem(JSON.stringify(['codex-capabilities', 'local', '/work']), '{broken');
    // Change scope and return to force a fresh read, as on a page reload.
    f.state.settings.cwd = '/other'; f.picker.render(); f.state.settings.cwd = '/work'; f.picker.render();
    await f.open(); f.button('收藏 代码审查').click(); f.choose(); assert.equal(f.state.selections.length, 1);
    f.dom.get('capability-filter-favorites').click(); assert.match(f.dom.get('capability-results').textContent, /代码审查/);
  });
});

test('page-memory preferences survive switching away and back when storage is blocked', async t => {
  const f = await fixture(t); localStorage.getItem = localStorage.setItem = () => { throw new Error('Storage denied'); };
  await f.open(); f.button('收藏 代码审查').click(); f.choose();
  f.state.settings.cwd = '/other'; f.picker.render(); f.state.settings.cwd = '/work'; f.picker.render(); await f.open();
  f.dom.get('capability-filter-favorites').click(); assert.match(f.dom.get('capability-results').textContent, /代码审查/);
  f.dom.get('capability-filter-recent').click(); assert.match(f.dom.get('capability-results').textContent, /代码审查/);
});

test('denied writes cannot replace newer page preferences with old readable storage', async t => {
  const f = await fixture(t), key = JSON.stringify(['codex-capabilities', 'local', '/work']);
  localStorage.setItem(key, JSON.stringify({ favorites: [], recent: [] })); localStorage.setItem = () => { throw new Error('Quota exceeded'); };
  await f.open(); f.button('收藏 代码审查').click(); f.choose();
  f.state.settings.cwd = '/other'; f.picker.render(); f.state.settings.cwd = '/work'; f.picker.render(); await f.open();
  f.dom.get('capability-filter-favorites').click(); assert.match(f.dom.get('capability-results').textContent, /代码审查/);
  assert.doesNotMatch(f.dom.get('capability-status').textContent, /使用保存在此浏览器/);
  f.dom.get('capability-filter-recent').click(); assert.match(f.dom.get('capability-results').textContent, /代码审查/);
});

test('recent selection does not erase a favorite updated by another browser view', async t => {
  const f = await fixture(t), key = JSON.stringify(['codex-capabilities', 'local', '/work']), favorite = JSON.stringify(['skill', skill().path]);
  localStorage.setItem(key, JSON.stringify({ favorites: [favorite], recent: [] })); f.picker.remember(plugin());
  assert.deepEqual(JSON.parse(localStorage.getItem(key)).favorites, [favorite]);
});

test('page-memory favorites survive recreating the chat controller while storage is blocked', async t => {
  const f = await fixture(t); localStorage.getItem = localStorage.setItem = () => { throw new Error('Storage denied'); };
  await f.open(); f.button('收藏 代码审查').click(); f.picker.dispose();
  const { mountCapabilities } = await import('../public/capabilities.js');
  const picker = mountCapabilities({ api: async () => ({ items: [skill()], unavailable: [] }), viewId: 'view', getState: () => f.state, onChange() {} });
  picker.render(); f.dom.get('show-capabilities').click(); await delay(0); f.dom.get('capability-filter-favorites').click();
  assert.match(f.dom.get('capability-results').textContent, /代码审查/); picker.dispose();
});

test('failed refreshes cannot re-enable selectable stale catalog entries', async t => {
  let calls = 0; const f = await fixture(t, async () => { if (++calls === 1) return { items: [skill()], unavailable: [] }; throw new Error('Catalog offline'); });
  await f.open(); f.dom.get('refresh-capabilities').click(); await delay(0);
  assert.ok(f.button('选择 代码审查') === undefined); assert.match(f.dom.get('capability-status').textContent, /Catalog offline/);
  assert.equal(f.state.selections.length, 0);
});

test('search composition suppresses even an unflagged Enter until composition ends', async t => {
  const f = await fixture(t); await f.open(); f.dom.event('capability-search', 'compositionstart');
  f.dom.event('capability-search', 'keydown', { key: 'Enter' }); assert.equal(f.state.selections.length, 0);
  f.dom.event('capability-search', 'compositionend'); f.dom.event('capability-search', 'keydown', { key: 'Enter' }); assert.equal(f.state.selections.length, 1);
});

test('cached choices cannot be selected while an explicit native refresh is pending', async t => {
  const response = deferred(); let calls = 0;
  const f = await fixture(t, () => ++calls === 1 ? { items: [skill()], unavailable: [] } : response.promise);
  await f.open(); f.dom.get('refresh-capabilities').click(); await delay(0); f.choose(); assert.equal(f.state.selections.length, 0);
  response.resolve({ items: [{ ...skill(), disabled: true, status: '未启用' }], unavailable: [] }); await delay(0); assert.equal(f.button('选择 代码审查').disabled, true);
});

test('reopening a successfully loaded picker uses its page cache immediately', async t => {
  const calls = [], f = await fixture(t, async (_path, body) => { calls.push(body); return { items: [skill(), plugin()], unavailable: [] }; });
  await f.open(); f.picker.close(); await f.open(); assert.equal(calls.length, 1);
  f.choose(); assert.equal(f.state.selections.length, 1); assert.equal(f.dom.get('capabilities-dialog').open, true);
});

test('apps load lazily while local plugins remain usable, including after a selection changes the draft', async t => {
  const apps = deferred(), calls = [], f = await fixture(t, async (_path, body) => {
    calls.push(body); return body.section === 'apps' ? apps.promise : { items: [skill(), plugin()], unavailable: [] };
  });
  await f.open(); assert.deepEqual(calls.map(call => call.section), ['workspace']);
  f.dom.get('capability-tab-plugins').click(); await delay(0);
  assert.deepEqual(calls.map(call => call.section), ['workspace', 'apps']);
  assert.equal(f.button('选择 Ponytail').disabled, false); f.choose('Ponytail'); assert.equal(f.state.selections.length, 1);
  apps.resolve({ items: [{ kind: 'app', id: 'github', name: 'GitHub', label: '@GitHub', status: '可用', disabled: false }], unavailable: [] }); await delay(0);
  assert.equal(f.dom.get('capabilities-dialog').open, true); assert.equal(f.button('选择 GitHub').disabled, false);
  f.picker.close(); await f.open(); assert.equal(calls.length, 2);
});

test('catalog caches stay separate for native generations, conversations and workspaces', async t => {
  for (const scope of ['generation', 'thread', 'cwd']) await t.test(scope, async t => {
    let reads = 0; const f = await fixture(t, async () => { reads++; return { items: [skill()], unavailable: [] }; });
    await f.open(); f.picker.close();
    if (scope === 'generation') f.state.generation++; else if (scope === 'thread') f.state.threadId = 'other'; else f.state.settings.cwd = '/other';
    f.picker.render(); await f.open(); assert.equal(reads, 2);
    f.picker.close(); await f.open(); assert.equal(reads, 2);
  });
});

test('late app catalogs leave the already opened local plugin details intact', async t => {
  const apps = deferred(), f = await fixture(t, async (_path, body) => body.section === 'apps' ? apps.promise : { items: [skill(), plugin()], unavailable: [] });
  await f.open(); f.dom.get('capability-tab-plugins').click(); await delay(0); f.button('查看 Ponytail 详情').click();
  const heading = f.dom.get('capability-details').children[1]; assert.equal(f.dom.get('capability-details').hidden, false);
  apps.resolve({ items: [], unavailable: [] }); await delay(0);
  assert.equal(f.dom.get('capability-details').hidden, false); assert.ok(f.dom.get('capability-details').children[1] === heading);
  assert.doesNotMatch(f.dom.get('capability-status').textContent, /正在读取/);
});

test('account invalidation closes the picker and discards pending catalog responses', async t => {
  const apps = deferred(), calls = [], f = await fixture(t, async (_path, body) => { calls.push(body.section); return body.section === 'apps' ? apps.promise : { items: [skill(), plugin()], unavailable: [] }; });
  await f.open(); f.dom.get('capability-tab-plugins').click(); await delay(0); f.picker.invalidate();
  apps.resolve({ items: [], unavailable: [] }); await delay(0); assert.equal(f.dom.get('capabilities-dialog').open, false);
  await f.open(); assert.deepEqual(calls, ['workspace', 'apps', 'workspace', 'apps']);
});

test('streaming renders preserve keyboard focus on unchanged selected tags', async t => {
  const f = await fixture(t); await f.open(); f.choose(); f.picker.close();
  const chip = f.dom.get('selected-capabilities').querySelectorAll('button')[0]; chip.focus(); f.picker.render();
  assert.equal(f.dom.document.activeElement, chip); assert.equal(chip.isConnected, true);
});

test('duplicate skill names keep separate native paths and tag removal preserves the other binding', async t => {
  const f = await fixture(t, async () => ({ items: [skill(), skill('/work/other/SKILL.md')], unavailable: [] })); await f.open(); f.choose(); f.choose();
  assert.match(f.dom.get('capability-results').textContent, /\/work\/other\/SKILL.md/);
  assert.equal(f.state.selections.length, 2); assert.notEqual(f.state.selections[0].path, f.state.selections[1].path);
  f.dom.get('selected-capabilities').querySelectorAll('button')[0].click(); assert.equal(f.state.selections.length, 1);
  assert.equal(f.state.selections[0].path, '/work/other/SKILL.md'); assert.equal(f.state.draft.slice(f.state.selections[0].start, f.state.selections[0].end), '$review');
});
