import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createCodexClient } from './codex.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });

/** Connected hosts keep separate native state and share only the owner login. */
export function createRemoteHostPool({ config, sharedAuth, controller, relay, createServer,
  createClient = host => createCodexClient({ socketFactory: () => relay.openHost(host.id) }) }) {
  const entries = new Map();
  let listing, listedAt = 0, closed = false;
  const dispose = entry => { entry.server?.dispose?.(); entry.client.close(); };
  async function sync(force = false) {
    if (closed) throw fault('REMOTE_POOL_CLOSED', '远端控制已关闭。');
    if (!(await controller.status()).enrolled) {
      for (const entry of entries.values()) dispose(entry);
      entries.clear(); listedAt = 0;
      throw fault('CONTROLLER_NOT_ENROLLED', '请先完成 server 控制端授权。');
    }
    if (!force && listedAt && Date.now() - listedAt < 15_000) return;
    if (!listing) listing = (async () => {
      const hosts = await controller.listHosts(), active = new Set();
      for (const host of hosts) {
        if (typeof host.id !== 'string' || !host.id || host.id.length > 256 || host.id === 'local') throw fault('INVALID_REMOTE_HOST', '设备标识不正确。');
        active.add(host.id);
        if (entries.has(host.id)) entries.get(host.id).host = host;
        else entries.set(host.id, { host, client: createClient(host) });
      }
      for (const [id, entry] of entries) if (!active.has(id)) { dispose(entry); entries.delete(id); }
      listedAt = Date.now();
    })().finally(() => { listing = null; });
    await listing;
  }
  return {
    async list() {
      await sync(true);
      return [...entries.values()].map(entry => ({ ...entry.host, online: entry.client.status().online }));
    },
    async server(hostId) {
      await sync();
      const entry = entries.get(hostId);
      if (!entry) throw fault('REMOTE_HOST_NOT_PAIRED', '设备尚未配对或已经移除，请刷新设备列表。');
      if (!entry.server) {
        const namespace = createHash('sha256').update(hostId).digest('hex');
        entry.server = createServer({ sharedAuth, codex: entry.client, config: { ...config,
          remoteHost: entry.host, stateDir: join(config.stateDir, 'remote-hosts', namespace), generatedRoots: [] } });
      }
      return entry.server;
    },
    revoke(session) { for (const entry of entries.values()) entry.server?.emit('session-revoked', session); },
    close() { if (!closed) { closed = true; for (const entry of entries.values()) dispose(entry); entries.clear(); } },
  };
}
