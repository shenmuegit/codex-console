import { watch } from 'node:fs';
import { boundedHistoryItem } from './transcript.mjs';

const contents = item => JSON.stringify(item, (key, value) => key.startsWith('_') ? undefined : value);
const turnChanged = (a, b) => !a || a.status !== b.status || JSON.stringify(a.error ?? null) !== JSON.stringify(b.error ?? null);

/** Other native processes persist history without notifying this app-server connection. */
export function createPassiveHistorySync({ codex, home, active, states, publish }) {
  const seen = new WeakMap();
  let closed = false, running, catalogStamp, version = 0, watcher;
  if (home) try {
    watcher = watch(home, { persistent: false }, (_event, file) => {
      if (/^(state|thread_history)_\d+\.sqlite(?:-wal)?$/.test(String(file))) ++version;
    });
    watcher.on('error', () => { watcher?.close(); watcher = null; });
  } catch { /* Native reads remain the fallback when filesystem notifications are unavailable. */ }
  const current = generation => !closed && active() && codex.status().online && codex.status().generation === generation;
  async function scan() {
    const generation = codex.status().generation;
    if (!current(generation)) return;
    const catalog = await codex.rpc('thread/list', { limit: 20, modelProviders: [], sortKey: 'updated_at', sortDirection: 'desc' });
    if (!current(generation)) return;
    const stamp = JSON.stringify([generation, catalog.result.data.map(t => [t.id, t.updatedAt, t.name])]);
    if (catalogStamp !== stamp) publish({ kind: 'notification', cursor: catalog.cursor,
      native: { method: 'thread/list/updated', params: {} } });
    catalogStamp = stamp;
    await Promise.allSettled(states().map(async state => {
      if (!state.ready || state.deleting) return;
      const ownLive = !state.passive && state.turns.find(t => t.status === 'inProgress' && !t._passive);
      const checkpoint = state.cursor, observed = version;
      const metadata = await codex.rpc('thread/read', { threadId: state.threadId, includeTurns: false });
      const thread = metadata.result.thread;
      const previous = seen.get(state), signature = JSON.stringify([generation, thread.updatedAt, thread.name, thread.preview]);
      const waiting = thread.historyMode !== 'legacy' && (state.passive || ownLive && !ownLive.items.some(i => i.type === 'userMessage'));
      if (!waiting && previous?.signature === signature && previous.version === observed && Date.now() - previous.readAt < 15000 && !state.turns.some(t => t._passive && t.status === 'inProgress')) return;
      const legacy = state.thread.historyMode === 'legacy';
      const turns = await codex.rpc('thread/turns/list', { threadId: state.threadId, limit: 20, sortDirection: 'desc', itemsView: legacy ? 'summary' : 'notLoaded' });
      let page = legacy ? turns : await codex.rpc('thread/items/list', { threadId: state.threadId, limit: 20, sortDirection: 'desc' });
      const data = [...page.result.data], known = new Set(state.turns.flatMap(t => t.items.map(i => i.id)));
      while (!legacy && !ownLive && known.size && page.result.nextCursor && !data.some(entry => known.has(entry.item.id)) && data.length < 200) {
        page = await codex.rpc('thread/items/list', { threadId: state.threadId, limit: 20, sortDirection: 'desc', cursor: page.result.nextCursor });
        data.push(...page.result.data);
      }
      if (!current(generation) || !states().includes(state) || !state.ready || state.cursor !== checkpoint) return;
      if (!legacy && !ownLive && known.size && page.result.nextCursor && !data.some(entry => known.has(entry.item.id))) {
        publish({ kind: 'resync', cursor: page.cursor, native: { threadId: state.threadId, reason: 'passive-history-gap' } }); return;
      }
      let responseCursor = page.cursor;
      if (!legacy && ownLive && !ownLive.items.some(i => i.type === 'userMessage') && !data.some(e => e.turnId === ownLive.id && e.item.type === 'userMessage')) {
        const prefix = await codex.rpc('thread/items/list', { threadId: state.threadId, turnId: ownLive.id, limit: 20, sortDirection: 'asc' });
        const loaded = new Set(data.map(e => e.item.id));
        data.push(...[...prefix.result.data].reverse().filter(e => !loaded.has(e.item.id))); responseCursor = prefix.cursor;
      }
      if (!current(generation) || !states().includes(state) || !state.ready || state.cursor !== checkpoint) return;
      const entries = (legacy ? [...turns.result.data].reverse().flatMap(t => t.items.map(item => ({ turnId: t.id, item }))) : data.reverse())
        .map(entry => ({ ...entry, item: boundedHistoryItem(entry.item) }));
      const changed = entries.filter(entry => {
        if (ownLive && (entry.turnId !== ownLive.id || entry.item.type !== 'userMessage')) return false;
        const item = state.turns.find(t => t.id === entry.turnId)?.items.find(i => i.id === entry.item.id);
        return !item || contents(item) !== contents(entry.item);
      }).map(entry => ({ ...entry, beforeId: entries.slice(entries.indexOf(entry) + 1).find(next => next.turnId === entry.turnId && known.has(next.item.id))?.item.id }));
      const relevant = new Set([...state.turns.map(t => t.id), ...entries.map(entry => entry.turnId)]);
      const changedTurns = turns.result.data.filter(t => !ownLive && relevant.has(t.id) && turnChanged(state.turns.find(old => old.id === t.id), t))
        .map(({ items, ...turn }) => turn).reverse();
      seen.set(state, { signature, version: observed, readAt: Date.now() });
      if (!changed.length && !changedTurns.length && state.thread.name === thread.name && state.thread.updatedAt === thread.updatedAt) return;
      publish({ kind: 'notification', cursor: responseCursor, native: { method: 'thread/history/updated', params: {
        threadId: state.threadId, thread: { id: thread.id, name: thread.name, preview: thread.preview, updatedAt: thread.updatedAt },
        turns: changedTurns, entries: changed,
      } } });
    }));
  }
  function sync() {
    if (!running) running = scan().catch(() => {}).finally(() => { running = null; });
    return running;
  }
  const timer = setInterval(sync, 2000); timer.unref();
  return { sync, close() { closed = true; clearInterval(timer); watcher?.close(); } };
}
