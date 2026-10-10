import { displayNativeText, mountAttachments, mountCompletions, commandAction, updateSelections } from './composer.js';
import { mountUsage } from './usage.js';

export function createChatState(threadId) {
  return { threadId, thread: null, turns: [], settings: {}, cursor: null, generation: null,
    ready: false, resync: false, buffer: [], bufferBytes: 0, historyCursor: null, draft: '', selections: [], attachments: [], pending: null, commandPending: false, requests: new Map() };
}
const copy = value => structuredClone(value);
const sameCursor = (a, b) => a && b && a.generation === b.generation && a.seq === b.seq;
const activeTurn = state => state.turns.findLast(t => t.status === 'inProgress');

function stampItems(turns, cursor, presentations = []) {
  const rendered = new Map(presentations.map(item => [item.id, item]));
  for (const turn of turns) for (const item of turn.items ?? []) {
    item._cursor = cursor;
    if (rendered.has(item.id)) item._presentation = rendered.get(item.id);
  }
  return turns;
}

export function installSnapshot(state, { snapshot, cursor }) {
  if (snapshot.thread.id !== state.threadId || (state.generation != null && cursor.generation < state.generation) ||
      (state.ready && cursor.generation === state.cursor?.generation && cursor.seq <= state.cursor.seq)) return state;
  const buffered = state.buffer;
  state.thread = copy(snapshot.thread);
  state.settings = { model: snapshot.model, effort: snapshot.reasoningEffort, approvalPolicy: snapshot.approvalPolicy,
    sandbox: snapshot.sandbox, cwd: snapshot.cwd, activePermissionProfile: snapshot.activePermissionProfile };
  state.turns = stampItems(copy(snapshot.initialTurnsPage?.data ?? snapshot.thread.turns ?? []).reverse(), cursor, snapshot.transcript?.items);
  state.error = state.turns.at(-1)?.error?.message ?? null;
  state.historyCursor = snapshot.initialTurnsPage?.nextCursor ?? null;
  state.cursor = cursor; state.generation = cursor.generation; state.ready = true; state.resync = false;
  state.buffer = []; state.bufferBytes = 0; state.requests.clear();
  for (const event of buffered) if (event.cursor.generation === cursor.generation && event.cursor.seq > cursor.seq) applyNativeEvent(state, event);
  reconcilePending(state);
  return state;
}

function reconcilePending(state) {
  if (state.pending && state.turns.some(t => t.items?.some(item => item.type === 'userMessage' && item.clientId === state.pending.id))) {
    settleSend(state, state.pending.id, { ok: true });
  }
}

export function prependHistory(state, page, cursor = state.cursor) {
  const ids = new Set(state.turns.map(t => t.id));
  const older = stampItems(copy(page.data).reverse().filter(t => !ids.has(t.id)), cursor, page.transcript?.items);
  state.turns.unshift(...older); state.historyCursor = page.nextCursor;
  reconcilePending(state);
  return state;
}

export function applyNativeEvent(state, event) {
  const { kind, cursor, native } = event, p = native?.params ?? {};
  if (kind === 'snapshot') return installSnapshot(state, { snapshot: native, cursor });
  if (kind === 'status' || kind === 'resync') {
    if (kind === 'resync' || (state.generation != null && cursor.generation !== state.generation)) {
      state.ready = false; state.resync = true; state.generation = cursor.generation; state.requests.clear();
    }
    return state;
  }
  if ((native?.threadId ?? p.threadId) !== state.threadId) return state;
  if (kind === 'render') {
    if (cursor.generation !== state.generation) return state;
    for (const rendered of native.items ?? []) {
      const item = state.turns.flatMap(t => t.items ?? []).find(item => item.id === rendered.id);
      const floor = Math.max(item?._cursor?.seq ?? 0, item?._presentation?.cursor?.seq ?? 0);
      if (item && rendered.cursor?.generation === state.generation && rendered.cursor.seq >= floor &&
          (sameCursor(item._cursor, rendered.cursor) || (rendered.cursor.seq <= state.cursor.seq && rendered.text === itemText(item)))) item._presentation = rendered;
    }
    return state;
  }
  if (state.generation != null && cursor.generation < state.generation) return state;
  if (state.generation != null && cursor.generation !== state.generation) {
    state.ready = false; state.resync = true; state.generation = cursor.generation; state.requests.clear();
  }
  if (!state.ready) {
    state.bufferBytes += JSON.stringify(event).length * 3;
    if (state.bufferBytes > 1_048_576) { state.buffer = []; state.bufferBytes = 0; state.resync = true; }
    else state.buffer.push(event);
    return state;
  }
  if (cursor.seq <= state.cursor.seq) return state;
  state.cursor = cursor;
  if (kind === 'request') { state.requests.set(event.requestKey, native); return state; }
  const method = native.method;
  if (method === 'serverRequest/resolved') state.requests.delete(`${cursor.generation}:${JSON.stringify(p.requestId)}`);
  if (method === 'thread/name/updated') state.thread.name = p.threadName ?? p.name;
  if (method === 'thread/status/changed') state.thread.status = p.status;
  if (method === 'thread/deleted') { state.ready = false; state.deleted = true; state.turns = []; state.requests.clear(); return state; }
  if (method === 'thread/archived') { state.ready = false; state.archived = true; state.requests.clear(); return state; }
  if (method === 'thread/settings/updated') {
    const s = p.threadSettings;
    state.settings = { model: s.model, effort: s.effort, approvalPolicy: s.approvalPolicy,
      sandbox: s.sandboxPolicy, cwd: s.cwd, activePermissionProfile: s.activePermissionProfile };
    state.thread.cwd = s.cwd;
  }
  if (method === 'error') state.error = `${p.error?.message ?? '原生执行失败。'}${p.willRetry ? '（原生后端将重试）' : ''}`;
  if (method === 'thread/tokenUsage/updated') state.tokenUsage = p.tokenUsage;
  if (['turn/started', 'turn/completed'].includes(method)) {
    if (method === 'turn/started') state.error = null;
    if (method === 'turn/completed' && p.turn.status === 'completed' && !p.turn.error) state.error = null;
    if (p.turn.error?.message) state.error = p.turn.error.message;
    let turn = state.turns.find(t => t.id === p.turn.id);
    if (!turn) state.turns.push(turn = { id: p.turn.id, items: [] });
    const existing = turn.items;
    Object.assign(turn, copy(p.turn));
    if (p.turn.itemsView !== 'full') {
      turn.items = existing;
      for (const item of p.turn.items ?? []) {
        const index = turn.items.findIndex(i => i.id === item.id);
        const value = { ...copy(item), _cursor: cursor };
        if (index < 0) turn.items.push(value); else turn.items[index] = value;
      }
    } else stampItems([turn], cursor);
  }
  if (p.item || (p.itemId && p.delta != null)) {
    let turn = state.turns.find(t => t.id === p.turnId);
    if (!turn) state.turns.push(turn = { id: p.turnId, status: 'inProgress', items: [] });
    let index = turn.items.findIndex(item => item.id === (p.item?.id ?? p.itemId));
    if (p.item) {
      const item = { ...copy(p.item), _cursor: cursor };
      if (index < 0) turn.items.push(item); else turn.items[index] = item;
    } else {
      if (index < 0) { turn.items.push({ id: p.itemId, type: method.includes('commandExecution') ? 'commandExecution' : method.includes('reasoning') ? 'reasoning' : 'agentMessage', text: '' }); index = turn.items.length - 1; }
      const item = turn.items[index];
      if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') item.text = (item.text ?? '') + p.delta;
      if (method === 'item/commandExecution/outputDelta') item.aggregatedOutput = (item.aggregatedOutput ?? '') + p.delta;
      if (method === 'item/reasoning/summaryTextDelta') { item.summary ??= []; const i = p.summaryIndex ?? 0; item.summary[i] = (item.summary[i] ?? '') + p.delta; }
      if (method === 'item/reasoning/textDelta') { item.content ??= []; const i = p.contentIndex ?? 0; item.content[i] = (item.content[i] ?? '') + p.delta; }
      item._cursor = cursor; delete item._presentation;
    }
  }
  reconcilePending(state);
  return state;
}

export function beginSend(state) {
  if (state.pending) throw Object.assign(new Error('上一条消息尚未确认，请先查看会话。'), { code: 'SEND_PENDING' });
  return state.pending = { id: crypto.randomUUID(), text: state.draft, selections: structuredClone(state.selections), uploadIds: state.attachments.filter(a => a.status === 'complete').map(a => a.id), unknown: false };
}
export function settleSend(state, id, { ok, unknown = false }) {
  if (state.pending?.id !== id) return;
  if (unknown) { state.pending.unknown = true; return; }
  if (ok && !state.composing && state.draft === state.pending.text) { state.draft = ''; state.selections = []; }
  if (ok) state.attachments = state.attachments.filter(item => !state.pending.uploadIds?.includes(item.id));
  state.pending = null;
}
export function buildTurnParams({ threadId, input, model, effort, clientUserMessageId }) {
  return { threadId, input, clientUserMessageId, summary: 'auto', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
    ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
export function permissionText(settings) {
  const sandbox = settings.sandbox ?? settings.sandboxPolicy;
  if (sandbox?.type === 'dangerFullAccess' && settings.approvalPolicy === 'never') return '完全访问 · 执行免审批';
  return `原生权限：${sandbox?.type ?? '未知'} · 审批：${typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : '受管理'}`;
}
export function itemText(item) {
  switch (item.type) {
    case 'agentMessage': case 'plan': return item.text ?? '';
    case 'userMessage': return (item.content ?? []).map(part => part.type === 'text' ? displayNativeText(part) : part.type === 'localImage' ? '［图片］' : part.name ?? '').join('\n');
    case 'reasoning': return [...(item.summary ?? []), ...(item.content ?? [])].join('\n');
    case 'commandExecution': return `${item.command ?? ''}${item.aggregatedOutput ? '\n' + item.aggregatedOutput : ''}`;
    case 'fileChange': return (item.changes ?? []).map(change => `${change.path}\n${change.diff ?? ''}`).join('\n');
    case 'mcpToolCall': return [item.server, item.tool, JSON.stringify(item.arguments), JSON.stringify(item.result ?? item.error ?? '')].join('\n');
    case 'functionCallOutput': return typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
    default: return item.text ?? JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('_') && !['html', 'id', 'type'].includes(key))), null, 2);
  }
}
export function shouldSubmitKey(event, { composing, finePointer }) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229 && finePointer;
}
export { activeTurn };

/** Browser bindings; the state functions above also run in the gateway and Node tests. */
export function mountChat({ api, viewId, uploadLimitBytes }) {
  const $ = selector => document.querySelector(selector), abort = new AbortController();
  const states = new Map(), messageNodes = new Map(), formNodes = new Map();
  let selected, project, projectCursor, threadPages, online = false, alive = true;
  let opening = 0, projectLoad = 0, threadLoad = 0, refreshTimer, drawing = false;
  let presentationPending = false, presentationAgain = false;
  let shownNativeError;
  let creatingProject = false, projectRequest;
  const layout = $('.work-layout'), feed = $('#chat-feed'), draft = $('#draft'), threadMenu = $('#thread-menu');
  const sidebar = $('#sidebar'), chatPane = $('#chat-pane'), backdrop = $('#sidebar-backdrop'), narrow = matchMedia('(max-width: 760px)');
  const busyThreads = new Set(); let menuTarget, menuTrigger;
  const attachments = mountAttachments({ api, viewId, uploadLimitBytes, getState: () => selected, getStates: () => [...states.values()], onChange: state => { save(state); if (selected === state) draw(); } });
  const usage = mountUsage({ api, viewId, getState: () => selected, onChange: () => draw(), onError: e => showError(e) });
  const completions = mountCompletions({ api, viewId, getState: () => selected, onChange: state => { save(state); draw(); } });
  $('#messages').replaceChildren(); $('#native-requests').replaceChildren();
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const showError = e => { if (alive) $('#chat-error').textContent = e?.message ?? String(e); };
  const bind = (node, type, fn) => node.addEventListener(type, event => { try { Promise.resolve(fn(event)).catch(showError); } catch (e) { showError(e); } }, { signal: abort.signal });
  const read = async (method, params = {}) => (await api('/api/rpc', { method, params })).result;
  function syncSidebar() {
    const drawerOpen = narrow.matches && layout.dataset.level !== 'chat';
    backdrop.hidden = !drawerOpen; chatPane.inert = drawerOpen; sidebar.inert = narrow.matches && !drawerOpen;
    if (drawerOpen) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
    else { sidebar.setAttribute('role', 'complementary'); sidebar.removeAttribute('aria-modal'); }
    $('#back-threads').setAttribute('aria-expanded', String(narrow.matches ? drawerOpen : layout.dataset.sidebarCollapsed !== 'true'));
  }
  function setLevel(level) { layout.dataset.level = level; syncSidebar(); }
  function closeSidebar() {
    if (menuTarget) closeThreadMenu();
    layout.dataset.sidebarCollapsed = 'true'; setLevel('chat'); $('#back-threads').focus();
  }
  narrow.addEventListener('change', () => {
    const focusedInside = sidebar.contains(document.activeElement); syncSidebar();
    if (sidebar.inert && focusedInside) $('#back-threads').focus();
  }, { signal: abort.signal });
  bind(sidebar, 'keydown', event => {
    if (!narrow.matches || layout.dataset.level === 'chat') return;
    if (event.key === 'Escape') { event.preventDefault(); closeSidebar(); return; }
    if (event.key !== 'Tab') return;
    const items = [...sidebar.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(node => !node.disabled && node.getAttribute('tabindex') !== '-1' && node.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  setLevel(layout.dataset.level ?? 'chat');
  function closeThreadMenu(restoreFocus = false) {
    const trigger = menuTrigger; menuTarget = null; menuTrigger = null;
    threadMenu.hidePopover(); threadMenu.hidden = true; trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
  }
  function openThreadMenu(item, archived, trigger) {
    if (menuTarget) closeThreadMenu();
    menuTarget = { ...item, archived }; menuTrigger = trigger;
    $('#thread-menu-archive').textContent = archived ? '恢复会话' : '归档会话';
    $('#thread-menu-rename').textContent = archived ? '重命名（先恢复会话）' : '重命名';
    $('#thread-menu-rename').disabled = archived || !online || busyThreads.has(item.id);
    $('#thread-menu-archive').disabled = $('#thread-menu-delete').disabled = !online || busyThreads.has(item.id);
    trigger.setAttribute('aria-expanded', 'true'); threadMenu.hidden = false; threadMenu.showPopover();
    const rect = trigger.getBoundingClientRect();
    threadMenu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 232)) + 'px';
    threadMenu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - (threadMenu.offsetHeight || 140) - 8)) + 'px';
    $('#thread-menu-copy').focus();
  }
  async function copyThreadId(threadId) {
    try { await navigator.clipboard.writeText(threadId); $('#turn-status').textContent = '已复制会话 ID'; }
    catch { window.prompt('复制会话 ID', threadId); }
  }
  async function renameConversation(target, name) {
    if (target.archived || !online || busyThreads.has(target.id)) return false;
    if (name === undefined) name = window.prompt('重命名会话', target.name ?? '');
    if (!name?.trim()) return false;
    name = name.trim(); busyThreads.add(target.id); draw();
    try {
      await api('/api/thread/rename', { viewId, threadId: target.id, name });
      if (!alive) return true;
      const state = states.get(target.id); if (state?.thread) state.thread.name = name;
      draw(); await loadThreads(); return true;
    } finally { busyThreads.delete(target.id); draw(); }
  }
  bind(threadMenu, 'toggle', event => { if (event.newState === 'closed' && !threadMenu.matches(':popover-open')) {
    menuTrigger?.setAttribute('aria-expanded', 'false'); menuTarget = null; menuTrigger = null; threadMenu.hidden = true;
  } });
  bind(threadMenu, 'keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeThreadMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const items = [$('#thread-menu-copy'), $('#thread-menu-rename'), $('#thread-menu-archive'), $('#thread-menu-delete')].filter(node => !node.disabled);
    const index = items.indexOf(document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  });
  bind($('#thread-menu-copy'), 'click', () => { const target = menuTarget; if (!target) return; closeThreadMenu(true); return copyThreadId(target.id); });
  bind($('#thread-menu-rename'), 'click', () => { const target = menuTarget; if (!target) return; closeThreadMenu(true); return renameConversation(target); });
  bind($('#thread-menu-archive'), 'click', () => { const target = menuTarget; if (!target) return; closeThreadMenu(true); return target.archived ? restore(target.id) : archiveConversation(target); });
  bind($('#thread-menu-delete'), 'click', () => { const target = menuTarget; if (!target) return; closeThreadMenu(true); return deleteConversation(target.id); });
  function save(state) {
    try { sessionStorage.setItem(`codex-draft:${state.threadId}`, JSON.stringify({ text: state.draft, selections: state.selections, pending: state.pending ? { ...state.pending, unknown: true } : null,
      attachments: state.attachments.filter(a => a.status === 'complete').map(a => ({ id: a.id, name: a.name, size: a.size, status: a.status })) })); } catch { /* Drafts still remain in memory when browser storage is unavailable. */ }
  }
  function stateFor(threadId) {
    let state = states.get(threadId);
    if (!state) {
      states.set(threadId, state = createChatState(threadId));
      try { const saved = JSON.parse(sessionStorage.getItem(`codex-draft:${threadId}`));
        if (typeof saved?.text === 'string') state.draft = saved.text;
        if (Array.isArray(saved?.selections)) state.selections = saved.selections;
        if (typeof saved?.pending?.id === 'string' && typeof saved.pending.text === 'string') state.pending = { ...saved.pending, unknown: true };
        if (Array.isArray(saved?.attachments)) state.attachments = saved.attachments.filter(a => typeof a.id === 'string' && typeof a.name === 'string').map(a => ({ ...a, status: 'complete' }));
      } catch {}
    }
    return state;
  }
  function row(title, detail, chosen, fn) {
    const button = element('button', null, 'list-row'); button.type = 'button';
    button.setAttribute('aria-current', String(chosen)); button.append(element('span', title, 'row-label'));
    if (detail) { button.title = detail; button.append(element('small', detail)); } bind(button, 'click', fn); return button;
  }
  async function loadProjects(more = false) {
    const version = ++projectLoad, page = await read('project/list', { limit: 20, ...(more && projectCursor ? { cursor: projectCursor } : {}) });
    if (!alive || version !== projectLoad) return;
    if (!more) $('#projects').replaceChildren();
    for (const item of page.data) {
      const button = row(item.name, item.roots?.[0]?.path, project?.id === item.id, () => chooseProject(item));
      const icon = element('span', null, 'project-icon'); icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z"/></svg>';
      button.insertBefore(icon, button.children[0]); $('#projects').append(button);
    }
    projectCursor = page.nextCursor; $('#more-projects').hidden = !projectCursor;
  }
  async function loadThreads(more = false) {
    const version = ++threadLoad, projectId = project?.id;
    const archived = $('#show-archived-threads').checked;
    const roots = project?.roots?.map(root => root.path) ?? [];
    const pages = more && threadPages ? threadPages.map(page => ({ ...page, data: [...page.data] })) :
      [{ params: projectId ? { projectId } : {}, data: [], done: false },
        ...(projectId && roots.length ? [{ params: { projectId: null, cwd: roots }, data: [], done: false }] : [])];
    const data = []; $('#more-threads').hidden = true;
    // Old desktop history has a cwd but no project ID; keep native membership and both native cursors.
    while (data.length < 20) {
      await Promise.all(pages.filter(page => !page.data.length && !page.done).map(async page => {
        const result = await read('thread/list', { limit: 20, modelProviders: [], sortKey: 'updated_at', archived,
          ...page.params, ...(page.cursor ? { cursor: page.cursor } : {}) });
        page.data = result.data; page.cursor = result.nextCursor; page.done = !result.nextCursor;
      }));
      if (!alive || version !== threadLoad || project?.id !== projectId) return;
      const next = pages.filter(page => page.data.length).sort((a, b) => b.data[0].updatedAt - a.data[0].updatedAt)[0];
      if (next) data.push(next.data.shift());
      else if (pages.every(page => page.done)) break;
    }
    if (!more) { if (menuTarget) closeThreadMenu(); $('#threads').replaceChildren(); }
    for (const item of data) {
      const button = row(item.name || item.preview || '未命名会话', `${item.status?.type === 'active' ? '运行中 · ' : ''}${new Date(item.updatedAt * 1000).toLocaleString()}`, selected?.threadId === item.id, () => archived ? restore(item.id, true) : open(item.id));
      const container = element('div', null, 'conversation-row'); container.dataset.threadId = item.id;
      const actions = element('button', null, 'thread-actions'); actions.type = 'button';
      actions.setAttribute('aria-label', '会话选项：' + (item.name || item.preview || item.id)); actions.setAttribute('aria-haspopup', 'menu'); actions.setAttribute('aria-expanded', 'false'); actions.setAttribute('aria-controls', 'thread-menu');
      actions.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
      bind(actions, 'click', () => openThreadMenu(item, archived, actions));
      if (item.status?.type === 'active') { button.append(element('span', '运行中', 'thread-activity')); button.setAttribute('aria-label', (item.name || item.preview || item.id) + '，运行中'); }
      if (archived) button.append(element('small', '点击恢复此会话')); container.append(button, actions); $('#threads').append(container);
    }
    if (!data.length && !more) $('#threads').append(element('p', archived ? '没有已归档会话。' : project ? '这个项目还没有会话。' : '这里还没有会话。', 'muted'));
    threadPages = pages; $('#more-threads').hidden = pages.every(page => page.done && !page.data.length);
  }
  async function chooseProject(item) {
    project = item;
    setLevel('threads'); draw(); await Promise.all([loadProjects(), loadThreads()]);
  }
  bind($('#new-project'), 'click', () => {
    if (creatingProject || !online) return;
    if (!projectRequest?.unknown) {
      projectRequest = null; $('#project-name').value = ''; $('#project-root').value = project?.roots?.[0]?.path ?? selected?.settings.cwd ?? ''; $('#project-error').textContent = '';
    } else { $('#project-name').value = projectRequest.name; $('#project-root').value = projectRequest.rootPath; }
    draw(); $('#project-dialog').showModal(); $(projectRequest?.unknown ? '#project-submit' : '#project-name').focus();
  });
  bind($('#close-project'), 'click', () => $('#project-dialog').close());
  bind($('#project-form'), 'submit', async event => {
    event.preventDefault(); if (creatingProject || !online) return;
    if (!projectRequest?.unknown) {
      const name = $('#project-name').value.trim(), rootPath = $('#project-root').value;
      if (!projectRequest || projectRequest.name !== name || projectRequest.rootPath !== rootPath) projectRequest = { name, rootPath, idempotencyKey: crypto.randomUUID() };
    }
    const request = projectRequest, currentProject = project, version = opening; let created;
    creatingProject = true; $('#project-error').textContent = ''; draw();
    try {
      created = (await api('/api/project/create', { viewId, name: request.name, rootPath: request.rootPath, idempotencyKey: request.idempotencyKey })).project;
      projectRequest = null;
    } catch (e) {
      request.unknown ||= e.outcome === 'unknown' || !e.status;
      if (alive) $('#project-error').textContent = request.unknown ? '创建结果尚未确认，请重试核对。' : e.message;
      return;
    } finally { creatingProject = false; if (alive) draw(); }
    if (!alive) return;
    if ($('#project-dialog').open && project === currentProject && opening === version) {
      $('#show-archived-threads').checked = false;
      $('#project-dialog').close(); await chooseProject(created); $('#new-thread').focus();
    } else await loadProjects();
  });
  function select(state) {
    if (selected) save(selected);
    selected = state; setLevel('chat'); messageNodes.clear(); formNodes.clear();
    completions.close(); if (menuTarget) closeThreadMenu();
    $('#messages').replaceChildren(); $('#native-requests').replaceChildren(); draft.value = state.draft; draw();
    if (narrow.matches) $('#thread-title').focus();
    const url = new URL(location.href); url.searchParams.set('thread', state.threadId); history.replaceState(null, '', url);
  }
  async function open(threadId) {
    const version = ++opening, state = stateFor(threadId); select(state); state.ready = false; draw();
    let result;
    try { result = await api('/api/thread/open', { viewId, threadId }); }
    catch (e) { if (version === opening) throw e; return; }
    if (!alive || version !== opening) return;
    installSnapshot(state, result); save(state); draw();
    attachments.hydrate(state);
    await loadThreads();
  }
  function addInput(label, schema, parent) {
    const wrapper = element('label', label), choices = schema.enum ?? schema.oneOf?.map(option => option.const);
    let input;
    if (choices) { input = element('select'); for (let i = 0; i < choices.length; i++) { const option = element('option', schema.enumNames?.[i] ?? schema.oneOf?.[i]?.title ?? String(choices[i])); option.value = String(i); input.append(option); } }
    else if (schema.type === 'array' && schema.items?.enum) { input = element('select'); input.multiple = true; for (const choice of schema.items.enum) { const option = element('option', String(choice)); option.value = String(choice); input.append(option); } }
    else { input = element('input'); input.type = schema.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(schema.type) ? 'number' : schema.isSecret ? 'password' : 'text';
      if (input.type === 'number') { input.step = schema.type === 'integer' ? '1' : 'any'; if (schema.minimum != null) input.min = schema.minimum; if (schema.maximum != null) input.max = schema.maximum; }
      if (schema.default != null) { if (input.type === 'checkbox') input.checked = Boolean(schema.default); else input.value = String(schema.default); }
    }
    input.required = Boolean(schema.required) && input.type !== 'checkbox'; wrapper.append(input); parent.append(wrapper);
    return () => choices ? choices[Number(input.value)] : input.type === 'checkbox' ? input.checked : schema.type === 'array' ? [...input.selectedOptions].map(o => o.value) : input.type === 'number' ? Number(input.value) : input.value;
  }
  function nativeForm(key, native) {
    const p = native.params, form = element('form', null, 'native-form');
    form.append(element('strong', native.method === 'item/tool/requestUserInput' ? 'Codex 需要你的回答' : '需要确认'));
    if (p.reason || p.message) form.append(element('p', p.reason ?? p.message));
    const values = new Map();
    if (native.method === 'item/tool/requestUserInput') {
      for (const question of p.questions ?? []) {
        const fieldset = element('fieldset'); fieldset.append(element('legend', question.question));
        values.set(question.id, addInput(question.header || '回答', { type: 'string', isSecret: question.isSecret,
          ...(!question.isOther && question.options?.length ? { enum: question.options.map(o => o.label) } : {}), required: true }, fieldset));
        if (question.isOther && question.options?.length) fieldset.append(element('small', question.options.map(o => `${o.label}${o.description ? '：' + o.description : ''}`).join('；'), 'muted'));
        form.append(fieldset);
      }
    } else if (native.method === 'mcpServer/elicitation/request' && p.mode === 'form') {
      for (const [name, schema] of Object.entries(p.requestedSchema?.properties ?? {})) {
        values.set(name, addInput(schema.title ?? name, { ...schema, required: p.requestedSchema?.required?.includes(name) }, form));
      }
    } else if (native.method === 'mcpServer/elicitation/request' && p.url) {
      if (/^https?:\/\//i.test(p.url)) { const link = element('a', '打开请求页面'); link.href = p.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; form.append(link); }
    } else if (p.command || p.permissions || p.grantRoot) form.append(element('pre', p.command ?? p.grantRoot ?? JSON.stringify(p.permissions, null, 2)));
    const buttons = element('div', null, 'toolbar'), status = element('p', '', 'error');
    function button(label, decision) { const node = element('button', label); node.type = decision === 'accept' ? 'submit' : 'button';
      if (decision !== 'accept') bind(node, 'click', () => respond(decision)); buttons.append(node); }
    if (!p.availableDecisions || p.availableDecisions.includes('accept')) button('确认', 'accept');
    button('拒绝', 'decline'); button('取消', 'cancel'); form.append(status, buttons);
    async function respond(decision) {
      if (form.dataset.sending) return; form.dataset.sending = 'true'; for (const b of buttons.children) b.disabled = true;
      let result;
      if (native.method === 'item/tool/requestUserInput') result = { answers: decision === 'accept' ? Object.fromEntries([...values].map(([id, get]) => [id, { answers: [String(get())] }])) : {} };
      else if (native.method === 'item/permissions/requestApproval') result = { permissions: decision === 'accept' ? p.permissions : {}, scope: 'turn' };
      else if (native.method === 'mcpServer/elicitation/request') result = { action: decision, content: decision === 'accept' && p.mode === 'form' ? Object.fromEntries([...values].map(([name, get]) => [name, get()])) : null, _meta: null };
      else result = { decision };
      try { await api('/api/request/respond', { viewId, requestKey: key, answer: { result } }); selected?.requests.delete(key); form.remove(); formNodes.delete(key); }
      catch (e) { status.textContent = e.message; if (e.status !== 409) { delete form.dataset.sending; for (const b of buttons.children) b.disabled = false; } }
    }
    bind(form, 'submit', event => { event.preventDefault(); return respond('accept'); });
    return form;
  }
  function draw() {
    if (!alive) return;
    $('#project-title').textContent = project ? project.name + ' 的会话' : '全部会话'; $('#project-title').title = $('#project-title').textContent;
    $('#all-threads').hidden = !project;
    $('#new-project').disabled = $('#project-submit').disabled = creatingProject || !online;
    $('#project-name').disabled = $('#project-root').disabled = creatingProject || Boolean(projectRequest?.unknown);
    $('#project-submit').textContent = creatingProject ? '创建中…' : projectRequest?.unknown ? '重试核对' : '创建项目';
    if (menuTarget) {
      $('#thread-menu-rename').disabled = menuTarget.archived || !online || busyThreads.has(menuTarget.id);
      $('#thread-menu-archive').disabled = $('#thread-menu-delete').disabled = !online || busyThreads.has(menuTarget.id);
    }
    const state = selected, active = state && activeTurn(state), stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    $('#thread-title').textContent = state?.deleted ? '会话已删除' : state?.thread?.name || (state ? '正在打开会话…' : '新会话');
    $('#thread-title').title = state?.thread?.name ?? '';
    $('#older-history').hidden = !state?.historyCursor;
    const hasMessages = Boolean(state?.turns.some(t => t.items?.length)); $('#chat-empty').hidden = hasMessages; $('#chat-pane').dataset.empty = String(!hasMessages);
    draft.disabled = !state?.ready || !online || state.deleting;
    if (state && !state.composing && draft.value !== state.draft) draft.value = state.draft;
    $('#choose-files').disabled = $('#choose-photos').disabled = !state?.ready || !online || state.deleting;
    $('#send').disabled = !state?.ready || !online || state.deleting || Boolean(state.pending) || state.commandPending || state.attachments.some(a => a.status !== 'complete') || (!state.draft.trim() && !state.attachments.length);
    $('#send-mode-label').hidden = !active; $('#stop-turn').hidden = !active; $('#stop-turn').disabled = !online;
    $('#retry-uncertain').hidden = !state?.pending?.unknown;
    $('#turn-status').textContent = state?.pending?.unknown ? '发送状态未知，请先核对会话' : state?.pending ? '正在提交…' : !online ? '连接中断 · 正在重连' : state?.commandPending ? '正在执行命令…' : active ? 'Codex 正在工作' : '';
    const currentIds = new Set();
    let position = 0;
    for (const turn of state?.turns ?? []) for (const item of turn.items ?? []) {
      currentIds.add(item.id);
      let entry = messageNodes.get(item.id), presentation = item._presentation;
      const role = item.type === 'userMessage' ? 'user' : ['agentMessage', 'plan'].includes(item.type) ? 'assistant' : 'tool';
      if (!entry) {
        const node = element(role === 'tool' ? 'details' : 'article', null, `message message-${role}`), header = element(role === 'tool' ? 'summary' : 'header'), body = element('div', null, 'message-body'), downloads = element('div', null, 'message-files');
        node.setAttribute('aria-label', role === 'user' ? '你的消息' : role === 'assistant' ? 'Codex 回复' : '工具输出');
        node.append(header, body, downloads); messageNodes.set(item.id, entry = { node, header, body, downloads });
      }
      entry.header.textContent = `${presentation?.label ?? ({ user: '你', assistant: 'Codex', tool: { reasoning: '思考', commandExecution: '命令', fileChange: '文件修改' }[item.type] ?? '工具' }[role])}${role === 'tool' && item.status ? ' · ' + ({ inProgress: '运行中', completed: '完成', failed: '失败' }[item.status] ?? item.status) : ''}`;
      const nativeText = itemText(item), emptyReasoning = item.type === 'reasoning' && !nativeText.trim();
      const text = emptyReasoning ? (turn.status === 'inProgress' ? '等待思考摘要…' : '模型未提供可显示的思考摘要。') : nativeText;
      const html = emptyReasoning ? null : presentation?.html;
      if (html ? entry.html !== html : entry.text !== text || entry.html) {
        if (html) entry.body.innerHTML = html; else { const plain = element('pre', text); entry.body.replaceChildren(plain); }
        entry.html = html; entry.text = text;
      }
      if (entry.files !== presentation?.files) {
        entry.downloads.replaceChildren();
        for (const file of presentation?.files ?? []) {
          if (file.imageHref && /^\/api\/images\/[A-Za-z0-9_-]+$/.test(file.imageHref)) { const image = element('img'); image.src = file.imageHref; image.alt = file.name; image.className = 'chat-image'; image.loading = 'lazy'; entry.downloads.append(image); }
          if (/^\/api\/files\/[A-Za-z0-9_-]+$/.test(file.href)) { const link = element('a', '下载 ' + file.name); link.href = file.href; link.download = file.name; entry.downloads.append(link); }
        }
        entry.files = presentation?.files;
      }
      const following = $('#messages').children[position++];
      if (following !== entry.node) $('#messages').insertBefore(entry.node, following ?? null);
    }
    for (const [id, entry] of messageNodes) if (!currentIds.has(id)) { entry.node.remove(); messageNodes.delete(id); }
    for (const [key, native] of state?.requests ?? []) if (!formNodes.has(key)) { const form = nativeForm(key, native); formNodes.set(key, form); $('#native-requests').append(form); }
    for (const [key, form] of formNodes) if (!state?.requests.has(key)) { form.remove(); formNodes.delete(key); }
    if (stick) feed.scrollTop = feed.scrollHeight;
    if (state) save(state);
    if (shownNativeError !== state?.error) { shownNativeError = state?.error; $('#chat-error').textContent = state?.error ?? ''; }
    attachments.render(state);
    usage.render();
  }
  function scheduleDraw() { if (!drawing) { drawing = true; requestAnimationFrame(() => { drawing = false; draw(); }); } }
  async function loadPresentation() {
    if (!selected?.ready || !online) return;
    if (presentationPending) { presentationAgain = true; return; }
    presentationPending = true; const state = selected;
    try { const event = await api('/api/thread/render', { viewId, threadId: state.threadId }); if (selected === state) { applyNativeEvent(state, event); scheduleDraw(); } }
    catch (e) { if (e.status !== 409) showError(e); }
    finally { presentationPending = false; if (presentationAgain) { presentationAgain = false; loadPresentation(); } }
  }
  async function submit() {
    if (!selected?.ready || !online || selected.deleting || selected.pending || selected.commandPending) return;
    const action = commandAction(selected.draft);
    if (action && !selected.composing) {
      const state = selected, commandText = state.draft; state.commandPending = true; draw();
      try {
        const done = await runCommand(action);
        if (done !== false && state.draft === commandText) { state.draft = ''; state.selections = []; }
      } finally { state.commandPending = false; save(state); if (selected === state) draw(); }
      return;
    }
    if (selected.attachments.some(a => a.status !== 'complete') || (!selected.draft.trim() && !selected.attachments.length)) return;
    const state = selected, submission = beginSend(state); save(state); draw(); $('#chat-error').textContent = '';
    try {
      await api('/api/thread/send', { viewId, threadId: state.threadId, draft: { text: submission.text, selections: submission.selections, uploadIds: submission.uploadIds },
        mode: activeTurn(state) ? $('#send-mode').value : 'start', clientUserMessageId: submission.id });
      settleSend(state, submission.id, { ok: true });
    } catch (e) { settleSend(state, submission.id, { ok: false, unknown: e.outcome === 'unknown' || !e.status }); showError(e); }
    finally { save(state); if (selected === state) draw(); }
  }
  function information(title, text) { $('#info-title').textContent = title; $('#info-body').textContent = text; $('#info-dialog').showModal(); }
  async function restore(threadId, selectRestored = false) {
    if (busyThreads.has(threadId)) return false;
    const version = selectRestored ? ++opening : opening, current = selected, currentProject = project;
    busyThreads.add(threadId); draw();
    try {
      await api('/api/thread/unarchive', { viewId, threadId });
      const state = states.get(threadId); if (state) state.archived = false;
      if (!alive) return;
      if (selectRestored && version === opening && selected === current && project === currentProject) {
        $('#show-archived-threads').checked = false; await open(threadId);
      } else await loadThreads();
    } finally { busyThreads.delete(threadId); draw(); }
  }
  async function runCommand({ command, args }) {
    if (command === 'new') return newThread();
    if (command === 'model') { if (args) { const [model, effort] = args.split(/\s+/); return usage.choose(model, effort); } $('#model').focus(); return; }
    if (command === 'permissions') { information('原生权限', permissionText(selected.settings) + '\n新会话及下轮发送默认完全访问，原生托管限制优先。'); return; }
    if (command === 'status') { const status = await api('/api/status'); information('会话状态', `连接：${status.online ? '在线' : '离线'}\n会话 ID：${selected.threadId}\n模型：${selected.settings.model ?? '未知'}\n思考强度：${selected.settings.effort ?? '原生默认'}\n${permissionText(selected.settings)}`); return; }
    if (command === 'usage') { $('#show-usage').click(); return; }
    if (command === 'skills') { selected.draft = '$'; selected.selections = []; draft.value = '$'; draft.focus(); draft.setSelectionRange(1, 1); completions.refresh(); return false; }
    if (!selected?.ready) throw new Error('请先打开会话。');
    if (command === 'compact') { await api('/api/thread/compact', { viewId, threadId: selected.threadId }); selected.tokenUsage = null; return; }
    if (command === 'rename') return renameConversation({ id: selected.threadId, name: selected.thread?.name }, args || undefined);
    if (command === 'archive') return archiveConversation({ id: selected.threadId, status: { type: activeTurn(selected) ? 'active' : 'idle' } });
    if (command === 'delete') return deleteConversation(selected.threadId);
    if (command === 'fork') { const result = await api('/api/thread/fork', { viewId, threadId: selected.threadId }); const state = stateFor(result.snapshot.thread.id); installSnapshot(state, result); select(state); await loadThreads(); return; }
    if (command === 'export') { const link = element('a'); link.href = '/api/thread/export?threadId=' + encodeURIComponent(selected.threadId); link.download = selected.threadId + '.md'; document.body.append(link); link.click(); link.remove(); }
  }
  function clearSelectedThread(threadId) {
    if (selected?.threadId !== threadId) return;
    ++opening; save(selected); selected = undefined; messageNodes.clear(); formNodes.clear();
    $('#messages').replaceChildren(); $('#native-requests').replaceChildren(); draft.value = '';
    const url = new URL(location.href); url.searchParams.delete('thread'); history.replaceState(null, '', url);
    layout.dataset.sidebarCollapsed = 'false'; setLevel('threads'); draw(); $('#new-thread').focus();
  }
  async function archiveConversation(item) {
    if (busyThreads.has(item.id) || !window.confirm('归档此会话？正在运行的工作会先停止。')) return false;
    busyThreads.add(item.id);
    try { await api('/api/thread/archive', { viewId, threadId: item.id, confirmed: true });
      const state = states.get(item.id); if (state) { state.archived = true; state.ready = false; }
      clearSelectedThread(item.id); await loadThreads();
    } finally { busyThreads.delete(item.id); }
  }
  async function deleteConversation(threadId) {
    if (busyThreads.has(threadId) || !window.confirm('删除此会话及其原生子会话记录？目录和已上传文件会保留。')) return false;
    const state = states.get(threadId); busyThreads.add(threadId); if (state) state.deleting = true; draw();
    try { await api('/api/thread/delete', { viewId, threadId, confirmed: true });
      if (state) { state.deleted = true; state.ready = false; } clearSelectedThread(threadId); await loadThreads();
    } finally { busyThreads.delete(threadId); if (state) state.deleting = false; draw(); }
  }
  async function newThread() {
    if ($('#new-thread').disabled) return false;
    const version = ++opening;
    const button = $('#new-thread'); button.disabled = true; $('#chat-error').textContent = '';
    try { const result = await api('/api/thread/start', { viewId, ...(project ? { projectId: project.id } : {}) });
      if (!alive || version !== opening) return false;
      const state = stateFor(result.snapshot.thread.id); installSnapshot(state, result); select(state); await loadThreads();
    } catch (e) { if (!alive || version !== opening) return false; throw e;
    } finally {
      button.disabled = false;
      // A late creation can bind the gateway after newer navigation has finished.
      if (alive && version !== opening && selected) await open(selected.threadId);
    }
  }
  bind($('#new-thread'), 'click', newThread);
  bind($('#all-threads'), 'click', () => { $('#project-title').focus(); return chooseProject(null); });
  bind($('#show-archived-threads'), 'change', () => loadThreads()); bind($('#close-info'), 'click', () => $('#info-dialog').close());
  bind($('#more-projects'), 'click', () => loadProjects(true)); bind($('#more-threads'), 'click', () => loadThreads(true));
  bind($('#back-projects'), 'click', closeSidebar); bind(backdrop, 'click', closeSidebar);
  bind($('#back-threads'), 'click', () => { layout.dataset.sidebarCollapsed = 'false'; setLevel('threads'); $('#new-thread').focus(); });
  bind($('#older-history'), 'click', async () => {
    const state = selected, button = $('#older-history'); if (!state?.historyCursor) return; button.disabled = true;
    try { const response = await api('/api/rpc', { method: 'thread/turns/list', params: { threadId: state.threadId, cursor: state.historyCursor, limit: 20, sortDirection: 'desc', itemsView: 'full' } });
      if (selected !== state) return; const top = feed.scrollTop, height = feed.scrollHeight;
      prependHistory(state, response.result, response.cursor); draw(); feed.scrollTop = top + feed.scrollHeight - height;
    } finally { button.disabled = false; }
  });
  // Submit prevention must run synchronously, before the async action wrapper yields.
  $('#composer').addEventListener('submit', event => { event.preventDefault(); submit().catch(showError); }, { signal: abort.signal });
  draft.addEventListener('input', () => { if (selected) { selected.selections = updateSelections(selected.draft, draft.value, selected.selections); selected.draft = draft.value; save(selected); draw(); } }, { signal: abort.signal });
  draft.addEventListener('compositionstart', () => { if (selected) selected.composing = true; }, { signal: abort.signal });
  draft.addEventListener('compositionend', () => { if (selected) { selected.composing = false; selected.selections = updateSelections(selected.draft, draft.value, selected.selections); selected.draft = draft.value; save(selected); draw(); } }, { signal: abort.signal });
  draft.addEventListener('keydown', event => { if (shouldSubmitKey(event, { composing: selected?.composing, finePointer: matchMedia('(pointer: fine)').matches })) { event.preventDefault(); $('#composer').requestSubmit(); } }, { signal: abort.signal });
  bind($('#stop-turn'), 'click', async () => { const turn = selected && activeTurn(selected); if (!turn) return; $('#stop-turn').disabled = true;
    try { await api('/api/thread/stop', { viewId, threadId: selected.threadId, turnId: turn.id }); } finally { draw(); } });
  bind($('#retry-uncertain'), 'click', () => { if (selected?.pending?.unknown && window.confirm('请先核对历史。确认重新发送当前草稿？')) { selected.pending = null; save(selected); draw(); } });
  return {
    async load() {
      const version = opening, requested = new URL(location.href).searchParams.get('thread');
      await Promise.all([loadProjects(), loadThreads(), usage.loadModels()]);
      if (!alive || version !== opening || selected) return;
      if (requested) {
        const scope = project;
        try { await open(requested); }
        catch (e) {
          const empty = selected && !selected.draft && !selected.pending && !selected.attachments.length;
          // shortcut: Codex 0.159.2 uses generic errors, replace the text check when it exposes a missing-thread code.
          if (alive && empty && online && project === scope && !selected.ready && selected.threadId === requested && e.code === -32600 &&
              e.message === 'no rollout found for thread id ' + requested) {
            selected = undefined; draw(); await newThread().catch(showError);
          }
          else showError(e);
        }
      }
      else if (online) await newThread().catch(showError);
    },
    onEvent(event) {
      if (!alive) return;
      const reconnected = event.kind === 'status' && event.native.online && !online;
      if (event.kind === 'status') online = event.native.online;
      if (reconnected) Promise.all([loadProjects(), loadThreads()]).catch(showError);
      if (event.kind === 'renderRequired' && event.native.threadId === selected?.threadId) loadPresentation();
      if (event.native?.method?.startsWith('project/')) loadProjects().catch(showError);
      const threadId = event.kind === 'snapshot' ? event.native.thread.id : event.native?.threadId ?? event.native?.params?.threadId;
      if (event.kind === 'snapshot' || (threadId && states.has(threadId))) applyNativeEvent(stateFor(threadId), event);
      if (['status', 'resync'].includes(event.kind)) {
        for (const state of states.values()) if (!event.native.threadId || event.native.threadId === state.threadId) applyNativeEvent(state, event);
        if (event.kind === 'resync' && selected && online && (!event.native.threadId || event.native.threadId === selected.threadId)) open(selected.threadId).catch(showError);
      }
      if (['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived', 'thread/deleted', 'turn/completed'].includes(event.native?.method)) {
        clearTimeout(refreshTimer); refreshTimer = setTimeout(() => loadThreads().catch(showError), 300);
      }
      scheduleDraw();
      usage.onEvent(event);
    },
    connection(value) { online = value; draw(); },
    open, getState: () => selected, viewId,
    dispose() { alive = false; if (menuTarget) closeThreadMenu(); abort.abort(); attachments.dispose(); usage.dispose(); completions.dispose(); clearTimeout(refreshTimer); $('#info-dialog').close(); $('#project-dialog').close(); if (selected) save(selected); },
  };
}
