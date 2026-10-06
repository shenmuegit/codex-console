// Exercise monitoring against the installed client's ping and damage methods.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = 0, serial = 0;
const timers = new Map(), sent = [];
const window = new EventTarget();
Object.assign(window, { isSecureContext: true, innerWidth: 360, innerHeight: 780,
  VideoDecoder: class {}, navigator: { onLine: true,
    connection: { effectiveType: '4g', rtt: 50, downlink: 12, saveData: false } } });
const document = new EventTarget();
document.hidden = false;
const context = vm.createContext({ window, document, navigator: window.navigator,
  console, performance: { now: () => now }, Date, Uint8Array, TextEncoder,
  Utilities: { s: value => String(value), cwarn() {} }, setInterval: (fn, delay) => {
    timers.set(++serial, { fn, delay }); return serial;
  }, clearInterval: id => timers.delete(id) });
vm.runInContext(fs.readFileSync('/usr/share/xpra/www/js/Constants.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('/usr/share/xpra/www/js/Client.js', 'utf8'), context);
const prototype = vm.runInContext('XpraClient.prototype', context);
// Hello normally creates windows/audio; this test controls only that boundary.
prototype._process_hello = function () { this.connected = true; };
prototype._process_draw = function (packet) { this.lastDraw = packet; };
prototype.close = function () { this.connected = false; };
prototype._process_close = function () { this.connected = false; this.reconnect_in_progress = true; };
vm.runInContext(fs.readFileSync(`${__dirname}/network.js`, 'utf8'), context);
const client = Object.assign(Object.create(prototype), {
  uuid: 'a'.repeat(32), connected: false, _render_density: 1, scale: 1.25,
  container: { clientWidth: 480, clientHeight: 1040 },
  id_to_window: { 1: { paint_pending: 1, paint_queue: [1, 2] } },
  protocol: { send: packet => sent.push(packet) },
  send: packet => sent.push(packet), _check_server_echo() {},
});
window.init_network_monitor(client, { 'remote-logging': { receive: true } });
assert.equal(sent.length, 0, 'Unverified clients must not report or start timers');
assert.equal(timers.size, 0);
client._process_hello(['hello', { 'remote-logging': { receive: true } }]);
assert.equal(timers.size, 2, 'One reporting timer and one lag timer belong to the connection');
now = 100;
client._process_ping_echo(['ping_echo', 60, 0, 0, 0, 0]);
now = 200;
client._process_ping_echo(['ping_echo', 120, 0, 0, 0, 0]);
now = 300;
client._process_ping_echo(['ping_echo', 180, 0, 0, 0, 0]);
client._process_draw(['draw', 1, 0, 0, 20, 20, 'webp', new Uint8Array(1500), 1]);
assert.equal(client.lastDraw[8], 1, 'The original draw handler must still run');
client.do_send_damage_sequence(1, 1, 20, 20, 2000, '');
client.do_send_damage_sequence(2, 1, 20, 20, 8000, '');
client.do_send_damage_sequence(3, 1, 20, 20, -1, 'private error text');
assert.equal(sent.filter(packet => packet[0] === 'damage-sequence').length, 3,
  'Monitoring must preserve every damage acknowledgment');
now = 5000;
const snapshot = JSON.parse(JSON.stringify(window.codexConsoleNetwork.snapshot()));
assert.equal(snapshot.rtt_ms, 120);
assert.equal(snapshot.rtt_p95_ms, 120);
assert.equal(snapshot.jitter_ms, 40);
assert.equal(snapshot.image_kbps, 2.4);
assert.equal(snapshot.decode_ms, 5, 'Xpra microseconds must be converted to milliseconds');
assert.equal(snapshot.decode_p95_ms, 8);
assert.equal(snapshot.decode_errors, 1);
assert.equal(snapshot.draw_updates_per_sec, 0.4);
assert.equal(snapshot.queued_paints, 3);
assert.equal(snapshot.network.effective_type, '4g');
assert.equal(snapshot.network.downlink_mbps, 12);
assert.equal(snapshot.secure_context, true);
assert.equal(snapshot.render_width, 480);
assert.ok(!JSON.stringify(snapshot).includes('private error text'));
const reportingTimer = [...timers.values()].find(timer => timer.delay === 5000);
reportingTimer.fn();
const report = sent.findLast(packet => packet[0] === 'logging');
assert.ok(report && report[1] === 20, 'Reports must use the authenticated Xpra logging channel');
const wire = report[2];
assert.ok(wire.startsWith('codex-console-network '));
assert.equal(JSON.parse(wire.slice(wire.indexOf(' ') + 1)).client, 'a'.repeat(32));
if (process.env.CONSOLE_TEST_NETWORK_REPORT) {
  fs.writeFileSync(process.env.CONSOLE_TEST_NETWORK_REPORT, wire);
}
now = 10000;
const idle = window.codexConsoleNetwork.snapshot();
assert.equal(idle.image_kbps, 0, 'A new idle interval must not reuse earlier throughput');
assert.equal(idle.decode_ms, null, 'An idle interval has no decode measurements');
assert.equal(idle.decode_errors, 0);
delete window.navigator.connection;
assert.equal(window.codexConsoleNetwork.snapshot().network, null,
  'Unsupported browser network hints must remain unknown');
const lagTimer = [...timers.values()].find(timer => timer.delay === 1000);
document.hidden = true;
lagTimer.fn();
document.hidden = false;
document.dispatchEvent(new Event('visibilitychange'));
now = 11150;
lagTimer.fn();
assert.equal(window.codexConsoleNetwork.snapshot().event_loop_lag_ms, 150);
window.dispatchEvent(new Event('pagehide'));
window.dispatchEvent(new Event('pageshow'));
assert.equal(timers.size, 2, 'Returning from browser page cache must not disable monitoring');
client._process_close(['close', 'network lost']);
assert.equal(timers.size, 0, 'Automatic reconnect must stop timers before the next hello');
client.close();
assert.equal(timers.size, 0, 'Disconnect must stop both timers');
assert.equal(window.codexConsoleNetwork.snapshot().connected, false);
client._process_hello(['hello', { 'remote-logging': { receive: true } }]);
assert.equal(timers.size, 2, 'Reconnection must create no duplicate timers');
assert.equal(window.codexConsoleNetwork.snapshot().reconnects, 1);
assert.equal(window.codexConsoleNetwork.snapshot().rtt_ms, null,
  'Reconnect must discard old-connection RTT samples');
client.close();
client._process_hello(['hello', { 'remote-logging': { receive: false } }]);
const count = sent.filter(packet => packet[0] === 'logging').length;
[...timers.values()].find(timer => timer.delay === 5000).fn();
assert.equal(sent.filter(packet => packet[0] === 'logging').length, count,
  'A server that declines client logging must receive no monitoring packets');
client.close();
console.log('PASS: authenticated network reports, RTT/jitter, image/decode units, idle intervals, browser fallbacks and reconnect cleanup');
