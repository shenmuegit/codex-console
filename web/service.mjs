import { access, stat, realpath, mkdir, readFile, writeFile, chmod, open, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { hashPassword, createAuth } from './auth.mjs';
import { backendEndpoint } from './codex.mjs';

const BACKEND = 'codex-console-native-backend.service', WEB = 'codex-console-native-web.service', MARKER = '# codex-console managed unit\n';
const repoDefault = dirname(dirname(fileURLToPath(import.meta.url)));
const configBase = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codex-console-web');
const stateBase = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'codex-console-web');
const fail = (code, message) => Object.assign(new Error(message), { code });
const pathValue = value => typeof value === 'string' && isAbsolute(value) && !/[\r\n\0]/.test(value);
function unitValue(value) {
  if (typeof value !== 'string') throw fail('INVALID_UNIT_VALUE', 'Unit argument must be text.');
  if (/[\r\n\0]/.test(value)) throw fail('INVALID_UNIT_VALUE', 'Newlines are not valid unit arguments.');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
}
export function renderUserUnits(config) {
  for (const key of ['workspace', 'environmentFile', 'backendHome', 'backendExecutable', 'nodePath', 'repoDir', 'configPath']) if (!pathValue(config[key])) throw fail('INVALID_UNIT_VALUE', 'Unit paths must be absolute.');
  const common = `Type=simple\nWorkingDirectory=${config.workspace.replace(/%/g, '%%')}\nEnvironmentFile=${config.environmentFile.replace(/%/g, '%%')}\nUMask=0077\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=30\n`;
  const backend = MARKER + `[Unit]\nDescription=Codex Console native app server\n[Service]\n${common}Environment=${unitValue('CODEX_HOME=' + config.backendHome)}\nExecStart=:${[config.backendExecutable, '--listen', config.backendUrl || 'ws://127.0.0.1:4500', '--managed-daemon'].map(value => unitValue(value)).join(' ')}\n[Install]\nWantedBy=default.target\n`;
  const web = MARKER + `[Unit]\nDescription=Codex Console authenticated browser client\nAfter=${BACKEND}\nWants=${BACKEND}\n[Service]\n${common}ExecStart=:${[config.nodePath, join(config.repoDir, 'web/server.mjs'), '--config', config.configPath].map(value => unitValue(value)).join(' ')}\n[Install]\nWantedBy=default.target\n`;
  return { backend, web };
}
export function assertPrivate(info) {
  if (info.uid !== process.getuid()) throw fail('OWNER_REQUIRED', 'Private configuration must belong to this OS user.');
  if (info.mode & 0o077) throw fail('PRIVATE_FILE_REQUIRED', 'Private configuration files must use owner-only permissions.');
}
async function canonicalDestination(path) {
  const suffix = [];
  for (;;) {
    try { return join(await realpath(path), ...suffix); }
    catch (e) {
      if (e.code !== 'ENOENT' || dirname(path) === path) throw e;
      suffix.unshift(basename(path)); path = dirname(path);
    }
  }
}
async function requireExternal(repo, paths) {
  for (const path of paths) for (const destination of [resolve(path), await canonicalDestination(path)]) {
    if (destination === repo || destination.startsWith(repo + '/')) throw fail('PRIVATE_PATH_IN_REPO', 'Configuration and app data must stay outside the checkout.');
  }
}
async function requireExecutables(config) {
  for (const key of ['nodePath', 'backendExecutable']) if (!pathValue(config[key])) throw fail('ABSOLUTE_PATH_REQUIRED', `${key} must be an absolute path.`);
  if (config.backendExecutable.includes('/.cache/')) throw fail('CACHE_BINARY_REFUSED', 'Install the verified source binary in a persistent path.');
  for (const path of [config.nodePath, config.backendExecutable, join(dirname(config.backendExecutable), 'codex-code-mode-host')]) {
    if (!(await stat(path)).isFile()) throw fail('EXECUTABLE_REQUIRED', 'A required native executable is missing.');
    await access(path, constants.X_OK);
  }
}
export async function validateConfig(config, configPath) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw fail('NODE_REQUIRED', 'Node.js 24 or newer is required.');
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || url.origin !== config.origin || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || Number(url.port || 443) !== config.port) throw fail('INVALID_ORIGIN', 'Configure one canonical HTTPS origin and matching port.');
  backendEndpoint(config.backendUrl); createAuth({ passwordHash: config.passwordHash });
  for (const key of ['repoDir', 'nodePath', 'backendExecutable', 'backendHome', 'workspace', 'environmentFile', 'tlsCert', 'tlsKey', 'stateDir']) if (!pathValue(config[key])) throw fail('ABSOLUTE_PATH_REQUIRED', `${key} must be an absolute path.`);
  if (!pathValue(configPath)) throw fail('ABSOLUTE_PATH_REQUIRED', 'Use an absolute config path.');
  const original = await realpath(process.env.CODEX_HOME || join(homedir(), '.codex')).catch(() => resolve(process.env.CODEX_HOME || join(homedir(), '.codex')));
  if (await realpath(config.backendHome) === original || resolve(config.backendHome) === resolve(join(homedir(), '.codex'))) throw fail('ORIGINAL_HOME_REFUSED', 'Keep the original desktop home separate; migration is a separate operation.');
  const repo = await realpath(config.repoDir);
  await requireExternal(repo, [configPath, config.stateDir, config.backendHome, config.environmentFile, config.tlsKey, config.tlsCert]);
  await requireExecutables(config);
  for (const path of [config.backendHome, config.workspace, config.repoDir]) if (!(await stat(path)).isDirectory()) throw fail('DIRECTORY_REQUIRED', 'A configured directory is missing.');
  await access(join(repo, 'web/server.mjs'), constants.R_OK);
  for (const path of [configPath, config.environmentFile, config.tlsKey, config.tlsCert]) assertPrivate(await stat(path));
  const cert = new X509Certificate(await readFile(config.tlsCert)), privateKey = createPrivateKey(await readFile(config.tlsKey));
  if (!cert.publicKey.equals(createPublicKey(privateKey)) || Date.parse(cert.validTo) <= Date.now()) throw fail('TLS_INVALID', 'TLS certificate/key are mismatched or expired.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? !cert.checkIP(host) : !cert.checkHost(host)) throw fail('TLS_HOST_MISMATCH', 'Certificate SAN does not match the configured origin.');
  return config;
}
export function unitCommand(action) {
  if (action === 'stop') return ['--user', 'stop', WEB, BACKEND];
  if (action === 'start') return ['--user', 'start', BACKEND, WEB];
  if (action === 'status') return ['--user', 'show', BACKEND, WEB, '--property=Id,ActiveState,SubState'];
  throw fail('UNKNOWN_ACTION', 'Unknown service action.');
}
export function statusSummary(config, units, health) {
  return { origin: config.origin, backendUnit: units.backend, webUnit: units.web, httpsAvailable: Boolean(health.httpsAvailable), nativeOnline: health.nativeOnline ?? null };
}
async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
async function exists(path) { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function requireOwnedUnit(path, allowMissing = false) {
  if (allowMissing && !await exists(path)) return;
  if (!pathValue(path) || !await exists(path) || (await stat(path)).uid !== process.getuid() || !(await readFile(path, 'utf8')).startsWith(MARKER)) {
    throw fail('UNIT_OWNERSHIP', 'An unrelated or missing unit uses the requested name; it is preserved.');
  }
}
async function requireOwnedLoadedUnits() {
  const blocks = execFileSync('systemctl', ['--user', 'show', BACKEND, WEB, '--property=Id,FragmentPath'], { encoding: 'utf8' }).trim().split(/\n\n/);
  for (const name of [BACKEND, WEB]) {
    const block = blocks.find(block => block.split('\n').includes('Id=' + name));
    await requireOwnedUnit(block?.match(/^FragmentPath=(.*)$/m)?.[1]);
  }
}
export async function initialize(options) {
  const configPath = options.configPath || join(configBase(), 'config.json');
  if (await exists(configPath)) throw fail('CONFIG_EXISTS', 'Existing credentials/configuration are preserved.');
  const privateDir = dirname(configPath), stateDir = options.stateDir || stateBase(), backendHome = options.backendHome || join(stateDir, 'native-home');
  const workspace = options.workspace || join(stateDir, 'workspace'), repoDir = await realpath(options.repoDir || repoDefault);
  const original = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const canonicalHome = await realpath(backendHome).catch(() => resolve(backendHome)), canonicalOriginal = await realpath(original).catch(() => original);
  if (canonicalHome === canonicalOriginal || resolve(backendHome) === resolve(join(homedir(), '.codex'))) throw fail('ORIGINAL_HOME_REFUSED', 'Do not initialize the original desktop home.');
  for (const path of [configPath, stateDir, backendHome, workspace]) if (!pathValue(path)) throw fail('ABSOLUTE_PATH_REQUIRED', 'Configuration paths must be absolute.');
  await requireExternal(repoDir, [configPath, stateDir, backendHome]);
  const origin = new URL(options.origin || 'https://127.0.0.1:8443').origin, url = new URL(origin), host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') throw fail('INVALID_ORIGIN', 'Configure an HTTPS origin.');
  const backendExecutable = options.backendExecutable || join(homedir(), '.local/lib/codex-console-web/bin/codex-app-server');
  const backendUrl = options.backendUrl || 'ws://127.0.0.1:4500'; backendEndpoint(backendUrl);
  await requireExecutables({ nodePath: process.execPath, backendExecutable });
  const tlsKey = join(privateDir, 'key.pem'), tlsCert = join(privateDir, 'cert.pem'), environmentFile = join(privateDir, 'runtime.env'), passwordFile = join(privateDir, 'owner-password');
  for (const path of [tlsKey, tlsCert, environmentFile, passwordFile]) if (await exists(path)) throw fail('CREDENTIAL_EXISTS', 'Existing private material is preserved.');
  if ((options.cert || options.key) && (!options.cert || !options.key)) throw fail('TLS_PAIR_REQUIRED', 'Provide both --cert and --key.');
  for (const path of [privateDir, stateDir, backendHome]) await privateDirectory(path);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const created = []; let staging;
  async function writeNew(path, data) {
    const file = await open(path, 'wx', 0o600); created.push(path);
    try { await file.writeFile(data); } finally { await file.close(); }
  }
  try {
    if (options.cert) {
      await writeNew(tlsCert, await readFile(options.cert)); await writeNew(tlsKey, await readFile(options.key));
    } else {
      staging = await mkdtemp(join(privateDir, '.init-'));
      const key = join(staging, 'key.pem'), cert = join(staging, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert,
        '-subj', '/CN=' + host, '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`, '-days', '30'], { stdio: 'ignore' });
      await writeNew(tlsKey, await readFile(key)); await writeNew(tlsCert, await readFile(cert));
    }
    const password = randomBytes(32).toString('base64url'); await writeNew(passwordFile, password + '\n');
    const allowed = ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'];
    const environment = options.environment || process.env;
    const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`') + '"';
    await writeNew(environmentFile, allowed.filter(key => environment[key] && !/[\r\n\0]/.test(environment[key])).map(key => `${key}=${quote(environment[key])}\n`).join(''));
    const authSource = join(original, 'auth.json'), authTarget = join(backendHome, 'auth.json'), nativeConfig = join(backendHome, 'config.toml');
    if (!await exists(authTarget) && await exists(authSource)) await writeNew(authTarget, await readFile(authSource));
    if (!await exists(nativeConfig)) await writeNew(nativeConfig, 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n');
    const config = { origin, listenHost: options.listenHost || (['127.0.0.1', '::1', 'localhost'].includes(host) ? (host === 'localhost' ? '127.0.0.1' : host) : '0.0.0.0'), port: Number(url.port || 443),
      backendUrl, backendExecutable, backendHome: await realpath(backendHome), workspace: await realpath(workspace), repoDir, nodePath: process.execPath, environmentFile, stateDir: await realpath(stateDir),
      generatedRoots: options.generatedRoots || [await realpath(workspace)], uploadLimitBytes: options.uploadLimitBytes || 33_554_432, tlsKey, tlsCert, passwordHash: await hashPassword(password) };
    await writeNew(configPath, JSON.stringify(config, null, 2));
    await validateConfig(config, configPath); return { config, configPath, passwordFile };
  } catch (e) {
    for (const path of created.reverse()) await rm(path, { force: true });
    throw e;
  } finally { if (staging) await rm(staging, { recursive: true, force: true }); }
}
async function install(config, configPath) {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user'); await privateDirectory(dir);
  const units = renderUserUnits({ ...config, configPath });
  const targets = [[BACKEND, units.backend], [WEB, units.web]];
  for (const [name] of targets) await requireOwnedUnit(join(dir, name), true);
  for (const [name, value] of targets) await writeFile(join(dir, name), value, { mode: 0o600 });
  execFileSync('systemctl', ['--user', 'daemon-reload']); execFileSync('systemctl', ['--user', 'enable', BACKEND, WEB], { stdio: 'pipe' });
}
async function health(config, configPath) {
  let cookie; const ca = [...rootCertificates, await readFile(config.tlsCert)];
  async function request(path, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(config.origin + path, { ca,
        method: body ? 'POST' : 'GET', headers: { Origin: config.origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks)) }); } catch (e) { reject(e); } });
      }); req.setTimeout(5000, () => req.destroy()); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  try {
    const password = (await readFile(join(dirname(configPath), 'owner-password'), 'utf8')).trim();
    const result = await request('/api/login', { password }); if (result.status !== 200) return { httpsAvailable: true, nativeOnline: null };
    cookie = result.headers['set-cookie'][0].split(';')[0]; const status = await request('/api/status'); await request('/api/logout', {});
    return { httpsAvailable: true, nativeOnline: status.data.online };
  } catch { return { httpsAvailable: false, nativeOnline: null }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, origin: { type: 'string' }, 'backend-bin': { type: 'string' },
      'backend-home': { type: 'string' }, workspace: { type: 'string' }, cert: { type: 'string' }, key: { type: 'string' }, 'state-dir': { type: 'string' }, 'listen-host': { type: 'string' } } });
    const action = positionals[0], configPath = values.config || join(configBase(), 'config.json');
    if (action === 'init') { const result = await initialize({ configPath, origin: values.origin, backendExecutable: values['backend-bin'], backendHome: values['backend-home'], workspace: values.workspace,
      cert: values.cert, key: values.key, stateDir: values['state-dir'], listenHost: values['listen-host'] }); console.log(JSON.stringify({ origin: result.config.origin, configPath, passwordFile: result.passwordFile })); }
    else {
      const config = JSON.parse(await readFile(configPath, 'utf8')); await validateConfig(config, configPath);
      if (action === 'install') { await install(config, configPath); console.log('Native user units installed.'); }
      else if (action === 'status') {
        const output = execFileSync('systemctl', unitCommand('status'), { encoding: 'utf8' }), blocks = output.trim().split(/\n\n/);
        const state = name => blocks.find(block => block.includes('Id=' + name))?.match(/ActiveState=(.*)/)?.[1] || 'unknown';
        console.log(JSON.stringify(statusSummary(config, { backend: state(BACKEND), web: state(WEB) }, await health(config, configPath))));
      } else { const command = unitCommand(action); await requireOwnedLoadedUnits(); execFileSync('systemctl', command, { stdio: 'pipe' }); }
    }
  } catch (e) { console.error(`Native service command failed (${e.code ?? e.name}).`); process.exitCode = 1; }
}
