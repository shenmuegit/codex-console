export function mountConnections({ api, selectedHost = 'local', selectHost }) {
  const $ = id => document.querySelector('#' + id), abort = new AbortController(), options = { signal: abort.signal };
  let alive = true, enrolled = false, timer, generation = 0, returnToSettings;
  const namesKey = 'codex-device-names';
  let savedNames = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(namesKey) ?? '[]');
    if (Array.isArray(saved)) savedNames = saved.filter(host => host && typeof host.id === 'string' && typeof host.name === 'string')
      .map(({ id, name }) => ({ id, name }));
  } catch { /* Storage may be unavailable; the authoritative inventory still loads. */ }
  const picker = $('host-picker');
  function updateHosts(hosts = []) {
    const items = [{ id: 'local', name: 'server 本机' }, ...hosts];
    if (!items.some(host => host.id === selectedHost)) items.push({ id: selectedHost, name: '远程设备 · 暂不可用' });
    picker.replaceChildren(...items.map(host => {
      const option = document.createElement('option'); option.value = host.id;
      option.textContent = host.name + (host.online === false ? ' · 未连接' : host.online === true ? ' · 已连接' : ''); return option;
    }));
    picker.value = selectedHost;
  }
  updateHosts(savedNames);
  const states = { ready: 'server 已就绪，输入被控端连接码即可添加设备。', unconfigured: 'server 尚未完成首次授权。',
    starting: '正在准备官方账号确认…', authorizing: '等待完成官方账号确认。', enrolling: '正在登记 server 控制端…',
    authenticationRequired: 'server 官方账号登录已失效，请恢复官方账号登录后刷新；已有控制端身份保留。',
    authenticationUnavailable: 'server 账号续期暂时失败，请检查原生后台后刷新；已有控制端身份保留。',
    cleanupRequired: '上次设置尚未清理完成，请稍后重试或联系管理员。', unavailable: '控制端账号或密钥不可用，请检查 server 状态。' };
  function error(value) { if (alive) $('connections-error').textContent = value?.message ?? '连接操作失败。'; }
  async function refresh() {
    const current = ++generation;
    try {
      const status = await api('/api/controller/status');
      if (!alive || current !== generation) return;
      enrolled = status.enrolled;
      $('controller-state').textContent = status.available ? states[status.phase] ?? '控制端正在处理。' : '管理员尚未准备 server 控制端。';
      $('controller-setup').hidden = enrolled;
      $('controller-authorize').disabled = !status.available || status.enrollmentPreserved === true || ['starting', 'authorizing', 'enrolling'].includes(status.phase);
      $('pair-submit').disabled = !enrolled;
      if (enrolled) {
        $('controller-auth-link').hidden = true; $('controller-auth-link').removeAttribute('href');
        $('controller-callback-form').hidden = true; $('controller-callback').value = '';
        const { hosts } = await api('/api/controller/hosts');
        if (!alive || current !== generation) return;
        updateHosts(hosts);
        try { sessionStorage.setItem(namesKey, JSON.stringify(hosts.map(({ id, name }) => ({ id, name })))); } catch { /* Names are optional tab-local hints. */ }
        $('connections-error').textContent = '';
      } else {
        updateHosts();
        try { sessionStorage.setItem(namesKey, '[]'); } catch { /* Optional browser storage. */ }
      }
      clearTimeout(timer);
      if (!enrolled && ['starting', 'authorizing', 'enrolling'].includes(status.phase)) timer = setTimeout(refresh, 2000);
    } catch (e) {
      if (e.status === 401) { try { sessionStorage.setItem(namesKey, '[]'); } catch { /* Optional browser storage. */ } }
      error(e);
    }
  }
  async function action(button, operation) {
    button.disabled = true; $('connections-error').textContent = '';
    try { await operation(); } catch (e) { error(e); }
    finally { if (alive) button.disabled = button.id === 'pair-submit' && !enrolled; }
  }
  $('show-settings').addEventListener('click', () => $('settings-dialog').showModal(), options);
  $('close-settings').addEventListener('click', () => $('settings-dialog').close(), options);
  for (const [button, dialog] of [['show-connections', 'connections-dialog'], ['show-usage', 'usage-dialog']]) {
    $(button).addEventListener('click', () => {
      if ($('settings-dialog').open) { returnToSettings = button; $('settings-dialog').close(); }
    }, { ...options, capture: true });
    $(dialog).addEventListener('close', () => {
      if (alive && returnToSettings === button) { returnToSettings = null; $('settings-dialog').showModal(); $(button).focus(); }
    }, options);
  }
  $('show-connections').addEventListener('click', () => { $('connections-dialog').showModal(); refresh(); }, options);
  $('close-connections').addEventListener('click', () => $('connections-dialog').close(), options);
  $('refresh-connections').addEventListener('click', refresh, options);
  picker.addEventListener('change', () => selectHost(picker.value), options);
  $('controller-authorize').addEventListener('click', () => action($('controller-authorize'), async () => {
    const started = await api('/api/controller/authorize', {}), url = new URL(started.url);
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize') throw new Error('官方授权地址无效。');
    if (!alive) return;
    $('controller-auth-link').href = url.href; $('controller-auth-link').hidden = false;
    $('controller-callback-form').hidden = false; $('controller-state').textContent = states.authorizing;
    clearTimeout(timer); timer = setTimeout(refresh, 2000);
  }), options);
  $('controller-callback-form').addEventListener('submit', event => {
    event.preventDefault(); action($('controller-callback-submit'), async () => {
      await api('/api/controller/callback', { url: $('controller-callback').value.trim() });
      $('controller-callback').value = ''; await refresh();
    });
  }, options);
  $('pair-form').addEventListener('submit', event => {
    event.preventDefault(); if (!enrolled) return;
    action($('pair-submit'), async () => { await api('/api/controller/pair', { code: $('pair-code').value.trim() }); $('pair-code').value = ''; await refresh(); });
  }, options);
  return { refresh, dispose() { alive = false; ++generation; clearTimeout(timer); abort.abort(); $('settings-dialog').close(); $('connections-dialog').close();
    $('controller-auth-link').removeAttribute('href'); $('controller-auth-link').hidden = true; $('controller-callback').value = ''; } };
}
