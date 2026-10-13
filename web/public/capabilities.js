import { insertSelection } from './composer.js';

const identity = item => JSON.stringify([item.kind, item.path ?? item.id]);
const capability = item => ['skill', 'plugin', 'app'].includes(item.kind);
const title = item => item.displayName || item.name || item.token?.slice(1) || '能力';
const pagePreferences = new WeakMap();

export function mountCapabilities({ api, viewId, selectedHost = 'local', getState, onChange, onOpen }) {
  const $ = selector => document.querySelector(selector), dialog = $('#capabilities-dialog'), draft = $('#draft'), search = $('#capability-search');
  const results = $('#capability-results'), details = $('#capability-details'), status = $('#capability-status'), trigger = $('#show-capabilities'), tags = $('#selected-capabilities');
  if (!pagePreferences.has(document)) pagePreferences.set(document, new Map());
  const abort = new AbortController(), metadata = new Map(), memoryPreferences = pagePreferences.get(document);
  let context, revision = 0, alive = true, items = [], unavailable = [], tab = 'skills', filter = 'all', choices = [], preferenceKey;
  let favorites = [], recent = [], storageLimited = false, loading = false, composing = false, tagSnapshot;
  const node = (tag, text, className) => { const value = document.createElement(tag); if (text != null) value.textContent = text; if (className) value.className = className; return value; };
  const button = (text, label, action, className) => { const value = node('button', text, className); value.type = 'button'; value.setAttribute('aria-label', label); value.onclick = action; return value; };
  const valid = value => alive && value && getState() === value.state && value.state.ready && value.state.online !== false && !value.state.deleting && value.generation === value.state.generation && value.cwd === value.state.settings?.cwd && value.source === value.state.draft;
  const selections = () => (getState()?.selections ?? []).filter(item => capability(item) && getState().draft.slice(item.start, item.end) === item.token);
  const selected = item => selections().some(selection => identity(selection) === identity(item));
  function preferences() {
    const next = JSON.stringify(['codex-capabilities', selectedHost, getState()?.settings?.cwd]);
    if (next === preferenceKey) return;
    preferenceKey = next; metadata.clear(); items = []; readPreferences();
  }
  function readPreferences() {
    const memory = memoryPreferences.get(preferenceKey);
    favorites = memory?.favorites ?? []; recent = memory?.recent ?? []; storageLimited = Boolean(memory?.dirty);
    if (memory?.dirty) return;
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? JSON.stringify(memory ?? {}));
      favorites = Array.isArray(saved?.favorites) ? saved.favorites.filter(value => typeof value === 'string') : [];
      recent = Array.isArray(saved?.recent) ? saved.recent.filter(value => typeof value === 'string').slice(0, 20) : [];
      memoryPreferences.set(preferenceKey, { favorites, recent, dirty: false });
    } catch { storageLimited = true; }
  }
  function persist() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ favorites, recent })); storageLimited = false; }
    catch { storageLimited = true; }
    memoryPreferences.set(preferenceKey, { favorites, recent, dirty: storageLimited });
  }
  function remember(item) {
    if (!capability(item)) return;
    preferences(); readPreferences(); const key = identity(item); metadata.set(key, item);
    recent = [key, ...recent.filter(value => value !== key)].slice(0, 20); persist();
  }
  function close(edit = false) {
    ++revision; context = null; loading = false; trigger.setAttribute('aria-expanded', 'false');
    if (dialog.open) dialog.close();
    if (edit && !draft.disabled) draft.focus();
  }
  function position() {
    const box = document.querySelector('#composer').getBoundingClientRect(), width = Math.min(480, window.innerWidth - 24);
    dialog.style.left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12)) + 'px';
    dialog.style.bottom = Math.max(12, Math.min(window.innerHeight - box.top + 8, window.innerHeight - 240)) + 'px';
    dialog.style.maxHeight = Math.max(200, Math.min(560, box.top - 24)) + 'px';
  }
  function choose(item) {
    if (!valid(context)) { close(); return; }
    if (loading || composing || item.disabled || context.state.composing || selected(item)) return;
    const caret = insertSelection(context.state, item, context);
    draft.value = context.state.draft; draft.setSelectionRange(caret, caret);
    context = { ...context, start: caret, end: caret, source: context.state.draft };
    remember(item); onChange(context.state); render(); renderList(); search.focus();
  }
  function remove(selection) {
    const state = getState(); if (!state?.ready || state.composing || state.draft.slice(selection.start, selection.end) !== selection.token) return;
    selection = state.selections.find(item => item.start === selection.start && item.end === selection.end && identity(item) === identity(selection)); if (!selection) return;
    const length = selection.end - selection.start;
    state.draft = state.draft.slice(0, selection.start) + state.draft.slice(selection.end);
    state.selections = state.selections.filter(item => item !== selection).map(item => item.start >= selection.end ? { ...item, start: item.start - length, end: item.end - length } : item);
    draft.value = state.draft; draft.setSelectionRange(selection.start, selection.start); close(); onChange(state); render(); draft.focus();
  }
  function row(item, target, inDetails = false) {
    const key = identity(item), name = title(item), entry = node('li', null, 'capability-row'), content = node('div', null, 'capability-copy');
    content.append(node('strong', name), node('small', item.name === name ? item.source : item.name + ' · ' + item.source, 'muted small'), node('p', item.description || '暂无用途说明'));
    if (item.kind === 'skill' && items.some(other => other !== item && other.kind === 'skill' && title(other) === name)) content.append(node('small', item.path, 'muted small'));
    const state = node('span', selected(item) ? '已选 · ' + item.status : item.status, 'capability-state');
    content.append(state);
    const actions = node('div', null, 'capability-actions'), choice = button(selected(item) ? '已选' : '选择', '选择 ' + name, () => choose(item), 'capability-choice');
    choice.disabled = Boolean(loading || item.disabled || selected(item)); choices.push(choice);
    const wasFavorite = favorites.includes(key);
    const favorite = button(wasFavorite ? '★' : '☆', (wasFavorite ? '取消收藏 ' : '收藏 ') + name, () => {
      if (!valid(context)) { close(); return; }
      readPreferences(); favorites = wasFavorite ? favorites.filter(value => value !== key) : [...new Set([...favorites, key])]; persist(); renderList();
      const replacement = [...results.querySelectorAll('button')].find(value => value.getAttribute('aria-label') === (favorites.includes(key) ? '取消收藏 ' : '收藏 ') + name);
      (replacement ?? search).focus();
    }, 'capability-favorite');
    favorite.setAttribute('aria-pressed', String(favorites.includes(key))); actions.append(favorite, choice);
    if (!inDetails) actions.append(button('详情', '查看 ' + name + ' 详情', () => showDetails(item), 'small'));
    entry.append(content, actions); target.append(entry);
  }
  function showDetails(item) {
    if (!valid(context)) { close(); return; }
    details.replaceChildren(); details.hidden = false; results.hidden = true; choices = [];
    const back = button('← 返回列表', '返回能力列表', () => { renderList(); search.focus(); }, 'small');
    details.append(back, node('h3', title(item)), node('p', item.description || '暂无用途说明'), node('p', item.source + ' · ' + item.status, 'muted small'));
    details.append(node('p', item.path ?? item.id, 'muted small'));
    if (item.kind === 'plugin') {
      details.append(node('h4', '包含的技能（' + (item.skills?.length ?? 0) + '）'));
      if (!item.skills?.length) details.append(node('p', '当前工作区未发现可列出的插件技能。', 'muted small'));
      const list = node('ul', null, 'capability-results'); for (const skill of item.skills ?? []) row(skill, list, true); details.append(list);
    }
    details.append(button(selected(item) ? '已选' : '选择此能力', '选择 ' + title(item), () => choose(item), 'capability-choice'));
    details.lastChild.disabled = Boolean(loading || item.disabled || selected(item)); choices.push(details.lastChild);
    back.focus();
  }
  function renderList() {
    if (!valid(context)) return;
    details.hidden = true; results.hidden = false; results.replaceChildren(); choices = [];
    const query = search.value.trim().toLocaleLowerCase();
    const matches = item => [item.name, item.displayName, item.description, item.source, ...(item.keywords ?? [])].some(value => value?.toLocaleLowerCase().includes(query));
    const visible = items.filter(item => (tab === 'skills' ? item.kind === 'skill' : item.kind !== 'skill') && (matches(item) || item.skills?.some(matches)) && (filter === 'all' || (filter === 'favorites' ? favorites : recent).includes(identity(item))));
    visible.sort((a, b) => filter === 'recent' ? recent.indexOf(identity(a)) - recent.indexOf(identity(b)) : Number(favorites.includes(identity(b))) - Number(favorites.includes(identity(a))) || Number(a.disabled) - Number(b.disabled) || title(a).localeCompare(title(b), 'zh-CN'));
    for (const item of visible) row(item, results);
    if (!visible.length) results.append(node('li', loading ? '正在读取当前工作区的能力…' : filter === 'favorites' ? '还没有匹配的收藏。点击条目旁的星标收藏。' : filter === 'recent' ? '还没有匹配的最近使用记录。选择后会显示在这里。' : query ? '没有匹配结果。试试用途关键词，或清空搜索浏览全部。' : '当前工作区没有可列出的能力。可以刷新列表重试。', 'capability-empty muted'));
    for (const value of ['skills', 'plugins']) { const control = $('#capability-tab-' + value); control.setAttribute('aria-selected', String(tab === value)); control.setAttribute('tabindex', tab === value ? '0' : '-1'); }
    $('#capability-panel').setAttribute('aria-labelledby', 'capability-tab-' + tab);
    for (const value of ['all', 'favorites', 'recent']) $('#capability-filter-' + value).setAttribute('aria-pressed', String(filter === value));
    status.textContent = [...unavailable.map(issue => issue.kind + '：' + issue.message), loading ? '正在读取…' : visible.length + ' 项', storageLimited ? '收藏和最近使用暂时只保存在当前页面。' : '收藏和最近使用保存在此浏览器'].join(' · ');
    $('#refresh-capabilities').disabled = loading;
  }
  async function load() {
    if (!valid(context)) return;
    const current = context, version = ++revision; loading = true; unavailable = []; renderList();
    try {
      const catalog = await api('/api/capabilities', { viewId, threadId: current.state.threadId });
      if (version !== revision || !valid(current)) { if (version === revision) close(); return; }
      items = catalog.items; unavailable = catalog.unavailable ?? []; metadata.clear();
      for (const item of items) { metadata.set(identity(item), item); for (const child of item.skills ?? []) metadata.set(identity(child), child); }
    } catch (error) {
      if (version !== revision || !valid(current)) { if (version === revision) close(); return; }
      items = []; unavailable = [{ kind: '列表暂时无法读取', message: error.message }];
    }
    loading = false; render(); renderList();
  }
  function open() {
    const state = getState(); if (!alive || !state?.ready || state.online === false || state.deleting || state.composing) return;
    onOpen?.(); preferences(); readPreferences(); let start = draft.selectionStart ?? state.draft.length, end = draft.selectionEnd ?? start;
    const binding = state.selections?.find(item => item.start < start && start < item.end);
    if (start === end && binding) start = end = binding.end;
    context = { state, generation: state.generation, cwd: state.settings?.cwd, source: state.draft, start, end };
    search.value = ''; filter = 'all'; composing = false; position(); dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); search.focus(); load();
  }
  function render() {
    const state = getState(); trigger.disabled = !state?.ready || state.online === false || state.deleting;
    if (context && !valid(context)) close(); preferences();
    const bound = selections(), snapshot = JSON.stringify([state?.threadId, preferenceKey, trigger.disabled, state?.composing, bound.map(item => [identity(item), item.start, item.end, title(metadata.get(identity(item)) ?? item)])]);
    if (snapshot === tagSnapshot) return;
    tagSnapshot = snapshot; tags.replaceChildren(); tags.hidden = !bound.length;
    if (bound.length) tags.append(node('span', '本条消息', 'muted small'));
    for (const selection of bound) {
      const name = title(metadata.get(identity(selection)) ?? selection), chip = button(name + ' ×', '移除 ' + name, () => remove(selection), 'capability-chip');
      chip.disabled = Boolean(trigger.disabled || state.composing); chip.title = name; tags.append(chip);
    }
    if (context && dialog.open) position();
  }
  const bind = (element, event, action) => element.addEventListener(event, action, { signal: abort.signal });
  bind(trigger, 'click', open); bind($('#close-capabilities'), 'click', () => close()); bind($('#done-capabilities'), 'click', () => close(true));
  bind($('#refresh-capabilities'), 'click', load); bind(dialog, 'cancel', () => close()); bind(dialog, 'close', () => close());
  bind(dialog, 'click', event => { if (event.target !== dialog) return; const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); });
  bind(search, 'input', renderList);
  bind(search, 'compositionstart', () => { composing = true; });
  bind(search, 'compositionend', () => { composing = false; });
  bind(search, 'keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    const first = choices.find(value => !value.disabled);
    if (event.key === 'ArrowDown' && first) { event.preventDefault(); first.focus(); }
    if (event.key === 'Enter') { event.preventDefault(); first?.click(); }
  });
  bind(dialog, 'keydown', event => {
    if (event.isComposing || event.keyCode === 229 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !choices.includes(event.target)) return;
    const enabled = choices.filter(value => !value.disabled), index = enabled.indexOf(event.target);
    event.preventDefault(); (event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length])?.focus();
  });
  for (const value of ['skills', 'plugins']) {
    const control = $('#capability-tab-' + value);
    bind(control, 'click', () => { tab = value; renderList(); });
    bind(control, 'keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); tab = event.key === 'Home' ? 'skills' : event.key === 'End' ? 'plugins' : value === 'skills' ? 'plugins' : 'skills'; renderList(); $('#capability-tab-' + tab).focus(); });
  }
  for (const value of ['all', 'favorites', 'recent']) bind($('#capability-filter-' + value), 'click', () => { filter = value; renderList(); });
  window.addEventListener?.('resize', position, { signal: abort.signal });
  window.addEventListener?.('storage', event => { if (event.key !== null && event.key !== preferenceKey) return; readPreferences(); if (valid(context)) renderList(); }, { signal: abort.signal });
  return { render, close, remember, dispose() { alive = false; abort.abort(); close(); } };
}
