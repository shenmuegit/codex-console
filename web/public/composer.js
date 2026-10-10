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
  const slash = prefix.match(/^\/([a-z]*)$/);
  if (slash) return { sigil: '/', query: slash[1], start: 0, end: caret };
  const match = prefix.match(/(?:^|\s)([@$])([^\s@$]*)$/);
  return match ? { sigil: match[1], query: match[2], start: caret - match[2].length - 1, end: caret } : null;
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

export function mountCompletions({ api, viewId, getState, onChange }) {
  const draft = document.querySelector('#draft'), menu = document.querySelector('#completion-menu'), abort = new AbortController();
  let timer, revision = 0, trigger, entries = [], active = 0, alive = true;
  const close = () => { menu.hidden = true; draft.setAttribute('aria-expanded', 'false'); draft.removeAttribute('aria-activedescendant'); };
  function choose(item) {
    if (!trigger || item.disabled) return;
    const state = getState(), original = draft.value, token = item.kind === 'command' ? '/' + item.command : (item.kind === 'skill' ? '$' : '@') + item.name;
    const next = original.slice(0, trigger.start) + token + ' ' + original.slice(trigger.end);
    state.selections = updateSelections(original, next, state.selections);
    if (item.kind !== 'command') state.selections.push({ kind: item.kind, ...(item.id ? { id: item.id } : {}), ...(item.path ? { path: item.path } : {}), start: trigger.start, end: trigger.start + token.length, token });
    state.draft = next; draft.value = next; draft.focus(); draft.setSelectionRange(trigger.start + token.length + 1, trigger.start + token.length + 1); close(); onChange(state);
  }
  function highlight() {
    for (let i = 0; i < entries.length; i++) document.querySelector('#completion-' + i)?.setAttribute('aria-selected', String(i === active));
    if (entries[active]) draft.setAttribute('aria-activedescendant', 'completion-' + active);
  }
  function show(result) {
    entries = result.items; active = 0; menu.replaceChildren();
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i], button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.id = 'completion-' + i;
      button.textContent = `${item.label} · ${item.kind}${item.disabled ? '（原生不可用）' : item.kind === 'thread' ? '（发送时快照）' : ''}`;
      button.disabled = Boolean(item.disabled); button.onclick = () => choose(item); menu.append(button);
    }
    for (const issue of result.unavailable ?? []) { const line = document.createElement('p'); line.className = 'muted small'; line.textContent = `${issue.kind}：${issue.message}`; menu.append(line); }
    if (!entries.length && !result.unavailable?.length) { const line = document.createElement('p'); line.textContent = '没有匹配的原生条目。'; menu.append(line); }
    menu.hidden = false; draft.setAttribute('aria-expanded', 'true'); highlight();
  }
  async function refresh() {
    const state = getState(); trigger = findTrigger(draft.value, draft.selectionStart, { composing: state?.composing });
    const version = ++revision;
    if (!state?.ready || !trigger) { close(); return; }
    if (trigger.sigil === '/') { show({ items: COMMANDS.filter(command => command.startsWith(trigger.query)).map(command => ({ kind: 'command', command, label: '/' + command })) }); return; }
    try {
      const result = await api('/api/completions', { viewId, threadId: state.threadId, sigil: trigger.sigil, query: trigger.query });
      if (alive && version === revision && getState() === state) show(result);
    } catch (e) { if (alive && version === revision) show({ items: [], unavailable: [{ kind: '补全', message: e.message }] }); }
  }
  draft.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 150); }, { signal: abort.signal });
  draft.addEventListener('compositionstart', close, { signal: abort.signal });
  draft.addEventListener('compositionend', () => { clearTimeout(timer); timer = setTimeout(refresh, 0); }, { signal: abort.signal });
  draft.addEventListener('keydown', event => {
    if (menu.hidden || event.isComposing || getState()?.composing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) return;
    if (event.key === 'Escape') { close(); event.preventDefault(); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && entries.length) { active = (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; highlight(); event.preventDefault(); }
    if (['Enter', 'Tab'].includes(event.key) && entries[active] && !entries[active].disabled) { event.preventDefault(); event.stopImmediatePropagation(); choose(entries[active]); }
  }, { signal: abort.signal });
  return { refresh, close, dispose() { alive = false; ++revision; abort.abort(); clearTimeout(timer); close(); } };
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
  let queue = Promise.resolve(), alive = true;
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
    container.replaceChildren();
    for (const record of state?.attachments ?? []) {
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
    const retained = new Set(getStates().flatMap(state => state.attachments));
    for (const record of records) if (!retained.has(record)) { if (record.previewUrl) URL.revokeObjectURL(record.previewUrl); records.delete(record); }
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
