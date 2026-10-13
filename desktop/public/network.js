(() => {
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ?
    Math.round(value * 100) / 100 : null;
  const mean = values => values.length ? number(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const p95 = values => values.length ? number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]) : null;
  const sample = (values, value) => { values.push(value); if (values.length > 60) values.shift(); };
  const monitor = client => {
    if (client._network_monitor) return client._network_monitor;
    let rtts = [], decoded = [], bytes = 0, updates = 0, errors = 0, lag = 0;
    let started = performance.now(), lastTick = started, lastPing = null, encoding = null;
    let reporting, ticking, receive = false, connections = 0;
    const snapshot = () => {
      const elapsed = (performance.now() - started) / 1000;
      const connection = window.navigator.connection || window.navigator.mozConnection || window.navigator.webkitConnection;
      const hints = connection ? {
        effective_type: ['slow-2g', '2g', '3g', '4g'].includes(connection.effectiveType) ? connection.effectiveType : null,
        rtt_ms: number(connection.rtt), downlink_mbps: number(connection.downlink),
        save_data: typeof connection.saveData === 'boolean' ? connection.saveData : null,
      } : null;
      return {
        version: 1, client: String(client.uuid || '').replaceAll('-', '').toLowerCase(),
        connected: !!client.connected, visible: !document.hidden,
        online: typeof window.navigator.onLine === 'boolean' ? window.navigator.onLine : null,
        secure_context: window.isSecureContext === true,
        rtt_ms: rtts.length ? number(rtts.at(-1)) : null, rtt_p95_ms: p95(rtts),
        rtt_sample_age_ms: lastPing === null ? null : number(performance.now() - lastPing),
        jitter_ms: mean(rtts.slice(1).map((value, index) => Math.abs(value - rtts[index]))),
        image_kbps: elapsed > 0 ? number(bytes * 8 / elapsed / 1000) : null,
        draw_updates_per_sec: elapsed > 0 ? number(updates / elapsed) : null,
        decode_ms: mean(decoded), decode_p95_ms: p95(decoded), decode_errors: errors,
        queued_paints: Object.values(client.id_to_window || {}).reduce((sum, win) =>
          sum + (win.paint_queue?.length || 0) + (win.paint_pending || 0), 0),
        event_loop_lag_ms: number(lag), reconnects: Math.max(0, connections - 1),
        encoding, decode_worker: !!client.decode_worker, offscreen: !!client.offscreen_api,
        webcodecs: typeof window.VideoDecoder === 'function',
        render_width: number(client.container?.clientWidth), render_height: number(client.container?.clientHeight),
        render_density: number(client._render_density), scale: number(client.scale), network: hints,
      };
    };
    const resetInterval = () => {
      started = performance.now();
      bytes = updates = errors = lag = 0;
      decoded = [];
    };
    const stop = () => {
      clearInterval(reporting); clearInterval(ticking);
      reporting = ticking = undefined;
    };
    const publish = () => {
      if (client.connected && receive) {
        // Reuse the password-authenticated WSS channel; no HTTP collector or probe traffic.
        try { client.send(['logging', 20, 'codex-console-network ' + JSON.stringify(snapshot())]); } catch {}
      }
      resetInterval();
    };
    const api = {
      snapshot, stop,
      start(caps) {
        if (!client.connected) return;
        stop();
        connections++;
        rtts = []; lastPing = null; encoding = null;
        resetInterval(); lastTick = started;
        receive = caps?.['remote-logging']?.receive === true || caps?.['remote-logging.multi-line'] === true;
        reporting = setInterval(publish, 5000);
        ticking = setInterval(() => {
          const now = performance.now();
          if (!document.hidden) lag = Math.max(lag, Math.max(0, now - lastTick - 1000));
          lastTick = now;
        }, 1000);
      },
      ping(value) { if (number(value) !== null) { sample(rtts, value); lastPing = performance.now(); } },
      draw(packet) {
        encoding = Utilities.s(packet[6]);
        const length = packet[7]?.byteLength ?? packet[7]?.length;
        if (typeof length === 'number' && length >= 0) bytes += length;
      },
      damage(time) {
        if (time < 0) errors++;
        else if (number(time) !== null) { updates++; sample(decoded, time / 1000); }
      },
    };
    document.addEventListener('visibilitychange', () => { lastTick = performance.now(); });
    window.addEventListener('pageshow', () => { resetInterval(); lastTick = performance.now(); });
    client._network_monitor = api;
    window.codexConsoleNetwork = { snapshot };
    return api;
  };
  window.init_network_monitor = (client, caps) => {
    const api = monitor(client);
    api.start(caps);
    return api;
  };
  const hello = XpraClient.prototype._process_hello;
  XpraClient.prototype._process_hello = function (packet) {
    const result = hello.call(this, packet);
    window.init_network_monitor(this, packet[1]);
    return result;
  };
  const ping = XpraClient.prototype._process_ping_echo;
  XpraClient.prototype._process_ping_echo = function (packet) {
    const result = ping.call(this, packet);
    monitor(this).ping(this.server_ping_latency);
    return result;
  };
  const draw = XpraClient.prototype._process_draw;
  XpraClient.prototype._process_draw = function (packet) {
    monitor(this).draw(packet); // Count bytes before transfer to the decode worker detaches the buffer.
    return draw.call(this, packet);
  };
  const damage = XpraClient.prototype.do_send_damage_sequence;
  XpraClient.prototype.do_send_damage_sequence = function (...args) {
    monitor(this).damage(args[4]);
    return damage.apply(this, args);
  };
  const close = XpraClient.prototype.close;
  XpraClient.prototype.close = function (...args) {
    this._network_monitor?.stop();
    return close.apply(this, args);
  };
  const socketClose = XpraClient.prototype._process_close;
  XpraClient.prototype._process_close = function (packet) {
    this._network_monitor?.stop();
    return socketClose.call(this, packet);
  };
})();
