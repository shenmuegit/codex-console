const number = value => typeof value === 'number' && Number.isFinite(value);
export function contextUsage(usage) {
  const tokens = number(usage?.last?.totalTokens) ? Math.max(0, usage.last.totalTokens) : null;
  const window = number(usage?.modelContextWindow) ? Math.max(0, usage.modelContextWindow) : null;
  const remainingPercent = tokens == null || window == null ? null : window <= 12000 ? 0 :
    Math.round(Math.min(100, Math.max(0, 100 * Math.max(0, (window - 12000) - Math.max(0, tokens - 12000)) / (window - 12000))));
  return { tokens, window, remainingPercent, usedPercent: remainingPercent == null ? null : 100 - remainingPercent };
}
export function weeklyUsage(response) {
  const buckets = response?.rateLimitsByLimitId != null ? Object.entries(response.rateLimitsByLimitId) : response?.rateLimits ? [['codex', response.rateLimits]] : [];
  return buckets.flatMap(([key, bucket]) => {
    const window = [bucket?.primary, bucket?.secondary].find(window => window?.windowDurationMins === 10080);
    if (!window) return [];
    const usedPercent = number(window.usedPercent) ? Math.max(0, window.usedPercent) : null;
    return [{ limitId: bucket.limitId ?? key, usedPercent, remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
      resetsAt: number(window.resetsAt) ? window.resetsAt * 1000 : null }];
  });
}
export function createUsageTracker() {
  let generation = 0, serial = 0, value = null;
  return {
    get value() { return value; },
    invalidate() { ++generation; ++serial; value = null; },
    async read(load) {
      const epoch = generation, request = ++serial;
      let response;
      try { response = await load(); }
      catch (e) { if (epoch !== generation || request !== serial) return null; throw e; }
      if (epoch !== generation || request !== serial) return null;
      value = weeklyUsage(response); return value;
    },
  };
}
export function modelChoice(models, model, effort) {
  const choice = models.find(item => item.model === model);
  if (!choice) throw Object.assign(new Error('模型不在原生目录中。'), { status: 422, code: 'UNKNOWN_MODEL' });
  if (effort != null && !choice.supportedReasoningEfforts?.some(option => option.reasoningEffort === effort)) {
    throw Object.assign(new Error('此模型不支持所选思考强度。'), { status: 422, code: 'UNSUPPORTED_EFFORT' });
  }
  return choice;
}

export function mountUsage({ api, viewId, getState, onChange, onError }) {
  const $ = selector => document.querySelector(selector), abort = new AbortController(), tracker = createUsageTracker();
  let models = [], modelVersion = 0, modelsRevision = 0, optionsKey, setting = false, alive = true, quotaTimer;
  const labels = { none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: 'Ultra' };
  const read = async (method, params = {}) => (await api('/api/rpc', { method, params })).result;
  async function loadModels() {
    const version = ++modelVersion, result = []; let cursor;
    do { const page = await read('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }); result.push(...page.data); cursor = page.nextCursor; } while (cursor);
    if (alive && version === modelVersion) { models = result; ++modelsRevision; render(); }
  }
  function renderQuota() {
    const parent = $('#weekly-usage'); parent.replaceChildren();
    if (tracker.value == null) { parent.textContent = '七天额度暂不可用。'; return; }
    if (!tracker.value.length) { parent.textContent = '原生后端未提供七天窗口。'; return; }
    for (const value of tracker.value) {
      const row = document.createElement('section'), title = document.createElement('h3'), line = document.createElement('p'), reset = document.createElement('p');
      title.textContent = value.limitId; line.textContent = value.usedPercent == null ? '用量未知' : `已用 ${value.usedPercent}% · 剩余 ${value.remainingPercent}%`;
      reset.textContent = value.resetsAt == null ? '重置时间未知' : '重置：' + new Date(value.resetsAt).toLocaleString(); reset.className = 'muted';
      row.append(title, line, reset); parent.append(row);
    }
  }
  async function refreshQuota() {
    try { await tracker.read(() => read('account/rateLimits/read')); if (alive) { $('#usage-error').textContent = ''; renderQuota(); } }
    catch (e) { if (!alive) return; $('#usage-error').textContent = e.message; renderQuota(); if (e.status === 409) scheduleQuota(); }
  }
  function scheduleQuota() { clearTimeout(quotaTimer); quotaTimer = setTimeout(() => refreshQuota(), 250); }
  function effortOptions(model, preferred) {
    const select = $('#effort'); select.replaceChildren();
    for (const option of model?.supportedReasoningEfforts ?? []) { const node = document.createElement('option'); node.value = option.reasoningEffort; node.textContent = labels[option.reasoningEffort] ?? option.reasoningEffort; node.title = option.description ?? ''; select.append(node); }
    select.value = model?.supportedReasoningEfforts?.some(option => option.reasoningEffort === preferred) ? preferred : model?.defaultReasoningEffort ?? '';
  }
  function render() {
    const state = getState(), model = $('#model'), value = state?.settings.model;
    const key = `${modelsRevision}:${state?.threadId}:${value}:${state?.settings.effort}`;
    if (!setting && optionsKey !== key) {
      optionsKey = key;
      model.replaceChildren();
      for (const item of models) { const option = document.createElement('option'); option.value = item.model; option.textContent = item.displayName || item.model; model.append(option); }
      if (value && !models.some(item => item.model === value)) { const option = document.createElement('option'); option.value = value; option.textContent = value + '（当前设置）'; option.disabled = true; model.append(option); }
      if (value) model.value = value;
      effortOptions(models.find(item => item.model === model.value), state?.settings.effort);
    }
    model.disabled = $('#effort').disabled = setting || !state?.ready || !models.length;
    const usage = contextUsage(state?.tokenUsage);
    $('#context-usage').textContent = usage.tokens == null ? '上下文未知' : `最近上下文 ${usage.tokens.toLocaleString()}${usage.window == null ? ' · 窗口未知' : ' / ' + usage.window.toLocaleString() + ` · 剩余 ${usage.remainingPercent}%`}`;
    $('#context-meter').hidden = usage.usedPercent == null;
    if (usage.usedPercent != null) $('#context-meter').value = usage.usedPercent;
  }
  async function apply() {
    const state = getState(); if (!state?.ready || setting) return; setting = true; $('#model').disabled = $('#effort').disabled = true;
    try { const result = await api('/api/thread/settings', { viewId, threadId: state.threadId, model: $('#model').value, effort: $('#effort').value });
      state.settings = result.settings; if (getState() === state) onChange(); return true;
    } catch (e) { onError(e); return false; }
    finally { setting = false; render(); }
  }
  $('#model').addEventListener('change', () => { const chosen = models.find(item => item.model === $('#model').value); effortOptions(chosen, $('#effort').value); apply(); }, { signal: abort.signal });
  $('#effort').addEventListener('change', apply, { signal: abort.signal });
  $('#show-usage').addEventListener('click', () => { $('#usage-dialog').showModal(); refreshQuota(); }, { signal: abort.signal });
  $('#close-usage').addEventListener('click', () => $('#usage-dialog').close(), { signal: abort.signal });
  $('#refresh-usage').addEventListener('click', refreshQuota, { signal: abort.signal });
  return {
    render, loadModels, refreshQuota,
    async choose(model, effort) { const choice = modelChoice(models, model, effort); $('#model').value = model; effortOptions(choice, effort ?? choice.defaultReasoningEffort); return apply(); },
    onEvent(event) {
      const method = event.native?.method;
      if (method === 'account/updated' || (event.kind === 'status' && event.native.online)) {
        tracker.invalidate(); renderQuota(); loadModels().catch(onError); scheduleQuota();
      } else if (method === 'account/rateLimits/updated' || method === 'thread/settings/updated') { tracker.invalidate(); renderQuota(); scheduleQuota(); }
    },
    dispose() { alive = false; abort.abort(); tracker.invalidate(); ++modelVersion; clearTimeout(quotaTimer); $('#usage-dialog').close(); },
  };
}
