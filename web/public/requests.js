const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node;
};
const formModes = ['form', 'openai/form', 'openaiForm'];
export const asyncQuestionId = (itemId, index) => JSON.stringify(['request_user_input_async', itemId, index]);
export const isAsyncQuestion = item => item.type === 'agentMessage' && Array.isArray(item.questions) && item.questions.length > 0;
export function questionReplies(text) {
  const value = text.trim(), start = '<send_user_message_question_reply>', end = '</send_user_message_question_reply>';
  if (!value.startsWith(start) || !value.endsWith(end)) return [];
  try {
    const parsed = JSON.parse(value.slice(start.length, -end.length)), entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter(entry => {
      if (typeof entry?.questionItemId !== 'string' || typeof entry.question !== 'string' || typeof entry.answer !== 'string') return false;
      const id = JSON.parse(entry.questionItemId); return Array.isArray(id) && id.length === 3 && id[0] === 'request_user_input_async' && typeof id[1] === 'string' && Number.isInteger(id[2]) && id[2] >= 0;
    });
  } catch { return []; }
}
function decisionLabel(decision) {
  const labels = { accept: '允许一次', acceptForSession: '允许此会话', decline: '拒绝', cancel: '取消并停止' };
  if (typeof decision === 'string') return Object.hasOwn(labels, decision) ? labels[decision] : undefined;
  if (Array.isArray(decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment)) return '允许并记住命令规则';
  const rule = decision?.applyNetworkPolicyAmendment?.network_policy_amendment;
  if (rule && ['allow', 'deny'].includes(rule.action) && typeof rule.host === 'string') return (rule.action === 'allow' ? '始终允许访问 ' : '始终拒绝访问 ') + rule.host;
}
export function approvalDecisions({ params }) {
  if (Array.isArray(params.availableDecisions)) return params.availableDecisions.filter(decisionLabel);
  const decisions = ['accept', 'acceptForSession'];
  if (params.proposedExecpolicyAmendment) decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
  for (const rule of params.proposedNetworkPolicyAmendments ?? []) decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: rule } });
  return [...decisions, 'decline', 'cancel'].filter(decisionLabel);
}
function choices(schema) {
  return schema.enum?.map((value, index) => ({ value, title: schema.enumNames?.[index] ?? String(value) })) ??
    (schema.oneOf ?? schema.anyOf)?.map(option => ({ value: option.const, title: option.title ?? String(option.const), description: option.description }));
}
function option(parent, name, value, title, description, multiple = false) {
  const label = element('label', null, 'request-option'), input = element('input'), content = element('span');
  input.type = multiple ? 'checkbox' : 'radio'; input.name = name; input.value = String(value); input.checked = false;
  content.append(element('strong', title)); if (description) content.append(element('small', description));
  label.append(input, content); parent.append(label); return input;
}
function field(parent, title, schema, required = false) {
  const group = element('fieldset'), name = crypto.randomUUID(); group.append(element('legend', title));
  if (schema.description) group.append(element('p', schema.description, 'muted')); parent.append(group);
  const multiple = schema.type === 'array', values = choices(multiple ? schema.items ?? {} : schema);
  if (values && (!values.length || values.some(option => option.value === undefined))) throw new Error('此表单选项暂不支持，请在 Codex 桌面完成。');
  let read;
  if (values?.length) {
    const inputs = values.map(value => { const input = option(group, name, value.value, value.title, value.description, multiple);
      input.checked = multiple ? schema.default?.includes(value.value) ?? false : schema.default === value.value; return input; });
    read = () => {
      const selected = values.filter((_value, index) => inputs[index].checked).map(value => value.value);
      if (multiple) {
        if (!selected.length && !required && schema.default == null) return undefined;
        if (selected.length < (schema.minItems ?? 0) || selected.length > (schema.maxItems ?? Infinity)) throw new Error('请检查“' + title + '”的选择数量。');
        return selected;
      }
      return selected[0];
    };
  } else if (['string', 'number', 'integer', 'boolean'].includes(schema.type)) {
    const label = element('label', title), input = element('input'); input.name = name;
    input.type = schema.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(schema.type) ? 'number' : schema.isSecret || schema.format === 'password' ? 'password' : { email: 'email', uri: 'url', date: 'date' }[schema.format] ?? 'text';
    input.checked = Boolean(schema.default); if (schema.default != null && input.type !== 'checkbox') input.value = String(schema.default);
    if (input.type === 'number') { input.step = schema.type === 'integer' ? '1' : 'any'; if (schema.minimum != null) input.min = schema.minimum; if (schema.maximum != null) input.max = schema.maximum; }
    if (schema.minLength != null) input.minLength = schema.minLength; if (schema.maxLength != null) input.maxLength = schema.maxLength;
    input.required = required && input.type !== 'checkbox'; label.append(input); group.append(label);
    read = () => {
      if (input.type === 'checkbox') return input.checked;
      if (!input.value) return undefined;
      if (input.type === 'number') {
        const value = Number(input.value);
        if (!Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error('请检查“' + title + '”的数值范围。');
        return value;
      }
      if (input.value.length < (schema.minLength ?? 0) || input.value.length > (schema.maxLength ?? Infinity)) throw new Error('请检查“' + title + '”的文字长度。');
      return input.value;
    };
  } else throw new Error('此表单字段暂不支持，请在 Codex 桌面完成。');
  return () => { const value = read(); if (required && value === undefined) throw new Error('请选择或填写“' + title + '”。'); return value; };
}
function questionField(parent, question, saved = '') {
  const group = element('fieldset'), name = crypto.randomUUID(); group.append(element('legend', question.question)); parent.append(group);
  const options = question.options ?? [], inputs = options.map(value => option(group, name, value.label, value.label, value.description));
  for (let index = 0; index < inputs.length; index++) {
    const label = inputs[index].parentNode; label.className += ' question-option'; inputs[index].className = 'sr-only';
    const number = element('span', String(index + 1), 'question-number'); number.setAttribute('aria-hidden', 'true'); label.insertBefore(number, inputs[index]);
    const arrow = element('span', '→', 'question-arrow'); arrow.setAttribute('aria-hidden', 'true'); label.append(arrow);
  }
  let other, input;
  if (question.isOther || !options.length) {
    if (options.length) { other = option(group, name, '__other', '其他'); other.parentNode.className = 'sr-only'; }
    const label = element('label', null, 'question-custom'); input = element('input'); input.type = question.isSecret ? 'password' : 'text'; input.maxLength = 8192; input.placeholder = options.length ? '或自行撰写回复' : '填写回复'; input.setAttribute('aria-label', question.isSecret ? question.question : '自行撰写回复'); label.append(input); group.append(label);
    if (other) input.addEventListener('input', () => { other.checked = true; });
  }
  const raw = () => !options.length || other?.checked ? input?.value ?? '' : options.find((_option, index) => inputs[index].checked)?.label ?? '';
  const read = () => {
    const value = raw();
    if (!value?.trim()) throw new Error('请选择或填写“' + (question.header || question.question) + '”。');
    return { answers: [value] };
  };
  function fill(value) { for (let index = 0; index < inputs.length; index++) inputs[index].checked = options[index].label === value; if (input) { input.value = options.some(option => option.label === value) ? '' : value; if (other) other.checked = Boolean(input.value); } }
  fill(saved);
  read.raw = raw; read.custom = input?.parentNode; read.setAnswer = value => { fill(value); group.disabled = true; if (input) input.disabled = true; };
  group.addEventListener('keydown', event => {
    if (!/^[1-9]$/.test(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || ['text', 'password'].includes(event.target?.type)) return;
    const chosen = inputs[Number(event.key) - 1]; if (!chosen || group.disabled) return;
    event.preventDefault(); fill(chosen.value); chosen.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return read;
}

export function createRequestCard({ api, viewId, state, key, native, onResolved, onChange = () => {}, signal }) {
  const asyncItem = isAsyncQuestion(native) ? native : null, generation = state.generation;
  const p = asyncItem ? { questions: native.questions.map((q, index) => ({ id: asyncQuestionId(native.id, index), question: q.title, isOther: true, options: q.options?.map(label => ({ label })) })) } : native.params;
  const method = native.method, question = Boolean(asyncItem) || method === 'item/tool/requestUserInput', permission = method === 'item/permissions/requestApproval', mcp = method === 'mcpServer/elicitation/request';
  const form = element('form', null, 'native-form'), status = element('p', '', 'error'), actions = element('div', null, 'toolbar request-actions'), values = new Map();
  const title = question ? '问题' : permission ? '请求访问权限' : mcp ? '应用请求 · ' + p.serverName : method === 'item/fileChange/requestApproval' ? '允许修改文件？' : p.kind === 'writeStdin' ? '允许向终端发送输入？' : '允许运行此命令？';
  const heading = element('div', null, question ? 'question-heading' : ''), close = element('button', '×', 'icon-button question-close'); close.type = 'button'; close.setAttribute('aria-label', '跳过问题');
  if (question) { form.className += ' question-card'; const label = element('span', '问题', 'question-heading-label'), icon = element('span', '?', 'question-icon'); icon.setAttribute('aria-hidden', 'true'); label.insertBefore(icon, label.firstChild); heading.append(label, close); } else heading.append(element('strong', title));
  form.setAttribute('aria-label', title); form.append(heading); status.setAttribute('role', 'alert');
  if (p.reason || p.message) form.append(element('p', p.reason ?? p.message));
  if (p.cwd) form.append(element('small', p.cwd, 'muted'));
  if (p.command) form.append(element('pre', p.command));
  if (p.grantRoot) form.append(element('pre', p.grantRoot));
  if (p.permissions || p.additionalPermissions) form.append(element('pre', JSON.stringify(p.permissions ?? p.additionalPermissions, null, 2)));
  if (p.networkApprovalContext) form.append(element('pre', JSON.stringify(p.networkApprovalContext, null, 2)));
  let supported = true, primary, primaryButton, composing = false;
  form.addEventListener('compositionstart', () => { composing = true; }, { signal });
  form.addEventListener('compositionend', () => { composing = false; }, { signal });
  form.addEventListener('keydown', event => { if (event.key === 'Enter' && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault(); }, { signal });
  try {
    if (question) for (const entry of p.questions ?? []) values.set(entry.id, questionField(form, entry, state.questionDrafts?.[entry.id] ?? ''));
    else if (mcp && formModes.includes(p.mode)) {
      if (p.requestedSchema?.type !== 'object' || !p.requestedSchema.properties) throw new Error('此表单暂不支持，请在 Codex 桌面完成。');
      for (const [name, schema] of Object.entries(p.requestedSchema.properties)) values.set(name, field(form, schema.title ?? name, schema, p.requestedSchema.required?.includes(name)));
    } else if (mcp && p.mode === 'url') {
      const url = new URL(p.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('授权地址不受支持。');
      const link = element('a', '打开授权页面', 'request-link'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; form.append(link, element('p', '在授权页面完成后，点击“已完成授权”继续。', 'muted'));
    } else if (mcp) throw new Error('此授权方式暂不支持，请在 Codex 桌面完成。');
  } catch (e) { supported = false; status.textContent = e.message; }
  function button(label, decision) {
    const node = element('button', label); node.type = decision === 'accept' ? 'submit' : 'button'; if (decision === 'accept') node.className = 'primary';
    node.addEventListener('click', event => { event.preventDefault(); respond(decision); }, { signal }); actions.append(node); return node;
  }
  if (question || mcp) {
    if (question) button('跳过', 'decline');
    if (supported) { primary = 'accept'; primaryButton = button(question ? '发送' : p.mode === 'url' ? '已完成授权' : '确认', primary); }
    if (mcp) { button('拒绝', 'decline'); button('取消', 'cancel'); }
  } else if (permission) {
    primary = 'accept'; button('允许本轮', 'accept'); button('允许此会话', 'acceptForSession'); button('拒绝', 'decline');
  } else {
    for (const decision of approvalDecisions(native)) { button(decisionLabel(decision), decision); if (decision === 'accept') primary = decision; }
  }
  form.append(status, actions);
  if (question && values.size === 1) { const custom = [...values.values()][0].custom; if (custom) actions.insertBefore(custom, actions.firstChild); }
  function validity() {
    if (!question || !primaryButton || form.dataset.resolved) return;
    try { for (const read of values.values()) read(); primaryButton.disabled = Boolean(form.dataset.sending); }
    catch { primaryButton.disabled = true; }
  }
  let resolvedSignature;
  function syncQuestions() {
    if (!asyncItem) return;
    const skipped = state.dismissedQuestions?.has(asyncItem.id), answered = [...values.keys()].every(id => state.questionAnswers?.has(id));
    if (skipped || answered) {
      const signature = JSON.stringify([answered, ...[...values.keys()].map(id => state.questionAnswers?.get(id))]);
      if (signature === resolvedSignature) return; resolvedSignature = signature;
      form.dataset.resolved = 'true'; close.hidden = true;
      const summary = element('p', p.questions.map(q => q.question).join('\n')), answer = element('p', answered ? [...values.keys()].map(id => state.questionAnswers.get(id)).join('\n') : '已跳过', 'question-answer');
      heading.children[0].textContent = answered ? '问题 · 已回答' : '问题 · 已跳过'; form.replaceChildren(heading, summary, answer);
    } else {
      for (const [id, read] of values) if (state.questionAnswers?.has(id)) read.setAnswer(state.questionAnswers.get(id));
      validity();
    }
  }
  if (question) {
    close.addEventListener('click', () => respond('decline'), { signal });
    for (const type of ['input', 'change']) form.addEventListener(type, () => {
      if (asyncItem) { state.questionDrafts ??= {}; for (const [id, read] of values) state.questionDrafts[id] = read.raw(); onChange(state); }
      validity();
    }, { signal });
    form.syncQuestions = syncQuestions; syncQuestions(); validity();
  }
  async function respond(decision) {
    if (composing || form.dataset.sending || form.dataset.resolved) return;
    if (asyncItem) {
      const current = state.turns.flatMap(turn => turn.items ?? []).find(item => item.id === asyncItem.id);
      if (!form.isConnected || state.generation !== generation || !current || JSON.stringify(current.questions) !== JSON.stringify(asyncItem.questions)) { status.textContent = '问题已变化，请重新打开会话。'; return; }
      if (decision !== 'accept') { (state.dismissedQuestions ??= new Set()).add(asyncItem.id); syncQuestions(); onChange(state); onResolved(form); return; }
    } else if (!state.requests.has(key)) return;
    if (!state.ready || !state.online || state.deleting) { status.textContent = '请等待会话重新连接后再回答。'; return; }
    if (decision === 'accept' && form.checkValidity && !form.checkValidity()) { form.reportValidity(); return; }
    let result;
    try {
      const content = decision === 'accept' ? Object.fromEntries([...values].map(([name, read]) => [name, read()]).filter(([, value]) => value !== undefined)) : null;
      if (question) result = { answers: content ?? {} };
      else if (permission) result = { permissions: ['accept', 'acceptForSession'].includes(decision) ? p.permissions : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
      else if (mcp) result = { action: decision, content: formModes.includes(p.mode) ? content : null, _meta: null };
      else result = { decision };
    } catch (e) { status.textContent = e.message; return; }
    form.dataset.sending = 'true'; for (const node of actions.children) node.disabled = true; close.disabled = true; status.className = 'muted'; status.textContent = '正在提交…';
    try {
      if (asyncItem) {
        const answers = p.questions.map(q => result.answers[q.id].answers[0]);
        await api('/api/thread/question', { viewId, threadId: state.threadId, itemId: asyncItem.id, answers });
        state.questionAnswers ??= new Map(); for (const [index, q] of p.questions.entries()) { state.questionAnswers.set(q.id, answers[index]); if (state.questionDrafts) delete state.questionDrafts[q.id]; }
        syncQuestions(); onChange(state);
      } else { await api('/api/request/respond', { viewId, requestKey: key, answer: { result } }); state.requests.delete(key); form.remove(); }
      onResolved(form);
    } catch (e) {
      const stale = e.status === 409 && (!asyncItem || ['STALE_QUESTION', 'QUESTION_ANSWERED', 'MESSAGE_ID_REUSED', 'OUTCOME_UNKNOWN'].includes(e.code));
      status.className = 'error'; status.textContent = stale ? '请求已被回答或已失效，请核对会话。' : e.message;
      if (!stale) { delete form.dataset.sending; close.disabled = false; for (const node of actions.children) node.disabled = false; validity(); }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (primary !== undefined) respond(primary); }, { signal });
  return form;
}
