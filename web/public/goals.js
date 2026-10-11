export function mountGoals({ api, viewId, getState, onChange }) {
  const $ = selector => document.querySelector(selector), abort = new AbortController(), entries = new Map();
  const draft = $('#draft'), labels = { active: '继续', paused: '已暂停', blocked: '受阻', usageLimited: '达到用量上限', budgetLimited: '达到预算上限', complete: '已完成' };
  let alive = true, timer, timed;
  const entryFor = state => {
    let entry = entries.get(state.threadId);
    if (!entry || entry.generation !== state.generation) entries.set(state.threadId, entry = { state, generation: state.generation, goal: null, loaded: false, unknown: Boolean(state.goalPending), cursor: null });
    return entry;
  };
  const valid = entry => alive && entries.get(entry.state.threadId) === entry && entry.generation === entry.state.generation;
  const current = entry => valid(entry) && getState() === entry.state && entry.state.ready && entry.state.online && !entry.state.deleting;
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const notify = state => { onChange(state); render(); };
  function accept(entry) {
    const state = entry.state, pending = state.goalPending;
    if (pending && state.draft === pending.text && !state.composing) { state.draft = ''; state.selections = []; state.goalMode = false; }
    state.goalPending = null; entry.unknown = false; entry.error = ''; entry.base = undefined;
  }
  function apply(entry, goal, cursor) {
    if (!valid(entry) || cursor?.generation !== entry.generation || entry.cursor && cursor.seq <= entry.cursor.seq || goal && goal.threadId !== entry.state.threadId) return;
    if (entry.state.goalMode && entry.base !== undefined && !entry.busy && (goal?.objective ?? null) !== entry.base) { entry.stale = true; entry.error = '目标已被其他操作修改，请核对后再发送。'; }
    entry.goal = goal; entry.cursor = cursor; entry.receivedAt = Date.now();
    if (entry.base === undefined && entry.state.goalMode) entry.base = goal?.objective ?? null;
    if (entry.unknown && entry.state.goalPending?.objective === goal?.objective) { accept(entry); entry.stale = false; }
  }
  async function load(state, check = false) {
    if (!alive || !state?.ready) return false;
    const entry = entryFor(state);
    if (entry.loading) return entry.loading;
    if (entry.loaded && !check) return !entry.failed;
    entry.loading = (async () => {
      try {
        const response = await api('/api/thread/goal', { viewId, threadId: state.threadId, action: 'get' });
        if (!valid(entry)) return false;
        apply(entry, response.result.goal ?? null, response.cursor); entry.loaded = true; entry.failed = false;
        if (check) { if (state.goalPending?.objective === entry.goal?.objective && state.goalPending) accept(entry); entry.stale = false; entry.unknown = false; entry.error = ''; entry.base = entry.goal?.objective ?? null; state.goalPending = null; }
        return true;
      } catch (error) { if (valid(entry)) { entry.failed = true; entry.error = error.message; } return false; }
      finally { entry.loading = null; if (valid(entry)) notify(state); }
    })();
    render(); return entry.loading;
  }
  const blocked = state => { const entry = entryFor(state); return Boolean(entry.busy || entry.loading || entry.failed || entry.unknown || entry.stale); };
  function clock(entry) {
    const goal = entry.goal; if (!goal) return;
    const seconds = goal.timeUsedSeconds + (goal.status === 'active' && current(entry) ? Math.floor((Date.now() - entry.receivedAt) / 1000) : 0);
    text($('#goal-progress'), `${labels[goal.status] ?? goal.status} · ${seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's'}`);
  }
  function render() {
    if (!alive) return;
    const state = getState(), entry = state && entryFor(state), goal = entry?.goal, mode = Boolean(state?.goalMode);
    $('#goal-mode').hidden = !mode; $('#goal-mode').disabled = Boolean(entry?.busy);
    const placeholder = mode ? '描述你的目标，定义可衡量的成果，以获得最佳效果' : goal ? '与 Codex 协作' : '向 Codex 发送消息…'; if (draft.placeholder !== placeholder) draft.placeholder = placeholder;
    $('#goal-status').hidden = !goal && !(mode && entry?.error);
    if (entry) {
      text($('#goal-title'), goal ? ({ active: '进行中的目标', paused: '已暂停的目标', complete: '已完成的目标' }[goal.status] ?? '当前目标') : '目标状态待核对');
      $('#goal-title').title = goal?.objective ?? ''; $('#goal-title').disabled = !goal || !current(entry) || blocked(state);
      $('#goal-details').hidden = !entry.expanded; text($('#goal-details'), goal ? `${goal.objective}\n已用 token：${goal.tokensUsed.toLocaleString('zh-CN')}${goal.tokenBudget != null ? ' / ' + goal.tokenBudget.toLocaleString('zh-CN') : ''}` : '');
      $('#goal-expand').hidden = !goal; $('#goal-expand').setAttribute('aria-expanded', String(Boolean(entry.expanded)));
      $('#goal-toggle').hidden = !goal || ['complete', 'budgetLimited'].includes(goal.status); $('#goal-toggle').disabled = !current(entry) || blocked(state);
      const toggle = goal?.status === 'active' ? '暂停目标' : '恢复目标'; $('#goal-toggle').setAttribute('aria-label', toggle); $('#goal-toggle').title = toggle; $('#goal-toggle').dataset.action = goal?.status === 'active' ? 'pause' : 'resume';
      $('#goal-clear').hidden = !goal; $('#goal-clear').disabled = !current(entry) || blocked(state);
      $('#goal-check').hidden = !(entry.failed || entry.unknown || entry.stale); $('#goal-check').disabled = !current(entry) || Boolean(entry.loading || entry.busy);
      $('#goal-error').hidden = !entry.error; text($('#goal-error'), entry.error ?? '');
      if (goal) clock(entry); else text($('#goal-progress'), '');
    }
    const ticking = entry && current(entry) && goal?.status === 'active' ? entry : null;
    if (timed !== ticking) { clearInterval(timer); timed = ticking; if (timed) { timer = setInterval(() => clock(timed), 1000); timer.unref?.(); } }
  }
  async function change(action, state = getState(), source = state?.draft) {
    const entry = state && entryFor(state);
    if (!entry || !current(entry) || blocked(state)) return false;
    const objective = source?.trim();
    if (action === 'set' && (state.attachments.length || state.selections.length || !objective || [...objective].length > 4000 || objective.includes('\0'))) {
      entry.error = state.attachments.length || state.selections.length ? '请先将文件、图片或引用作为会话消息发送，再设置目标。' : '目标须为 1–4000 个字符。'; notify(state); return false;
    }
    if (action === 'clear' && !window.confirm('清除当前目标？聊天记录会保留，正在执行的轮次不会被中断。')) return false;
    entry.busy = true; entry.error = ''; if (action === 'set') state.goalPending = { text: source, objective }; notify(state);
    try {
      let response = await api('/api/thread/goal', { viewId, threadId: state.threadId, action, ...(action === 'set' ? { objective } : {}) });
      if (!valid(entry)) return false;
      // Newer native versions return an empty mutation reply; reconcile without repeating the write.
      if (action !== 'clear' && response.result.goal === undefined) { if (!current(entry)) return false; response = await api('/api/thread/goal', { viewId, threadId: state.threadId, action: 'get' }); }
      if (!valid(entry)) return false;
      apply(entry, action === 'clear' ? null : response.result.goal, response.cursor);
      if (action === 'set') accept(entry);
      return true;
    } catch (error) {
      if (valid(entry)) { entry.unknown = error.outcome === 'unknown' || !error.status; entry.error = error.message + (entry.unknown ? ' 操作状态未知，请先核对目标。' : ''); if (!entry.unknown) state.goalPending = null; }
      return false;
    } finally { entry.busy = false; if (valid(entry)) notify(state); }
  }
  function enter(state, value = '') {
    const entry = entryFor(state); state.goalMode = true; state.draft = value; state.selections = []; entry.base = entry.loaded ? entry.goal?.objective ?? null : undefined;
    notify(state); draft.value = value; draft.focus(); draft.setSelectionRange(value.length, value.length);
  }
  async function submit(state = getState()) {
    const entry = entryFor(state), source = state.draft;
    if (!(await load(state)) || !current(entry)) return false;
    return change('set', state, source);
  }
  async function command(args) {
    const state = getState(), entry = entryFor(state), action = args.toLowerCase();
    if (!args) { enter(state); return false; }
    if (!(await load(state)) || !current(entry)) return false;
    if (action === 'edit') { enter(state, entry.goal?.objective ?? ''); return false; }
    if (['pause', 'resume', 'clear'].includes(action)) return change(action, state);
    enter(state, args); return submit(state);
  }
  const bind = (id, fn) => $(id).addEventListener('click', fn, { signal: abort.signal });
  bind('#goal-mode', () => { const state = getState(); if (!state || entryFor(state).busy) return; state.goalMode = false; notify(state); draft.focus(); });
  bind('#goal-title', () => command('edit'));
  bind('#goal-toggle', () => change(entryFor(getState()).goal?.status === 'active' ? 'pause' : 'resume'));
  bind('#goal-clear', () => change('clear'));
  bind('#goal-check', () => load(getState(), true));
  bind('#goal-expand', () => { const entry = entryFor(getState()); entry.expanded = !entry.expanded; render(); });
  return { command, submit, load, render, blocked,
    onEvent(event) { const p = event.native?.params, entry = entries.get(p?.threadId); if (entry && ['thread/goal/updated', 'thread/goal/cleared'].includes(event.native.method)) { apply(entry, event.native.method === 'thread/goal/cleared' ? null : p.goal, event.cursor); notify(entry.state); } render(); },
    dispose() { alive = false; abort.abort(); clearInterval(timer); entries.clear(); },
  };
}
