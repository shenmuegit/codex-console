process.on('uncaughtException', error => { console.error(error.message); process.exitCode = 1; });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = process.env.CONSOLE_TEST_ROOT || __dirname;
const web = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-console-audio-'));
try {
  const builder = fs.readFileSync(path.join(root, 'console.sh'), 'utf8')
    .split(" <<'PY'\n")[1].split('\nPY\n')[0];
  const built = spawnSync('python3', ['-', web, path.join(root, 'mobile.js')], { input: builder, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const timers = [];
  const context = vm.createContext({ window: {}, document: { getElementById: () => ({ addEventListener() {} }), querySelector: () => ({ addEventListener() {} }) }, navigator: {}, default_settings: {},
    Utilities: { getFirstBrowserLanguage: () => 'zh-CN', isEventSupported: () => true },
    MediaSourceUtil: { getMediaSourceClass: () => null }, AudioContext: class {}, PACKET_TYPES: { sound_control: "sound-control" },
    jQuery: () => ({ scrollLeft: () => 0, scrollTop: () => 0, mousedown() {}, mouseup() {} }),
    setTimeout: callback => { timers.push(callback); }, console });
  vm.runInContext(fs.readFileSync(path.join(web, 'Client.js'), 'utf8'), context, { displayErrors: false });
  const Client = vm.runInContext('XpraClient', context);
  for (const enabled of [true, false]) {
    const client = Object.assign(Object.create(Client.prototype), {
      container: { clientWidth: 480, clientHeight: 928 },
      remove_windows() {}, cancel_all_files() {}, clear_timers() {}, close_protocol() {},
      emit_connection_lost() {}, log() {}, send() {}, debug() {},
      on_audio_state_change(state) { this.audio_state = state; },
    });
    client.init_state();
    Object.assign(client, { connected: true, audio_enabled: enabled,
      audio_mediasource_enabled: true, audio_aurora_enabled: false,
      audio_codec: 'opus+mka', audio_framework: 'mediasource',
      audio_codecs: { 'opus+mka': 'audio/webm; codecs="opus"' },
      mediasource_codecs: { 'opus+mka': 'audio/webm; codecs="opus"' },
    });
    let advertised;
    client.connect = () => { advertised = client._get_audio_caps(); };
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      client.do_reconnect();
      timers.shift()();
      assert.deepEqual(Array.from(advertised.decoders), ['opus+mka'], 'Reconnecting must advertise a playable codec instead of silencing the server');
      assert.equal(client.audio_enabled, enabled, 'Reconnecting must retain the audio preference');
      assert.equal(client.audio_codec, 'opus+mka');
      assert.equal(client.audio_framework, 'mediasource');
      assert.equal(client.audio_mediasource_enabled, true);
      assert.equal(client.audio_aurora_enabled, false);
      assert.equal(client.mediasource_codecs['opus+mka'], 'audio/webm; codecs="opus"');
    }
  }
  console.log('PASS: audio capabilities and preferences survive repeated Xpra reconnects');
} finally {
  fs.rmSync(web, { recursive: true, force: true });
}
