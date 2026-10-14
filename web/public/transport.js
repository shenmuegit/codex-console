export function createTransport(backendOrigin) {
  if (backendOrigin !== undefined) {
    const origin = new URL(backendOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== backendOrigin || origin.hostname.includes('*')) throw new Error('Backend must be a canonical HTTPS origin.');
  }
  function url(path) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\#\s]/.test(path)) throw new Error('Expected a relative API path.');
    const pathname = path.split('?')[0], decoded = decodeURIComponent(pathname);
    if (/[\\]/.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..') || new URL(path, 'https://console.invalid').pathname !== pathname) throw new Error('Invalid API path.');
    return backendOrigin === undefined ? path : backendOrigin + path;
  }
  async function request(path, body) {
    const response = await fetch(url(path), { credentials: 'include', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message ?? '请求失败。'), data.error, { status: response.status });
    return data;
  }
  return { url, request, eventSource: path => new EventSource(url(path), { withCredentials: true }) };
}

export function pageEntryUrl(path, href = location.href) {
  return path.startsWith('/?') ? new URL(href).pathname + path.slice(1) : path;
}
