// Uses the installed Xpra mouse and window code, without a browser or dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function serverClipboardText(packet, index) {
  const result = spawnSync('python3', ['-c', `
import sys
from xpra.net.rencodeplus import rencodeplus
from xpra.net.common import Packet
packet = Packet(*rencodeplus.loads(sys.stdin.buffer.read()))
sys.stdout.buffer.write(packet.get_buffer(int(sys.argv[1])))
`, String(index)], { input: Buffer.from(context.rencode(packet)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

class Surface extends EventTarget {
  style = {};
  children = [];
  value = '';
  onwheel = null;
  captured = new Set();
  append(...children) { this.children.push(...children); }
  dispatchEvent(event) {
    const result = super.dispatchEvent(event);
    this[`on${event.type}`]?.(event);
    return result;
  }
  focus() {
    this.focused = true;
    document.activeElement = this;
    this.dispatchEvent(new Event('focus'));
  }
  blur() {
    this.focused = false;
    if (document.activeElement === this) document.activeElement = null;
    this.dispatchEvent(new Event('blur'));
  }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  setCustomValidity(value) { this.validityMessage = value; }
  reportValidity() {}
  click() { this.clicks = (this.clicks || 0) + 1; this.dispatchEvent(new Event('click')); }
  showModal() { this.open = true; this.modal = true; }
  close() { this.open = false; this.modal = false; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  get clientWidth() { return Number.parseFloat(this.style.width) || 360; }
  get clientHeight() { return Number.parseFloat(this.style.height) || 680; }
  getBoundingClientRect() {
    const scales = this.style.transform?.match(/scale\(([^)]+)\)/)?.[1].split(',').map(Number) || [1];
    return { left: this.left || 0, top: this.top || 0,
      width: this.clientWidth * scales[0], height: this.clientHeight * (scales[1] ?? scales[0]) };
  }
}
const screen = new Surface();
screen.dataset = { codexInstance: 'chatgpt (/console/profile)', codexUploadDir: '/console/uploads' };
const browser = new Surface();
browser.PointerEvent = Event;
browser.navigator = { languages: ['zh-CN'], language: 'zh-CN', appVersion: 'Linux', platform: 'Linux x86_64',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0' };
browser.innerWidth = 360;
browser.innerHeight = 680;
browser.visualViewport = new Surface();
browser.visualViewport.width = 360;
browser.visualViewport.height = 680;
browser.location = { href: 'https://localhost:15443/?sound=true', search: '?sound=true' };
browser.history = { replaceState: (_state, _title, url) => {
  browser.location.href = String(url);
  browser.location.search = new URL(url).search;
} };
const toolbar = new Surface();
const profileButtons = new Map();
const connectionStatus = Object.fromEntries(
  ['progress', 'progress-label', 'progress-details', 'progress-bar', 'connection-retry'].map(id => [id, new Surface()]));
const uploadUI = Object.fromEntries(['mobile-upload', 'upload', 'upload-local', 'upload-local-caption', 'upload-file', 'upload-files', 'upload-cancel', 'upload-status']
  .map(id => [id, new Surface()]));
const packets = [];
let now = 0;
let timerId = 0;
const timers = new Map();
const schedule = (callback, delay = 0) => {
  timers.set(++timerId, { callback, at: now + delay });
  return timerId;
};
function advance(ms) {
  const target = now + ms;
  while (true) {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > target) break;
    now = next[1].at;
    if (next[1].interval) next[1].at += next[1].interval;
    else timers.delete(next[0]);
    next[1].callback();
  }
  now = target;
}
const jquery = () => ({ attr: () => '', parents: () => ({ length: 0 }),
  scrollLeft: () => 0, scrollTop: () => 0, mousedown: () => {}, mouseup: () => {}, text: () => {}, hide: () => {} });
const document = new Surface();
document.createElement = () => new Surface();
document.body = new Surface();
document.getElementById = id => id === 'screen' ? screen :
  id === 'float_menu' ? toolbar : connectionStatus[id] || uploadUI[id] || null;
document.querySelector = selector => selector === '#screen' ? screen : null;
document.querySelectorAll = selector => selector === '#performance_menu_entry [data-performance]' ? [...profileButtons.values()] : [];
const context = vm.createContext({ window: browser, document,
  console, performance: { now: () => now }, setTimeout: schedule,
  clearTimeout: id => timers.delete(id), setInterval: (callback, delay) => {
    const id = schedule(callback, delay);
    timers.get(id).interval = delay;
    return id;
  }, clearInterval: id => timers.delete(id), AbortController, jQuery: jquery, $: jquery,
  default_settings: {}, navigator: browser.navigator, screen: {}, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array,
  crypto: require('node:crypto').webcrypto,
  MediaSourceUtil: { getMediaSourceClass: () => null }, AudioContext: class {} });
vm.runInContext(fs.readFileSync('/usr/share/xpra/www/js/lib/rencode.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('/usr/share/xpra/www/js/lib/lz4.js', 'utf8'), context);
for (const file of ['Utilities', 'Constants', 'Keycodes', 'Window']) {
  vm.runInContext(fs.readFileSync(`/usr/share/xpra/www/js/${file}.js`, 'utf8'), context);
}
const mobile = path.join(__dirname, 'mobile.js');
// Load the same adapted client that console.sh serves, without starting a session.
const web = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-console-test-'));
try {
  const builder = fs.readFileSync(path.join(__dirname, 'console.sh'), 'utf8')
    .split(" <<'PY'\n")[1].split('\nPY\n')[0];
  const built = spawnSync('python3', ['-', web, mobile], { input: builder, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<button\b[^>]*data-performance="([^"]+)"/g)) {
    const button = new Surface();
    button.dataset = { performance: match[1] };
    profileButtons.set(match[1], button);
  }
  assert.equal(profileButtons.size, 3, 'The submenu must expose all three profiles as buttons');
  assert.ok(!html.includes('<select id="performance_profile"'), 'The browser dropdown must be removed');
  // Keyboard submission and the form must share password validation.
  const authResponses = [];
  const passwordField = {
    value: '', reportValidity() { return this.value.length > 0; }, removeEventListener() {},
  };
  const authContext = vm.createContext({
    document: { getElementById: () => passwordField }, $: () => ({ fadeOut() {} }),
  });
  vm.runInContext(html.slice(html.indexOf('var password_input ='),
    html.indexOf('      function keycloak_prompt_fn(')), authContext);
  authContext.window = authContext;
  authContext.event = { preventDefault() {} };
  authContext.login_callback = password => authResponses.push(password);
  // Native forms expose button IDs as names in their inline callback scope.
  const submit = html.match(/<form id="login_form" onsubmit="([^"]+)"/)[1];
  vm.runInContext(`with ({login_connect: {}}) { ${submit} }`, authContext);
  assert.equal(authResponses.length, 0, 'An empty password must not submit an authentication response');
  passwordField.value = 'test-only-password';
  vm.runInContext('password_special_keys({keyCode:13,preventDefault(){}})', authContext);
  assert.deepEqual(authResponses, ['test-only-password'], 'Enter must submit the password once');
  assert.equal(passwordField.value, '', 'Submitting must clear the password field');
  const cancel = html.match(/id="login_cancel" onclick="([^"]+)"/)[1];
  vm.runInContext(`with ({login_cancel: {}}) { ${cancel} }`, authContext);
  assert.deepEqual(authResponses, ['test-only-password', null], 'Cancel must keep the authentication callback contract');
  for (const type of ['keydown', 'keyup']) {
    const event = new Event(type, { cancelable: true });
    authContext.event = event;
    const handler = html.match(/<form id="login_form"[^>]*>/)[0].match(new RegExp(`on${type}="([^"]+)"`));
    if (handler) vm.runInContext(handler[1], authContext);
    assert.equal(event.cancelBubble, true, 'Password form keys must not reach the remote desktop');
    assert.equal(event.defaultPrevented, false, 'Password typing must retain native browser behavior');
  }
  // Each successful reconnect initializes the real toolbar again.
  let menuClicks = [];
  const menuElement = { style: {} };
  const menuQuery = {
    on(type, handler) { if (type === 'click') menuClicks.push(handler); return this; },
    off(type, handler) { if (type === 'click') menuClicks = menuClicks.filter(fn => fn !== handler); return this; },
  };
  for (const method of ['children', 'removeClass', 'addClass', 'css', 'hide', 'show', 'fadeIn', 'attr']) {
    menuQuery[method] = () => menuQuery;
  }
  const menuContext = vm.createContext({
    $: () => menuQuery, document: { getElementById: () => menuElement },
    client: { reconfigure_all_trays() {} },
    float_menu_item_size: 30, float_menu_item_count: 7, float_menu_padding: 0,
    getstrparam: () => 'novnc', getboolparam: (name, fallback) => name === 'autohide' || fallback,
  });
  vm.runInContext(html.slice(html.indexOf('var float_menu_expanded ='),
    html.indexOf('      function init_auth_autosubmit()')), menuContext);
  for (let connection = 0; connection < 6; connection++) {
    vm.runInContext('init_float_menu()', menuContext);
    menuClicks.forEach(handler => handler());
    assert.equal(menuElement.style.width, '90px', 'A click after reconnect must open the three-control drawer exactly once');
    menuClicks.forEach(handler => handler());
    assert.equal(menuElement.style.width, '0px', 'The next click must close the drawer');
  }
  const clientScript = html.match(/src="([^"]*Client\.js[^"]*)"/)[1].split('?')[0];
  vm.runInContext(fs.readFileSync(path.join(web, clientScript), 'utf8'), context);
} finally {
  fs.rmSync(web, { recursive: true, force: true });
}
if (fs.existsSync(mobile)) vm.runInContext(fs.readFileSync(mobile, 'utf8'), context);
const Client = vm.runInContext('XpraClient', context);
const Window = vm.runInContext('XpraWindow', context);
const types = vm.runInContext('PACKET_TYPES', context);
vm.runInContext('Utilities.clog=()=>{}; Utilities.cdebug=()=>{};', context);
const noop = () => {};
let promptCallback;
const passwordPrompt = (_heading, callback) => { promptCallback = callback; };
const retry = Object.assign(Object.create(Client.prototype), {
  container: screen, password_prompt_fn: passwordPrompt, clog: noop,
  host: 'localhost', port: 15443, ssl: true, passwords: [], protocol: {},
});
retry.init_state(); // The real reconnect path resets state before connecting again.
assert.equal(retry.password_prompt_fn, passwordPrompt, 'Reconnecting must retain the in-page password dialog');
retry._process_challenge([types.challenge, new Uint8Array(32), {}, 'hmac+sha256', 'sha256', 'password']);
assert.equal(typeof promptCallback, 'function', 'A challenge after reconnect must ask for a password');
function connectionLifecycle(connected) {
  return Object.assign(Object.create(Client.prototype), {
    connected, reconnect: true, reconnect_count: 20, reconnect_attempt: 0, reconnect_in_progress: false,
    disconnect_reason: null, retries: 0, closed: [], clog: noop, debug: noop,
    cancel_open_timer: noop, cancel_hello_timer: noop, cancel_all_files: noop,
    emit_connection_lost: noop, remove_windows: noop, close_audio: noop, clear_timers: noop, close_protocol: noop,
    do_reconnect() { this.retries++; }, callback_close(reason) { this.closed.push(reason); },
  });
}
const rejected = connectionLifecycle(false);
rejected._process_disconnect([types.disconnect, 'authentication failed']);
rejected._process_close([types.close, 'Normal Closure', 1000]);
assert.equal(rejected.retries, 0, 'Rejected authentication must not reconnect and prompt for the password again');
assert.equal(rejected.closed.at(-1), 'authentication failed', 'The authentication error must remain visible');
const cancelled = connectionLifecycle(false);
cancelled.disconnect('password prompt cancelled');
cancelled._process_close([types.close, 'Normal Closure', 1000]);
assert.equal(cancelled.retries, 0, 'Cancelling authentication must not reopen the password form');
const disconnected = connectionLifecycle(true);
disconnected.close();
assert.equal(disconnected.connected, false, 'Closing must clear the established connection state');
disconnected._process_close([types.close, 'Normal Closure', 1000]);
assert.equal(disconnected.retries, 0, 'An intentional disconnect must remain disconnected');
const interrupted = connectionLifecycle(true);
interrupted._process_close([types.close, 'Abnormal Closure', 1006]);
assert.equal(interrupted.retries, 1, 'An established connection must still recover from a network interruption');
const passwordKeys = Object.assign(connectionLifecycle(false), {
  capture_keyboard: true, keyboard_map: {}, key_packets: [], clipboard_enabled: false,
  _check_browser_language: noop, _keyb_get_modifiers: () => [], send: packet => packets.push(packet),
});
packets.length = 0;
for (const pressed of [true, false]) {
  passwordKeys._keyb_process(pressed, {
    code: 'Enter', key: 'Enter', which: 13, keyCode: 13, getModifierState: () => false,
  });
}
advance(0);
assert.equal(packets.length, 0, 'Submitting a password must not send key-action packets before authentication completes');
passwordKeys.connected = true;
passwordKeys._keyb_process(true, { code: 'Enter', key: 'Enter', which: 13, keyCode: 13, getModifierState: () => false });
advance(0);
assert.equal(packets[0][0], types.key_action, 'Keyboard input must still work after authentication');
let loginPrompts = 0;
let submitPassword;
const challengePasswords = [];
const login = Object.assign(connectionLifecycle(false), {
  container: screen, host: 'localhost', port: 15443, ssl: true, passwords: [], opens: 0,
  reconnect_delay: 1000, schedule_open_timer: noop, on_connection_progress: noop,
  password_prompt_fn(_heading, callback) { loginPrompts++; submitPassword = callback; },
  initialize_workers() { this.opens++; this.protocol = {}; },
  close_protocol() { this.connected = false; this.protocol = null; },
  do_reconnect: Client.prototype.do_reconnect,
  do_process_challenge(_digest, _salt, _saltDigest, password) { challengePasswords.push(password); },
});
login.connect();
assert.equal(login.opens, 0, 'Waiting for a password must not start a connection that can time out');
advance(60000);
assert.equal(login.opens, 0, 'Taking time to enter the password must not expire an authentication handshake');
assert.equal(loginPrompts, 1, 'The initial connection must prompt for a password once');
submitPassword('test-only-password');
assert.equal(login.opens, 1, 'Submitting the password must start the connection');
login._process_challenge([types.challenge, new Uint8Array(32), {}, 'hmac+sha256', 'sha256', 'password']);
assert.deepEqual(challengePasswords, ['test-only-password']);
// A drop before the server hello must also reuse the submitted password.
login._process_close([types.close, 'Abnormal Closure', 1006]);
advance(1000);
assert.equal(login.opens, 2, 'A network drop during authentication must reconnect automatically');
login._process_challenge([types.challenge, new Uint8Array(32), {}, 'hmac+sha256', 'sha256', 'password']);
assert.deepEqual(challengePasswords, ['test-only-password', 'test-only-password']);
assert.equal(loginPrompts, 1, 'Automatic reconnection must reuse the password without another prompt');
login.connected = true;
login._process_close([types.close, 'Abnormal Closure', 1006]);
advance(1000);
assert.equal(login.opens, 3, 'An established connection must recover using the same password');
login._process_challenge([types.challenge, new Uint8Array(32), {}, 'hmac+sha256', 'sha256', 'password']);
assert.equal(loginPrompts, 1, 'Established-session reconnection must not ask for the password again');
login.connected = true;
login.close();
login._process_close([types.close, 'Normal Closure', 1000]);
advance(1000);
assert.equal(login.opens, 3, 'An intentional disconnect must stop retrying even with a remembered password');
login.do_reconnect();
advance(1000);
assert.equal(login.opens, 4, 'An explicit reconnect must keep the password in the current page');
login._process_challenge([types.challenge, new Uint8Array(32), {}, 'hmac+sha256', 'sha256', 'password']);
assert.equal(loginPrompts, 1, 'An explicit reconnect must not ask for the password again');
login._process_disconnect([types.disconnect, 'authentication failed']);
login._process_close([types.close, 'Normal Closure', 1000]);
advance(1000);
assert.equal(login.opens, 4, 'A rejected password must stop automatic retry');
login.init_state();
login.connect();
assert.equal(login.opens, 4, 'A rejected password must not be reused on the next attempt');
assert.equal(loginPrompts, 2, 'An explicit retry after rejection must ask for a corrected password');
submitPassword(null);
assert.equal(login.opens, 4, 'Cancelling the password prompt must not open a connection');
const client = Object.assign(Object.create(Client.prototype), {
  container: screen, connected: false, scale: 1, id_to_window: {}, buttons_pressed: new Set(),
  desktop_width: 360, desktop_height: 680, focused_wid: 7, last_button_event: [-1, false, -1, -1],
  clipboard_direction: 'to-server', server_readonly: false, mouse_grabbed: false,
  clipboard_enabled: true, encoding_options: {}, clog: noop, log: noop,
  audio_codecs: {}, keyboard_layout: 'us', capabilities: {},
  send: packet => packets.push(structuredClone(packet)), debug: noop,
  on_connection_progress: noop, init_audio: noop, init_packet_handlers: noop, init_keyboard: noop,
  callback_close: () => { browser.location = 'connect.html'; }, // Xpra's page default.
  _keyb_get_modifiers: () => [], _get_monitors: () => [], position_float_menu: noop,
});
client.init();
for (const type of ['keydown', 'keyup']) {
  const event = new Event(type, { cancelable: true });
  toolbar.dispatchEvent(event);
  assert.equal(event.cancelBubble, true, 'Toolbar keys must not reach the remote desktop');
  assert.equal(event.defaultPrevented, false, 'Native menu controls must retain keyboard activation');
}
const initialLocation = browser.location;
client.callback_close('No password specified for authentication challenge');
assert.equal(browser.location, initialLocation, 'Disconnecting must stay on the console page');
assert.equal(connectionStatus.progress.style.display, 'block', 'The reason must remain visible');
assert.equal(connectionStatus['progress-details'].textContent, 'No password specified for authentication challenge');
assert.equal(connectionStatus['progress-bar'].hidden, true, 'A closed connection must not look like ongoing loading');
assert.equal(connectionStatus['connection-retry'].hidden, false, 'A closed connection must expose a reconnect action');
client.callback_close('authentication failed');
assert.equal(connectionStatus['progress-label'].textContent, '密码验证失败', 'Rejected authentication must show a clear error');
assert.equal(connectionStatus['progress-details'].textContent, '请检查服务器访问密码后重新连接。');
assert.equal(profileButtons.get('balanced').getAttribute('aria-pressed'), 'true', 'The page should start in balanced mode');
assert.equal(client._get_DPI(), 144, 'Rendering and font DPI must increase together');
client.connected = true;
const canvas = new Surface();
const win = Object.assign(Object.create(Window.prototype), {
  client, wid: 7, canvas, x: 0, y: 31, w: 1280, h: 820, scale: client.scale,
  metadata: { 'class-instance': [screen.dataset.codexInstance, 'Chatgpt'], 'size-constraints': { 'minimum-size': [480, 600] } },
  windowtype: ['NORMAL'], override_redirect: false, tray: false, fullscreen: false,
  resizable: false, leftoffset: 0, rightoffset: 0, topoffset: 0, bottomoffset: 0,
  updateCSSGeometry: noop, ensure_visible: () => false, focus: noop,
  geometry_cb: window => client.send_configure_window(window, {}, false),
  mouse_down_cb: (event, window) => client.on_mousedown(event, window),
  mouse_up_cb: (event, window) => client.on_mouseup(event, window),
  mouse_move_cb: (event, window) => client.on_mousemove(event, window),
  mouse_scroll_cb: (event, window) => client.on_mousescroll(event, window),
});
client.id_to_window[7] = win;
const foreignWindow = Object.assign(Object.create(Window.prototype), {
  ...win, wid: 6,
  metadata: { 'class-instance': ['chatgpt (/automation/profile)', 'Chatgpt'],
    'size-constraints': { 'minimum-size': [1500, 1100] } },
});
client.id_to_window[6] = foreignWindow;
for (const [profile, density, quality, speed] of [
  ['smooth', 1, 45, 90], ['sharp', 2, 95, 70], ['balanced', 1.5, 70, 80],
]) {
  packets.length = 0;
  const clickEvent = new Event('click', { cancelable: true });
  profileButtons.get(profile).dispatchEvent(clickEvent);
  assert.equal(clickEvent.defaultPrevented, false, 'Buttons must retain their native click behavior');
  for (const [name, button] of profileButtons) {
    assert.equal(button.getAttribute('aria-pressed'), String(name === profile), 'Exactly one profile must be marked selected');
  }
  assert.equal(client._get_DPI(), 96 * density, 'Higher resolution must keep the same logical font size');
  assert.equal(win.w, Math.ceil(480 * density));
  assert.ok(Math.abs(win.h / client.scale - 680) < 1);
  assert.equal(foreignWindow.fullscreen, false, 'Shared Chatgpt class names must not select an automation browser');
  assert.equal(client.encoding_options['min-quality'], quality);
  assert.equal(client.encoding_options['min-speed'], speed);
  client._make_hello_base();
  client._make_hello();
  assert.equal(client.capabilities.uuid, client.uuid, 'The serialized hello must route completion to the same client ID used in upload names');
  assert.equal(client.capabilities.dpi, 0, 'Connect must leave DPI unset so the configured value is applied to fonts');
  assert.ok(client.capabilities.wants.includes('display'), 'The browser must request the actual X11 display bounds');
  assert.ok(client.capabilities.wants.includes('features'),
    'The browser must request server features or Xpra omits its upload capabilities');
  assert.ok(packets.some(packet => packet[0] === 'encoding-options' &&
    packet[1]['min-quality'] === quality && packet[1]['min-speed'] === speed),
    'Changing a profile must update the connected server, without reloading');
  const query = new URL(browser.location.href).searchParams;
  assert.equal(query.get('performance'), profile, 'Refreshing must retain the selected profile');
  assert.equal(query.get('sound'), 'true', 'Changing quality must preserve other URL settings');
}
if (process.env.CONSOLE_TEST_CLIENT_HELLO) {
  fs.writeFileSync(process.env.CONSOLE_TEST_CLIENT_HELLO, JSON.stringify(client.capabilities));
}
profileButtons.get('sharp').dataset.performance = '__proto__';
profileButtons.get('sharp').dispatchEvent(new Event('click'));
profileButtons.get('sharp').dataset.performance = 'sharp';
assert.equal(client.encoding_options['min-quality'], 70, 'Unknown profiles must use a valid preset');
assert.equal(new URL(browser.location.href).searchParams.get('performance'), 'balanced');
assert.equal(profileButtons.get('balanced').getAttribute('aria-pressed'), 'true');
packets.length = 0;
client._screen_resized();
assert.ok(packets.some(packet => packet[0] === types.configure_display && packet[1].dpi.x === 144),
  'Initial connection must apply font DPI even if the canvas size has not changed');
packets.length = 0;
win.register_canvas_pointer_events(canvas);
function touch(type, x, y, id = 1) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerType: 'touch', pointerId: id, isPrimary: id === 1,
    clientX: x, clientY: y, offsetX: x, offsetY: y, button: 0, getModifierState: () => false });
  canvas.dispatchEvent(event);
  return event;
}

touch('pointerdown', 100, 120);
touch('pointermove', 130, 150);
touch('pointerup', 130, 150);
const clicks = () => packets.filter(packet => packet[0] === types.button_action);
assert.equal(clicks().length, 2, 'A touch drag must press and release the mouse button');
assert.equal(clicks()[0][2], 1, 'Touch must use the left mouse button');
assert.equal(clicks()[0][3], true);
assert.equal(clicks()[1][3], false);
const move = packets.find(packet => packet[0] === types.pointer_position);
assert.ok(move, 'Dragging must send mouse motion');
assert.equal(clicks()[0][4][0], Math.round(100 * client.scale));
assert.equal(move[2][0], Math.round(130 * client.scale), 'Scaled touch coordinates must match the screen');
assert.equal(client.buttons_pressed.size, 0);

packets.length = 0;
touch('pointerdown', 80, 90);
touch('pointerup', 80, 90);
canvas.dispatchEvent(new Event('lostpointercapture'));
assert.equal(clicks().length, 2, 'A single tap must send its click before returning from pointerup');
advance(400);
assert.equal(clicks().length, 2, 'A single tap must never send a delayed duplicate');
assert.equal(clicks()[0][2], 1, 'A single tap must click the left mouse button');

packets.length = 0;
touch('pointerdown', 80, 90);
touch('pointerup', 80, 90);
advance(100);
touch('pointerdown', 80, 90);
touch('pointerup', 80, 90);
advance(400);
assert.equal(clicks().length, 4, 'Two consecutive taps must produce two immediate left clicks');
assert.ok(clicks().every(packet => packet[2] === 1));

packets.length = 0;
client.wheel_delta_x = client.wheel_delta_y = 0;
touch('pointerdown', 80, 90);
touch('pointerdown', 120, 90, 2);
touch('pointermove', 80, 30);
touch('pointermove', 120, 30, 2);
touch('pointerup', 80, 30);
touch('pointerup', 120, 30, 2);
advance(400);
assert.ok(clicks().some(packet => packet[2] === 5), 'Two-finger sliding up must scroll down');
assert.ok(clicks().every(packet => packet[2] !== 1 && packet[2] !== 3), 'Scrolling must not left-click or right-click');
assert.equal(client.buttons_pressed.size, 0);

packets.length = 0;
touch('pointerdown', 80, 90);
touch('pointerdown', 120, 90, 2);
touch('pointerup', 120, 90, 2);
assert.equal(clicks().length, 0, 'A two-finger tap must wait for both fingers to lift');
touch('pointerup', 80, 90);
assert.deepEqual(clicks().map(packet => [packet[2], packet[3]]), [[3, true], [3, false]],
  'A two-finger tap must emit only a right-button press and release');
for (const [lift, liftX, remain, remainX] of [[1, 80, 2, 120], [2, 120, 1, 80]]) {
  packets.length = 0;
  touch('pointerdown', 80, 90);
  touch('pointerdown', 120, 90, 2);
  touch('pointerup', liftX, 90, lift);
  touch('pointermove', remainX, 30, remain);
  touch('pointerup', remainX, 30, remain);
  assert.equal(clicks().length, 0, 'Sliding a residual finger must cancel the two-finger tap');
}

packets.length = 0;
touch('pointerdown', 80, 90);
touch('pointermove', 100, 120);
touch('pointerdown', 200, 200, 2);
touch('pointercancel', 100, 120);
assert.equal(clicks().length, 2, 'A second finger must not add a mouse press');
assert.equal(client.buttons_pressed.size, 0, 'Cancelling touch must release the mouse button');
touch('pointerdown', 80, 90);
touch('pointermove', 100, 120);
canvas.dispatchEvent(new Event('lostpointercapture'));
assert.equal(client.buttons_pressed.size, 0, 'Losing pointer capture must release the mouse button');
touch('pointerdown', 80, 90);
touch('pointermove', 100, 120);
browser.dispatchEvent(new Event('blur'));
assert.equal(client.buttons_pressed.size, 0, 'Leaving the page must release the mouse button');
packets.length = 0;
touch('pointerdown', 80, 90);
browser.dispatchEvent(new Event('blur'));
advance(400);
assert.equal(clicks().length, 0, 'An unfinished tap must not click after the page loses focus');

for (const [width, height] of [[360, 680], [752, 248], [1280, 900]]) {
  browser.innerWidth = browser.visualViewport.width = width;
  browser.innerHeight = browser.visualViewport.height = height;
  client._screen_resized();
  assert.ok(win.w >= 480 && win.h >= 600, 'Codex minimum size must be respected');
  assert.ok(Math.abs(win.w / client.scale - width) < 1, 'The window must fit browser width');
  assert.ok(Math.abs(win.h / client.scale - height) < 1, 'The window must fit browser height');
  assert.equal(win.x, 0);
  assert.equal(win.y, 0);
  packets.length = 0;
  touch('pointerdown', width / 2, height / 2);
  touch('pointerup', width / 2, height / 2);
  advance(300);
  assert.ok(Math.abs(clicks()[0][4][0] - win.w / 2) <= 1);
  assert.ok(Math.abs(clicks()[0][4][1] - win.h / 2) <= 1);
}
// X11 clamps coordinates outside its physical display, even if the window is taller.
Object.assign(client, { cancel_open_timer: noop, cancel_hello_timer: noop,
  _process_modifier_keycodes: noop, _process_audio_caps: noop, _send_ping: noop, on_connect: noop, send_keymap: noop });
client._process_hello(['hello', { rencodeplus: true, version: '6.5.4',
  actual_desktop_size: [1280, 900], clipboard: true, 'client-shutdown': true }]);
assert.deepEqual(client._server_size, [1280, 900], 'The actual display bounds must survive the real hello handler');
for (const [width, height] of [[360, 696], [320, 860], [752, 248], [1280, 900]]) {
  browser.innerWidth = browser.visualViewport.width = width;
  browser.innerHeight = browser.visualViewport.height = height;
  for (const profile of ['smooth', 'balanced', 'sharp']) {
    profileButtons.get(profile).dispatchEvent(new Event('click'));
    assert.ok(win.x + win.w <= 1280 && win.y + win.h <= 900,
      'The complete window must fit the X11 pointer range, including portrait mode');
    screen.left = 13;
    screen.top = -37;
    packets.length = 0;
    const x = screen.left + width * .7;
    const y = screen.top + height - 8;
    touch('pointerdown', x, y);
    touch('pointerup', x, y);
    advance(300);
    assert.ok(Math.abs(clicks()[0][4][0] - win.w * .7) <= 1,
      'Horizontal clicks must follow the displayed canvas, including viewport offsets');
    assert.ok(Math.abs(clicks()[0][4][1] - win.h * (height - 8) / height) <= 1,
      'Bottom clicks must follow the displayed canvas without X11 clipping');
    client.on_mousemove({ clientX: x, clientY: y, preventDefault: noop }, win);
    assert.deepEqual(packets.find(packet => packet[0] === types.pointer_position)[2], clicks()[0][4],
      'Mouse motion must use the same transformed coordinates as touch clicks');
    client.wheel_delta_x = client.wheel_delta_y = 0;
    client.on_mousescroll({ clientX: x, clientY: y, deltaX: 0, deltaY: 120, deltaMode: 0, preventDefault: noop }, win);
    assert.ok(clicks().filter(packet => packet[2] >= 4).every(packet =>
      packet[4][0] === clicks()[0][4][0] && packet[4][1] === clicks()[0][4][1]),
      'Wheel events must point at the displayed location too');
  }
}
screen.left = screen.top = 0;
delete client._server_size;
profileButtons.get('balanced').dispatchEvent(new Event('click'));
assert.equal(typeof browser.init_mobile_keyboard, 'function', 'The phone input-method bridge must exist');
browser.init_mobile_keyboard(client);
const bar = document.body.children.find(element => element.id === 'mobile-inputbar');
assert.ok(!bar, 'There must be no extra input bar above the phone keyboard');
const input = document.body.children.find(element => element.id === 'mobile-ime');
assert.ok(input, 'Chinese composition still needs a focusable input receiver');
assert.ok(!input.focused, 'Page initialization must not bring up the phone keyboard');
browser.toggle_mobile_keyboard();
assert.equal(input.focused, true);
browser.innerWidth = browser.visualViewport.width = 360;
browser.visualViewport.height = 390;
browser.visualViewport.dispatchEvent(new Event('resize'));
assert.ok(Math.abs(win.h / client.scale - 390) < 1, 'The remote window must use the full height above the keyboard');
packets.length = 0;
input.dispatchEvent(new Event('compositionstart'));
input.value = 'vswen';
input.dispatchEvent(new Event('input'));
assert.equal(packets.length, 0, 'Uncommitted double-pinyin composition must stay in the phone input method');
input.value = '中文😀';
input.dispatchEvent(new Event('compositionend'));
input.dispatchEvent(new Event('input'));
advance(0);
assert.equal(packets.filter(packet => packet[0] === types.key_action).length, 4,
  'Inline clipboard contents must be followed by paste without a 100 ms pre-paste wait');
advance(250);
const tokens = packets.filter(packet => packet[0] === types.clipboard_token);
assert.equal(tokens.length, 1, 'A composition must be committed once');
assert.equal(serverClipboardText(tokens[0], 7), '中文😀', 'Chinese and emoji must survive real browser encoding and server decoding');
client._process_clipboard_request([types.clipboard_request, 42, 'CLIPBOARD', 'UTF8_STRING']);
const contents = packets.find(packet => packet[0] === types.clipboard_contents);
assert.equal(serverClipboardText(contents, 6), '中文😀', 'A server clipboard request must also receive the original text');
for (const api of ['read', 'readText']) {
  let reads = 0;
  context.navigator.clipboard = { [api]: async () => { reads++; return api === 'read' ? [] : 'old device clipboard'; } };
  const beforeRequest = packets.length;
  client._process_clipboard_request([types.clipboard_request, 44, 'CLIPBOARD', 'UTF8_STRING']);
  const reply = packets.slice(beforeRequest).find(packet => packet[0] === types.clipboard_contents);
  assert.ok(reply, 'HTTPS clipboard requests must use the committed IME text immediately');
  assert.equal(serverClipboardText(reply, 6), '中文😀', 'Device clipboard contents must not replace committed IME text');
  assert.equal(reads, 0, 'Programmatic paste must not depend on asynchronous device clipboard permissions');
}
delete context.navigator.clipboard;
const keys = packets.filter(packet => packet[0] === types.key_action);
assert.deepEqual(keys.map(packet => [packet[2], packet[3]]),
  [['Control_L', true], ['v', true], ['v', false], ['Control_L', false]],
  'Committed text must use the native paste sequence and release Control');
assert.equal(input.value, '');
packets.length = 0;
const backspace = new Event('beforeinput', { cancelable: true });
backspace.inputType = 'deleteContentBackward';
input.dispatchEvent(backspace);
const enter = new Event('keydown', { cancelable: true });
enter.key = 'Enter';
input.dispatchEvent(enter);
assert.equal(backspace.defaultPrevented, true);
assert.equal(enter.defaultPrevented, true);
assert.deepEqual(packets.filter(packet => packet[0] === types.key_action).map(packet => packet[2]),
  ['BackSpace', 'BackSpace', 'Return', 'Return']);
packets.length = 0;
input.value = '第一段😀';
input.dispatchEvent(new Event('input'));
advance(0);
advance(20);
input.value = '第二段';
input.dispatchEvent(new Event('input'));
input.dispatchEvent(enter);
advance(79);
assert.equal(packets.filter(packet => packet[0] === types.clipboard_token).length, 1,
  'Rapid commits must not replace the clipboard before the first paste can consume it');
assert.ok(!packets.some(packet => packet[0] === types.key_action && packet[2] === 'Return'));
advance(1);
assert.deepEqual(packets.filter(packet => packet[0] === types.clipboard_token).map(packet => serverClipboardText(packet, 7)),
  ['第一段😀', '第二段'], 'Queued Unicode commits must preserve their order');
advance(100);
assert.deepEqual(packets.filter(packet => packet[0] === types.key_action).map(packet => packet[2]),
  ['Control_L', 'v', 'v', 'Control_L', 'Control_L', 'v', 'v', 'Control_L', 'Return', 'Return'],
  'Enter must follow both pastes within 200 ms, without the old pre-paste waits');
packets.length = 0;
input.value = '草稿';
input.dispatchEvent(new Event('input'));
client.connected = false;
advance(250);
assert.equal(input.value, '草稿', 'Disconnecting before paste must preserve committed input');
assert.ok(!packets.some(packet => packet[0] === types.key_action), 'Disconnected input must not issue paste keys');
client.connected = true;
browser.toggle_mobile_keyboard();
assert.equal(input.focused, false);
browser.toggle_mobile_keyboard();
assert.equal(input.focused, true, 'The keyboard button must reopen the hidden input receiver');
async function checkClipboard() {
  const text = '2. Open Design：中文，双拼\n3. UI/UX Pro Max Skill（仪表盘）😀\n4. café — Taste';
  context.client = client; // The installed readText implementation references this global.
  for (const modern of [false, true]) {
    packets.length = 0;
    client.clipboard_buffer = '';
    if (modern) context.navigator.clipboard = { readText: async () => text };
    else delete context.navigator.clipboard;
    const event = { clipboardData: { getData: format => {
      assert.equal(format, 'text/plain');
      return text;
    } } };
    client.read_clipboard(event);
    await Promise.resolve();
    const token = packets.find(packet => packet[0] === types.clipboard_token);
    assert.ok(token, 'Reading the phone clipboard must send its contents');
    assert.equal(serverClipboardText(token, 7), text, 'Clipboard reads must not double-encode UTF-8');
    assert.equal(client.clipboard_buffer, text, 'The clipboard buffer must remain Unicode');
    delete context.navigator.clipboard;
    client._process_clipboard_request([types.clipboard_request, 43, 'CLIPBOARD', 'UTF8_STRING']);
    const contents = packets.find(packet => packet[0] === types.clipboard_contents);
    assert.equal(serverClipboardText(contents, 6), text, 'Later clipboard requests must preserve the same text');
    packets.length = 0;
    if (modern) context.navigator.clipboard = { readText: async () => text };
    client.read_clipboard(event);
    await Promise.resolve();
    assert.equal(packets.length, 0, 'Reading unchanged clipboard contents must not send another token');
  }
  delete context.navigator.clipboard;
}
async function checkPasswordHandshake() {
  context.crypto = require('node:crypto').webcrypto;
  vm.runInContext('Utilities.clog=()=>{}; Utilities.cdebug=()=>{};', context);
  for (const algorithm of ['hmac+sha256', 'hmac+sha512']) {
    const salt = Uint8Array.from({ length: 64 }, (_, i) => (37 * i) % 256);
    const reply = await new Promise((resolve, reject) => {
      const auth = Object.assign(Object.create(Client.prototype), {
        ssl: true, host: 'localhost', passwords: ['test-only-password'], protocol: {}, clog: noop,
        do_send_hello: (response, clientSalt) => resolve(['hello', {
          challenge_response: response, challenge_client_salt: clientSalt,
        }]),
        disconnect: reason => reject(new Error(reason)), cerror: reason => reject(new Error(reason)),
      });
      auth._process_challenge([types.challenge, salt, {}, algorithm, algorithm, 'password']);
    });
    const result = spawnSync('python3', ['-c', `
import sys, tempfile
from xpra.auth.file import Authenticator
from xpra.net.rencodeplus import rencodeplus
from xpra.util.objects import typedict
caps = typedict(rencodeplus.loads(sys.stdin.buffer.read())[1])
with tempfile.NamedTemporaryFile(mode="w") as password:
    password.write("test-only-password")
    password.flush()
    auth = Authenticator(username="desktop", filename=password.name)
    auth.salt = bytes((37 * i) % 256 for i in range(64))
    auth.digest = auth.salt_digest = sys.argv[1]
    assert auth.authenticate_hmac(caps), "Browser authentication rejected by Xpra"
`, algorithm], { input: Buffer.from(context.rencode(reply)), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
function checkUploadChunks() {
  const sent = [];
  const sender = Object.assign(Object.create(Client.prototype), {
    file_transfer: true, remote_file_transfer: true, remote_open_files: true,
    remote_file_chunks: 4, send_chunks_in_progress: new Map(),
    send: packet => sent.push(packet), debug: noop, log: noop, warn: noop, error: noop,
  });
  const bytes = Uint8Array.from({ length: 9 }, (_, i) => i);
  sender.do_send_file('image.png', '', bytes.length, bytes);
  const id = sent[0][7]['file-chunk-id'];
  for (let chunk = 0; chunk <= 3; chunk++) {
    sender._process_ack_file_chunk([types.ack_file_chunk, id, true, '', chunk]);
  }
  const chunks = sent.filter(packet => packet[0] === types.send_file_chunk);
  assert.equal(chunks.length, 3, 'The final acknowledgement must not send an extra empty image chunk');
  assert.deepEqual(Buffer.concat(chunks.map(packet => Buffer.from(packet[3]))), Buffer.from(bytes));
  assert.deepEqual(chunks.map(packet => packet[4]), [true, true, false]);
  assert.equal(sender.send_chunks_in_progress.size, 0, 'A completed image must release its transfer state');
}
async function checkUpload() {
  const negotiated = Object.assign(Object.create(Client.prototype), {
    file_transfer: true, encoding_options: {}, audio_codecs: {}, id_to_window: {},
    clog: noop, log: noop, warn: noop, debug: noop, send: noop, send_keymap: noop,
    cancel_open_timer: noop, cancel_hello_timer: noop, _process_modifier_keycodes: noop,
    _process_audio_caps: noop, _send_ping: noop, on_connect: noop, on_connection_progress: noop,
  });
  const serverHello = process.env.CONSOLE_TEST_SERVER_HELLO ?
    JSON.parse(fs.readFileSync(process.env.CONSOLE_TEST_SERVER_HELLO, 'utf8')) :
    { version: '6.5.4', rencodeplus: true, clipboard: true,
      actual_desktop_size: [4096, 4096], file: { enabled: true, open: true, 'size-limit': 32768, chunks: 1024 } };
  negotiated._process_hello([types.hello, serverHello]);
  assert.equal(negotiated.remote_file_transfer, true, 'Xpra 6.5 file capabilities must enable the upload transport');
  assert.equal(negotiated.remote_open_files, true, 'Xpra 6.5 must enable the completion callback');
  assert.equal(negotiated.remote_file_size_limit, serverHello.file['size-limit']);
  assert.equal(negotiated.remote_file_chunks, serverHello.file.chunks);
  const uploadClient = Object.assign(negotiated, {
    container: screen, connected: false, id_to_window: {}, focused_wid: 8,
    uuid: 'a'.repeat(32), send_chunks_in_progress: new Map(),
    clipboard_direction: 'to-server',
    send: packet => packets.push(structuredClone(packet)), debug: noop, log: noop, warn: noop,
    emit_connection_established: noop,
  });
  const dialog = Object.assign(Object.create(Window.prototype), {
    wid: 8, windowtype: ['DIALOG'], metadata: { 'class-instance': ['ChatGPT', 'ChatGPT'], pid: 24 },
    override_redirect: false, tray: false,
  });
  browser.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 15)';
  browser.init_mobile_upload?.(uploadClient);
  assert.equal(uploadUI['upload-local-caption'].textContent, '选择图片');
  assert.equal(uploadUI.upload.accept, 'image/*', 'Photo selection must not request videos');
  assert.ok(uploadUI['upload-file'].onclick, 'A separate native file input must use the same upload bridge');
  assert.equal(uploadUI.upload.hidden, false, 'The phone must tap a rendered native file input');
  assert.ok(uploadUI['upload-local'].children.includes(uploadUI.upload),
    'The file input must be inside the modal so the browser does not make it inert');
  assert.equal(uploadUI['mobile-upload'].hidden, true, 'Initializing before connection must not show a picker');
  uploadClient.connected = true;
  uploadClient.id_to_window = { 7: win, 8: dialog };
  win.metadata.pid = 24;
  dialog.metadata.role = 'GtkFileChooserDialog';
  advance(250);
  assert.equal(uploadUI['mobile-upload'].hidden, true,
    'A chooser left open before login must not start a new upload during the initial window replay');
  uploadClient._process_startup_complete([types.startup_complete]);
  advance(250);
  assert.equal(uploadUI['mobile-upload'].hidden, true, 'Logging in must not reopen a leftover upload');
  assert.ok(packets.some(packet => packet[0] === types.close_window && packet[1] === 8),
    'Cancel the leftover picker so the user can open a fresh Codex upload');
  uploadClient.id_to_window[8] = Object.assign(Object.create(Window.prototype), {
    ...dialog, metadata: { ...dialog.metadata, role: '' },
  });
  const freshDialog = uploadClient.id_to_window[8];
  const selectLocal = () => {
    const event = new Event('click', { cancelable: true });
    uploadUI.upload.dispatchEvent(event);
    return event;
  };
  advance(250);
  assert.equal(selectLocal().defaultPrevented, true, 'An ordinary Codex dialog must not accept file uploads');
  freshDialog.metadata.role = 'GtkFileChooserDialog';
  advance(250);
  assert.equal(uploadUI['mobile-upload'].hidden, false, 'The real Electron picker has a generic class and no transient parent');
  assert.equal(uploadUI['mobile-upload'].modal, true, 'A modal local-file surface must cover the Linux directory picker');
  assert.equal(uploadUI.upload.clicks, undefined, 'Opening the remote picker must wait for a user gesture before opening the phone picker');
  assert.equal(selectLocal().defaultPrevented, false, 'An open Codex chooser must allow the native file-picker action');
  assert.equal(selectLocal().defaultPrevented, false,
    'If the phone emits no change or cancel event, the next tap must still open its picker');
  const bytes = new TextEncoder().encode('上传正文');
  uploadUI.upload.files = [{ name: '测试 空格.txt', type: 'text/plain', size: bytes.length,
    arrayBuffer: async () => bytes.buffer }];
  packets.length = 0;
  uploadUI.upload.dispatchEvent(new Event('change'));
  await new Promise(setImmediate);
  const sent = packets.find(packet => packet[0] === types.send_file);
  assert.ok(sent, 'The browser file must enter Xpra’s real upload transport');
  assert.equal(sent[4], true, 'Completion must invoke the host upload helper');
  assert.deepEqual(Buffer.from(sent[6]), Buffer.from(bytes));
  const request = sent[1].match(/^cc-[a-f0-9]{32}-([a-f0-9]{32})--测试 空格.txt$/)?.[1];
  assert.ok(request, 'The upload must bind the completed file to this browser request');
  const saved = `/console/uploads/${request}/测试 空格.txt`;
  const notification = (id, path = saved) => [types.notify_show, 0, 1, '', 0, '',
    'codex-console-upload', JSON.stringify({ request: id, path }), 10, null, [], {}];
  const malformed = notification(request);
  malformed[7] = 'null';
  assert.doesNotThrow(() => uploadClient._process_notify_show(malformed), 'Malformed completion must be ignored safely');
  uploadClient._process_notify_show(notification('b'.repeat(32)));
  assert.ok(!packets.some(packet => packet[0] === types.key_action), 'Unmatched completion must never type into the app');
  uploadClient._process_notify_show(notification(request, '/etc/passwd'));
  assert.ok(!packets.some(packet => packet[0] === types.key_action), 'Only the private upload inbox can be selected');
  uploadClient._process_notify_show(notification(request));
  advance(700);
  const token = packets.find(packet => packet[0] === types.clipboard_token);
  assert.equal(serverClipboardText(token, 7), saved, 'Paste the actual completed path with Unicode intact');
  context.navigator.clipboard = { read: () => { throw new Error('Must not read the device clipboard for an upload'); } };
  uploadClient._process_clipboard_request([types.clipboard_request, 45, 'CLIPBOARD', 'UTF8_STRING']);
  assert.equal(serverClipboardText(packets.find(packet => packet[0] === types.clipboard_contents), 6), saved,
    'HTTPS requests must receive the completed upload path, not device clipboard contents');
  delete context.navigator.clipboard;
  const keys = packets.filter(packet => packet[0] === types.key_action);
  assert.ok(keys.some(packet => packet[2] === 'l' && packet[3]), 'Open the native chooser location field');
  assert.ok(keys.some(packet => packet[2] === 'o' && packet[3] && packet[4].includes('mod1')),
    'Activate the native Open button explicitly; Electron may leave Cancel as the default response');
  assert.ok(!keys.some(packet => packet[2] === 'Return'), 'Return must not activate the native Cancel response');
  assert.ok(keys.every(packet => packet[1] === 8), 'Every upload keystroke must target the captured chooser');
  uploadUI['upload-cancel'].click();
  assert.ok(packets.some(packet => packet[0] === types.close_window && packet[1] === 8),
    'Cancel must close the original Codex picker rather than leave the Linux browser open');
  packets.length = 0;
  uploadClient._process_notify_show(notification(request));
  advance(350);
  assert.equal(packets.length, 0, 'Cancelling must discard a late completion');
  const genericFile = uploadUI['upload-file'];
  genericFile.dispatchEvent(new Event('click', { cancelable: true }));
  const documentBytes = new TextEncoder().encode('general file contents');
  genericFile.files = [{ name: 'document.pdf', type: 'application/pdf', size: documentBytes.length,
    arrayBuffer: async () => documentBytes.buffer }];
  genericFile.dispatchEvent(new Event('change'));
  await new Promise(setImmediate);
  const documentUpload = packets.find(packet => packet[0] === types.send_file);
  assert.ok(documentUpload[1].endsWith('--document.pdf'), 'The file entry must read its own selection rather than the previous photo');
  assert.deepEqual(Buffer.from(documentUpload[6]), Buffer.from(documentBytes));
  uploadUI['upload-cancel'].click();
  packets.length = 0;
  for (const stop of ['closed', 'disconnected', 'focus', 'clipboard']) {
    uploadClient.connected = true;
    uploadClient.clipboard_enabled = true;
    uploadClient.focused_wid = 8;
    uploadClient.id_to_window[8] = freshDialog;
    selectLocal();
    uploadUI.upload.dispatchEvent(new Event('change'));
    await new Promise(setImmediate);
    const send = packets.find(packet => packet[0] === types.send_file);
    const id = send[1].match(/^cc-[a-f0-9]{32}-([a-f0-9]{32})--/)[1];
    packets.length = 0;
    uploadClient._process_notify_show(notification(id, `/console/uploads/${id}/测试 空格.txt`));
    if (stop === 'closed') delete uploadClient.id_to_window[8];
    if (stop === 'disconnected') uploadClient.connected = false;
    if (stop === 'focus') uploadClient.focused_wid = 7;
    if (stop === 'clipboard') uploadClient.clipboard_enabled = false;
    advance(700);
    assert.ok(!packets.some(packet => packet[0] === types.key_action && ['v', 'o'].includes(packet[2])),
      `Do not paste or confirm when the chooser is ${stop}`);
    uploadUI['upload-cancel'].click();
    packets.length = 0;
  }
  delete uploadClient.id_to_window[8];
  advance(250);
  assert.equal(uploadUI['mobile-upload'].open, false, 'Closing the native picker must release the modal surface');
}
checkClipboard().then(checkPasswordHandshake).then(checkUploadChunks).then(checkUpload).then(() => console.log('PASS: quality submenu, reconnect lifecycle, browser password authentication, disconnect status, gestures, sizing, IME, UTF-8 paste, and native chooser upload'))
  .catch(error => { console.error(error); process.exitCode = 1; });
