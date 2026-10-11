export function mountGoals({ api, viewId, getState }) {
  const $ = selector => document.querySelector(selector), abort = new AbortController();
  const dialog = $('#goal-dialog'), objective = $('#goal-objective');
  const labels = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '达到用量上限', budgetLimited: '达到预算上限', complete: '已完成' };
  let target, writing = false, alive = true;
  const valid = entry => alive && target === entry && getState() === entry.state && entry.state.ready && entry.state.online && !entry.state.deleting && entry.state.generation === entry.generation;
  const close = () => { target = null; dialog.close(); };
  const fail = (entry, error) => { if (valid(entry)) $('#goal-error').textContent = error.message; };
  const bind = (node, type, fn) => node.addEventListener(type, fn, { signal: abort.signal });
  function render() {
    if (!target) return;
    if (!valid(target)) { close(); return; }
    const { goal, loading, unknown, stale } = target, disabled = loading || writing || unknown || stale;
    const summary = $('#goal-summary'), text = loading ? '正在读取目标…' : goal ? `${labels[goal.status] ?? goal.status}\n已用 token：${goal.tokensUsed.toLocaleString('zh-CN')}${goal.tokenBudget != null ? ' / ' + goal.tokenBudget.toLocaleString('zh-CN') : ''}\n已用时间：${Math.floor(goal.timeUsedSeconds / 60)} 分 ${goal.timeUsedSeconds % 60} 秒` : '尚未设置目标。';
    if (summary.textContent !== text) summary.textContent = text;
    objective.disabled = loading || writing || unknown;
    $('#goal-save').disabled = disabled;
    $('#goal-toggle').hidden = !goal || ['complete', 'budgetLimited'].includes(goal.status);
    $('#goal-toggle').disabled = disabled; $('#goal-toggle').textContent = goal?.status === 'active' ? '暂停目标' : '恢复目标';
    $('#goal-clear').hidden = !goal; $('#goal-clear').disabled = disabled;
  }
  function apply(entry, goal, cursor) {
    if (!valid(entry) || cursor?.generation !== entry.generation || entry.cursor && cursor.seq <= entry.cursor.seq) return;
    if (entry.dirty && !writing && (goal?.objective ?? null) !== entry.baseline) { entry.stale = true; fail(entry, Error('目标已被其他操作修改，请重新打开后再编辑。')); }
    entry.goal = goal; entry.cursor = cursor;
    if (!entry.dirty) { objective.value = goal?.objective ?? ''; entry.baseline = goal?.objective ?? null; }
    render();
  }
  async function change(action) {
    const entry = target;
    if (!entry || !valid(entry) || entry.loading || writing || entry.unknown || entry.stale) return false;
    const text = objective.value.trim();
    if (action === 'set' && (!text || [...text].length > 4000 || text.includes('\0'))) { fail(entry, Error('目标须为 1–4000 个字符。')); return false; }
    if (action === 'clear' && !window.confirm('清除当前目标？聊天记录会保留，正在执行的轮次不会被中断。')) return false;
    writing = true; $('#goal-error').textContent = ''; render();
    try {
      let response = await api('/api/thread/goal', { viewId, threadId: entry.state.threadId, action, ...(action === 'set' ? { objective: text } : {}) });
      if (!valid(entry)) return false;
      // Newer native versions return an empty mutation reply; read once to reconcile it.
      if (action !== 'clear' && response.result.goal === undefined) response = await api('/api/thread/goal', { viewId, threadId: entry.state.threadId, action: 'get' });
      if (!valid(entry)) return false;
      entry.dirty = false; apply(entry, action === 'clear' ? null : response.result.goal, response.cursor);
      objective.value = entry.goal?.objective ?? ''; entry.baseline = entry.goal?.objective ?? null;
      return true;
    } catch (error) {
      if (valid(entry)) { entry.unknown = error.outcome === 'unknown' || !error.status; fail(entry, Error(error.message + (entry.unknown ? ' 操作状态未知，请重新打开目标核对后再操作。' : ''))); }
      return false;
    } finally { writing = false; render(); }
  }
  bind($('#goal-form'), 'submit', event => { event.preventDefault(); change('set'); });
  bind(objective, 'input', () => { if (target) target.dirty = true; });
  bind($('#goal-toggle'), 'click', () => change(target?.goal?.status === 'active' ? 'pause' : 'resume'));
  bind($('#goal-clear'), 'click', () => change('clear'));
  bind($('#close-goal'), 'click', close); bind(dialog, 'close', () => { target = null; });
  return {
    async command(args) {
      if (writing) return false;
      const state = getState();
      if (args && !['edit', 'pause', 'resume', 'clear'].includes(args.toLowerCase()) && (state.attachments.length || state.selections.length)) throw Error('请先将文件、图片或引用作为会话消息发送，再设置目标。');
      const entry = target = { state, generation: state.generation, goal: null, cursor: null, loading: true, dirty: false, baseline: null };
      objective.value = ''; $('#goal-error').textContent = ''; dialog.showModal(); render();
      try {
        const response = await api('/api/thread/goal', { viewId, threadId: state.threadId, action: 'get' });
        if (!valid(entry)) return false;
        apply(entry, response.result.goal, response.cursor); entry.loading = false; render();
        if (['pause', 'resume', 'clear'].includes(args.toLowerCase())) return await change(args.toLowerCase());
        if (args && args.toLowerCase() !== 'edit') { objective.value = args; entry.dirty = true; return await change('set'); }
        objective.focus(); return true;
      } catch (error) { entry.unknown = true; fail(entry, error); return false; }
      finally { if (target === entry) { entry.loading = false; render(); } }
    },
    render,
    onEvent(event) {
      const entry = target, p = event.native?.params;
      if (entry && p?.threadId === entry.state.threadId && ['thread/goal/updated', 'thread/goal/cleared'].includes(event.native.method)) apply(entry, event.native.method === 'thread/goal/cleared' ? null : p.goal, event.cursor);
      render();
    },
    dispose() { alive = false; abort.abort(); close(); },
  };
}
