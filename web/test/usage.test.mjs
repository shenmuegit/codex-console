import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { contextUsage, weeklyUsage, createUsageTracker, modelChoice } from '../public/usage.js';
import { createChatState, installSnapshot, applyNativeEvent } from '../public/chat.js';
import { httpsFixture, resumeFixture } from './helpers.mjs';

const models = [{ model: 'native-model', displayName: 'Native', defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];
async function waitCall(peer, method) { for (let i = 0; i < 100; i++) { if (peer.sent.some(m => m.method === method)) return; await delay(5); } assert.fail(`Missing ${method}`); }

test('context uses latest tokens and the native 12000 baseline; missing values stay unknown', () => {
  const v = contextUsage({ last: { totalTokens: 112000 }, total: { totalTokens: 900000 }, modelContextWindow: 200000 });
  assert.deepEqual(v, { tokens: 112000, window: 200000, remainingPercent: 47, usedPercent: 53 });
  assert.equal(contextUsage({ last: { totalTokens: 5 }, modelContextWindow: null }).remainingPercent, null);
  assert.equal(contextUsage({ last: { totalTokens: 5 }, modelContextWindow: 12000 }).remainingPercent, 0);
  assert.equal(contextUsage({ last: { totalTokens: 1000000 }, modelContextWindow: 200000 }).remainingPercent, 0);
  assert.equal(contextUsage({ last: { totalTokens: 0 }, modelContextWindow: 200000 }).remainingPercent, 100);
  assert.deepEqual(contextUsage(null), { tokens: null, window: null, remainingPercent: null, usedPercent: null });
});

test('weekly quotas prefer native buckets and find a weekly window in either slot', () => {
  const weekly = (usedPercent, resetsAt) => ({ usedPercent, resetsAt, windowDurationMins: 10080 });
  const result = weeklyUsage({ rateLimits: { secondary: weekly(99, 1) }, rateLimitsByLimitId: {
    a: { limitId: 'a', primary: { usedPercent: 70, windowDurationMins: 300 }, secondary: weekly(20, 123) },
    b: { limitId: 'b', primary: weekly(130, 456), secondary: null },
    unknown: { primary: { usedPercent: 30, windowDurationMins: null }, secondary: null },
  } });
  assert.deepEqual(result, [{ limitId: 'a', usedPercent: 20, remainingPercent: 80, resetsAt: 123000 }, { limitId: 'b', usedPercent: 130, remainingPercent: 0, resetsAt: 456000 }]);
  assert.equal(weeklyUsage({ rateLimits: { primary: weekly(5, null) } })[0].resetsAt, null);
  assert.deepEqual(weeklyUsage({ rateLimitsByLimitId: {}, rateLimits: { primary: weekly(5, 1) } }), []);
});

test('superseded account reads cannot repopulate a cleared usage cache', async () => {
  const tracker = createUsageTracker(); let finish;
  const pending = tracker.read(() => new Promise(resolve => { finish = resolve; }));
  tracker.invalidate(); finish({ rateLimits: { secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 123 } } });
  assert.equal(await pending, null); assert.equal(tracker.value, null);
  await tracker.read(async () => ({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } } }));
  assert.equal(tracker.value[0].remainingPercent, 90);
  let reject;
  const staleError = tracker.read(() => new Promise((resolve, fail) => { reject = fail; }));
  tracker.invalidate(); reject(new Error('Old account failed'));
  assert.equal(await staleError, null);
});

test('model and effort selection use the actual catalog; accepted defaults never erase drafts', () => {
  assert.equal(modelChoice(models, 'native-model', 'high').model, 'native-model');
  assert.throws(() => modelChoice(models, 'native-model', 'ultra'), { code: 'UNSUPPORTED_EFFORT' });
  assert.throws(() => modelChoice(models, 'invented', 'low'), { code: 'UNKNOWN_MODEL' });
  const state = createChatState('t'); installSnapshot(state, { snapshot: resumeFixture('t'), cursor: { generation: 1, seq: 1 } }); state.draft = 'preserve';
  applyNativeEvent(state, { kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'thread/settings/updated', params: { threadId: 't', threadSettings: { model: 'native-model', effort: 'high', cwd: '/tmp', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } } } });
  assert.equal(state.settings.effort, 'high'); assert.equal(state.draft, 'preserve');
});

test('native failures after an accepted send remain visible in chat state', () => {
  const state = createChatState('t'); installSnapshot(state, { snapshot: resumeFixture('t'), cursor: { generation: 1, seq: 1 } });
  applyNativeEvent(state, { kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'error', params: { threadId: 't', turnId: 'v', error: { message: 'Native weekly quota unavailable' }, willRetry: false } } });
  assert.match(state.error, /Native weekly/);
  applyNativeEvent(state, { kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'turn/completed', params: { threadId: 't', turn: { id: 'v', status: 'completed', items: [], error: null } } } });
  assert.equal(state.error, null);
  installSnapshot(state, { snapshot: resumeFixture('t', [{ id: 'failed', status: 'failed', items: [], error: { message: 'Persisted native failure' } }]), cursor: { generation: 1, seq: 4 } });
  assert.equal(state.error, 'Persisted native failure');
});

test('model selector applies future settings and waits for native confirmation; unsupported effort never mutates a turn', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'active', status: 'inProgress', items: [] }])); await opening;
  const pending = f.request('/api/thread/settings', { method: 'POST', cookie, body: { viewId, threadId: 't', model: 'native-model', effort: 'high' } });
  await waitCall(f.peer, 'model/list'); f.peer.replyTo('model/list', { data: models, nextCursor: null });
  await waitCall(f.peer, 'thread/settings/update'); assert.deepEqual(f.peer.sent.at(-1).params, { threadId: 't', model: 'native-model', effort: 'high' });
  f.peer.replyTo('thread/settings/update', {});
  f.peer.notify('thread/settings/updated', { threadId: 't', threadSettings: { model: 'native-model', effort: 'high', cwd: f.dir, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } });
  assert.equal((await pending).json.settings.effort, 'high'); assert.equal(f.peer.sent.some(m => m.method === 'turn/settings/update'), false);
  const bad = f.request('/api/thread/settings', { method: 'POST', cookie, body: { viewId, threadId: 't', model: 'native-model', effort: 'ultra' } });
  await delay(15); f.peer.replyTo('model/list', { data: models, nextCursor: null }); assert.equal((await bad).status, 422);
  assert.equal(f.peer.sent.filter(m => m.method === 'thread/settings/update').length, 1); stream.req.destroy();
});

test('server rejects quota results from an account that changed during its native read', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login();
  const pending = f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'account/rateLimits/read', params: {} } });
  await waitCall(f.peer, 'account/rateLimits/read');
  f.peer.notify('account/updated', { authMode: 'chatgpt', planType: 'plus' });
  f.peer.replyTo('account/rateLimits/read', { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 123 } }, rateLimitsByLimitId: null });
  assert.equal((await pending).status, 409);
});
