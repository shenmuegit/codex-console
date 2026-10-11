const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node;
};
const formModes = ['form', 'openai/form', 'openaiForm'];
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
function questionField(parent, question) {
  const group = element('fieldset'), name = crypto.randomUUID(); group.append(element('legend', question.header || '回答'), element('p', question.question)); parent.append(group);
  const options = question.options ?? [], inputs = options.map(value => option(group, name, value.label, value.label, value.description));
  let other, input;
  if (question.isOther || !options.length) {
    if (options.length) other = option(group, name, '__other', '其他');
    const label = element('label', options.length ? '填写其他回答' : '你的回答'); input = element('input'); input.type = question.isSecret ? 'password' : 'text'; input.maxLength = 8192; label.append(input); group.append(label);
    if (other) input.addEventListener('input', () => { other.checked = true; });
  }
  return () => {
    const value = !options.length || other?.checked ? input?.value : options.find((_option, index) => inputs[index].checked)?.label;
    if (!value?.trim()) throw new Error('请选择或填写“' + (question.header || question.question) + '”。');
    return { answers: [value] };
  };
}

export function createRequestCard({ api, viewId, state, key, native, onResolved, signal }) {
  const p = native.params, method = native.method, question = method === 'item/tool/requestUserInput', permission = method === 'item/permissions/requestApproval', mcp = method === 'mcpServer/elicitation/request';
  const form = element('form', null, 'native-form'), status = element('p', '', 'error'), actions = element('div', null, 'toolbar request-actions'), values = new Map();
  const title = question ? 'Codex 需要你的回答' : permission ? '请求访问权限' : mcp ? '应用请求 · ' + p.serverName : method === 'item/fileChange/requestApproval' ? '允许修改文件？' : p.kind === 'writeStdin' ? '允许向终端发送输入？' : '允许运行此命令？';
  form.setAttribute('aria-label', title); form.append(element('strong', title)); status.setAttribute('role', 'alert');
  if (p.reason || p.message) form.append(element('p', p.reason ?? p.message));
  if (p.cwd) form.append(element('small', p.cwd, 'muted'));
  if (p.command) form.append(element('pre', p.command));
  if (p.grantRoot) form.append(element('pre', p.grantRoot));
  if (p.permissions || p.additionalPermissions) form.append(element('pre', JSON.stringify(p.permissions ?? p.additionalPermissions, null, 2)));
  if (p.networkApprovalContext) form.append(element('pre', JSON.stringify(p.networkApprovalContext, null, 2)));
  let supported = true, primary;
  try {
    if (question) for (const entry of p.questions ?? []) values.set(entry.id, questionField(form, entry));
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
    if (supported) { primary = 'accept'; button(question ? '提交回答' : p.mode === 'url' ? '已完成授权' : '确认', primary); }
    button(question ? '跳过' : '拒绝', 'decline'); if (mcp) button('取消', 'cancel');
  } else if (permission) {
    primary = 'accept'; button('允许本轮', 'accept'); button('允许此会话', 'acceptForSession'); button('拒绝', 'decline');
  } else {
    for (const decision of approvalDecisions(native)) { button(decisionLabel(decision), decision); if (decision === 'accept') primary = decision; }
  }
  form.append(status, actions);
  async function respond(decision) {
    if (form.dataset.sending || !state.requests.has(key)) return;
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
    form.dataset.sending = 'true'; for (const node of actions.children) node.disabled = true; status.className = 'muted'; status.textContent = '正在提交…';
    try { await api('/api/request/respond', { viewId, requestKey: key, answer: { result } }); state.requests.delete(key); form.remove(); onResolved(form); }
    catch (e) { status.className = 'error'; status.textContent = e.status === 409 ? '请求已被回答或已失效。' : e.message; if (e.status !== 409) { delete form.dataset.sending; for (const node of actions.children) node.disabled = false; } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (primary !== undefined) respond(primary); }, { signal });
  return form;
}
