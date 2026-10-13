// Exercise the real DOM bridge in an isolated Electron profile; no app account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'console-keyboard-'));
const children = [];
let socket;
let discovery;
const start = (command, args, env, extra = []) => {
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe', ...extra] });
  child.stderr.on('data', data => fs.appendFileSync(path.join(work, 'process.log'), data));
  children.push(child);
  return child;
};
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  const log = path.join(work, 'process.log');
  assert.fail(`${message}; child exits: ${JSON.stringify(children.map(child => child.exitCode))}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(-1500) : ''}`);
}
async function main() {
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile);
  const x11 = start('Xvfb', ['-displayfd', '3', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], process.env, ['pipe']);
  const [displayData] = await once(x11.stdio[3], 'data');
  const env = { ...process.env, DISPLAY: `:${String(displayData).trim()}`,
    CODEX_ELECTRON_USER_DATA_PATH: profile, CONSOLE_STATE_DIR: work,
    XDG_CONFIG_HOME: path.join(work, 'config'), XDG_DATA_HOME: path.join(work, 'data'),
    XDG_CACHE_HOME: path.join(work, 'cache') };
  start(process.env.CONSOLE_TEST_APP_BIN || '/usr/bin/chatgpt',
    ['--ozone-platform=x11', '--disable-gpu', `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${process.env.CONSOLE_TEST_DPR || 1}`,
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], env);
  const activePort = path.join(profile, 'DevToolsActivePort');
  const port = await until(() => fs.existsSync(activePort) && Number(fs.readFileSync(activePort, 'utf8').split('\n')[0]),
    'Electron must publish its ephemeral loopback CDP port');
  const targets = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find(target => target.type === 'page' && target.url.startsWith('app:') &&
        new URL(target.url).pathname === '/index.html' && !new URL(target.url).search);
    } catch { return null; }
  }, 'The Codex renderer must be available');
  // Logged-in builds also expose hidden /index.html?initialRoute=... pages.
  // Reject those before attaching, regardless of discovery ordering.
  discovery = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ ...targets, url: 'app://-/index.html?initialRoute=/hidden',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/hidden' }, targets]));
  });
  discovery.listen(0, '127.0.0.1');
  await once(discovery, 'listening');
  fs.writeFileSync(activePort, `${discovery.address().port}\n/devtools/browser/test\n`);
  socket = new WebSocket(targets.webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (pending.has(packet.id)) {
      const { resolve, reject } = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) reject(new Error(JSON.stringify(packet.error))); else resolve(packet.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await rpc('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await until(() => evaluate("Boolean(document.documentElement && document.body && document.readyState === 'complete')"), 'The renderer must finish loading');
  await delay(2000);
  if (process.env.CONSOLE_TEST_DPR) {
    const resized = spawnSync('python3', ['-c', `
import os
from xpra.x11.bindings.display_source import init_display_source
init_display_source()
from xpra.x11.bindings.window import X11WindowBindings
window = X11WindowBindings()
for wid in window.get_children(window.get_root_xid()):
    try:
        wmclass = bytes(window.XGetWindowProperty(wid, 'WM_CLASS', 'STRING'))
        if os.environ['CODEX_ELECTRON_USER_DATA_PATH'].encode() in wmclass:
            assert window.ResizeWindow(wid, 721, 911)
            assert window.getGeometry(wid)[2:4] == (721, 911)
            break
    except Exception:
        continue
else:
    raise AssertionError('The isolated app window must be resizable')
`], { env, encoding: 'utf8' });
    assert.equal(resized.status, 0, resized.stderr);
    await until(() => evaluate('Math.abs(Math.round(innerWidth*devicePixelRatio)-721) < Math.ceil(devicePixelRatio) && Math.abs(Math.round(innerHeight*devicePixelRatio)-911) < Math.ceil(devicePixelRatio)'),
      'The renderer viewport must match native pixels within fractional-DPI quantization');
  }
  await rpc('Page.stopLoading');
  await evaluate(`document.open(); document.write('<!doctype html><html></html>'); document.close(); document.documentElement.innerHTML = '<head><style>body{margin:0}input,textarea,button{box-sizing:border-box} .field{position:absolute;left:10px;width:300px;height:40px} #edit{top:130px;background:white} #edit span{display:inline-block;width:100px;height:30px} #clip{position:absolute;left:400px;top:130px;width:90px;height:30px;overflow:hidden} #clipped{width:200px;height:60px} #composer{position:absolute;left:10px;top:430px;width:300px;height:100px} #composer .ProseMirror{position:absolute;left:5px;top:15px;width:200px;height:60px} #composer button{position:absolute;left:230px;top:60px}</style></head><body><input id="text" class="field" style="top:10px"><textarea class="field" style="top:70px"></textarea><div id="edit" class="field" contenteditable="true"><p>Editable <span contenteditable="false">Locked</span></p></div><input class="field" style="top:190px" readonly><input class="field" style="top:250px" disabled><input class="field" style="top:310px" type="checkbox"><div class="field" style="top:370px;cursor:text">Text-looking non-input</div><div id="composer" data-codex-composer-root><span>Prompt padding</span><div class="ProseMirror" contenteditable="true" data-codex-composer><p>Prompt</p></div><button>Send</button></div><div id="clip"><textarea id="clipped"></textarea></div></body>'; true`);
  const xpra = path.join(work, 'xpra');
  const notices = path.join(work, 'notices');
  fs.writeFileSync(xpra, '#!/usr/bin/env python3\nimport json, os, sys\nfrom pathlib import Path\nassert sys.argv[1:6] == ["control", os.environ["DISPLAY"], "send-notification", "7272", "codex-console-keyboard"]\nassert sys.argv[7] == "*"\nwith Path(os.environ["CONSOLE_STATE_DIR"]).joinpath("notices").open("a") as output: output.write(sys.argv[6] + "\\n")\n', { mode: 0o755 });
  start('python3', [path.join(__dirname, 'keyboard.py'), profile], { ...env, PATH: `${work}:${env.PATH}` });
  const snapshots = () => fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const contains = (map, x, y) => map.rects.some(([left, top, width, height]) =>
    x >= left && y >= top && x < left + width && y < top + height);
  const map = await until(() => snapshots().find(item => item.rects?.length), 'The bridge must publish editable hit regions');
  if (process.env.CONSOLE_TEST_DPR) {
    const size = await evaluate('({innerWidth, innerHeight, width: visualViewport.width, height: visualViewport.height, dpr:devicePixelRatio})');
    const dimensions = JSON.stringify({width:map.width, height:map.height, dpr:map.dpr, viewport:size});
    assert.ok(Math.abs(map.width - 721) < Math.ceil(map.dpr), `Region width must match native fractional-DPI pixels: ${dimensions}`);
    assert.ok(Math.abs(map.height - 911) < Math.ceil(map.dpr), `Region height must match native fractional-DPI pixels: ${dimensions}`);
  }
  const dpr = await evaluate('devicePixelRatio');
  for (const [x, y, expected, reason] of [
    [20, 20, true, 'text input'], [20, 80, true, 'textarea'], [20, 140, true, 'contenteditable'],
    [120, 160, false, 'noneditable child'], [20, 200, false, 'readonly'], [20, 260, false, 'disabled'],
    [20, 320, false, 'checkbox'], [20, 380, false, 'cursor:text'], [20, 437, true, 'composer padding'],
    [255, 505, false, 'composer button'], [420, 145, true, 'visible clipped input'],
    [510, 145, false, 'clipped-away input'],
  ]) assert.equal(contains(map, Math.round(x * dpr), Math.round(y * dpr)), expected, reason);
  assert.equal(map.focused, false);
  await evaluate('document.querySelector("#text").focus(); true');
  await until(() => snapshots().findLast(item => item.focused), 'Native focus must be reported');
  await evaluate('document.activeElement.blur(); const cover = document.createElement("div"); cover.id="cover"; cover.style="position:absolute;left:30px;top:10px;width:50px;height:40px;z-index:9999"; document.body.append(cover); true');
  const blocked = await until(() => snapshots().findLast(item => item.rects?.length && !item.focused &&
    !contains(item, 40 * dpr, 20 * dpr)), 'An overlay must invalidate covered input pixels');
  assert.equal(contains(blocked, 20 * dpr, 20 * dpr), true, 'The uncovered input must remain usable');
  await evaluate('document.getElementById("cover").style.display="none"; true');
  await until(() => contains(snapshots().at(-1), 40 * dpr, 20 * dpr),
    'Hiding an overlay must restore the formerly covered editable pixels');
  await evaluate('document.head.insertAdjacentHTML("beforeend", "<style>@keyframes slideCover {from{left:-70px}to{left:130px}}</style>"); const movingCover=document.getElementById("cover"); movingCover.style.display="block"; movingCover.style.left="-70px"; movingCover.style.animation="slideCover 3s linear forwards"; true');
  await delay(1300);
  assert.equal(snapshots().at(-1).rects.length, 0, 'Moving overlays must invalidate geometry until their layout is stable');
  await until(() => snapshots().findLast(item => item.rects?.length && !contains(item, 140 * dpr, 20 * dpr)),
    'CSS animation completion must publish the final hit geometry');
  await evaluate('const output = document.createElement("div"); output.style="position:absolute;left:600px;top:10px;width:200px;height:40px"; document.body.append(output); true');
  await delay(1000);
  const streamingStart = snapshots().length;
  await evaluate('window.testStream = setInterval(() => { document.body.lastElementChild.textContent = String(performance.now()); }, 30); true');
  await delay(1500);
  const streaming = snapshots().slice(streamingStart);
  await evaluate('clearInterval(window.testStream); true');
  assert.ok(streaming.some(item => contains(item, 20 * dpr, 20 * dpr)),
    'Unrelated streaming output must not starve editable-region updates');
  const count = snapshots().length;
  await until(() => snapshots().length > count, 'A late-joining Web client must receive a fresh heartbeat');
  const mobile = fs.readFileSync(path.join(__dirname, 'mobile.js'), 'utf8');
  const keyboard = mobile.slice(mobile.indexOf('  window.init_mobile_keyboard ='), mobile.lastIndexOf('})();'));
  await evaluate(`window.__client = { _screen_resized() {} }; ${keyboard}
    const button = document.createElement('a'); button.id='keyboard_button'; button.href='#'; button.textContent='Keyboard';
    button.style='position:absolute;left:350px;top:10px;width:100px;height:50px'; document.body.append(button);
    window.init_mobile_keyboard(window.__client);
    button.addEventListener('click', event => { event.preventDefault(); window.toggle_mobile_keyboard(); });
    document.getElementById('mobile-ime').style='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    window.__client._set_keyboard(true); true`);
  await rpc('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 360, y: 20, radiusX: 2, radiusY: 2 }] });
  await rpc('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(300);
  assert.equal(await evaluate('window.__client._ime_open'), false, 'A native touch on the keyboard button must close an open IME');
  await evaluate('window.__client._set_keyboard(true); true');
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: 360, y: 20, button: 'left', clickCount: 1 });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 360, y: 20, button: 'left', clickCount: 1 });
  await delay(300);
  assert.equal(await evaluate('window.__client._ime_open'), false, 'A native mouse click on the keyboard button must close an open IME');
  await evaluate('window.testTicks=[]; let at=performance.now(); window.testTickTimer=setInterval(() => { const now=performance.now(); window.testTicks.push(now-at); at=now; },16); document.querySelector("#text").style.height="300px"; true');
  await delay(2500);
  const longestTick = await evaluate('clearInterval(window.testTickTimer); Math.max(...window.testTicks)');
  assert.ok(longestTick < 150, `A region refresh must yield to input and painting, longest timer gap was ${longestTick} ms`);
  console.log('PASS: real Electron DOM identifies editable pixels, excludes controls/occlusion/clipping, and reports focus and heartbeats');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  socket?.close();
  discovery?.close();
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([once(child, 'exit').catch(() => {}), delay(2000)]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
  fs.rmSync(work, { recursive: true, force: true });
});
