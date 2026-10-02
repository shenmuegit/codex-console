(() => {
  const doubleTapDelay = 180;
  // Use Xpra mouse callbacks, including its right-button and wheel protocol.
  XpraWindow.prototype.register_canvas_pointer_events = function (canvas) {
    this._release_touch?.();
    this._touch_events?.abort();
    this._touch_events = new AbortController();
    const options = { passive: false, signal: this._touch_events.signal };
    let pointer = null;
    let start = null;
    let last = null;
    let mode = null;
    let pending = null;
    let holdTimer = null;
    const mouse = (event, button = 0) => ({
      clientX: event.clientX, clientY: event.clientY, which: button + 1, button, target: canvas,
      ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      getModifierState: key => event.getModifierState?.(key) || false,
      preventDefault: () => event.preventDefault(),
    });
    const click = (event, button = 0) => {
      this.mouse_down_cb(mouse(event, button), this);
      this.mouse_up_cb(mouse(event, button), this);
    };
    const flush = () => {
      if (!pending) return;
      const event = pending.event;
      clearTimeout(pending.timer);
      pending = null;
      click(event);
    };
    const release = () => {
      if (pointer === null) return;
      clearTimeout(holdTimer);
      if (mode === 'drag') this.mouse_up_cb(mouse(last), this);
      const id = pointer;
      pointer = null;
      mode = start = last = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    this._release_touch = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      release();
    };
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.isPrimary || pointer !== null) return;
      const second = pending && performance.now() - pending.at <= doubleTapDelay &&
        Math.hypot(event.clientX - pending.event.clientX, event.clientY - pending.event.clientY) <= 24;
      if (second) {
        clearTimeout(pending.timer);
        pending = null;
      } else {
        flush();
      }
      pointer = event.pointerId;
      start = last = event;
      mode = second ? 'second' : 'tap';
      canvas.setPointerCapture(pointer);
      if (second) holdTimer = setTimeout(() => {
        if (mode === 'second') mode = 'scroll';
      }, 220);
    }, options);
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId !== pointer) return;
      event.preventDefault();
      event.stopPropagation();
      const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 6;
      if (mode === 'tap' && moved) {
        mode = 'drag';
        this.mouse_down_cb(mouse(start), this);
      } else if (mode === 'second' && moved) {
        mode = 'scroll';
        clearTimeout(holdTimer);
      }
      if (mode === 'drag') this.mouse_move_cb(mouse(event), this);
      if (mode === 'scroll') this.mouse_scroll_cb({
        ...mouse(event), deltaX: (last.clientX - event.clientX) * 3,
        deltaY: (last.clientY - event.clientY) * 3, deltaMode: 0,
      }, this);
      last = event;
    }, options);
    const end = event => {
      if (event.pointerId !== pointer) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'pointercancel') {
        this._release_touch();
        return;
      }
      last = event;
      if (mode === 'tap') {
        pending = { event, at: performance.now(), timer: setTimeout(flush, doubleTapDelay) };
      } else if (mode === 'second') {
        click(event, 2);
      }
      release();
    };
    canvas.addEventListener('pointerup', end, options);
    canvas.addEventListener('pointercancel', end, options);
    canvas.addEventListener('lostpointercapture', () => {
      if (pointer !== null) this._release_touch();
    }, options);
    window.addEventListener('blur', this._release_touch, options);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._release_touch();
    }, options);
    if (Utilities.isEventSupported('wheel')) canvas.addEventListener('wheel', event => {
      this.mouse_scroll_cb(event, this);
      event.stopPropagation();
      event.preventDefault();
    }, options);
  };
  const destroy = XpraWindow.prototype.destroy;
  XpraWindow.prototype.destroy = function () {
    this._release_touch?.();
    this._touch_events?.abort();
    return destroy.call(this);
  };

  // ponytail: fit one Codex window; use desktop mode for a layout with multiple apps.
  const mainWindow = client => Object.values(client.id_to_window).find(win =>
    !win.override_redirect && !win.tray && win.has_windowtype(['NORMAL']) &&
    (win.metadata['class-instance'] || []).some(value => /chatgpt|codex/i.test(Utilities.s(value))));
  const profiles = {
    smooth: [1, 45, 90], balanced: [1.5, 70, 80], sharp: [2, 95, 70],
  };
  const setProfile = (client, name) => {
    const [density, quality, speed] = profiles[name];
    client._render_density = density;
    const options = { 'min-quality': quality, 'min-speed': speed };
    for (const [key, value] of Object.entries(options)) client.set_encoding_option(key, value);
    if (client.connected) {
      client.send(['encoding-options', options]);
      client._screen_resized();
    }
  };
  const getDPI = XpraClient.prototype._get_DPI;
  XpraClient.prototype._get_DPI = function () {
    return Math.round(getDPI.call(this) * (this._render_density || 1));
  };
  const hello = XpraClient.prototype._make_hello;
  XpraClient.prototype._make_hello = function () {
    hello.call(this);
    // Xpra 6.5 applies Xsettings only when DPI changes: set it after connection.
    this.capabilities.dpi = 0;
  };
  const fit = client => {
    const viewport = window.visualViewport;
    const width = Math.max(1, viewport?.width || window.innerWidth);
    const height = Math.max(1, viewport?.height || window.innerHeight);
    const minimum = mainWindow(client)?.metadata['size-constraints']?.['minimum-size'] || [480, 600];
    client.scale = (client._render_density || 1) * Math.max(1, minimum[0] / width, minimum[1] / height);
    Object.assign(client.container.style, {
      width: `${Math.ceil(width * client.scale)}px`, height: `${Math.ceil(height * client.scale)}px`,
      transform: `scale(${1 / client.scale})`, transformOrigin: 'top left',
    });
    for (const win of Object.values(client.id_to_window)) win.scale = client.scale;
  };
  const init = XpraClient.prototype.init;
  XpraClient.prototype.init = function (...args) {
    let profile = new URLSearchParams(window.location.search).get('performance') || 'balanced';
    if (!Object.hasOwn(profiles, profile)) profile = 'balanced';
    setProfile(this, profile);
    const selector = document.getElementById('performance_profile');
    if (selector) {
      selector.value = profile;
      selector.onchange = () => {
        const name = Object.hasOwn(profiles, selector.value) ? selector.value : 'balanced';
        selector.value = name;
        setProfile(this, name);
        const url = new URL(window.location.href);
        url.searchParams.set('performance', name);
        window.history.replaceState(null, '', url);
      };
    }
    const result = init.apply(this, args);
    fit(this);
    this.desktop_width = this.container.clientWidth;
    this.desktop_height = this.container.clientHeight;
    if (!this._viewport_resize) {
      this._viewport_resize = () => this._screen_resized();
      window.visualViewport?.addEventListener('resize', this._viewport_resize);
    }
    return result;
  };
  const resize = XpraClient.prototype._screen_resized;
  XpraClient.prototype._screen_resized = function (event) {
    fit(this);
    resize.call(this, event);
    if (this.connected) {
      // Apply Xsettings after connection too, even when the initial canvas size already matches.
      const dpi = this._get_DPI();
      this.send([PACKET_TYPES.configure_display, { dpi: { x: dpi, y: dpi } }]);
    }
    const win = mainWindow(this);
    if (this.connected && win && !win.fullscreen) win.set_fullscreen(true);
  };
  const newWindow = XpraClient.prototype._new_window;
  XpraClient.prototype._new_window = function (...args) {
    const result = newWindow.apply(this, args);
    this._screen_resized();
    return result;
  };

  window.init_mobile_keyboard = client => {
    // Keep a focusable IME receiver without adding a visible input row.
    const input = document.createElement('textarea');
    input.id = 'mobile-ime';
    input.rows = 1;
    input.tabIndex = -1;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '手机输入法，可使用双拼');
    document.body.append(input);
    let composing = false;
    let busy = false;
    let queue = [];
    const key = (name, pressed, modifiers, value, text, code) => client.send([
      PACKET_TYPES.key_action, client.focused_wid || client.topwindow,
      name, pressed, modifiers, value, text, code, 0,
    ]);
    const preserve = message => {
      input.value = queue.map(item => item.text || '').join('') + input.value;
      queue = [];
      busy = false;
      input.setCustomValidity(message);
      input.reportValidity();
    };
    const pump = () => {
      if (!queue.length) { busy = false; return; }
      busy = true;
      if (!client.connected || client.server_readonly) {
        preserve('连接尚未就绪，输入内容已保留');
        return;
      }
      const item = queue[0];
      if (item.text !== undefined) {
        if (!client.clipboard_enabled) {
          preserve('中文输入需要启用连接的剪贴板，输入内容已保留');
          return;
        }
        // ponytail: commit through Xpra clipboard; use an IME bridge to preserve remote clipboard contents.
        client.clipboard_buffer = item.text;
        client.send_clipboard_token(Utilities.StringToUint8(item.text));
        // Xpra also waits 100 ms between a clipboard update and a paste key.
        setTimeout(() => {
          if (!client.connected) { preserve('连接已断开，输入内容已保留'); return; }
          key('Control_L', true, [], 0xffe3, '', 17);
          key('v', true, ['control'], 118, 'v', 86);
          key('v', false, ['control'], 118, 'v', 86);
          key('Control_L', false, [], 0xffe3, '', 17);
          queue.shift();
          setTimeout(pump, 100);
        }, 100);
      } else {
        key(item.name, true, [], item.value, '', item.code);
        key(item.name, false, [], item.value, '', item.code);
        queue.shift();
        pump();
      }
    };
    const enqueue = item => {
      const tail = queue.at(-1);
      if (item.text !== undefined && queue.length > 1 && tail.text !== undefined) tail.text += item.text;
      else queue.push(item);
      if (!busy) pump();
    };
    const commit = () => {
      if (composing || !input.value) return;
      const text = input.value;
      input.value = '';
      input.setCustomValidity('');
      enqueue({ text });
    };
    const special = name => enqueue(name === 'Backspace' ?
      { name: 'BackSpace', value: 0xff08, code: 8 } : { name: 'Return', value: 0xff0d, code: 13 });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; commit(); });
    input.addEventListener('input', event => { if (!event.isComposing) commit(); });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (composing || event.isComposing) return;
      if (event.key === 'Enter' || (event.key === 'Backspace' && !input.value)) {
        event.preventDefault();
        special(event.key);
      }
    });
    input.addEventListener('keyup', event => event.stopPropagation());
    input.addEventListener('beforeinput', event => {
      if (composing || event.isComposing) return;
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph' ||
          (event.inputType === 'deleteContentBackward' && !input.value)) {
        event.preventDefault();
        special(event.inputType === 'deleteContentBackward' ? 'Backspace' : 'Enter');
      }
    });
    window.toggle_mobile_keyboard = () => {
      client._ime_open = !client._ime_open;
      if (client._ime_open) input.focus({ preventScroll: true });
      else input.blur();
      client._screen_resized();
      const button = document.getElementById('keyboard_button');
      button?.classList.toggle('icon-toggled', client._ime_open);
    };
  };
})();
