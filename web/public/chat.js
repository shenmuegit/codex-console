export function createChatState(threadId) {
  return { threadId, thread: null, turns: [], settings: {}, cursor: null, generation: null,
    ready: false, resync: false, buffer: [], bufferBytes: 0, historyCursor: null, draft: '', pending: null, requests: new Map() };
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
      if (item && sameCursor(item._cursor, rendered.cursor)) item._presentation = rendered;
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
  if (method === 'thread/settings/updated') {
    const s = p.threadSettings;
    state.settings = { model: s.model, effort: s.effort, approvalPolicy: s.approvalPolicy,
      sandbox: s.sandboxPolicy, cwd: s.cwd, activePermissionProfile: s.activePermissionProfile };
  }
  if (method === 'thread/tokenUsage/updated') state.tokenUsage = p.tokenUsage;
  if (['turn/started', 'turn/completed'].includes(method)) {
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
  return state.pending = { id: crypto.randomUUID(), text: state.draft, unknown: false };
}
export function settleSend(state, id, { ok, unknown = false }) {
  if (state.pending?.id !== id) return;
  if (unknown) { state.pending.unknown = true; return; }
  if (ok && !state.composing && state.draft === state.pending.text) state.draft = '';
  state.pending = null;
}
export function buildTurnParams({ threadId, input, model, effort, clientUserMessageId }) {
  return { threadId, input, clientUserMessageId, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
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
    case 'userMessage': return (item.content ?? []).map(part => part.type === 'text' ? part.text : part.type === 'localImage' ? '［图片］' : part.name ?? '').join('\n');
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
export function mountChat({ api, viewId, defaultCwd }) {
  const $ = selector => document.querySelector(selector), abort = new AbortController();
  const states = new Map(), messageNodes = new Map(), formNodes = new Map();
  let selected, project, projectCursor, threadCursor, online = false, alive = true;
  let opening = 0, projectLoad = 0, threadLoad = 0, refreshTimer, drawing = false;
  const layout = $('.work-layout'), feed = $('#chat-feed'), draft = $('#draft');
  $('#cwd').value = defaultCwd; $('#messages').replaceChildren(); $('#native-requests').replaceChildren();
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const showError = e => { if (alive) $('#chat-error').textContent = e?.message ?? String(e); };
  const bind = (node, type, fn) => node.addEventListener(type, event => { try { Promise.resolve(fn(event)).catch(showError); } catch (e) { showError(e); } }, { signal: abort.signal });
  const read = async (method, params = {}) => (await api('/api/rpc', { method, params })).result;
  function save(state) {
    try { sessionStorage.setItem(`codex-draft:${state.threadId}`, JSON.stringify({ text: state.draft, pending: state.pending ? { ...state.pending, unknown: true } : null })); } catch { /* Drafts still remain in memory when browser storage is unavailable. */ }
  }
  function stateFor(threadId) {
    let state = states.get(threadId);
    if (!state) {
      states.set(threadId, state = createChatState(threadId));
      try { const saved = JSON.parse(sessionStorage.getItem(`codex-draft:${threadId}`));
        if (typeof saved?.text === 'string') state.draft = saved.text;
        if (typeof saved?.pending?.id === 'string' && typeof saved.pending.text === 'string') state.pending = { ...saved.pending, unknown: true };
      } catch {}
    }
    return state;
  }
  function row(title, detail, chosen, fn) {
    const button = element('button', null, 'list-row'); button.type = 'button';
    button.setAttribute('aria-current', String(chosen)); button.append(element('span', title));
    if (detail) button.append(element('small', detail)); bind(button, 'click', fn); return button;
  }
  async function loadProjects(more = false) {
    const version = ++projectLoad, page = await read('project/list', { limit: 20, ...(more && projectCursor ? { cursor: projectCursor } : {}) });
    if (!alive || version !== projectLoad) return;
    if (!more) $('#projects').replaceChildren(row('全部会话', null, !project, () => chooseProject(null)));
    for (const item of page.data) $('#projects').append(row(item.name, item.roots?.[0]?.path, project?.id === item.id, () => chooseProject(item)));
    projectCursor = page.nextCursor; $('#more-projects').hidden = !projectCursor;
  }
  async function loadThreads(more = false) {
    const version = ++threadLoad, projectId = project?.id;
    const page = await read('thread/list', { limit: 20, modelProviders: [], sortKey: 'updated_at',
      ...(projectId ? { projectId } : {}), ...(more && threadCursor ? { cursor: threadCursor } : {}) });
    if (!alive || version !== threadLoad || project?.id !== projectId) return;
    if (!more) $('#threads').replaceChildren();
    for (const item of page.data) $('#threads').append(row(item.name || item.preview || '未命名会话',
      `${item.status?.type === 'active' ? '运行中 · ' : ''}${new Date(item.updatedAt * 1000).toLocaleString()}`, selected?.threadId === item.id, () => open(item.id)));
    if (!page.data.length && !more) $('#threads').append(element('p', '这里还没有会话。', 'muted'));
    threadCursor = page.nextCursor; $('#more-threads').hidden = !threadCursor;
  }
  async function chooseProject(item) {
    project = item; $('#project-title').textContent = item?.name ?? '全部会话';
    $('#cwd').value = item?.roots?.[0]?.path ?? defaultCwd; $('#cwd').readOnly = Boolean(item);
    layout.dataset.level = 'threads'; await Promise.all([loadProjects(), loadThreads()]);
  }
  function select(state) {
    if (selected) save(selected);
    selected = state; layout.dataset.level = 'chat'; messageNodes.clear(); formNodes.clear();
    $('#messages').replaceChildren(); $('#native-requests').replaceChildren(); draft.value = state.draft; draw();
  }
  async function open(threadId) {
    const version = ++opening, state = stateFor(threadId); select(state); state.ready = false; draw();
    let result;
    try { result = await api('/api/thread/open', { viewId, threadId }); }
    catch (e) { if (version === opening) throw e; return; }
    if (!alive || version !== opening) return;
    installSnapshot(state, result); save(state); draw();
    const url = new URL(location.href); url.searchParams.set('thread', threadId); history.replaceState(null, '', url);
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
    const state = selected, active = state && activeTurn(state), stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    $('#thread-title').textContent = state?.thread?.name || (state ? '正在打开会话…' : '选择或新建一个会话');
    $('#thread-id').textContent = state?.threadId ?? ''; $('#copy-thread').disabled = !state;
    $('#refresh-chat').disabled = !state || !online; $('#older-history').hidden = !state?.historyCursor;
    $('#effective-settings').textContent = state?.ready ? `${active ? '下轮默认：' : '会话默认：'}${state.settings.model ?? '原生模型'} · ${state.settings.effort ?? '原生思考强度'} · ${permissionText(state.settings)}` : '';
    $('#chat-empty').hidden = Boolean(state?.turns.some(t => t.items?.length));
    draft.disabled = !state?.ready || !online;
    if (state && !state.composing && draft.value !== state.draft) draft.value = state.draft;
    $('#send').disabled = !state?.ready || !online || Boolean(state.pending) || !state.draft.trim();
    $('#send-mode-label').hidden = !active; $('#stop-turn').hidden = !active; $('#stop-turn').disabled = !online;
    $('#retry-uncertain').hidden = !state?.pending?.unknown;
    $('#turn-status').textContent = state?.pending?.unknown ? '发送状态未知，请先核对会话' : state?.pending ? '正在提交…' : active ? 'Codex 正在工作' : state?.ready ? 'Enter 发送 · Shift+Enter 换行' : '';
    const currentIds = new Set();
    let position = 0;
    for (const turn of state?.turns ?? []) for (const item of turn.items ?? []) {
      currentIds.add(item.id);
      let entry = messageNodes.get(item.id), presentation = item._presentation;
      const role = item.type === 'userMessage' ? 'user' : ['agentMessage', 'plan'].includes(item.type) ? 'assistant' : 'tool';
      if (!entry) {
        const node = element(role === 'tool' ? 'details' : 'article', null, `message message-${role}`), header = element(role === 'tool' ? 'summary' : 'header'), body = element('div', null, 'message-body');
        node.append(header, body); messageNodes.set(item.id, entry = { node, header, body });
      }
      entry.header.textContent = `${presentation?.label ?? ({ user: '你', assistant: 'Codex', tool: { reasoning: '思考', commandExecution: '命令', fileChange: '文件修改' }[item.type] ?? '工具' }[role])}${role === 'tool' && item.status ? ' · ' + ({ inProgress: '运行中', completed: '完成', failed: '失败' }[item.status] ?? item.status) : ''}`;
      const text = itemText(item), html = presentation?.html;
      if (html ? entry.html !== html : entry.text !== text || entry.html) {
        if (html) entry.body.innerHTML = html; else { const plain = element('pre', text); entry.body.replaceChildren(plain); }
        entry.html = html; entry.text = text;
      }
      const following = $('#messages').children[position++];
      if (following !== entry.node) $('#messages').insertBefore(entry.node, following ?? null);
    }
    for (const [id, entry] of messageNodes) if (!currentIds.has(id)) { entry.node.remove(); messageNodes.delete(id); }
    for (const [key, native] of state?.requests ?? []) if (!formNodes.has(key)) { const form = nativeForm(key, native); formNodes.set(key, form); $('#native-requests').append(form); }
    for (const [key, form] of formNodes) if (!state?.requests.has(key)) { form.remove(); formNodes.delete(key); }
    if (stick) feed.scrollTop = feed.scrollHeight;
    if (state) save(state);
  }
  function scheduleDraw() { if (!drawing) { drawing = true; requestAnimationFrame(() => { drawing = false; draw(); }); } }
  async function submit() {
    if (!selected?.ready || !online || selected.pending || !selected.draft.trim()) return;
    const state = selected, submission = beginSend(state); save(state); draw(); $('#chat-error').textContent = '';
    try {
      await api('/api/thread/send', { viewId, threadId: state.threadId, draft: { text: submission.text },
        mode: activeTurn(state) ? $('#send-mode').value : 'start', clientUserMessageId: submission.id });
      settleSend(state, submission.id, { ok: true });
    } catch (e) { settleSend(state, submission.id, { ok: false, unknown: e.outcome === 'unknown' || !e.status }); showError(e); }
    finally { save(state); if (selected === state) draw(); }
  }
  bind($('#new-thread'), 'click', async () => {
    const button = $('#new-thread'); button.disabled = true; $('#chat-error').textContent = '';
    try { const result = await api('/api/thread/start', { viewId, cwd: $('#cwd').value, ...(project ? { projectId: project.id } : {}) });
      const state = stateFor(result.snapshot.thread.id); installSnapshot(state, result); select(state); await loadThreads();
    } finally { button.disabled = false; }
  });
  bind($('#copy-thread'), 'click', async () => { if (!selected) return; try { await navigator.clipboard.writeText(selected.threadId); $('#turn-status').textContent = '已复制会话 ID'; } catch { window.prompt('复制会话 ID', selected.threadId); } });
  bind($('#refresh-projects'), 'click', () => loadProjects()); bind($('#refresh-threads'), 'click', () => loadThreads());
  bind($('#more-projects'), 'click', () => loadProjects(true)); bind($('#more-threads'), 'click', () => loadThreads(true));
  bind($('#refresh-chat'), 'click', () => selected && open(selected.threadId));
  bind($('#back-projects'), 'click', () => { layout.dataset.level = 'projects'; }); bind($('#back-threads'), 'click', () => { layout.dataset.level = 'threads'; });
  bind($('#older-history'), 'click', async () => {
    const state = selected, button = $('#older-history'); if (!state?.historyCursor) return; button.disabled = true;
    try { const response = await api('/api/rpc', { method: 'thread/turns/list', params: { threadId: state.threadId, cursor: state.historyCursor, limit: 20, sortDirection: 'desc', itemsView: 'full' } });
      if (selected !== state) return; const top = feed.scrollTop, height = feed.scrollHeight;
      prependHistory(state, response.result, response.cursor); draw(); feed.scrollTop = top + feed.scrollHeight - height;
    } finally { button.disabled = false; }
  });
  // Submit prevention must run synchronously, before the async action wrapper yields.
  $('#composer').addEventListener('submit', event => { event.preventDefault(); submit().catch(showError); }, { signal: abort.signal });
  draft.addEventListener('input', () => { if (selected) { selected.draft = draft.value; save(selected); draw(); } }, { signal: abort.signal });
  draft.addEventListener('compositionstart', () => { if (selected) selected.composing = true; }, { signal: abort.signal });
  draft.addEventListener('compositionend', () => { if (selected) { selected.composing = false; selected.draft = draft.value; save(selected); draw(); } }, { signal: abort.signal });
  draft.addEventListener('keydown', event => { if (shouldSubmitKey(event, { composing: selected?.composing, finePointer: matchMedia('(pointer: fine)').matches })) { event.preventDefault(); $('#composer').requestSubmit(); } }, { signal: abort.signal });
  bind($('#stop-turn'), 'click', async () => { const turn = selected && activeTurn(selected); if (!turn) return; $('#stop-turn').disabled = true;
    try { await api('/api/thread/stop', { viewId, threadId: selected.threadId, turnId: turn.id }); } finally { draw(); } });
  bind($('#retry-uncertain'), 'click', () => { if (selected?.pending?.unknown && window.confirm('请先核对历史。确认重新发送当前草稿？')) { selected.pending = null; save(selected); draw(); } });
  return {
    async load() { await Promise.all([loadProjects(), loadThreads()]); const requested = new URL(location.href).searchParams.get('thread'); if (requested) await open(requested); },
    onEvent(event) {
      if (!alive) return;
      if (event.kind === 'status') online = event.native.online;
      const threadId = event.kind === 'snapshot' ? event.native.thread.id : event.native?.threadId ?? event.native?.params?.threadId;
      if (event.kind === 'snapshot' || (threadId && states.has(threadId))) applyNativeEvent(stateFor(threadId), event);
      if (['status', 'resync'].includes(event.kind)) {
        for (const state of states.values()) applyNativeEvent(state, event);
        if (event.kind === 'resync' && selected && online) open(selected.threadId).catch(showError);
      }
      if (['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived', 'thread/deleted', 'turn/completed'].includes(event.native?.method)) {
        clearTimeout(refreshTimer); refreshTimer = setTimeout(() => loadThreads().catch(showError), 300);
      }
      scheduleDraw();
    },
    connection(value) { online = value; draw(); },
    open, getState: () => selected, viewId,
    dispose() { alive = false; abort.abort(); clearTimeout(refreshTimer); if (selected) save(selected); },
  };
}
