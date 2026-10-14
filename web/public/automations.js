const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const effortLabels = { none: '无', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高' };

export function mountAutomations({ api, viewId, selectedHost = 'local', getState, onOpenThread }) {
  const $ = id => document.querySelector('#' + id), trigger = $('show-automations'), dialog = $('automations-dialog');
  trigger.hidden = selectedHost !== 'local';
  if (selectedHost !== 'local') return { onEvent() {}, dispose() {} };
  const abort = new AbortController(), rows = new Map(), busyRows = new Set();
  const list = $('automation-list'), listError = $('automation-list-error'), form = $('automation-form'), formError = $('automation-form-error'), menu = $('automation-menu');
  list.replaceChildren();
  const fields = ['name', 'prompt', 'kind', 'thread', 'project', 'model', 'effort', 'schedule', 'interval', 'time', 'once', 'rule'].map(name => $('automation-' + name));
  let alive = true, session = 0, listRevision = 0, formRevision = 0, context, editing, saving = false, composing = false, conflicted = false, timeZone;
  let menuRow, menuTrigger, models = [];
  const bind = (element, event, action) => element.addEventListener(event, action, { signal: abort.signal });
  const node = (tag, text, className) => { const value = document.createElement(tag); if (text != null) value.textContent = text; if (className) value.className = className; return value; };
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const active = version => alive && dialog.open && version === session && context?.state === getState() && context?.threadId === getState()?.threadId;
  const currentForm = (version, revision) => active(version) && !form.hidden && revision === formRevision;

  function closeMenu(restoreFocus = false) {
    const control = menuTrigger; menuRow = menuTrigger = null;
    if (menu.matches(':popover-open')) menu.hidePopover(); menu.hidden = true;
    control?.setAttribute('aria-expanded', 'false'); if (restoreFocus) control?.focus();
  }
  function ended() {
    ++session; ++formRevision; context = editing = null; saving = composing = conflicted = false; busyRows.clear(); closeMenu();
    trigger.setAttribute('aria-expanded', 'false');
  }
  function close(restoreFocus = true) {
    if (dialog.open) dialog.close(); else ended();
    if (restoreFocus && alive) trigger.focus();
  }
  function date(value) {
    if (!Number.isFinite(value)) return '未知';
    return new Date(value).toLocaleString('zh-CN', { ...(timeZone ? { timeZone } : {}), hour12: false });
  }
  function scheduleLabel(rrule) {
    const rule = rrule.trim().replace(/^RRULE:/, ''), pad = value => value.padStart(2, '0');
    let match = rule.match(/^FREQ=(MINUTELY|HOURLY);INTERVAL=(\d+)$/);
    if (match) return '每 ' + match[2] + (match[1] === 'MINUTELY' ? ' 分钟' : ' 小时');
    match = rule.match(/^FREQ=(DAILY|WEEKLY)(?:;BYDAY=([A-Z,]+))?;BYHOUR=(\d{1,2});BYMINUTE=(\d{1,2})(?:;BYSECOND=0)?$/);
    if (match) {
      const weekdays = match[2]?.split(',');
      if (match[1] === 'DAILY' && !weekdays) return '每天 ' + pad(match[3]) + ':' + pad(match[4]);
      if (match[1] === 'WEEKLY' && weekdays?.every(day => days.includes(day))) return '每' + weekdays.map(day => '周' + '一二三四五六日'[days.indexOf(day)]).join('、') + ' ' + pad(match[3]) + ':' + pad(match[4]);
    }
    match = rule.match(/^DTSTART;TZID=[^:\n]+:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})00\nRRULE:FREQ=DAILY;COUNT=1$/);
    if (match) return '一次 · ' + match[1] + '/' + match[2] + '/' + match[3] + ' ' + match[4] + ':' + match[5];
    match = rule.match(/^DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\nRRULE:FREQ=DAILY;COUNT=1$/);
    if (match) return '一次 · ' + date(Date.parse(match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] + ':' + match[6] + 'Z'));
    return '自定义计划';
  }
  function rowFor(item) {
    let row = rows.get(item.id);
    if (!row) {
      row = { node: node('li', null, 'automation-row'), name: node('button', null, 'automation-name'), meta: node('p', null, 'muted small'), prompt: node('p'), rule: node('p', null, 'automation-rule muted small'), times: node('p', null, 'muted small'), action: node('button', '⋯', 'icon-button automation-row-menu') };
      row.node.dataset.automationId = item.id; row.name.type = row.action.type = 'button'; row.action.setAttribute('aria-haspopup', 'menu'); row.action.setAttribute('aria-expanded', 'false');
      const content = node('div', null, 'automation-copy'); content.append(row.name, row.meta, row.prompt, row.rule, row.times); row.node.append(content, row.action);
      bind(row.name, 'click', () => edit(row.item.id)); bind(row.action, 'click', () => openMenu(row)); rows.set(item.id, row);
    }
    row.item = item; text(row.name, item.name); row.name.setAttribute('aria-label', '编辑 ' + item.name); row.action.setAttribute('aria-label', item.name + ' 的选项');
    text(row.meta, (item.status === 'PAUSED' ? '已暂停' : '已启用') + ' · ' + (item.kind === 'heartbeat' ? '继续原会话' : '独立会话'));
    text(row.prompt, item.promptPreview ?? ''); text(row.rule, scheduleLabel(item.rrule)); row.rule.title = item.rrule;
    text(row.times, '下一次：' + date(item.nextRunAt) + ' · 上次：' + date(item.lastRunAt));
    row.name.disabled = row.action.disabled = busyRows.has(item.id); return row;
  }
  async function loadList() {
    const version = session, revision = ++listRevision; if (!active(version)) return;
    $('refresh-automations').disabled = true; text($('automation-list-status'), '正在读取原生任务…'); listError.textContent = '';
    try {
      const result = await api('/api/automations/list', { viewId }); if (!active(version) || revision !== listRevision) return;
      timeZone = result.timeZone; text($('automation-timezone'), '服务电脑本地时间' + (timeZone ? '（' + timeZone + '）' : ''));
      const focus = list.contains(document.activeElement) ? document.activeElement : null, ids = new Set(result.items.map(item => item.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.node.remove(); rows.delete(id); }
      result.items.forEach((item, index) => { const row = rowFor(item); if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] ?? null); });
      if (focus?.isConnected && document.activeElement !== focus) focus.focus();
      $('automation-empty').hidden = result.items.length > 0; text($('automation-list-status'), result.items.length + ' 个任务');
      listError.textContent = (result.unavailable ?? []).map(issue => typeof issue === 'string' ? issue : (issue.id ? issue.id + '：' : '') + issue.message).join('\n');
    } catch (error) { if (active(version) && revision === listRevision) { listError.textContent = error.message; text($('automation-list-status'), '读取失败，可刷新重试'); } }
    finally { if (active(version) && revision === listRevision) $('refresh-automations').disabled = false; }
  }
  function open() {
    if (!alive) return;
    const state = getState(); context = { state, threadId: state?.threadId }; ++session;
    form.hidden = true; $('automation-list-panel').hidden = false; text($('automations-title'), '定时任务'); trigger.setAttribute('aria-expanded', 'true');
    dialog.showModal(); $('new-automation').focus(); loadList();
  }
  function openMenu(row) {
    if (!active(session) || busyRows.has(row.item.id)) return;
    closeMenu(); menuRow = row; menuTrigger = row.action; menuTrigger.setAttribute('aria-expanded', 'true');
    text($('automation-menu-toggle'), row.item.status === 'PAUSED' ? '恢复任务' : '暂停任务'); $('automation-menu-open').hidden = row.item.kind !== 'heartbeat';
    menu.hidden = false; menu.showPopover(); const box = menuTrigger.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(box.right - 224, window.innerWidth - 232)) + 'px';
    menu.style.top = Math.max(8, Math.min(box.bottom + 4, window.innerHeight - (menu.offsetHeight || 180) - 8)) + 'px'; $('automation-menu-edit').focus();
  }
  function selectOptions(select, data, emptyLabel, fallback, chosen = select.value) {
    const options = [];
    if (emptyLabel != null) { const option = node('option', emptyLabel); option.value = ''; options.push(option); }
    for (const item of data) { const option = node('option', item.label); option.value = item.id; options.push(option); }
    if (chosen && !options.some(option => option.value === chosen)) { const option = node('option', fallback ?? chosen); option.value = chosen; options.push(option); }
    select.replaceChildren(...options); select.value = chosen || (emptyLabel == null ? options[0]?.value ?? '' : '');
  }
  function effortOptions(preferred = $('automation-effort').value) {
    const chosen = $('automation-model').value, model = models.find(item => item.model === chosen) ?? (!chosen ? models.find(item => item.isDefault) : null);
    selectOptions($('automation-effort'), (model?.supportedReasoningEfforts ?? []).map(item => ({ id: item.reasoningEffort, label: effortLabels[item.reasoningEffort] ?? item.reasoningEffort })), '沿用 Codex 默认', null, preferred);
  }
  async function pages(method, params = {}) {
    const items = [], seen = new Set(); let cursor;
    do {
      const { result } = await api('/api/rpc', { method, params: { limit: 100, ...params, ...(cursor ? { cursor } : {}) } });
      items.push(...result.data); cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('原生目录返回了重复的分页游标。'); if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function catalogs(version, revision) {
    const issues = [], pending = new Set(['会话', '项目', '模型']);
    const status = () => { if (currentForm(version, revision)) text($('automation-catalog-status'), [...(pending.size ? ['正在读取' + [...pending].join('、') + '…'] : []), ...issues].join(' · ')); };
    status();
    await Promise.allSettled([['thread/list', '会话'], ['project/list', '项目'], ['model/list', '模型']].map(async ([method, label]) => {
      try {
        const data = await pages(method, method === 'thread/list' ? { archived: false, modelProviders: [], sortKey: 'recency_at', sortDirection: 'desc' } : {});
        if (!currentForm(version, revision)) return;
        if (method === 'thread/list') {
          const state = getState(); if (state?.ready && state.threadId && !data.some(item => item.id === state.threadId)) data.unshift({ id: state.threadId, name: state.thread?.name || state.thread?.preview || '当前会话（未命名）' });
          selectOptions($('automation-thread'), data.map(item => ({ id: item.id, label: item.name || item.preview || item.id })), null, '原会话（' + $('automation-thread').value + '）');
        } else if (method === 'project/list') selectOptions($('automation-project'), data.filter(item => item.metadata?.['codex-console.archived'] !== 'true').map(item => ({ id: item.id, label: item.name || item.id })), '无项目');
        else { models = data; selectOptions($('automation-model'), models.map(item => ({ id: item.model, label: item.displayName || item.model })), '沿用 Codex 默认'); effortOptions(); }
      } catch (error) { issues.push(label + '：' + error.message); }
      finally { pending.delete(label); status(); }
    }));
  }
  function layoutFields() {
    const heartbeat = $('automation-kind').value === 'heartbeat', schedule = $('automation-schedule').value;
    $('automation-heartbeat-fields').hidden = !heartbeat; $('automation-cron-fields').hidden = heartbeat;
    $('automation-interval-field').hidden = !['minutes', 'hours'].includes(schedule); $('automation-time-field').hidden = !['daily', 'weekly'].includes(schedule);
    $('automation-days-field').hidden = schedule !== 'weekly'; $('automation-once-field').hidden = schedule !== 'once'; $('automation-rule-field').hidden = schedule !== 'custom';
  }
  function fillForm(item) {
    editing = item ?? null; models = []; conflicted = saving = composing = false; formError.textContent = '';
    for (const field of fields) field.disabled = false;
    const state = getState(), currentId = state?.ready ? state.threadId : '';
    $('automation-name').value = item?.name ?? ''; $('automation-prompt').value = item?.prompt ?? '';
    $('automation-kind').value = item?.kind ?? 'cron'; $('automation-kind').disabled = Boolean(item);
    selectOptions($('automation-thread'), currentId ? [{ id: currentId, label: state.thread?.name || state.thread?.preview || '当前会话（未命名）' }] : [], null, null, item?.targetThreadId ?? currentId);
    selectOptions($('automation-project'), [], '无项目', null, item?.projectId ?? '');
    selectOptions($('automation-model'), [], '沿用 Codex 默认', null, item?.model ?? '');
    effortOptions(item?.reasoningEffort ?? '');
    text($('automation-environment'), '执行环境：' + (item?.executionEnvironment === 'worktree' ? '原生工作树' : '本机') + '。工作目录由原生项目决定。');
    $('automation-schedule').value = item ? 'custom' : 'daily'; $('automation-rule').value = item?.rrule ?? '';
    $('automation-interval').value = '1'; $('automation-time').value = '09:00'; $('automation-once').value = '';
    for (const day of days) $('automation-day-' + day).checked = false;
    $('save-automation').disabled = false; text($('save-automation'), item ? '保存任务' : '创建任务'); layoutFields();
  }
  async function edit(id) {
    if (!active(session)) return;
    closeMenu(); const version = session, revision = ++formRevision;
    form.hidden = false; $('automation-list-panel').hidden = true; text($('automations-title'), id ? '编辑任务' : '新建任务');
    fillForm(); $('automation-form-scroll').scrollTop = 0;
    if (!id) { $('automation-name').focus(); catalogs(version, revision); return; }
    editing = { id }; for (const field of fields) field.disabled = true;
    $('save-automation').disabled = true; text($('automation-catalog-status'), '正在读取完整任务…'); $('cancel-automation').focus();
    try {
      const { item } = await api('/api/automations/read', { viewId, id }); if (!currentForm(version, revision)) return;
      fillForm(item); $('automation-name').focus(); catalogs(version, revision);
    } catch (error) { if (currentForm(version, revision)) { formError.textContent = error.message; text($('automation-catalog-status'), '任务读取失败，请返回列表后重试。'); } }
  }
  function back() {
    ++formRevision; editing = null; saving = composing = conflicted = false; form.hidden = true; $('automation-list-panel').hidden = false;
    text($('automations-title'), '定时任务'); $('new-automation').focus();
  }
  function recurrence() {
    const schedule = $('automation-schedule').value;
    if (schedule === 'custom') { const rule = $('automation-rule').value; if (!rule.trim()) throw new Error('请填写原生 RRULE。'); return rule === editing?.rrule ? rule : rule.trim(); }
    if (['minutes', 'hours'].includes(schedule)) { const interval = Number($('automation-interval').value); if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('间隔需要是大于 0 的整数。'); return 'FREQ=' + (schedule === 'minutes' ? 'MINUTELY' : 'HOURLY') + ';INTERVAL=' + interval; }
    if (schedule === 'once') {
      const value = $('automation-once').value;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请选择一次任务的日期与时间。');
      if (!timeZone || !/^[\w/+.-]+$/.test(timeZone)) throw new Error('尚未读取到服务电脑时区，请返回列表刷新后再试。');
      return 'DTSTART;TZID=' + timeZone + ':' + value.replaceAll('-', '').replaceAll(':', '') + '00\nRRULE:FREQ=DAILY;COUNT=1';
    }
    const [hour, minute] = $('automation-time').value.split(':').map(Number);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('请选择有效的执行时间。');
    const selectedDays = days.filter(day => $('automation-day-' + day).checked);
    if (schedule === 'weekly' && !selectedDays.length) throw new Error('每周计划至少选择一天。');
    return 'FREQ=' + (schedule === 'weekly' ? 'WEEKLY;BYDAY=' + selectedDays.join(',') : 'DAILY') + ';BYHOUR=' + hour + ';BYMINUTE=' + minute + ';BYSECOND=0';
  }
  async function save(event) {
    event.preventDefault(); const version = session, revision = formRevision;
    if (!currentForm(version, revision) || saving || conflicted || composing || event.isComposing || $('save-automation').disabled) return;
    formError.textContent = '';
    let item, patch;
    try {
      const name = $('automation-name').value.trim(), prompt = $('automation-prompt').value, kind = $('automation-kind').value;
      if (!name || !prompt.trim()) throw new Error('请填写任务名称和提示词。');
      item = { name, prompt, rrule: recurrence() };
      if (kind === 'heartbeat') { item.targetThreadId = $('automation-thread').value; if (!item.targetThreadId) throw new Error('请选择要继续的原会话。'); }
      else { item.projectId = $('automation-project').value || null; item.model = $('automation-model').value || null; item.reasoningEffort = $('automation-effort').value || null; }
      if (editing) patch = Object.fromEntries(Object.entries(item).filter(([key, value]) => value !== (editing[key] ?? (value === null ? null : undefined))));
      else item = { ...item, kind, status: 'ACTIVE', ...(kind === 'cron' ? { executionEnvironment: 'local' } : {}) };
    } catch (error) { formError.textContent = error.message; return; }
    if (editing && !Object.keys(patch).length) { back(); return; }
    saving = true; $('save-automation').disabled = true; text($('save-automation'), '正在保存…');
    try {
      await api('/api/automations/' + (editing ? 'update' : 'create'), editing ? { viewId, id: editing.id, expectedUpdatedAt: editing.updatedAt, patch } : { viewId, item });
      if (!currentForm(version, revision)) return; back(); loadList();
    } catch (error) {
      if (!currentForm(version, revision)) return;
      conflicted = error.status === 409; formError.textContent = conflicted ? '任务已在原生 Codex 中更改。输入内容已保留，请复制后返回列表，重新打开任务再编辑。' : error.message;
    } finally {
      if (currentForm(version, revision)) { saving = false; $('save-automation').disabled = conflicted; text($('save-automation'), editing ? '保存任务' : '创建任务'); }
    }
  }
  async function changeRow(action) {
    const row = menuRow, version = session; if (!row || !active(version) || busyRows.has(row.item.id)) return;
    const item = row.item; closeMenu(true);
    if (action === 'delete' && !window.confirm('删除“' + item.name + '”定时任务？已产生的会话会保留。')) return;
    busyRows.add(item.id); rowFor(item); listError.textContent = '';
    try {
      await api('/api/automations/' + (action === 'delete' ? 'delete' : 'update'), { viewId, id: item.id, expectedUpdatedAt: item.updatedAt, ...(action === 'delete' ? { confirmed: true } : { patch: { status: item.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' } }) });
      if (active(version)) await loadList();
    } catch (error) { if (active(version)) listError.textContent = error.status === 409 ? '任务已在原生 Codex 中更改，请刷新列表后重试。' : error.message; }
    finally {
      if (active(version)) {
        busyRows.delete(item.id); const existing = rows.get(item.id); if (existing) rowFor(existing.item);
        if (form.hidden && [document.body, dialog].includes(document.activeElement)) (existing?.action ?? $('new-automation')).focus();
      }
    }
  }
  bind(trigger, 'click', open); bind($('close-automations'), 'click', () => close()); bind(dialog, 'close', () => { if (!dialog.open) ended(); });
  bind(dialog, 'cancel', event => { event.preventDefault(); if (!composing) close(); });
  bind(dialog, 'click', event => { if (event.target !== dialog) return; const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); });
  bind($('refresh-automations'), 'click', loadList); bind($('new-automation'), 'click', () => edit()); bind($('cancel-automation'), 'click', back);
  bind(form, 'submit', save); bind(form, 'compositionstart', () => { composing = true; }); bind(form, 'compositionend', () => { composing = false; });
  bind($('automation-kind'), 'change', layoutFields); bind($('automation-schedule'), 'change', layoutFields);
  bind($('automation-model'), 'change', () => { $('automation-effort').value = ''; effortOptions(); });
  bind($('automation-menu-edit'), 'click', () => { if (menuRow) edit(menuRow.item.id); });
  bind($('automation-menu-toggle'), 'click', () => changeRow('toggle')); bind($('automation-menu-delete'), 'click', () => changeRow('delete'));
  bind($('automation-menu-open'), 'click', async () => {
    const item = menuRow?.item, version = session; if (item?.kind !== 'heartbeat' || !active(version)) return; closeMenu();
    try { await onOpenThread?.(item.targetThreadId); if (alive && session === version) close(false); }
    catch (error) { if (active(version)) listError.textContent = error.message; }
  });
  bind(menu, 'toggle', event => { if (event.newState === 'closed') closeMenu(); });
  bind(menu, 'keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const controls = ['edit', 'toggle', 'open', 'delete'].map(name => $('automation-menu-' + name)).filter(control => !control.hidden && !control.disabled), index = controls.indexOf(document.activeElement);
    (event.key === 'Home' ? controls[0] : event.key === 'End' ? controls.at(-1) : controls[(index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length])?.focus();
  });
  return {
    onEvent(event) { if (!alive || !dialog.open) return; if (!active(session)) { close(false); return; } if (event.native?.method === 'automation/changed') loadList(); },
    dispose() { if (!alive) return; close(false); alive = false; abort.abort(); trigger.hidden = true; rows.clear(); },
  };
}
