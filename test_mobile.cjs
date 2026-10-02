// Uses the installed Xpra mouse and window code, without a browser or dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
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
  setCustomValidity(value) { this.validityMessage = value; }
  reportValidity() {}
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  get clientWidth() { return Number.parseFloat(this.style.width) || 360; }
  get clientHeight() { return Number.parseFloat(this.style.height) || 680; }
}
const screen = new Surface();
const browser = new Surface();
browser.PointerEvent = Event;
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
const profileSelector = new Surface();
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
    timers.delete(next[0]);
    next[1].callback();
  }
  now = target;
}
const jquery = () => ({ attr: () => '', parents: () => ({ length: 0 }),
  scrollLeft: () => 0, scrollTop: () => 0 });
const document = new Surface();
document.createElement = () => new Surface();
document.body = new Surface();
document.getElementById = id => id === 'performance_profile' ? profileSelector : null;
document.querySelector = () => null;
const context = vm.createContext({ window: browser, document,
  console, performance: { now: () => now }, setTimeout: schedule,
  clearTimeout: id => timers.delete(id), AbortController, jQuery: jquery, $: jquery,
  default_settings: {}, navigator: {}, screen: {}, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array });
vm.runInContext(fs.readFileSync('/usr/share/xpra/www/js/lib/rencode.js', 'utf8'), context);
for (const file of ['Utilities', 'Constants', 'Keycodes', 'Window', 'Client']) {
  vm.runInContext(fs.readFileSync(`/usr/share/xpra/www/js/${file}.js`, 'utf8'), context);
}
const mobile = path.join(__dirname, 'mobile.js');
if (fs.existsSync(mobile)) vm.runInContext(fs.readFileSync(mobile, 'utf8'), context);
const Client = vm.runInContext('XpraClient', context);
const Window = vm.runInContext('XpraWindow', context);
const types = vm.runInContext('PACKET_TYPES', context);
const noop = () => {};
const client = Object.assign(Object.create(Client.prototype), {
  container: screen, connected: false, scale: 1, id_to_window: {}, buttons_pressed: new Set(),
  desktop_width: 360, desktop_height: 680, focused_wid: 7, last_button_event: [-1, false, -1, -1],
  clipboard_direction: 'to-server', server_readonly: false, mouse_grabbed: false,
  clipboard_enabled: true, encoding_options: {}, clog: noop, log: noop,
  audio_codecs: {}, keyboard_layout: 'us', capabilities: {},
  send: packet => packets.push(structuredClone(packet)), debug: noop,
  on_connection_progress: noop, init_audio: noop, init_packet_handlers: noop, init_keyboard: noop,
  _keyb_get_modifiers: () => [], _get_monitors: () => [], position_float_menu: noop,
});
client.init();
assert.equal(profileSelector.value, 'balanced', 'The page should start in balanced mode');
assert.equal(client._get_DPI(), 144, 'Rendering and font DPI must increase together');
client.connected = true;
const canvas = new Surface();
const win = Object.assign(Object.create(Window.prototype), {
  client, wid: 7, canvas, x: 0, y: 31, w: 1280, h: 820, scale: client.scale,
  metadata: { 'class-instance': ['chatgpt', 'Chatgpt'], 'size-constraints': { 'minimum-size': [480, 600] } },
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
for (const [profile, density, quality, speed] of [
  ['smooth', 1, 45, 90], ['sharp', 2, 95, 70], ['balanced', 1.5, 70, 80],
]) {
  packets.length = 0;
  profileSelector.value = profile;
  profileSelector.dispatchEvent(new Event('change'));
  assert.equal(client._get_DPI(), 96 * density, 'Higher resolution must keep the same logical font size');
  assert.equal(win.w, Math.ceil(480 * density));
  assert.ok(Math.abs(win.h / client.scale - 680) < 1);
  assert.equal(client.encoding_options['min-quality'], quality);
  assert.equal(client.encoding_options['min-speed'], speed);
  client._make_hello();
  assert.equal(client.capabilities.dpi, 0, 'Connect must leave DPI unset so the configured value is applied to fonts');
  assert.ok(packets.some(packet => packet[0] === 'encoding-options' &&
    packet[1]['min-quality'] === quality && packet[1]['min-speed'] === speed),
    'Changing a profile must update the connected server, without reloading');
  const query = new URL(browser.location.href).searchParams;
  assert.equal(query.get('performance'), profile, 'Refreshing must retain the selected profile');
  assert.equal(query.get('sound'), 'true', 'Changing quality must preserve other URL settings');
}
profileSelector.value = '__proto__';
profileSelector.dispatchEvent(new Event('change'));
assert.equal(profileSelector.value, 'balanced', 'Unknown profiles must use a valid preset');
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
assert.equal(clicks().length, 0, 'A single tap must wait briefly for the double-tap gesture');
advance(179);
assert.equal(clicks().length, 0, 'The 180 ms double-tap window must still be respected');
advance(1);
assert.equal(clicks().length, 2);
assert.equal(clicks()[0][2], 1, 'A single tap must click the left mouse button');

packets.length = 0;
touch('pointerdown', 80, 90);
touch('pointerup', 80, 90);
advance(100);
touch('pointerdown', 80, 90);
touch('pointerup', 80, 90);
advance(400);
assert.equal(clicks().length, 2, 'A double tap must produce only a right click');
assert.ok(clicks().every(packet => packet[2] === 3));

packets.length = 0;
client.wheel_delta_x = client.wheel_delta_y = 0;
touch('pointerdown', 80, 90);
touch('pointerup', 80, 90);
advance(100);
touch('pointerdown', 80, 90);
advance(250);
touch('pointermove', 80, 30);
touch('pointerup', 80, 30);
advance(400);
assert.ok(clicks().some(packet => packet[2] === 5), 'Holding the second tap and sliding up must scroll down');
assert.ok(clicks().every(packet => packet[2] !== 1 && packet[2] !== 3), 'Scrolling must not left-click or right-click');
assert.equal(client.buttons_pressed.size, 0);

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
touch('pointerup', 80, 90);
browser.dispatchEvent(new Event('blur'));
advance(400);
assert.equal(clicks().length, 0, 'A pending tap must not click after the page loses focus');

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
advance(250);
const tokens = packets.filter(packet => packet[0] === types.clipboard_token);
assert.equal(tokens.length, 1, 'A composition must be committed once');
assert.equal(serverClipboardText(tokens[0], 7), '中文😀', 'Chinese and emoji must survive real browser encoding and server decoding');
client._process_clipboard_request([types.clipboard_request, 42, 'CLIPBOARD', 'UTF8_STRING']);
const contents = packets.find(packet => packet[0] === types.clipboard_contents);
assert.equal(serverClipboardText(contents, 6), '中文😀', 'A server clipboard request must also receive the original text');
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
console.log('PASS: Xpra gestures, sizing, and phone IME composition with UTF-8 paste');
