import { displayNativeText } from './composer.js';

export function mountFollowups({ api, viewId, getState, onChange, onError }) {
  const $ = selector => document.querySelector(selector), abort = new AbortController(), rows = new Map();
  const list = $('#queued-messages'), menu = $('#queue-menu'), mode = $('#send-mode');
  const menuButtons = ['#queue-menu-edit', '#queue-menu-side', '#queue-menu-toggle'].map($);
  let alive = true, target, trigger, editing, displayed;
  try { mode.value = sessionStorage.getItem('codex-follow-up-mode') === 'steer' ? 'steer' : 'queue'; }
  catch { mode.value = 'queue'; }
  const bind = (node, type, fn) => node.addEventListener(type, event => {
    try { Promise.resolve(fn(event)).catch(onError); } catch (e) { onError(e); }
  }, { signal: abort.signal });
  const label = item => [item.input.find(part => part.type === 'text'), ...item.input.filter(part => part.type !== 'text')].filter(Boolean).map(part => part.type === 'text' ? displayNativeText(part) : ['localImage', 'image'].includes(part.type) ? '［图片］' : part.name ?? '').filter(Boolean).join('\n');
  function closeMenu(focus = false) {
    const previous = trigger; target = trigger = null;
    menu.hidePopover(); menu.hidden = true; previous?.setAttribute('aria-expanded', 'false'); if (focus) previous?.focus();
  }
  function setMode(value) { mode.value = value; try { sessionStorage.setItem('codex-follow-up-mode', value); } catch {} }
  function openSide(threadId) {
    $('#side-chat-frame').src = '/?thread=' + encodeURIComponent(threadId) + '&side=1';
    $('#side-chat').hidden = false; $('#close-side-chat').focus();
  }
  bind(mode, 'change', () => setMode(mode.value));
  async function load(state) {
    if (!alive || !state?.ready) return;
    const revision = state.queueRevision = (state.queueRevision ?? 0) + 1, generation = state.generation, data = [];
    let cursor;
    do {
      const response = await api('/api/rpc', { method: 'thread/queue/list', params: { threadId: state.threadId, limit: 100, ...(cursor ? { cursor } : {}) } });
      if (!alive || revision !== state.queueRevision || !state.ready || state.generation !== generation) return;
      data.push(...response.result.data); cursor = response.result.nextCursor;
    } while (cursor);
    state.queued = data; render();
  }
  async function action(state, item, kind, text) {
    if (!state.ready || mode.disabled || state.queueBusy || state.queueRecovery && kind !== 'restore') return;
    const transfer = ['steer', 'side'].includes(kind), operationId = crypto.randomUUID();
    if (transfer) { state.queueRecovery = { id: operationId, queuedSubmissionId: item.id, text: label(item) }; onChange(state); }
    state.queueBusy = true; render();
    try {
      const response = await api('/api/thread/queue', { viewId, threadId: state.threadId, queuedSubmissionId: item.id, action: kind,
        ...(kind !== 'delete' ? { operationId } : {}), ...(kind === 'restore' ? { recoveryId: state.queueRecovery.id } : {}), ...(text !== undefined ? { text } : {}) });
      if (transfer || kind === 'restore') state.queueRecovery = null;
      if (kind !== 'update') state.queued = state.queued.filter(entry => entry.id !== item.id);
      if (alive && kind === 'side') {
        openSide(response.result.threadId);
      }
      await load(state); return true;
    } catch (e) {
      if (transfer && e.status && e.outcome !== 'unknown') state.queueRecovery = null;
      if (e.queueRecovery) state.queueRecovery = e.queueRecovery;
      if (alive && e.queueRecovery?.sideThreadId) openSide(e.queueRecovery.sideThreadId);
      load(state).catch(onError); throw e;
    } finally { state.queueBusy = false; onChange(state); render(); }
  }
  function button(text, name, click, icon) {
    const node = document.createElement('button'); node.type = 'button'; node.dataset.action = name;
    node.setAttribute('aria-label', text); node.title = text;
    if (icon) { node.className = 'icon-button'; node.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + icon + '</svg>'; }
    else node.textContent = text;
    bind(node, 'click', click); return node;
  }
  function render() {
    if (!alive) return;
    const state = getState(); mode.disabled = !state?.ready || !state.online || state.deleting;
    if (displayed !== state) { closeMenu(); rows.clear(); list.replaceChildren(); displayed = state; }
    if (target && (!state?.ready || !state.queued?.some(item => item.id === target.item.id))) closeMenu();
    list.hidden = !state?.queued?.length;
    $('#queue-recovery').hidden = !state?.queueRecovery;
    $('#queue-recovery-text').textContent = state?.queueRecovery ? '消息发送状态待核对：' + state.queueRecovery.text : '';
    $('#queue-recovery-restore').disabled = $('#queue-recovery-dismiss').disabled = mode.disabled || Boolean(state?.queueBusy);
    let index = 0;
    for (const item of state?.queued ?? []) {
      let row = rows.get(item.id);
      if (!row) {
        row = document.createElement('div'); row.className = 'queued-message'; row.dataset.queuedSubmissionId = item.id;
        const icon = document.createElement('span'); icon.className = 'queue-icon'; icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 4v12a3 3 0 0 0 3 3h11m-4-4 4 4-4 4M9 5h10M9 9h10"/></svg>';
        const text = document.createElement('span'); text.className = 'queued-text'; row.append(icon, text);
        row.append(button('引导', 'steer', () => action(state, row.item, 'steer')),
          button('删除排队消息', 'delete', () => action(state, row.item, 'delete'), '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'));
        const more = button('消息选项', 'menu', () => {
          closeMenu(); target = { state, item: row.item }; trigger = more; more.setAttribute('aria-expanded', 'true');
          $('#queue-menu-toggle').textContent = mode.value === 'queue' ? '关闭排队' : '开启排队';
          menu.hidden = false; menu.showPopover(); const rect = more.getBoundingClientRect();
          menu.style.left = Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)) + 'px';
          menu.style.top = Math.max(8, Math.min(rect.top - (menu.offsetHeight || 140) - 4, window.innerHeight - (menu.offsetHeight || 140) - 8)) + 'px';
          $('#queue-menu-edit').focus();
        }, '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>');
        more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); row.append(more); rows.set(item.id, row);
      }
      row.item = item; row.children[1].textContent = label(item); row.children[1].title = label(item);
      for (const control of row.querySelectorAll('button')) control.disabled = mode.disabled || Boolean(state.queueBusy) || Boolean(state.queueRecovery);
      if (list.children[index++] !== row) list.insertBefore(row, list.children[index - 1] ?? null);
    }
    for (const [id, row] of rows) if (!state?.queued?.some(item => item.id === id)) { row.remove(); rows.delete(id); }
    for (const node of menuButtons) node.disabled = mode.disabled || Boolean(state?.queueBusy);
  }
  bind(menu, 'toggle', event => { if (event.newState === 'closed' && target) closeMenu(); });
  bind(menu, 'keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = menuButtons.filter(node => !node.disabled), index = items.indexOf(document.activeElement);
    event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  bind($('#queue-menu-toggle'), 'click', () => { setMode(mode.value === 'queue' ? 'steer' : 'queue'); closeMenu(true); });
  bind($('#queue-menu-side'), 'click', () => { const current = target; closeMenu(); return action(current.state, current.item, 'side'); });
  bind($('#queue-menu-edit'), 'click', () => {
    editing = target; closeMenu(); $('#queue-edit-text').value = displayNativeText(editing.item.input.find(part => part.type === 'text') ?? { text: '' });
    $('#queue-edit-error').textContent = ''; $('#queue-edit-dialog').showModal(); $('#queue-edit-text').focus();
  });
  bind($('#queue-edit-cancel'), 'click', () => { editing = null; $('#queue-edit-dialog').close(); });
  $('#queue-edit-form').addEventListener('submit', async event => {
    event.preventDefault(); const current = editing, text = $('#queue-edit-text').value;
    if (!current || current.state.queueBusy || !text.trim()) return;
    $('#queue-edit-save').disabled = true; $('#queue-edit-error').textContent = '';
    try { if (await action(current.state, current.item, 'update', text) && editing === current) { editing = null; $('#queue-edit-dialog').close(); } }
    catch (e) { if (alive) $('#queue-edit-error').textContent = e.message; }
    finally { if (alive) $('#queue-edit-save').disabled = false; }
  }, { signal: abort.signal });
  bind($('#close-side-chat'), 'click', () => { $('#side-chat').hidden = true; $('#side-chat-frame').src = 'about:blank'; $('#draft').focus(); });
  bind($('#queue-recovery-restore'), 'click', () => {
    const state = getState(); if (state?.queueRecovery && window.confirm('请先核对当前及侧边会话。确认这条消息需要重新排队？')) return action(state, { id: state.queueRecovery.queuedSubmissionId }, 'restore');
  });
  bind($('#queue-recovery-dismiss'), 'click', () => { const state = getState(); if (state && !state.queueBusy) { state.queueRecovery = null; onChange(state); render(); } });
  return { load, render, dispose() { alive = false; closeMenu(); abort.abort(); $('#queue-edit-dialog').close(); $('#side-chat').hidden = true; $('#side-chat-frame').src = 'about:blank'; } };
}
