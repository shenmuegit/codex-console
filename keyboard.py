"""Send editable DOM hit regions through the existing authenticated Xpra channel."""
import base64
import hashlib
import json
import os
from pathlib import Path
from queue import Empty, Full, Queue
import socket
import subprocess
import sys
import time
from threading import Thread
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

from xpra.net.websockets.header import decode_hybi, encode_hybi_header


PROBE = r"""(() => {
  if (window.top !== window || window.__codexConsoleKeyboardInstalled) return;
  window.__codexConsoleKeyboardInstalled = true;
  const interactive = 'a[href],button,input,select,textarea,[contenteditable="true"],[draggable="true"],[role="button"],[role="link"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])';
  const editable = element => {
    if (!(element instanceof Element) || element.closest('[inert],[aria-disabled="true"],[aria-readonly="true"]')) return false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.matches(':disabled') && !element.readOnly && element.inputMode !== 'none' &&
        (!(element instanceof HTMLInputElement) || /^(text|search|email|url|tel|password|number)$/.test(element.type));
    }
    return element.isContentEditable;
  };
  const hitEditable = element => {
    if (editable(element)) return true;
    const root = element?.closest('[data-codex-composer-root]');
    const editor = root?.querySelector('.ProseMirror');
    // Codex forwards clicks on its noninteractive composer padding to the editor.
    return !!(editor && editable(editor) && !editor.contains(element) &&
      !root.contains(element.closest(interactive)));
  };
  let rects = [];
  let bounds = [];
  let blockers = new Map();
  let timer;
  let revision = 0;
  let viewport = [];
  let dirty = true;
  let activeScan = null;
  // Native window coordinates include scrollbars; visualViewport excludes them.
  const viewWidth = () => innerWidth;
  const viewHeight = () => innerHeight;
  const stamp = element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return JSON.stringify([box.left, box.top, box.right, box.bottom, style.transform,
      style.clipPath, style.borderRadius, style.visibility, style.pointerEvents]);
  };
  const inMotion = () => document.getAnimations().some(animation =>
    animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity &&
    animation.effect.getKeyframes().some(frame => Object.keys(frame).some(key =>
      /^(transform|translate|rotate|scale|left|top|right|bottom|inset|width|height|margin|padding|clip|mask|borderRadius|visibility|pointerEvents|display|overflow)/.test(key))));
  const report = () => window.__codexConsoleKeyboard(JSON.stringify({
    width: Math.round(viewWidth() * devicePixelRatio), height: Math.round(viewHeight() * devicePixelRatio),
    dpr: devicePixelRatio, rects, focused: editable(document.activeElement),
  }));
  const geometryChanged = () => viewport[0] !== viewWidth() || viewport[1] !== viewHeight() || viewport[2] !== devicePixelRatio ||
    bounds.some(([root, box, before]) => !root.isConnected || stamp(root) !== before) ||
    [...blockers].some(([node, before]) => !node.isConnected || stamp(node) !== before);
  const resize = new ResizeObserver(() => { if (!dirty && geometryChanged()) invalidate(); });
  const scan = async () => {
    timer = null;
    const generation = revision, regions = [];
    activeScan = generation;
    const done = () => { if (activeScan === generation) activeScan = null; };
    if (inMotion()) { done(); return; }
    viewport = [viewWidth(), viewHeight(), devicePixelRatio];
    const dpr = devicePixelRatio, width = Math.round(viewWidth() * dpr), height = Math.round(viewHeight() * dpr);
    const candidates = [...document.querySelectorAll('input,textarea,[contenteditable],[data-codex-composer-root]')]
      .filter(element => editable(element) || (element.matches('[data-codex-composer-root]') &&
        editable(element.querySelector('.ProseMirror'))));
    const roots = candidates.filter(element => !candidates.some(parent => parent !== element && parent.contains(element)));
    bounds = roots.map(root => [root, root.getBoundingClientRect(), stamp(root)]);
    resize.disconnect();
    roots.forEach(root => resize.observe(root));
    const cache = new WeakMap();
    const nextBlockers = new Map();
    let pixels = 0;
    let slice = performance.now();
    for (const [root, box] of bounds) {
      const left = Math.max(0, Math.floor(box.left * dpr)), right = Math.min(width, Math.ceil(box.right * dpr));
      const top = Math.max(0, Math.floor(box.top * dpr)), bottom = Math.min(height, Math.ceil(box.bottom * dpr));
      pixels += Math.max(0, right - left) * Math.max(0, bottom - top);
      // ponytail: rasterize native mouse pixels for exact hit tests. Huge/custom
      // editors fall back to the keyboard button; use an app bridge above 1M pixels.
      if (pixels > 1000000) { regions.length = 0; break; }
      let previous = new Map();
      for (let y = top; y < bottom; y++) {
        const row = new Map();
        let start = -1;
        for (let x = left; x <= right; x++) {
          const element = x < right ? document.elementFromPoint(x / dpr, y / dpr) : null;
          if (element && !cache.has(element)) {
            const hit = hitEditable(element);
            cache.set(element, hit);
            if (!hit && !roots.some(root => element.contains(root))) {
              // A button's children have the same noneditable hit result. Track
              // its stable box rather than a rotating spinner inside it.
              const owner = element.closest(interactive);
              const block = owner && !hitEditable(owner) && !roots.some(root => owner.contains(root)) ? owner : element;
              if (!nextBlockers.has(block)) nextBlockers.set(block, stamp(block));
            }
          }
          const hit = element && cache.get(element);
          if (hit && start < 0) start = x;
          if (!hit && start >= 0) {
            const key = `${start}:${x}`;
            const rect = previous.get(key) || [start, y, x - start, 0];
            if (!previous.has(key)) regions.push(rect);
            rect[3]++;
            row.set(key, rect);
            start = -1;
          }
        }
        previous = row;
        if (performance.now() - slice > 8) {
          // Yield between rows so exact hit tests never hold up input/painting.
          await new Promise(resolve => setTimeout(resolve, 0));
          if (generation !== revision) { done(); return; }
          slice = performance.now();
        }
      }
      if (regions.length > 4096) { regions.length = 0; break; }
    }
    if (generation !== revision) { done(); return; }
    done();
    if (inMotion() || bounds.some(([root, box, before]) => stamp(root) !== before) ||
        [...nextBlockers].some(([node, before]) => stamp(node) !== before)) return;
    blockers = nextBlockers;
    rects = regions;
    dirty = false;
    report();
  };
  const invalidate = () => {
    revision++;
    dirty = true;
    rects = [];
    if (timer) return;
    report();
    timer = setTimeout(scan, 120);
  };
  new MutationObserver(records => {
    // Token streaming outside the inputs must not continually clear their map.
    const affected = !bounds.length || bounds.some(([root, box]) => {
      const current = root.getBoundingClientRect();
      if (!root.isConnected || ['left', 'top', 'right', 'bottom'].some(key => current[key] !== box[key])) return true;
      return records.some(record => {
        const node = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!node || node.contains(root) || root.contains(node) ||
            [...blockers.keys()].some(block => node.contains(block) || block.contains(node))) return true;
        const changed = node.getBoundingClientRect();
        return changed.left < box.right && changed.right > box.left && changed.top < box.bottom && changed.bottom > box.top;
      });
    });
    if (affected) invalidate();
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.addEventListener('resize', invalidate);
  window.visualViewport?.addEventListener('resize', invalidate);
  document.addEventListener('scroll', invalidate, true);
  document.addEventListener('focusin', report, true);
  document.addEventListener('focusout', () => queueMicrotask(report), true);
  for (const event of ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel']) {
    document.addEventListener(event, () => { if (inMotion() || dirty || geometryChanged()) invalidate(); }, true);
  }
  setInterval(() => {
    if (inMotion()) { if (!dirty) invalidate(); }
    else if (activeScan === null && !timer && (dirty || geometryChanged())) invalidate();
  }, 250);
  // Reuse the raster for heartbeats; only rescan when the layout changes.
  setInterval(report, 1000);
  scan();
})();"""


class Devtools:
    """Small CDP connection; reuse Xpra's WebSocket frame codec."""
    def __init__(self, url):
        address = urlsplit(url)
        if address.scheme != "ws" or address.hostname != "127.0.0.1":
            raise ValueError("CDP must use loopback")
        self.socket = socket.create_connection((address.hostname, address.port), timeout=3)
        self.buffer = b""
        self.serial = 0
        try:
            key = base64.b64encode(os.urandom(16)).decode()
            self.socket.sendall((f"GET {address.path} HTTP/1.1\r\nHost: 127.0.0.1:{address.port}\r\n"
                                 "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                                 f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            while b"\r\n\r\n" not in self.buffer:
                self.read()
                if len(self.buffer) > 16384:
                    raise ValueError("Oversized CDP handshake")
            header, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            headers = {name.lower(): value.strip() for name, value in
                       (line.split(b":", 1) for line in header.split(b"\r\n")[1:] if b":" in line)}
            if not header.startswith(b"HTTP/1.1 101 ") or headers.get(b"sec-websocket-accept") != expected:
                raise ValueError("CDP rejected WebSocket upgrade")
        except Exception:
            self.socket.close()
            raise

    def read(self):
        chunk = self.socket.recv(65536)
        if not chunk:
            raise ConnectionError("CDP closed")
        self.buffer += chunk
        if len(self.buffer) > 2 * 1024 * 1024:
            raise ValueError("Oversized CDP message")

    def send(self, payload, opcode=1):
        mask = os.urandom(4)
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(encode_hybi_header(opcode, len(payload), has_mask=True) + mask + masked)

    def call(self, method, **params):
        self.serial += 1
        self.send(json.dumps({"id": self.serial, "method": method, "params": params}).encode())

    def receive(self):
        message = b""
        while True:
            frame = decode_hybi(self.buffer)
            if not frame:
                self.read()
                continue
            opcode, payload, length, final = frame
            self.buffer = self.buffer[length:]
            if opcode == 8:
                raise ConnectionError("CDP closed")
            if opcode == 9:
                self.send(bytes(payload), 10)
            elif opcode in (0, 1):
                message += bytes(payload)
                if len(message) > 2 * 1024 * 1024:
                    raise ValueError("Oversized CDP message")
                if final:
                    return json.loads(message)


def notify(payload):
    subprocess.run(["xpra", "control", os.environ["DISPLAY"], "send-notification", "7272",
                    "codex-console-keyboard", payload, "*"], check=True, timeout=3,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run(profile):
    http = build_opener(ProxyHandler({}))
    # Never let slow control commands queue stale geometry behind DOM updates.
    pending = Queue(maxsize=1)

    def publish(payload):
        try:
            pending.put_nowait(payload)
        except Full:
            try:
                pending.get_nowait()
            except Empty:
                pass
            pending.put_nowait(payload)

    def relay():
        while True:
            try:
                notify(pending.get())
            except (OSError, subprocess.SubprocessError):
                # Clients expire metadata if the server is unavailable.
                pass

    Thread(target=relay, daemon=True).start()
    last_warning = 0
    while True:
        connection = None
        try:
            port = int((profile / "DevToolsActivePort").read_text().splitlines()[0])
            if not 1024 <= port <= 65535:
                raise ValueError("Invalid CDP port")
            with http.open(f"http://127.0.0.1:{port}/json/list", timeout=3) as response:
                targets = json.load(response)
            target = next(target for target in targets if target["type"] == "page" and
                          target["url"].startswith("app:") and urlsplit(target["url"]).path == "/index.html" and
                          not urlsplit(target["url"]).query)
            connection = Devtools(target["webSocketDebuggerUrl"])
            connection.call("Runtime.enable")
            connection.call("Page.enable")
            connection.call("Runtime.addBinding", name="__codexConsoleKeyboard")
            connection.call("Page.addScriptToEvaluateOnNewDocument", source=PROBE)
            connection.call("Runtime.evaluate", expression=PROBE)
            while True:
                packet = connection.receive()
                if packet.get("error") or packet.get("result", {}).get("exceptionDetails"):
                    raise RuntimeError("DOM probe rejected")
                if packet.get("method") == "Runtime.bindingCalled":
                    params = packet["params"]
                    if params["name"] == "__codexConsoleKeyboard":
                        payload = params["payload"]
                        if len(payload) > 120000:
                            payload = "null"
                        publish(payload)
        except (OSError, ValueError, KeyError, IndexError, StopIteration, RuntimeError, subprocess.SubprocessError) as error:
            if connection:
                publish("null")
                if time.monotonic() - last_warning > 60:
                    print(f"Keyboard DOM bridge reconnecting: {type(error).__name__}", file=sys.stderr, flush=True)
                    last_warning = time.monotonic()
        finally:
            if connection:
                connection.socket.close()
        time.sleep(1)


if __name__ == "__main__":
    run(Path(sys.argv[1]))
