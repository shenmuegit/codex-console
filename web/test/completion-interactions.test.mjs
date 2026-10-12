import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountCompletions, findTrigger } from '../public/composer.js';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';

const file = (name = 'chat.js') => ({ kind: 'file', name, path: '/work/web/public/' + name, label: '@web/public/' + name });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(t, text = '@', api = async () => ({ items: [file()] }), onCommand) {
  const dom = domFixture(), state = { ready: true, online: true, generation: 1, threadId: 't', draft: text, selections: [], settings: { cwd: '/work' } }, changes = [];
  const draft = dom.get('draft'); draft.value = text; draft.setSelectionRange(text.length, text.length);
  const menu = mountCompletions({ api, viewId: 'view', getState: () => state, onChange: value => changes.push(value.draft), onCommand });
  t.after(() => { menu.dispose(); dom.restore(); });
  return { dom, state, draft, menu, changes, options: () => dom.get('completion-menu').children.filter(node => node.tagName === 'BUTTON'),
    input(text, caret = text.length) { state.draft = draft.value = text; draft.setSelectionRange(caret, caret); dom.event('draft', 'input'); },
    key(key, fields = {}) { return dom.event('draft', 'keydown', { key, ...fields }); },
  };
}

test('Escape invalidates an in-flight mention search instead of reopening the popup', async t => {
  const response = deferred(), f = fixture(t, '@chat', () => response.promise); const loading = f.menu.refresh();
  assert.equal(f.key('Escape').defaultPrevented, true); response.resolve({ items: [file()] }); await loading;
  assert.equal(f.dom.get('completion-menu').hidden, true); assert.equal(f.draft.getAttribute('aria-expanded'), 'false');
});

test('typing invalidates old results before the debounce and Enter cannot submit an unresolved mention', async t => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const f = fixture(t, '@old', () => ++calls === 1 ? old.promise : fresh.promise); const loading = f.menu.refresh();
  f.input('@new'); old.resolve({ items: [file('old.js')] }); await loading;
  assert.equal(f.options().length, 0); assert.equal(f.key('Enter').defaultPrevented, true); assert.equal(f.state.draft, '@new');
  await delay(180); fresh.resolve({ items: [file('new.js')] }); await delay(0);
  f.key('Enter'); assert.equal(f.state.draft, '@web/public/new.js ');
});

test('IME start closes pending search results and cannot accept or send a candidate', async t => {
  const response = deferred(), f = fixture(t, '@中文', () => response.promise), loading = f.menu.refresh();
  f.state.composing = true; f.dom.event('draft', 'compositionstart'); response.resolve({ items: [file()] }); await loading;
  assert.equal(f.dom.get('completion-menu').hidden, true); assert.equal(f.key('Enter', { isComposing: true }).defaultPrevented, false); assert.equal(f.state.draft, '@中文');
});

test('keyboard navigation skips unavailable entries and empty results do not send raw mentions', async t => {
  const f = fixture(t, '@', async () => ({ items: [{ kind: 'app', id: 'app', name: 'Unavailable', label: '@Unavailable', disabled: true }, file(), { ...file('last.js'), disabled: true }, file('end.js')] }));
  await f.menu.refresh(); assert.equal(f.options()[1].getAttribute('aria-selected'), 'true');
  f.key('End'); assert.equal(f.options()[3].getAttribute('aria-selected'), 'true'); f.key('ArrowDown'); assert.equal(f.options()[1].getAttribute('aria-selected'), 'true');
  f.key('ArrowUp'); assert.equal(f.options()[3].getAttribute('aria-selected'), 'true'); f.key('Home'); f.key('Tab');
  assert.equal(f.state.draft, '@web/public/chat.js '); assert.equal(f.state.selections[0].path, '/work/web/public/chat.js');
});

test('unavailable-only and empty mention menus consume Enter but leave Shift+Enter unchanged', async t => {
  for (const items of [[], [{ kind: 'app', id: 'app', name: 'Unavailable', label: '@Unavailable', disabled: true }]]) await t.test(items.length ? 'unavailable' : 'empty', async t => {
    const f = fixture(t, '@', async () => ({ items })); await f.menu.refresh();
    assert.equal(f.key('Enter').defaultPrevented, true); assert.equal(f.key('Enter', { shiftKey: true }).defaultPrevented, false); assert.equal(f.state.draft, '@');
  });
});

test('caret movement and a changed connection generation invalidate old candidates', async t => {
  const response = deferred(), f = fixture(t, '@chat rest', () => response.promise); f.draft.setSelectionRange(5, 5); const loading = f.menu.refresh();
  f.draft.setSelectionRange(10, 10); f.dom.event('draft', 'click'); response.resolve({ items: [file()] }); await loading;
  assert.equal(f.dom.get('completion-menu').hidden, true);
  f.input('@chat'); await f.menu.refresh(); f.state.generation = 2; f.options()[0].click(); assert.equal(f.state.draft, '@chat');
  assert.equal(f.dom.get('completion-menu').hidden, true);
});

test('pending results close when the workspace changes and editing a bound mention searches on the first keystroke', async t => {
  const response = deferred(), f = fixture(t, '@chat', () => response.promise), loading = f.menu.refresh();
  f.state.settings.cwd = '/other'; response.resolve({ items: [file()] }); await loading; assert.equal(f.dom.get('completion-menu').hidden, true);
  f.state.settings.cwd = '/work'; await f.menu.refresh(); f.key('Enter');
  f.input('@web/Xpublic/chat.js ', 6); await delay(180);
  assert.equal(f.dom.get('completion-menu').hidden, false); assert.ok(f.options().length);
});

test('outside clicks and Shift+Tab close the popup without modifying the draft', async t => {
  const f = fixture(t); await f.menu.refresh(); const backward = f.key('Tab', { shiftKey: true });
  assert.equal(backward.defaultPrevented, false); assert.equal(f.dom.get('completion-menu').hidden, true);
  await f.menu.refresh(); f.dom.document.body.dispatchEvent(new Event('pointerdown')); assert.equal(f.dom.get('completion-menu').hidden, true); assert.equal(f.state.draft, '@');
});

test('choosing from inside a word replaces the complete trigger and binds only the selected path', async t => {
  const f = fixture(t, '请看 @chaOLD 后文'); f.draft.setSelectionRange(7, 7); await f.menu.refresh(); f.key('Enter');
  assert.equal(f.state.draft, '请看 @web/public/chat.js 后文');
  assert.deepEqual(f.state.selections, [{ kind: 'file', path: '/work/web/public/chat.js', start: 3, end: 22, token: '@web/public/chat.js' }]);
});

test('quoted path search supports spaces without consuming surrounding text or reopening a bound mention', async t => {
  const f = fixture(t, '看 @"My Folder/in" 后文'); f.draft.setSelectionRange(16, 16);
  assert.deepEqual(findTrigger(f.draft.value, 16), { sigil: '@', query: 'My Folder/in', start: 2, end: 17 });
  assert.deepEqual(findTrigger(f.draft.value, 17), { sigil: '@', query: 'My Folder/in', start: 2, end: 17 });
  await f.menu.refresh(); f.key('Enter'); f.draft.setSelectionRange(f.state.selections[0].end, f.state.selections[0].end); await f.menu.refresh();
  assert.equal(f.dom.get('completion-menu').hidden, true);
});

test('slash choices have Chinese descriptions and can be searched by their meaning', async t => {
  const f = fixture(t, '/压缩', async () => assert.fail('Slash commands are local'));
  await f.menu.refresh(); assert.equal(f.options().length, 1); assert.match(f.options()[0].textContent, /compact.*压缩/);
  f.key('Enter'); assert.equal(f.state.draft, '/compact ');
});

test('root folder candidates show their type instead of repeating the same name as their path', async t => {
  const f = fixture(t, '@', async () => ({ items: [{ kind: 'directory', name: 'web', path: '/work/web', label: '@web' }] }));
  await f.menu.refresh(); assert.equal(f.options()[0].children[0].textContent, 'web'); assert.equal(f.options()[0].children[1].textContent, '文件夹');
});

test('choosing a slash command invokes its existing handler once after updating the draft', async t => {
  const commands = [], f = fixture(t, '/fo', async () => assert.fail(), command => commands.push(command));
  await f.menu.refresh(); f.key('Enter'); assert.deepEqual(commands, ['fork']); assert.equal(f.state.draft, '/fork '); assert.equal(f.dom.get('completion-menu').hidden, true);
});

test('literal shell variables still send as text after an empty skill search', async t => {
  const f = fixture(t, '$HOME', async () => ({ items: [] })); await f.menu.refresh(); assert.equal(f.key('Enter').defaultPrevented, false); assert.equal(f.state.selections.length, 0);
});

test('mounted chat chooses /skills directly without sending a model message', async t => {
  const dom = domFixture(), sent = []; let chat;
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => {
    sent.push({ path, body }); if (path === '/api/thread/open') return { snapshot: resumeFixture('t'), cursor: { generation: 1, seq: 1 } };
    if (path === '/api/completions') return { items: [{ kind: 'skill', name: 'native-skill', path: '/work/SKILL.md', label: '$native-skill' }] };
    return { result: { data: [], nextCursor: null } };
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('t');
  chat.getState().draft = dom.get('draft').value = '/sk'; dom.get('draft').setSelectionRange(3, 3); dom.event('draft', 'input'); await delay(180);
  dom.event('draft', 'keydown', { key: 'Enter' }); await delay(0);
  assert.equal(chat.getState().draft, '$'); assert.equal(sent.some(call => call.path === '/api/thread/send'), false);
  assert.ok(sent.some(call => call.path === '/api/completions' && call.body.sigil === '$'));
});

test('native fuzzy mention search stays in the open workspace and excludes outside results', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId); t.after(() => stream.req.destroy());
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  for (let n = 0; n < 100 && !f.peer.sent.some(call => call.method === 'thread/resume'); n++) await delay(5);
  const snapshot = resumeFixture('t'); snapshot.cwd = snapshot.thread.cwd = f.dir; f.peer.replyTo('thread/resume', snapshot); await opening;
  const results = { fuzzyFileSearch: { files: [{ root: f.dir, path: 'web/public/chat.js', file_name: 'chat.js', match_type: 'file', score: 40, indices: null },
    { root: f.dir, path: '../outside.txt', file_name: 'outside.txt', match_type: 'file', score: 30, indices: null }] },
    'fs/readDirectory': { entries: [] }, 'thread/list': { data: [], nextCursor: null }, 'app/list': { data: [], nextCursor: null }, 'app/installed': { apps: [] }, 'plugin/installed': { marketplaces: [] } }, answered = new Set();
  const timer = setInterval(() => { for (const call of f.peer.sent) if (results[call.method] && !answered.has(call.id)) { answered.add(call.id); f.peer.emit({ id: call.id, result: results[call.method] }); } }, 5); t.after(() => clearInterval(timer));
  const response = await f.request('/api/completions', { method: 'POST', cookie, body: { viewId, threadId: 't', sigil: '@', query: 'chat' } });
  assert.equal(response.status, 200); assert.deepEqual(f.peer.sent.find(call => call.method === 'fuzzyFileSearch')?.params.roots, [f.dir]);
  assert.equal(response.json.items.length, 1); assert.equal(response.json.items[0].path, f.dir + '/web/public/chat.js'); assert.equal(response.json.items[0].label, '@web/public/chat.js');
  const denied = await f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'fuzzyFileSearch', params: { query: 'secret', roots: ['/'] } } }); assert.equal(denied.status, 403);
});
