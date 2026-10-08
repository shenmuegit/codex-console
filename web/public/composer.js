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
  document.querySelector('#choose-files').addEventListener('click', () => fileInput.click(), { signal: abort.signal });
  document.querySelector('#choose-photos').addEventListener('click', () => photoInput.click(), { signal: abort.signal });
  function render(state) {
    container.replaceChildren();
    for (const record of state?.attachments ?? []) {
      const node = document.createElement('div'); node.className = 'attachment';
      const src = record.previewUrl || (/^\/api\/images\/[A-Za-z0-9_-]+$/.test(record.imageHref) ? record.imageHref : null);
      if (src) { const image = document.createElement('img'); image.src = src; image.alt = record.name; image.width = 64; image.height = 64; node.append(image); }
      const label = document.createElement('span'); label.textContent = record.name;
      const status = document.createElement('small'); status.textContent = record.status === 'complete' ? '已上传' : record.status === 'error' ? record.error : record.status === 'uploading' ? `上传中 ${record.progress}%` : '等待上传';
      label.append(document.createElement('br'), status); node.append(label);
      if (record.status === 'uploading') { const progress = document.createElement('progress'); progress.max = 100; progress.value = record.progress; progress.setAttribute('aria-label', record.name + ' 上传进度'); node.append(progress); }
      if (record.status === 'error' && record.file) { const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => { record.status = 'pending'; enqueue(record); notify(state); }; node.append(retry); }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.setAttribute('aria-label', '移除附件 ' + record.name);
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
