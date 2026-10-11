export function formatNativePath(path) {
  return /\s/u.test(path) && !path.includes('"') ? `"${path}"` : path;
}

export function displayNativeText(part) {
  const bytes = new TextEncoder().encode(part.text), decoder = new TextDecoder();
  let end = bytes.length, result = '';
  for (const range of [...(part.text_elements ?? [])].sort((a, b) => b.byteRange.start - a.byteRange.start)) {
    const { start, end: stop } = range.byteRange;
    if (typeof range.placeholder !== 'string' || !Number.isInteger(start) || !Number.isInteger(stop) || start < 0 || stop > end || start > stop) continue;
    result = range.placeholder + decoder.decode(bytes.subarray(stop, end)) + result; end = start;
  }
  return decoder.decode(bytes.subarray(0, end)) + result;
}

export function updateQueuedInput(input, text) {
  const index = input.findIndex(part => part.type === 'text');
  if (index < 0) return [{ type: 'text', text, text_elements: [] }, ...input];
  const part = input[index], bytes = new TextEncoder().encode(part.text), decoder = new TextDecoder();
  let original = '', offset = 0;
  const selections = [];
  for (const range of [...(part.text_elements ?? [])].sort((a, b) => a.byteRange.start - b.byteRange.start)) {
    const { start, end } = range.byteRange;
    if (typeof range.placeholder !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < offset || end > bytes.length || start > end) continue;
    original += decoder.decode(bytes.subarray(offset, start));
    selections.push({ start: original.length, end: original.length + range.placeholder.length,
      replacement: decoder.decode(bytes.subarray(start, end)), token: range.placeholder });
    original += range.placeholder; offset = end;
  }
  original += decoder.decode(bytes.subarray(offset));
  if (text === original) return input;
  let encoded = '', previous = 0; const elements = [];
  const retained = updateSelections(original, text, selections);
  // Dialog edits can change both sides of an otherwise unchanged reference.
  for (const selection of selections) {
    if (retained.some(item => item.replacement === selection.replacement && item.token === selection.token)) continue;
    const start = text.indexOf(selection.token);
    if (start < 0 || original.indexOf(selection.token) !== original.lastIndexOf(selection.token) || start !== text.lastIndexOf(selection.token)) continue;
    if (!retained.some(item => start < item.end && start + selection.token.length > item.start)) retained.push({ ...selection, start, end: start + selection.token.length });
  }
  for (const selection of retained.sort((a, b) => a.start - b.start)) {
    encoded += text.slice(previous, selection.start);
    const start = encoded.length; encoded += selection.replacement;
    elements.push({ byteRange: utf8Range(encoded, start, encoded.length), placeholder: selection.token });
    previous = selection.end;
  }
  encoded += text.slice(previous);
  return input.map((item, i) => i === index ? { ...part, text: encoded, text_elements: elements } : item);
}

export const COMMANDS = ['new', 'model', 'permissions', 'status', 'usage', 'skills', 'compact', 'rename', 'archive', 'delete', 'fork', 'export'];
const COMMAND_DETAILS = { new: '新建会话', model: '选择模型与思考强度', permissions: '查看当前权限', status: '查看会话状态', usage: '查看账号用量', skills: '选择技能', compact: '压缩当前会话上下文', rename: '重命名会话', archive: '归档当前会话', delete: '删除当前会话', fork: '从当前会话创建分支', export: '下载 Markdown 聊天记录' };
export function commandAction(text) {
  const match = text.trimEnd().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/);
  return match && COMMANDS.includes(match[1]) ? { command: match[1], args: match[2]?.trim() ?? '' } : null;
}
export function utf8Range(text, start, end) {
  const split = offset => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length || split(start) || split(end)) {
    throw Object.assign(new Error('引用位置已变化，请重新选择。'), { status: 400, code: 'INVALID_SELECTION_RANGE' });
  }
  const encode = new TextEncoder(); return { start: encode.encode(text.slice(0, start)).length, end: encode.encode(text.slice(0, end)).length };
}
export function findTrigger(text, caret, { composing = false } = {}) {
  if (composing) return null;
  const prefix = text.slice(0, caret);
  if ((prefix.match(/```/g)?.length ?? 0) % 2 || (prefix.split('\n').at(-1).match(/(?<!\\)`/g)?.length ?? 0) % 2) return null;
  const slash = prefix.match(/^\/([\p{L}\p{N}_-]*)$/u);
  if (slash) return { sigil: '/', query: slash[1], start: 0, end: caret + text.slice(caret).match(/^[\p{L}\p{N}_-]*/u)[0].length };
  const quoted = prefix.match(/(?:^|\s)([@$])"([^"\n]*)("?)$/);
  if (quoted) { const tail = text.slice(caret).split('\n')[0], close = tail.indexOf('"'); return { sigil: quoted[1], query: quoted[2], start: caret - quoted[2].length - 2 - quoted[3].length, end: quoted[3] ? caret : caret + (close < 0 ? tail.length : close + 1) }; }
  const match = prefix.match(/(?:^|\s)([@$])([^\s@$"`]*)$/);
  return match ? { sigil: match[1], query: match[2], start: caret - match[2].length - 1, end: caret + text.slice(caret).match(/^[^\s@$"`]*/)[0].length } : null;
}
export function updateSelections(previous, next, selections = []) {
  let start = 0, tail = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) ++start;
  while (tail < previous.length - start && tail < next.length - start && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) ++tail;
  const oldEnd = previous.length - tail, delta = next.length - previous.length;
  return selections.flatMap(item => item.end <= start ? [item] : item.start >= oldEnd ? [{ ...item, start: item.start + delta, end: item.end + delta }] : []);
}
function snapshotValue(selection, budget) {
  const title = [...(selection.name ?? '')].slice(0, 160).join(''), content = String(selection.snapshot ?? '');
  const quote = (snapshot, truncated) => JSON.stringify({ threadId: selection.id, title, snapshot, truncated }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const encode = new TextEncoder(), full = quote(content, Boolean(selection.truncated));
  if (encode.encode(full).length <= budget) return full;
  const chars = [...content]; let lo = 0, hi = chars.length;
  while (lo < hi) { const middle = Math.ceil((lo + hi) / 2); if (encode.encode(quote(chars.slice(0, middle).join(''), true)).length <= budget) lo = middle; else hi = middle - 1; }
  return quote(chars.slice(0, lo).join(''), true);
}
export function encodeComposer({ text, selections = [], uploads = [], threadId, mode }) {
  const ordered = [...selections].sort((a, b) => a.start - b.start), references = new Map();
  let previous = 0, idBytes = 0;
  for (const item of ordered) {
    utf8Range(text, item.start, item.end);
    if (item.start < previous || text.slice(item.start, item.end) !== item.token) throw Object.assign(new Error('引用文本已改变，请重新选择。'), { status: 400, code: 'STALE_SELECTION' });
    previous = item.end;
    if (item.kind === 'thread' && item.id !== threadId && !references.has(item.id)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) throw Object.assign(new Error('会话引用 ID 不正确。'), { status: 400, code: 'INVALID_THREAD_REFERENCE' });
      if (references.size >= 16 || idBytes + item.id.length > 768) throw Object.assign(new Error('会话引用超过原生数量或长度上限。'), { status: 400, code: 'TOO_MANY_REFERENCES' });
      references.set(item.id, item); idBytes += item.id.length;
    }
  }
  let encoded = '', offset = 0; const elements = [], typed = [], seen = new Set();
  for (const item of ordered) {
    encoded += text.slice(offset, item.start); let replacement = item.token;
    if (['file', 'directory'].includes(item.kind)) replacement = formatNativePath(item.path);
    else if (item.kind === 'thread' && references.has(item.id)) {
      const title = [...(item.name ?? '')].slice(0, 160).join('').replace(/\\/g, '\\\\').replace(/\]\(/g, ']\\(').replace(/\]/g, '\\]');
      replacement = `[@${title}](thread://${item.id})`;
    }
    const start = new TextEncoder().encode(encoded).length; encoded += replacement;
    elements.push({ byteRange: { start, end: new TextEncoder().encode(encoded).length }, placeholder: item.token });
    const key = `${item.kind}:${item.path ?? item.id}`;
    if (!seen.has(key)) {
      if (item.kind === 'skill') typed.push({ type: 'skill', name: item.name, path: item.path });
      if (['app', 'plugin'].includes(item.kind)) typed.push({ type: 'mention', name: item.name, path: `${item.kind}://${item.id}` });
      seen.add(key);
    }
    offset = item.end;
  }
  encoded += text.slice(offset);
  const input = [...(encoded ? [{ type: 'text', text: encoded, text_elements: elements }] : []), ...typed, ...uploads];
  if (!references.size) return { input };
  const budget = Math.min(8192, Math.floor((32768 - 256) / references.size));
  const additionalContext = Object.fromEntries([...references].map(([id, selection]) => [`web_thread_${id}`, { kind: 'untrusted', value: snapshotValue(selection, budget) }]));
  if (mode === 'queue') return { input: [...input, { type: 'text', text: '<untrusted_text>\n[' + Object.values(additionalContext).map(v => v.value).join(',') + ']\n</untrusted_text>', text_elements: [] }] };
  return { input, additionalContext };
}

export function mountCompletions({ api, viewId, getState, onChange, onCommand }) {
  const draft = document.querySelector('#draft'), menu = document.querySelector('#completion-menu'), abort = new AbortController();
  const groups = { file: '文件和文件夹', directory: '文件和文件夹', thread: '会话', app: '应用', plugin: '插件', skill: '技能', command: '命令' };
  let timer, revision = 0, context, entries = [], active = -1, alive = true, loading = false;
  const close = () => { ++revision; clearTimeout(timer); context = null; entries = []; active = -1; loading = false; menu.hidden = true; draft.setAttribute('aria-expanded', 'false'); draft.setAttribute('aria-busy', 'false'); draft.removeAttribute('aria-activedescendant'); };
  const valid = value => alive && value && getState() === value.state && value.state.ready && value.state.online !== false && !value.state.deleting && !value.state.composing && value.generation === value.state.generation && value.cwd === value.state.settings?.cwd && value.source === draft.value && value.caret === draft.selectionStart && draft.selectionStart === draft.selectionEnd;
  function current() {
    const state = getState(), caret = draft.selectionStart, trigger = findTrigger(draft.value, caret, { composing: state?.composing });
    if (!state?.ready || state.online === false || state.deleting || !trigger || caret !== draft.selectionEnd || state.selections?.some(item => item.start < caret && caret <= item.end && draft.value.slice(item.start, item.end) === item.token)) return null;
    return { ...trigger, state, source: draft.value, caret, generation: state.generation, cwd: state.settings?.cwd };
  }
  function open() {
    menu.hidden = false; draft.setAttribute('aria-expanded', 'true'); draft.setAttribute('aria-busy', String(loading));
    menu.setAttribute('aria-label', context?.sigil === '/' ? '选择命令' : context?.sigil === '$' ? '选择技能' : '选择引用');
    const top = menu.parentNode?.getBoundingClientRect().top ?? draft.getBoundingClientRect().top;
    const heading = document.querySelector('#thread-title')?.parentNode?.getBoundingClientRect().bottom ?? 16;
    menu.style.maxHeight = Math.max(80, Math.min(320, top - heading - 16)) + 'px';
  }
  function status(text) { const line = document.createElement('p'); line.className = 'muted small'; line.setAttribute('role', 'status'); line.textContent = text; menu.replaceChildren(line); open(); }
  function choose(item, selected = context) {
    if (selected !== context || item.disabled) return;
    if (!valid(selected)) { close(); return; }
    const { state, source: original, start, end } = selected, token = item.kind === 'command' ? '/' + item.command : item.label ?? (item.kind === 'skill' ? '$' : '@') + item.name;
    const tail = original.slice(end), space = /^\s/.test(tail) ? '' : ' ', next = original.slice(0, start) + token + space + tail;
    state.selections = updateSelections(original, next, state.selections);
    if (item.kind !== 'command') state.selections.push({ kind: item.kind, ...(item.id ? { id: item.id } : {}), ...(item.path ? { path: item.path } : {}), start, end: start + token.length, token });
    state.draft = next; draft.value = next; draft.focus(); const caret = start + token.length + (space || tail ? 1 : 0); draft.setSelectionRange(caret, caret); close(); onChange(state);
    if (item.kind === 'command' && !tail.trim()) onCommand?.(item.command);
  }
  function highlight() {
    for (let i = 0; i < entries.length; i++) { const node = document.querySelector('#completion-' + i), value = String(i === active); if (node?.getAttribute('aria-selected') !== value) node?.setAttribute('aria-selected', value); }
    if (active >= 0) { draft.setAttribute('aria-activedescendant', 'completion-' + active); document.querySelector('#completion-' + active)?.scrollIntoView({ block: 'nearest' }); }
    else draft.removeAttribute('aria-activedescendant');
  }
  function show(result) {
    entries = result.items; active = entries.findIndex(item => !item.disabled); loading = false; menu.replaceChildren(); let group;
    const selected = context;
    for (let i = 0; i < entries.length; i++) {
      if (groups[entries[i].kind] !== group) { group = groups[entries[i].kind]; const heading = document.createElement('p'); heading.className = 'completion-group'; heading.setAttribute('aria-hidden', 'true'); heading.textContent = group; menu.append(heading); }
      const item = entries[i], button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.id = 'completion-' + i;
      const name = document.createElement('span'), detail = document.createElement('small'); name.className = 'completion-name'; name.textContent = item.kind === 'command' ? item.label : item.name ?? item.label;
      const path = ['file', 'directory'].includes(item.kind) ? item.label.slice(1) : null;
      detail.className = 'completion-detail'; detail.textContent = (item.description ?? (path === item.name ? item.kind === 'directory' ? '文件夹' : '文件' : path ?? groups[item.kind])) + (item.disabled ? ' · 当前不可用' : '');
      button.setAttribute('role', 'option'); button.setAttribute('aria-label', item.label + '，' + detail.textContent); button.setAttribute('aria-disabled', String(Boolean(item.disabled))); button.append(name, detail);
      button.disabled = Boolean(item.disabled); button.onclick = () => choose(item, selected); button.addEventListener('pointerdown', event => event.preventDefault(), { signal: abort.signal });
      button.addEventListener('pointermove', () => { if (!item.disabled && valid(selected) && active !== i) { active = i; highlight(); } }, { signal: abort.signal }); menu.append(button);
    }
    for (const issue of result.unavailable ?? []) { const line = document.createElement('p'); line.className = 'muted small'; line.textContent = `${issue.kind}：${issue.message}`; menu.append(line); }
    if (!entries.length && !result.unavailable?.length) { const line = document.createElement('p'); line.textContent = '没有匹配结果。'; menu.append(line); }
    open(); highlight();
  }
  async function refresh() {
    close(); const selected = context = current(), version = revision; if (!selected) return;
    const { state, sigil, query } = selected;
    if (sigil === '/') { show({ items: COMMANDS.filter(command => command.startsWith(query.toLocaleLowerCase()) || COMMAND_DETAILS[command].includes(query)).map(command => ({ kind: 'command', command, label: '/' + command, description: COMMAND_DETAILS[command], disabled: Boolean(state.pending || state.acceptedTurn || state.commandPending) })) }); return; }
    loading = true; status('搜索中…');
    try {
      const result = await api('/api/completions', { viewId, threadId: state.threadId, sigil, query });
      if (version === revision) { if (valid(selected)) show(result); else close(); }
    } catch (e) { if (version === revision) { if (valid(selected)) show({ items: [], unavailable: [{ kind: '补全', message: e.message }] }); else close(); } }
  }
  function schedule() {
    close(); context = current(); if (!context) return;
    if (context.sigil === '/') { refresh(); return; }
    loading = true; status('搜索中…'); timer = setTimeout(refresh, 150);
  }
  draft.addEventListener('input', schedule, { signal: abort.signal });
  draft.addEventListener('compositionstart', close, { signal: abort.signal });
  draft.addEventListener('compositionend', () => { close(); timer = setTimeout(refresh, 0); }, { signal: abort.signal });
  draft.addEventListener('click', () => { if (!valid(context)) refresh(); }, { signal: abort.signal });
  draft.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !valid(context)) refresh(); }, { signal: abort.signal });
  document.body.addEventListener('pointerdown', event => { if (event.target !== draft && !menu.contains(event.target)) close(); }, { signal: abort.signal });
  draft.addEventListener('keydown', event => {
    if (menu.hidden || event.isComposing || getState()?.composing || event.keyCode === 229) return;
    if (event.key === 'Escape') { close(); event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!valid(context)) { close(); if (['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); } return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Enter' && event.shiftKey) return;
    if (event.key === 'Tab' && event.shiftKey) { close(); return; }
    if (event.shiftKey) return;
    const enabled = entries.flatMap((item, index) => item.disabled ? [] : [index]);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && enabled.length) {
      active = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(enabled.indexOf(active) + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]; highlight(); event.preventDefault();
    }
    if (['Enter', 'Tab'].includes(event.key)) {
      if (!entries.length && !loading && context.sigil === '$' || event.key === 'Tab' && active < 0) { close(); return; }
      event.preventDefault(); event.stopImmediatePropagation(); if (active >= 0) choose(entries[active]);
    }
  }, { signal: abort.signal });
  return { refresh, close, dispose() { alive = false; abort.abort(); close(); } };
}

export function mountImageViewer() {
  const dialog = document.querySelector('#image-viewer'), image = document.querySelector('#image-viewer-image');
  const close = document.querySelector('#close-image-viewer'), abort = new AbortController(), options = { signal: abort.signal };
  let opener;
  function open(target) {
    if (!target?.matches?.('.chat-image')) return false;
    const url = new URL(target.src, location.href);
    if (url.origin !== new URL(location.href).origin || url.protocol !== 'blob:' && !/^\/api\/images\/[A-Za-z0-9_-]+$/.test(url.pathname)) return false;
    opener = target; image.src = url.href; image.alt = target.alt; dialog.showModal(); close.focus(); return true;
  }
  document.body.addEventListener('click', event => { if (open(event.target)) event.preventDefault(); }, options);
  document.body.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && open(event.target)) event.preventDefault(); }, options);
  close.addEventListener('click', () => dialog.close(), options);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }, options);
  dialog.addEventListener('close', () => { image.removeAttribute('src'); if (opener?.isConnected && opener.getClientRects().length) opener.focus(); opener = null; }, options);
  return { dispose() { abort.abort(); dialog.close(); image.removeAttribute('src'); opener = null; } };
}

export function mountAttachments({ api, viewId, getState, getStates, onChange, uploadLimitBytes }) {
  const fileInput = document.querySelector('#file-input'), photoInput = document.querySelector('#photo-input');
  const container = document.querySelector('#attachments'), abort = new AbortController(), records = new Set();
  let queue = Promise.resolve(), alive = true, renderedState, renderedKey, renderedRecords = [];
  const raster = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  function notify(state) { if (alive) onChange(state); }
  function sendBytes(record) {
    return new Promise((resolve, reject) => {
      const xhr = record.xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads/${encodeURIComponent(record.id)}?viewId=${encodeURIComponent(viewId)}`);
      xhr.withCredentials = true; xhr.responseType = 'json'; xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      let updated = 0;
      xhr.upload.onprogress = event => { if (performance.now() - updated < 100) return; updated = performance.now();
        record.progress = event.total ? Math.round(100 * event.loaded / event.total) : 0; notify(record.state); };
      xhr.onload = () => xhr.status === 201 ? resolve(xhr.response) : reject(Object.assign(new Error(xhr.response?.error?.message ?? '上传失败。'), { status: xhr.status }));
      xhr.onerror = () => reject(new Error('上传连接中断，草稿已保留。'));
      xhr.onabort = () => reject(new Error('上传已取消。'));
      xhr.send(record.file);
    });
  }
  function enqueue(record) {
    queue = queue.then(async () => {
      if (!alive || record.removed) return;
      record.status = 'uploading'; record.error = ''; notify(record.state);
      try {
        if (record.file.size > uploadLimitBytes) throw new Error(`单文件不能超过 ${uploadLimitBytes.toLocaleString()} 字节。`);
        if (raster.has(record.file.type) && !record.previewUrl) {
          record.previewUrl = URL.createObjectURL(record.file);
          try {
            if (typeof createImageBitmap === 'function') { const bitmap = await createImageBitmap(record.file); bitmap.close(); }
            else { const image = new Image(); image.src = record.previewUrl; await image.decode(); }
          } catch { URL.revokeObjectURL(record.previewUrl); record.previewUrl = null; throw new Error('无法读取这张照片，请选择 PNG、JPEG、WebP 或 GIF。'); }
        }
        if (record.id) {
          try { Object.assign(record, await api(`/api/uploads/${encodeURIComponent(record.id)}?threadId=${encodeURIComponent(record.state.threadId)}`)); record.status = 'complete'; notify(record.state); return; } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }
        }
        const meta = await api('/api/uploads', { viewId, threadId: record.state.threadId, name: record.name, size: record.file.size, mime: record.file.type || '' });
        record.id = meta.id;
        const complete = await sendBytes(record); Object.assign(record, complete); record.status = 'complete'; record.progress = 100;
      } catch (e) { if (!record.removed) { record.status = 'error'; record.error = e.message; } }
      finally { delete record.xhr; notify(record.state); }
    }).catch(() => {});
  }
  function add(files) {
    const state = getState(); if (!state?.ready) return;
    for (const file of files) {
      const record = { clientId: crypto.randomUUID(), state, file, name: file.name, size: file.size, status: 'pending', progress: 0 };
      records.add(record); state.attachments.push(record); enqueue(record);
    }
    notify(state);
  }
  for (const input of [fileInput, photoInput]) input.addEventListener('change', () => { add([...input.files]); input.value = ''; }, { signal: abort.signal });
  document.querySelector('#draft').addEventListener('paste', event => {
    if (event.currentTarget.disabled || !getState()?.ready) return;
    const clipboard = event.clipboardData, files = [...(clipboard?.files ?? [])];
    if (!files.length) for (const item of clipboard?.items ?? []) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile(); if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault(); add(files);
  }, { signal: abort.signal });
  document.querySelector('#choose-files').addEventListener('click', () => { document.querySelector('#attachment-actions').open = false; fileInput.click(); }, { signal: abort.signal });
  document.querySelector('#choose-photos').addEventListener('click', () => { document.querySelector('#attachment-actions').open = false; photoInput.click(); }, { signal: abort.signal });
  function render(state) {
    const retained = new Set(getStates().flatMap(state => state.attachments));
    for (const record of records) if (!retained.has(record)) { if (record.previewUrl) URL.revokeObjectURL(record.previewUrl); records.delete(record); }
    const attachments = state?.attachments ?? [];
    const key = JSON.stringify(attachments.map(record => [record.id, record.name, record.status, record.error, record.progress, record.previewUrl, record.imageHref, Boolean(record.file)]));
    if (renderedState === state && renderedKey === key && attachments.every((record, index) => renderedRecords[index] === record)) return;
    container.replaceChildren();
    for (const record of attachments) {
      const src = record.previewUrl || (/^\/api\/images\/[A-Za-z0-9_-]+$/.test(record.imageHref) ? record.imageHref : null);
      const node = document.createElement('div'); node.className = 'attachment' + (src ? ' attachment-image' : '');
      if (src) { const image = document.createElement('img'); image.src = src; image.alt = record.name; image.width = image.height = 80; image.className = 'chat-image'; image.setAttribute('role', 'button'); image.setAttribute('tabindex', '0'); image.setAttribute('aria-haspopup', 'dialog'); image.setAttribute('aria-label', '查看大图 ' + record.name); node.append(image); }
      if (!src) {
        const label = document.createElement('span'); label.textContent = record.name;
        const status = document.createElement('small'); status.textContent = record.status === 'complete' ? '已上传' : record.status === 'error' ? record.error : record.status === 'uploading' ? `上传中 ${record.progress}%` : '等待上传';
        label.append(document.createElement('br'), status); node.append(label);
      } else if (record.status === 'error') { const status = document.createElement('small'); status.textContent = record.error; node.append(status); }
      if (record.status === 'uploading') { const progress = document.createElement('progress'); progress.max = 100; progress.value = record.progress; progress.setAttribute('aria-label', record.name + ' 上传进度'); node.append(progress); }
      if (record.status === 'error' && record.file) { const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => { record.status = 'pending'; enqueue(record); notify(state); }; node.append(retry); }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = src ? '×' : '移除'; if (src) remove.className = 'attachment-remove'; remove.setAttribute('aria-label', '移除附件 ' + record.name);
      remove.onclick = () => { record.removed = true; record.xhr?.abort(); state.attachments = state.attachments.filter(item => item !== record); notify(state); };
      node.append(remove); container.append(node);
    }
    renderedState = state; renderedKey = key; renderedRecords = [...attachments];
  }
  return {
    render,
    async hydrate(state) {
      for (const record of state.attachments) {
        if (record.file || !record.id) continue;
        try { Object.assign(record, await api(`/api/uploads/${encodeURIComponent(record.id)}?threadId=${encodeURIComponent(state.threadId)}`)); }
        catch (e) { record.status = 'error'; record.error = e.message; }
      }
      notify(state);
    },
    dispose() { alive = false; abort.abort(); for (const record of records) { record.xhr?.abort(); if (record.previewUrl) URL.revokeObjectURL(record.previewUrl); } },
  };
}
