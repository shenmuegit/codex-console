export function startPlugin({ backendOrigin, connect, loadApp = () => import('../public/app.js') }) {
  document.documentElement.dataset.isolaPlugin = 'true';
  let disposed = false, app;
  const abort = new AbortController();
  function dispose() {
    if (disposed) return;
    disposed = true; abort.abort(); app?.dispose(); app = null;
  }
  let nestedSide = false;
  try {
    nestedSide = window.parent !== window && new URL(location.href).searchParams.get('side') === '1' &&
      window.parent.location.origin === new URL(location.href).origin;
  } catch { /* A cross-origin parent must connect through the SDK. */ }
  window.addEventListener?.('pagehide', dispose, { signal: abort.signal });
  const ready = (async () => {
    try {
      const client = nestedSide ? undefined : await connect();
      if (disposed) return;
      const { mountApp } = await loadApp();
      if (disposed) return;
      app = mountApp({ backendOrigin, registerMenu: client && (items => client.registerMenu(items)) });
      if (disposed) { app.dispose(); app = null; }
    } catch (error) { if (disposed) return; dispose(); throw error; }
  })();
  return { ready, dispose };
}
