import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import * as designSystem from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-queue-')), originalFetch = globalThis.fetch, origin = 'https://queue.example.test', calls = [], queues = [], remotePosts = new Map();
  const app = await testApp(t, { dataDir, env: { ZERNIO_API_KEY: 'synthetic-queue-key' }, appUrl: origin, directScheduler: false }); let hook, sequence = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic-queue-key');
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body, key: options.headers['Idempotency-Key'] });
    if (hook) { const response = await hook(url, options, body); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: 'facebook-queue-account', platform: 'facebook', profileId: 'queue-profile', isActive: true }] });
    if (url.pathname.endsWith('/queue/slots')) {
      if (method === 'GET') { assert.equal(url.searchParams.get('profileId'), 'queue-profile'); assert.equal(url.searchParams.get('all'), 'true'); return Response.json({ queues: structuredClone(queues), count: queues.length }); }
      if (method === 'DELETE') { assert.equal(url.searchParams.get('profileId'), 'queue-profile'); const id = url.searchParams.get('queueId'); assert.ok(id); const index = queues.findIndex(row => row._id === id); assert.ok(index >= 0); const [removed] = queues.splice(index, 1); if (removed.isDefault && queues.length) queues[0].isDefault = true; return Response.json({ success: true, deleted: true }); }
      assert.equal(body.profileId, 'queue-profile');
      let row;
      if (method === 'POST') { row = { _id: 'queue-' + (++sequence), profileId: body.profileId, name: body.name, timezone: body.timezone, slots: body.slots, active: body.active, isDefault: !queues.length }; queues.push(row); }
      else { assert.equal(method, 'PUT'); assert.ok(body.queueId); row = queues.find(row => row._id === body.queueId); assert.ok(row); Object.assign(row, { name: body.name, timezone: body.timezone, slots: body.slots, active: body.active }); if (body.setAsDefault) for (const item of queues) item.isDefault = item === row; }
      return Response.json({ success: true, schedule: structuredClone(row), nextSlots: [], reshuffledCount: body.reshuffleExisting ? 2 : 0, skippedDailyLimit: 0 });
    }
    if (url.pathname.endsWith('/queue/preview')) { assert.equal(url.searchParams.get('profileId'), 'queue-profile'); return Response.json({ profileId: 'queue-profile', queueId: url.searchParams.get('queueId'), count: 2, slots: ['2070-11-01T09:00:00-04:00', '2070-11-08T09:00:00-05:00'] }); }
    if (url.pathname.endsWith('/tools/validate/post')) return Response.json({ valid: true, errors: [], warnings: [] });
    if (url.pathname.endsWith('/posts') && method === 'POST') {
      assert.equal(body.queuedFromProfile, 'queue-profile'); assert.ok(queues.some(row => row._id === body.queueId)); assert.equal(body.scheduledFor, undefined); assert.equal(body.publishNow, undefined);
      const post = { _id: 'queued-post-' + (++sequence), profileId: 'queue-profile', content: body.content, platforms: body.platforms.map(row => ({ ...row, status: 'scheduled' })), status: 'scheduled', scheduledFor: '2070-11-01T09:00:00-04:00', queueId: body.queueId, queuedFromProfile: body.queuedFromProfile }; remotePosts.set(post._id, post); return Response.json({ post });
    }
    const match = /\/posts\/([^/]+)(\/retry|\/edit)?$/.exec(url.pathname);
    if (match) {
      const post = remotePosts.get(match[1]); assert.ok(post);
      if (method === 'PUT') { assert.equal(body.queueId, undefined); assert.equal(body.queuedFromProfile, undefined); Object.assign(post, body, { status: body.isDraft ? 'draft' : 'scheduled', platforms: (body.platforms || post.platforms).map(row => ({ ...row, status: body.isDraft ? 'draft' : 'scheduled' })) }); if (body.isDraft) delete post.scheduledFor; }
      if (method === 'DELETE') { post.status = 'cancelled'; return Response.json({ success: true }); }
      if (match[2] === '/retry') { assert.deepEqual(body, {}); post.status = 'published'; post.platforms = post.platforms.map(row => ({ ...row, status: 'published' })); }
      if (match[2] === '/edit') { assert.equal(body.accountId, 'facebook-queue-account'); post.platforms[0].customContent = body.content; return Response.json({ success: true }); }
      return Response.json({ post: structuredClone(post) });
    }
    assert.fail(`Unexpected synthetic Zernio request ${method} ${url.pathname}`);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`; let cookie;
  async function request(path, method = 'GET', body, key = randomUUID()) { const response = await originalFetch(base + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/auth/setup', 'POST', { name: 'Queue owner', email: 'queue@example.test', password: 'a synthetic queue acceptance passphrase' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const project = '/projects/' + setup.data.projectId;
  await request(project, 'PATCH', { zernioProfileId: 'queue-profile' }); const path = project + '/integrations/queues';
  const list = async () => (await request(path)).data;
  const create = async name => { const current = await list(); return request(path + '/create', 'POST', { name, timezone: 'America/New_York', slots: [{ dayOfWeek: 1, time: '09:00' }], active: true, expectedListVersion: current.version }); };
  return { app, path, project, calls, queues, remotePosts, request, list, create, setHook(value) { hook = value; }, writes: () => calls.filter(row => row.method !== 'GET' && !row.url.pathname.includes('/tools/validate/')), async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('queue lifecycle scopes profile, enforces edit snapshots, manages defaults and previews offset-aware slots', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const first = await f.create('Morning'); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.queue.isDefault, true);
    const second = await f.create('Evening'); assert.equal(second.data.queue.isDefault, false); const row = second.data.queue;
    const changed = await f.request(`${f.path}/${row._id}/update`, 'POST', { name: 'Evening launch', timezone: 'Asia/Dubai', slots: [{ dayOfWeek: 2, time: '18:00' }], active: true, expectedVersion: row.version, setAsDefault: true, reshuffleExisting: false }); assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(changed.data.queue.isDefault, true); assert.equal(changed.data.queues.find(item => item._id === first.data.queue._id).isDefault, false);
    const beforeStale = f.writes().length; assert.equal((await f.request(`${f.path}/${row._id}/delete`, 'POST', { expectedVersion: row.version, confirmDelete: row._id })).status, 409); assert.equal(f.writes().length, beforeStale);
    const preview = await f.request(`${f.path}/${row._id}/preview?count=2`); assert.equal(preview.status, 200); assert.deepEqual(preview.data.slots, ['2070-11-01T09:00:00-04:00', '2070-11-08T09:00:00-05:00']); assert.equal(preview.data.previewOnly, true);
    for (const times of [['2070-11-01T09:00:00Z', '2070-11-01T09:00:00Z'], ['2070-11-02T09:00:00Z', '2070-11-01T09:00:00Z'], ['2000-11-01T09:00:00Z']]) { f.setHook(url => url.pathname.endsWith('/queue/preview') ? Response.json({ profileId: 'queue-profile', count: times.length, slots: times }) : undefined); assert.equal((await f.request(`${f.path}/${row._id}/preview?count=2`)).status, 502); } f.setHook(undefined);
    const beforeInvalid = f.writes().length;
    for (const patch of [{ slots: [{ dayOfWeek: 1, time: '09:00' }, { dayOfWeek: 1, time: '09:00' }] }, { slots: [{ dayOfWeek: 7, time: '25:00' }] }, { timezone: 'Not/A_Timezone' }]) assert.equal((await f.request(`${f.path}/create`, 'POST', { name: 'Invalid schedule', timezone: 'UTC', slots: [{ dayOfWeek: 1, time: '09:00' }], active: true, expectedListVersion: changed.data.version, ...patch })).status, 400);
    const current = changed.data.queue, body = { name: current.name, timezone: current.timezone, slots: current.slots, active: current.active, expectedVersion: current.version, setAsDefault: true, reshuffleExisting: true };
    assert.equal((await f.request(`${f.path}/${row._id}/update`, 'POST', body)).status, 400); assert.equal((await f.request(`${f.path}/foreign/delete`, 'POST', { confirmDelete: 'foreign', expectedVersion: row.version })).status, 403); assert.equal(f.writes().length, beforeInvalid);
    const reshuffled = await f.request(`${f.path}/${row._id}/update`, 'POST', { ...body, confirmReshuffle: true }); assert.equal(reshuffled.data.reshuffledCount, 2);
    const removed = await f.request(`${f.path}/${row._id}/delete`, 'POST', { expectedVersion: reshuffled.data.queue.version, confirmDelete: row._id }); assert.equal(removed.status, 200); assert.equal(removed.data.queues.length, 1); assert.equal(removed.data.queues[0].isDefault, true);
    // The list's Pause button sends this exact status request: the reviewed version and only the wanted `active` value.
    const remaining = removed.data.queues[0], paused = await f.request(`${f.path}/${remaining._id}/status`, 'POST', { active: false, expectedVersion: remaining.version });
    assert.equal(paused.status, 200, JSON.stringify(paused.data)); assert.equal(paused.data.changed, true); assert.equal(paused.data.queue.active, false); assert.equal(paused.data.queue.isDefault, true); assert.equal(paused.data.queues.find(queue => queue._id === remaining._id).active, false);
    const beforeRepeat = f.writes().length, repeated = await f.request(`${f.path}/${remaining._id}/status`, 'POST', { active: false, expectedVersion: paused.data.queue.version });
    assert.equal(repeated.status, 200); assert.equal(repeated.data.changed, false); assert.equal(repeated.data.queue.version, paused.data.queue.version); assert.equal(f.writes().length, beforeRepeat, 'An unchanged status sends nothing to the provider.');
    assert.equal((await f.request(`${f.path}/${remaining._id}/status`, 'POST', { active: true, expectedVersion: remaining.version })).data.error.code, 'QUEUE_CHANGED');
    await f.app.sql.run("UPDATE memberships SET role='editor'"); const beforeEditor = f.calls.length; assert.equal((await f.request(`${f.path}/create`, 'POST', {})).status, 403); assert.equal(f.calls.length, beforeEditor); assert.equal((await f.request(f.path)).status, 200);
  } finally { await f.close(); }
});

test('queue creation protects ambiguous writes and accepted responses followed by failed confirmation', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const list = await f.list(), body = { name: 'Unknown creation', timezone: 'UTC', slots: [{ dayOfWeek: 0, time: '10:00' }], active: true, expectedListVersion: list.version }, key = randomUUID();
    f.setHook((url, options) => url.pathname.endsWith('/queue/slots') && options.method === 'POST' ? Response.json({ success: true, schedule: { _id: 'ambiguous', profileId: 'foreign-profile' } }) : undefined);
    const uncertain = await f.request(`${f.path}/create`, 'POST', body, key); assert.equal(uncertain.data.operation.status, 'uncertain'); const count = f.writes().length; assert.equal(count, 1, 'The ambiguous queue creation reached the provider exactly once.');
    assert.equal((await f.request(`${f.path}/create`, 'POST', body, key)).status, 409); const nextBody = { ...body, name: 'Another creation' }, blockedKey = randomUUID(), blocked = await f.request(`${f.path}/create`, 'POST', nextBody, blockedKey); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, uncertain.data.operation.id); assert.equal(f.writes().length, count);
    const operationId = uncertain.data.operation.id; await f.request(`${f.project}/operations/${operationId}/review`, 'POST', { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic provider did not persist this invalid receipt.', reference: 'queue-fixture-check' });
    f.setHook(undefined); const closed = await f.request(`${f.path}/create`, 'POST', nextBody, blockedKey); assert.equal(closed.data.error.code, 'OPERATION_NOT_SENT'); assert.deepEqual(closed.data.operation, blocked.data.operation); assert.equal(f.writes().length, count); const good = await f.request(`${f.path}/create`, 'POST', nextBody); assert.equal(good.status, 200, JSON.stringify(good.data));
    const before = f.writes().length, current = good.data.queue; let sent = false;
    f.setHook((url, options) => { if (!url.pathname.endsWith('/queue/slots')) return; if (options.method === 'PUT') { sent = true; return Response.json({ success: true, schedule: { ...f.queues[0], name: 'Changed' } }); } if (sent && options.method === 'GET') throw new Error('Synthetic read-back unavailable'); });
    const changed = await f.request(`${f.path}/${current._id}/update`, 'POST', { name: 'Changed', timezone: current.timezone, slots: current.slots, active: true, expectedVersion: current.version, setAsDefault: false, reshuffleExisting: false }); assert.equal(changed.data.operation.status, 'uncertain'); assert.equal(f.writes().length, before + 1);
  } finally { await f.close(); }
});

test('approved local posts enqueue through the shared publisher with a locked provider queue intent', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Approved launch')).data.queue;
    assert.equal((await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: true })).status, 200);
    const created = await f.request(`${f.project}/posts`, 'POST', { content: 'Approved queued campaign', platforms: ['facebook'], accounts: ['facebook-queue-account'], queueId: queue._id, queueVersion: queue.version, scheduledAt: '', status: 'draft' }); assert.equal(created.status, 201, JSON.stringify(created.data)); const post = created.data.record;
    const publish = key => f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id }, key);
    const before = f.writes().length; assert.equal((await publish(randomUUID())).status, 403); assert.equal(f.writes().length, before);
    const approval = await f.request(`${f.project}/approvals/posts/${post.id}/request`, 'POST', {}); assert.equal(approval.status, 200, JSON.stringify(approval.data)); assert.equal(approval.data.item.review.snapshot.queueId, queue._id);
    assert.equal((await f.request(`${f.project}/approvals/posts/${post.id}/review`, 'POST', { reviewId: approval.data.item.review.id, decision: 'approved', note: 'Reviewed exact queue and saved post.' })).status, 200);
    const summary = (await f.request(`${f.project}/approvals/posts`)).data.posts.find(row => row.post.id === post.id).queue; assert.equal(summary.ready, true); assert.equal(summary.name, queue.name); assert.equal(summary.timezone, 'America/New_York'); assert.deepEqual(summary.slots, queue.slots);
    const key = randomUUID(), accepted = await publish(key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.post.status, 'scheduled'); assert.equal(accepted.data.post.queueId, ''); assert.equal(accepted.data.post.queueVersion, ''); assert.equal(accepted.data.provider.queueId, queue._id); assert.equal(accepted.data.post.scheduledAt, '2070-11-01T09:00:00-04:00');
    const providerPost = f.writes().find(row => row.url.pathname.endsWith('/posts')); assert.equal(providerPost.body.queuedFromProfile, 'queue-profile'); assert.equal(providerPost.body.queueId, queue._id); assert.equal(providerPost.body.scheduledFor, undefined); assert.equal(providerPost.body.publishNow, undefined); assert.equal(providerPost.body.timezone, 'America/New_York');
    const sent = f.writes().length; assert.equal((await publish(key)).status, 200); assert.equal((await f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id, queueId: queue._id }, key)).status, 200); assert.equal(f.writes().length, sent); assert.equal(f.calls.some(row => row.url.pathname.endsWith('/queue/next-slot')), false);
    const bad = await f.request(`${f.project}/posts`, 'POST', { content: 'Conflicting timing', platforms: ['facebook'], queueId: queue._id, queueVersion: queue.version, scheduledAt: '2070-01-01T09:00:00Z' }); assert.equal(bad.status, 400);
    for (const malformed of [{ queueId: false }, { queueId: queue._id, queueVersion: 'fake' }, { queueVersion: queue.version }]) assert.equal((await f.request(`${f.project}/posts`, 'POST', { content: 'Bad intent', platforms: ['facebook'], ...malformed })).status, 400);
  } finally { await f.close(); }
});

test('required approval and explicit recipients are rechecked after the final queue read', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Policy race')).data.queue;
    for (const action of ['request', 'review', 'publish']) {
      f.setHook(undefined);
      await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: false });
      const post = (await f.request(`${f.project}/posts`, 'POST', { content: `Implicit queued ${action}`, platforms: ['facebook'], queueId: queue._id, queueVersion: queue.version, status: 'draft' })).data.record;
      const pending = action === 'review' ? await f.request(`${f.project}/approvals/posts/${post.id}/request`, 'POST', {}) : null;
      const before = f.writes().length; let queueReads = 0, changed = false;
      f.setHook(async (url, options) => {
        if (url.pathname.endsWith('/queue/slots') && (!options.method || options.method === 'GET') && ++queueReads === (action === 'publish' ? 2 : 1)) {
          changed = true;
          assert.equal((await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: true })).status, 200);
        }
      });
      const path = action === 'publish' ? '/integrations/social/publish' : `/approvals/posts/${post.id}/${action}`;
      const body = action === 'publish' ? { postId: post.id } : action === 'review' ? { reviewId: pending.data.item.review.id, decision: 'approved' } : {};
      const result = await f.request(f.project + path, 'POST', body);
      assert.equal(changed, true, 'The policy changes during the final provider queue read.');
      assert.equal(result.status, 409, JSON.stringify(result.data));
      assert.equal(result.data.error.code, 'APPROVAL_ACCOUNTS_REQUIRED');
      assert.equal(f.writes().length, before, 'No provider post is created after approval becomes required.');
      const review = await f.app.sql.get('SELECT status FROM post_approval_reviews WHERE post_id=? ORDER BY seq DESC LIMIT 1', post.id);
      assert.equal(review?.status, action === 'review' ? 'pending' : undefined, 'The race cannot create or approve a review.');
    }
  } finally { await f.close(); }
});

test('queue edits stale approvals and a queue change during provider validation blocks post dispatch', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Race queue')).data.queue;
    const created = await f.request(`${f.project}/posts`, 'POST', { content: 'Queue changed during validation', platforms: ['facebook'], accounts: ['facebook-queue-account'], queueId: queue._id, queueVersion: queue.version, status: 'draft' }); const post = created.data.record;
    f.setHook(url => { if (url.pathname.endsWith('/tools/validate/post')) { f.queues[0].slots[0].time = '11:00'; return Response.json({ valid: true, errors: [], warnings: [] }); } });
    const before = f.writes().length, refused = await f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id }); assert.equal(refused.status, 409, JSON.stringify(refused.data)); assert.equal(refused.data.error.code, 'QUEUE_CHANGED'); assert.equal(f.writes().length, before);
    f.setHook(undefined); f.queues[0].slots[0].time = '09:00';
    await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: true }); const review = await f.request(`${f.project}/approvals/posts/${post.id}/request`, 'POST', {}); assert.equal(review.status, 200);
    f.queues[0].slots[0].time = '11:00'; const blocked = (await f.request(`${f.project}/approvals/posts`)).data.posts.find(row => row.post.id === post.id); assert.equal(blocked.queue.ready, false); assert.match(blocked.queue.message, /changed/); assert.equal((await f.request(`${f.project}/approvals/posts/${post.id}/review`, 'POST', { reviewId: review.data.item.review.id, decision: 'approved' })).status, 409);
    assert.equal((await f.request(`${f.project}/approvals/posts/${post.id}/request`, 'POST', {})).status, 409);
    f.queues[0].slots[0].time = '09:00'; assert.equal((await f.request(`${f.project}/approvals/posts/${post.id}/review`, 'POST', { reviewId: review.data.item.review.id, decision: 'approved' })).status, 200); f.queues[0].slots[0].time = '11:00';
    const current = (await f.list()).queues[0]; await f.request(`${f.project}/posts/${post.id}`, 'PATCH', { queueVersion: current.version });
    const status = (await f.request(`${f.project}/approvals/posts`)).data.posts.find(row => row.post.id === post.id); assert.equal(status.status, 'stale'); assert.equal((await f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id })).status, 409);
  } finally { await f.close(); }
});

test('a lost queued-post acknowledgement blocks a sibling publish control from sending the same saved post twice', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Acknowledgement safety')).data.queue;
    const post = (await f.request(`${f.project}/posts`, 'POST', { content: 'Only one queued send', platforms: ['facebook'], accounts: ['facebook-queue-account'], queueId: queue._id, queueVersion: queue.version, status: 'draft' })).data.record;
    f.setHook((url, options) => { if (url.pathname.endsWith('/posts') && options.method === 'POST') throw new Error('Synthetic accepted post acknowledgement lost'); });
    const fromQueuePage = await f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id, queueId: queue._id }); assert.equal(fromQueuePage.data.operation.status, 'uncertain'); const count = f.writes().length;
    const fromPublishingPage = await f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id }); assert.equal(fromPublishingPage.status, 409); assert.equal(f.writes().length, count, 'Optional queue confirmation fields cannot bypass the shared saved-post operation identity.');
  } finally { await f.close(); }
});

test('assigned queue posts refresh, reschedule, cancel, retry failures and edit live text without retaining enqueue intent', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Lifecycle queue')).data.queue;
    async function enqueue(content) { const post = (await f.request(`${f.project}/posts`, 'POST', { content, platforms: ['facebook'], accounts: ['facebook-queue-account'], queueId: queue._id, queueVersion: queue.version, status: 'draft' })).data.record; const accepted = await f.request(`${f.project}/integrations/social/publish`, 'POST', { postId: post.id }); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); return accepted.data.post; }
    const post = await enqueue('Queue lifecycle'); f.queues[0].active = false; const queueReads = () => f.calls.filter(call => call.url.pathname.endsWith('/queue/slots')).length, reads = queueReads();
    let result = await f.request(`${f.project}/integrations/social/status?postId=${post.id}`); assert.equal(result.status, 200); assert.equal(result.data.post.queueId, '');
    result = await f.request(`${f.project}/integrations/social/update`, 'POST', { postId: post.id, content: 'Reviewed new timing', mode: 'scheduled', scheduledAt: '2071-01-01T09:00:00Z' }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.post.scheduledAt, '2071-01-01T09:00:00.000Z'); assert.equal(result.data.post.queueVersion, '');
    result = await f.request(`${f.project}/integrations/social/update`, 'POST', { postId: post.id, mode: 'draft' }); assert.equal(result.status, 200); assert.equal(result.data.post.scheduledAt, '');
    result = await f.request(`${f.project}/integrations/social/cancel`, 'POST', { postId: post.id, confirmCancellation: true }); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'cancelled'); assert.equal(queueReads(), reads, 'Actions on an existing provider post do not reapply its consumed queue intent.');
    f.queues[0].active = true; const failed = await enqueue('Queued failed copy'); const remote = f.remotePosts.get(failed.externalId); remote.status = 'failed'; remote.platforms[0].status = 'failed';
    result = await f.request(`${f.project}/integrations/social/status?postId=${failed.id}`); assert.equal(result.data.post.status, 'failed');
    await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: true }); const review = await f.request(`${f.project}/approvals/posts/${failed.id}/request`, 'POST', {}); assert.equal(review.status, 200); assert.equal(review.data.item.review.snapshot.queueId, undefined); assert.equal((await f.request(`${f.project}/approvals/posts/${failed.id}/review`, 'POST', { reviewId: review.data.item.review.id, decision: 'approved' })).status, 200);
    result = await f.request(`${f.project}/integrations/social/retry`, 'POST', { postId: failed.id, confirmPublish: true }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.post.status, 'published'); assert.equal(result.data.post.queueId, '');
    // With approval required, the published-text edit needs its own approved review.
    const edit = await f.request(`${f.project}/approvals/posts/${failed.id}/request`, 'POST', { action: 'social/edit-published', proposal: { accountId: 'facebook-queue-account', content: 'Live correction' } }); assert.equal(edit.status, 200, JSON.stringify(edit.data)); assert.equal((await f.request(`${f.project}/approvals/posts/${failed.id}/review`, 'POST', { reviewId: edit.data.item.review.id, decision: 'approved' })).status, 200);
    result = await f.request(`${f.project}/integrations/social/edit-published`, 'POST', { postId: failed.id, accountId: 'facebook-queue-account', content: 'Live correction', confirmEdit: true }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.post.providerResults[0].customContent, 'Live correction');
    assert.equal(f.writes().filter(call => call.method === 'POST' && call.url.pathname.endsWith('/posts')).length, 2, 'All sibling actions use the existing provider post, never create another queued post.');
  } finally { await f.close(); }
});

test('queue approval cards show verified weekly timing and block stale approval without hiding ordinary drafts on provider failure', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Visible launch queue')).data.queue;
    const queued = (await f.request(`${f.project}/posts`, 'POST', { content: 'Queue review', platforms: ['facebook'], queueId: queue._id, queueVersion: queue.version })).data.record;
    const ordinary = (await f.request(`${f.project}/posts`, 'POST', { content: 'Ordinary draft', platforms: ['facebook'] })).data.record;
    const requested = await f.request(`${f.project}/approvals/posts/${queued.id}/request`, 'POST', {}); assert.equal(requested.status, 200); const item = requested.data.item;
    const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <', source.indexOf('export default function')), end = source.lastIndexOf('\n}');
    const { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'QueueApprovalView.tsx', { jsx: { runtime: 'classic' } });
    const ui = Object.fromEntries(Object.entries(designSystem).filter(([name]) => /^[A-Z]/.test(name)));
    const render = entry => { const context = { React, ...ui, lines: value => String(value), options: () => [], data: { requireApproval: true, posts: [entry] }, posts: [entry], role: 'owner', busy: '', error: '', notice: '', filter: 'all', notes: {}, canReview: true, canRequest: true, days: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], when: value => value, label: value => value, link: () => '', PostVariantPreview: () => null, PLATFORM_RULES: {}, action() {}, setFilter() {}, setNotes() {}, review() {}, path: '', load() {}, focusId: '', setFocusId() {}, onCardKey() {}, actionable: [], chosen: [], blockedChosen: 0, selected: [], setSelected() {}, bulk: null, bulkResult: null, setBulkResult() {}, bulkReview() {}, postName: item => item.post.id, statusValues: ['all', 'pending', 'stale', 'approved', 'rejected', 'not_requested'], counts: {}, platformChoices: [], platform: '', setPlatform() {}, sort: 'requested', setSort() {}, restrictions: {}, restrictionTargets: () => [], approveBlocked: new Function('return ' + stripTypeScriptTypes(source.match(/^const approveBlocked = (.+);$/m)[1]))(), PublishedEditComparison: () => null, ProposedUpdateComparison: () => null, AdSpendReviews: () => null, AdSpendPolicySwitch: () => null, request() {}, onChanged() {} }; return renderToStaticMarkup(new Function(...Object.keys(context), code + ';return render();')(...Object.values(context))); };
    let markup = render(item); assert.match(markup, /Visible launch queue/); assert.match(markup, /America\/New_York/); assert.match(markup, /Monday 09:00/); assert.match(markup, /next free slot assigned on submission/); assert.doesNotMatch(markup, /No planned publishing time/); assert.doesNotMatch(markup, /disabled=""[^>]*>Approve post/);
    f.setHook(url => { if (url.pathname.endsWith('/queue/slots')) throw new Error('Synthetic queue service unavailable'); });
    const list = await f.request(`${f.project}/approvals/posts`); assert.equal(list.status, 200); const unavailable = list.data.posts.find(row => row.post.id === queued.id); assert.equal(unavailable.queue.ready, false); assert.equal(list.data.posts.find(row => row.post.id === ordinary.id).queue, null);
    markup = render(unavailable); assert.match(markup, /disabled=""[^>]*>Approve post/); assert.match(markup, /could not be verified/); assert.equal((await f.request(`${f.project}/approvals/posts/${queued.id}/review`, 'POST', { reviewId: item.review.id, decision: 'approved' })).status, 502);
  } finally { await f.close(); }
});

test('the queue UI retains 5xx and pending action keys and rejects stale view receipts', async () => {
  const source = await readFile(new URL('../src/ZernioQueues.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), end = source.indexOf('  async function save(', start), code = stripTypeScriptTypes(source.slice(start, end));
  const keys = { current: new Map() }, calls = []; let live = true, failure = Object.assign(new Error('Gateway unavailable'), { status: 502 });
  const write = new Function('current', 'keys', 'crypto', 'requester', 'setEnqueueReviews', `return (${code});`)(() => live, keys, globalThis.crypto, { current: async (...args) => { calls.push(args); if (failure) throw failure; return { operation: { status: 'complete' }, queue: { _id: 'one', version: 'v1' } }; } }, () => {});
  const body = { name: 'Queue' }; await assert.rejects(write('/queues/create', body, 'queue'), /Gateway/); failure = Object.assign(new Error('Pending'), { status: 409, code: 'OPERATION_PENDING' }); await assert.rejects(write('/queues/create', body, 'queue'), /Pending/); failure = null; await write('/queues/create', body, 'queue'); assert.equal(calls[0][3], calls[2][3]); assert.equal(keys.current.size, 0);
  const nextBody = { name: 'Another queue' }; failure = Object.assign(new Error('Previous outcome unresolved'), { status: 409, code: 'QUEUE_PREVIOUS_OUTCOME_UNRESOLVED', operation: { status: 'failed' } }); await assert.rejects(write('/queues/create', nextBody, 'queue'), /Previous/); assert.equal(keys.current.size, 0); failure = null; await write('/queues/create', nextBody, 'queue'); assert.notEqual(calls[3][3], calls[4][3], 'The blocked new request must get a fresh key after operator reconciliation.');
  live = false; await assert.rejects(write('/queues/create', body, 'queue'), /project|role/); assert.equal(calls.length, 5);
});

test('queue enqueue requires inline review of the exact saved post and queue snapshot', async () => {
  const source = await readFile(new URL('../src/ZernioQueues.tsx', import.meta.url), 'utf8'), keyStart = source.indexOf('function enqueueReviewKey('), enqueueStart = source.indexOf('async function enqueue('), enqueueEnd = source.indexOf('  const localPosts =', enqueueStart);
  const projectPath = '/projects/one', approvalRequired = true;
  const enqueueReviewKey = new Function('projectPath', 'approvalRequired', `return (${stripTypeScriptTypes(source.slice(keyStart, enqueueStart))});`)(projectPath, approvalRequired);
  let item = { post: { id: 'post-one', content: 'Reviewed caption', accounts: ['facebook-one'], queueId: 'queue-one', queueVersion: 'v1' }, status: 'approved', assets: [] }, queue = { _id: 'queue-one', name: 'Weekly launch', active: true, version: 'v1', slots: [{ dayOfWeek: 1, time: '09:00' }] }, enqueueReviews = {}, calls = 0;
  const start = source.indexOf('    <Stack as="section" gap={3}><Heading level={3} size="sm">Saved posts ready for queues'), end = source.indexOf('\n    {confirmDialog}', start);
  const { code } = await transformWithOxc(`const render = () => (${source.slice(start, end).trim()});`, 'QueueEnqueueReview.tsx', { jsx: { runtime: 'classic' } });
  const review = value => { enqueueReviews = typeof value === 'function' ? value(enqueueReviews) : value; };
  function render(loaded = true, localPosts = [item]) { const context = { React, ...designSystem, loaded, localPosts, queues: [queue], approvalRequired, enqueueReviewKey, enqueueReviews, setEnqueueReviews: review, canWrite: true, busy: false, onOpenApprovals: null, onEditPost: null, enqueue() {} }; return new Function(...Object.keys(context), code + ';return render();')(...Object.values(context)); }
  const all = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(all)];
  const submit = async () => {
    const context = { canWrite: true, queues: [queue], approvalRequired, enqueueReviews, enqueueReviewKey, projectPath, action: async run => run(), write: async () => { calls++; return { post: { scheduledAt: '2070-01-01T09:00:00Z' } }; }, current: () => true, setPosts() {}, setNotice() {}, setError() {}, onChanged: null, load: async () => {} };
    return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(enqueueStart, enqueueEnd))});`)(...Object.values(context))(item);
  };
  assert.doesNotMatch(renderToStaticMarkup(render(false, [])), /No unsent local posts/); assert.match(renderToStaticMarkup(render(true, [])), /No unsent local posts/);
  let markup = renderToStaticMarkup(render()); assert.match(markup, /reserves its next free slot and publishes the post/); assert.match(markup, /aria-disabled="true"[^>]*>Add saved post to queue/); await submit(); assert.equal(calls, 0);
  all(render()).find(node => node.type === designSystem.Checkbox).props.onChange({ target: { checked: true } });
  markup = renderToStaticMarkup(render()); assert.match(markup, /checked=""/); assert.doesNotMatch(markup, /aria-disabled="true"[^>]*>Add saved post to queue/); await submit(); assert.equal(calls, 1);
  for (const changed of [{ ...item, post: { ...item.post, content: 'Changed after review' } }, { ...item, assets: [{ id: 'asset-one', approval: 'pending' }] }]) { const original = item; item = changed; markup = renderToStaticMarkup(render()); assert.doesNotMatch(markup, /checked=""/); assert.match(markup, /aria-disabled="true"[^>]*>Add saved post to queue/); await submit(); assert.equal(calls, 1); item = original; }
  queue = { ...queue, version: 'v2' }; item = { ...item, post: { ...item.post, queueVersion: 'v2' } }; markup = renderToStaticMarkup(render()); assert.doesNotMatch(markup, /checked=""/); await submit(); assert.equal(calls, 1, 'Confirmation must not follow a newly reviewed queue version.');
  assert.doesNotMatch(source.slice(enqueueStart, enqueueEnd), /window\.confirm/);
});

test('pausing and activating a queue sends one receipted update with only its active state changed', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Pausable')).data.queue, toggle = (row, body, key) => f.request(`${f.path}/${encodeURIComponent(row._id)}/status`, 'POST', body, key);
    let before = f.writes().length, key = randomUUID();
    const paused = await toggle(queue, { active: false, expectedVersion: queue.version }, key);
    assert.equal(paused.status, 200, JSON.stringify(paused.data)); assert.equal(paused.data.operation.status, 'complete'); assert.equal(paused.data.changed, true);
    assert.deepEqual({ ...paused.data.queue, version: undefined }, { ...queue, active: false, version: undefined }); assert.equal(paused.data.queues[0].active, false);
    assert.equal(f.writes().length, before + 1, 'One toggle sends exactly one provider request.');
    assert.deepEqual(f.writes().at(-1).body, { profileId: 'queue-profile', queueId: queue._id, setAsDefault: true, reshuffleExisting: false, name: queue.name, timezone: queue.timezone, slots: queue.slots, active: false });
    assert.equal(f.writes().at(-1).key, key);
    assert.deepEqual((await toggle(queue, { active: false, expectedVersion: queue.version }, key)).data, paused.data); assert.equal(f.writes().length, before + 1, 'A retried idempotency key sends nothing.');
    const stale = await toggle(queue, { active: false, expectedVersion: queue.version }); assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'QUEUE_CHANGED'); assert.equal(f.writes().length, before + 1);
    const activated = await toggle(paused.data.queue, { active: true, expectedVersion: paused.data.queue.version }); assert.equal(activated.status, 200, JSON.stringify(activated.data)); assert.equal(activated.data.queue.active, true); assert.equal(f.writes().length, before + 2);
    const same = await toggle(activated.data.queue, { active: true, expectedVersion: activated.data.queue.version }); assert.equal(same.status, 200); assert.equal(same.data.changed, false); assert.equal(f.writes().length, before + 2, 'An unchanged state sends nothing.');
    before = f.writes().length;
    for (const body of [{ active: 'no', expectedVersion: queue.version }, { active: false, expectedVersion: queue.version, name: 'Renamed' }, { active: false }]) assert.equal((await toggle(activated.data.queue, body)).status, 400);
    assert.equal((await f.request(`${f.path}/${queue._id}/status`)).status, 405);
    const list = await f.list(), empty = await f.request(`${f.path}/create`, 'POST', { name: 'Empty', timezone: 'UTC', slots: [], active: false, expectedListVersion: list.version }); assert.equal(empty.status, 200, JSON.stringify(empty.data));
    const noSlots = await toggle(empty.data.queue, { active: true, expectedVersion: empty.data.queue.version }); assert.equal(noSlots.status, 400); assert.equal(noSlots.data.error.code, 'QUEUE_SLOTS_REQUIRED');
    assert.equal(f.writes().length, before + 1, 'Invalid toggles send nothing (only the empty queue creation was sent).');
    await f.app.sql.run("UPDATE memberships SET role='editor'"); const calls = f.calls.length;
    assert.equal((await toggle(queue, { active: false, expectedVersion: activated.data.queue.version })).status, 403); assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});

test('parallel queue toggles send one provider request and an unconfirmed toggle stays uncertain', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const queue = (await f.create('Contended')).data.queue, toggle = (row, body, key) => f.request(`${f.path}/${row._id}/status`, 'POST', body, key), before = f.writes().length;
    // The first toggle is held at its provider request; the second, under a new key, arrives while the queue still reads active.
    let reached, release, holding = true; const held = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.setHook(async (url, options) => { if (holding && url.pathname.endsWith('/queue/slots') && options.method === 'PUT') { holding = false; reached(); await gate; } });
    const leading = toggle(queue, { active: false, expectedVersion: queue.version }); await held;
    const second = await toggle(queue, { active: false, expectedVersion: queue.version }); release(); const first = await leading; f.setHook(undefined);
    assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(second.status, 409); assert.equal(second.data.error.code, 'OPERATION_NOT_SENT', JSON.stringify(second.data));
    assert.equal(f.writes().length, before + 1, 'Parallel toggles of one queue reach the provider once.');
    const paused = first.data.queue;
    f.setHook((url, options) => url.pathname.endsWith('/queue/slots') && options.method === 'PUT' ? Response.json({ success: true, schedule: { ...structuredClone(f.queues[0]), active: false } }) : undefined);
    const uncertain = await toggle(paused, { active: true, expectedVersion: paused.version }); assert.equal(uncertain.status, 409); assert.equal(uncertain.data.operation.status, 'uncertain');
    f.setHook(undefined); const blocked = await toggle(paused, { active: true, expectedVersion: paused.version }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT');
    assert.equal(f.writes().length, before + 2, 'The unconfirmed toggle was sent once and blocks further queue changes until reviewed.');
  } finally { await f.close(); }
});
