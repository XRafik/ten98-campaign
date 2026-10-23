import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const config = () => ({ enabled: true, gap: 2, gapFreq: 'week', startDate: '2070-01-01T09:00:00.000Z', expireCount: 5, expireDate: null, contentVariations: ['First campaign caption', 'Second campaign caption'] });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-recycling-')), originalFetch = globalThis.fetch, origin = 'https://recycling.example.test', calls = [], accounts = ['facebook', 'twitter', 'youtube', 'tiktok'].map(platform => ({ _id: `${platform}-recycle`, platform, profileId: 'recycle-profile', isActive: true })), remotePosts = new Map(); let hook;
  const app = await testApp(t, { dataDir, appUrl: origin, env: { ZERNIO_API_KEY: 'synthetic-recycling-key' }, directScheduler: false });
  const remote = { _id: 'provider-seed', profileId: 'recycle-profile', content: 'Original campaign caption', status: 'published', publishedAt: '2026-10-01T09:00:00Z', mediaItems: [], platforms: [{ platform: 'facebook', accountId: 'facebook-recycle', status: 'published', customContent: 'Separate Facebook caption', platformSpecificData: { firstComment: 'A reviewed first comment' } }, { platform: 'twitter', accountId: 'twitter-recycle', status: 'published' }] }; remotePosts.set(remote._id, remote);
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.headers.Authorization, 'Bearer synthetic-recycling-key'); const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body });
    if (hook) { const response = await hook(url, method, body); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts });
    if (url.pathname.endsWith('/tools/validate/post')) return Response.json({ valid: true, errors: [], warnings: [] });
    if (url.pathname.endsWith('/posts')) {
      assert.equal(method, 'GET'); assert.equal(url.searchParams.get('profileId'), 'recycle-profile'); assert.equal(url.searchParams.get('includeHidden'), 'true');
      const all = [...remotePosts.values()].filter(row => !url.searchParams.get('accountId') || row.platforms.some(copy => copy.accountId === url.searchParams.get('accountId'))), page = Number(url.searchParams.get('page')), limit = Number(url.searchParams.get('limit'));
      return Response.json({ posts: all.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: all.length, pages: Math.ceil(all.length / limit) } });
    }
    if (url.pathname.endsWith('/posts/provider-seed/edit')) { remote.platforms.find(row => row.accountId === body.accountId).customContent = body.content; return Response.json({ success: true }); }
    const match = /\/posts\/([^/]+)$/.exec(url.pathname); if (match) {
      const post = remotePosts.get(match[1]); assert.ok(post);
      if (method === 'PUT') {
        if (body.recycling) { assert.deepEqual(Object.keys(body), ['recycling']); post.recycling = { ...post.recycling, ...body.recycling, recycleCount: post.recycling?.recycleCount || 0, contentVariationIndex: 0, ...(body.recycling.enabled ? { nextRecycleAt: body.recycling.startDate } : { nextRecycleAt: null }) }; }
        else Object.assign(post, body, { status: body.isDraft ? 'draft' : 'scheduled' });
      }
      return Response.json({ post: structuredClone(post) });
    }
    assert.fail('Unexpected synthetic provider request: ' + method + ' ' + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`; let cookie;
  async function request(path, method = 'GET', body, key = randomUUID()) { const response = await originalFetch(base + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/auth/setup', 'POST', { name: 'Recycling owner', email: 'recycling@example.test', password: 'synthetic recycling fixture passphrase' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const projectId = setup.data.projectId, project = `/projects/${projectId}`; await request(project, 'PATCH', { zernioProfileId: 'recycle-profile' });
  const local = await app.store.create(projectId, 'posts', { content: remote.content, platforms: ['facebook', 'twitter'], accounts: ['facebook-recycle', 'twitter-recycle'], status: 'published', externalId: remote._id, zernioProfileId: 'recycle-profile', mediaItems: [], providerResults: remote.platforms }), path = `${project}/integrations/recycling/posts/${local.id}`;
  const detail = async () => (await request(path)).data;
  const review = async (configuration = config()) => request(path + '/review', 'POST', { configuration, expectedFingerprint: (await detail()).fingerprint, confirmReview: true });
  return { app, calls, remote, remotePosts, accounts, local, path, project, projectId, request, detail, review, setHook(value) { hook = value; }, writes: () => calls.filter(row => row.method === 'PUT'), async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('reviewed recurring publication updates only recycling, verifies all account content, reads copies and stops without deleting them', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.request(`${f.project}/integrations/recycling`)).data.posts.length, 1); const before = await f.detail(); assert.equal(before.canEnable, true); assert.equal(before.recycling.recycleCount, null); assert.equal(before.copies[0].content, 'Separate Facebook caption'); assert.equal(before.copies[0].options.firstComment, 'A reviewed first comment');
    const reviewed = await f.review(); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data)); assert.equal(f.writes().length, 0, 'Review must never enable an upstream cycle.');
    const validation = f.calls.filter(row => row.url.pathname.endsWith('/tools/validate/post')); assert.equal(validation.length, 2); assert.deepEqual(validation.map(row => row.body.content), config().contentVariations); assert.ok(validation.every(row => row.body.platforms[0].customContent === 'Separate Facebook caption'));
    const key = randomUUID(), applied = await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }, key); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.post.recycling.enabled, true); assert.equal(applied.data.post.recycling.recycleCount, 0); assert.deepEqual(f.writes()[0].body, { recycling: config() }); assert.equal(f.remote.content, 'Original campaign caption');
    assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }, key)).status, 200); assert.equal(f.writes().length, 1);
    const copy = { ...structuredClone(f.remote), _id: 'created-copy', status: 'scheduled', platforms: [structuredClone(f.remote.platforms[1])], scheduledFor: '2070-01-15T09:00:00Z', recycledFromPostId: f.remote._id, recycling: { enabled: false } }; f.remotePosts.set(copy._id, copy);
    const copies = await f.request(f.path + '/copies'); assert.equal(copies.status, 200); assert.equal(copies.data.complete, true); assert.equal(copies.data.copies[0].id, copy._id);
    const stopped = await f.request(f.path + '/stop', 'POST', { expectedFingerprint: (await f.detail()).fingerprint, confirmStop: true }); assert.equal(stopped.status, 200, JSON.stringify(stopped.data)); assert.equal(stopped.data.post.recycling.enabled, false); assert.equal(f.remotePosts.get(copy._id).status, 'scheduled'); assert.deepEqual(f.writes()[1].body, { recycling: { enabled: false } });
    const sameCaption = await f.review({ ...config(), contentVariations: [] }); assert.equal(sameCaption.status, 200); assert.equal(f.calls.filter(row => row.url.pathname.endsWith('/tools/validate/post')).at(-1).body.content, 'Original campaign caption', 'No variations reuses the existing base caption, preserving separate account captions.');
    f.accounts.push({ _id: 'facebook-second', platform: 'facebook', profileId: 'recycle-profile', isActive: true }); f.remote.platforms.push({ platform: 'facebook', accountId: 'facebook-second', status: 'published' }); const names = (await f.detail()).copies.filter(row => row.platform === 'facebook').map(row => row.accountName); assert.equal(new Set(names).size, 2, 'Unpopulated IDs still identify distinct destinations on the same platform.');
  } finally { await f.close(); }
});

test('recycling rejects unsupported platforms, generated seeds, invalid dates/variations, changed options and stale asset approvals', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const patch of [{ gap: 0 }, { gapFreq: 'day' }, { startDate: '2070-02-31T09:00:00Z' }, { startDate: '2070-01-01 09:00' }, { expireDate: '2069-01-01T09:00:00Z' }, { expireCount: 0 }, { contentVariations: ['Only one'] }, { contentVariations: ['x'.repeat(25001), 'Second'] }]) assert.ok([400, 422].includes((await f.review({ ...config(), ...patch })).status), 'Reject malformed interval, time or variation settings.');
    for (const platform of ['youtube', 'tiktok']) { const original = f.remote.platforms; f.remote.platforms = [{ platform, accountId: `${platform}-recycle`, status: 'published' }]; assert.equal((await f.review()).status, 422); f.remote.platforms = original; }
    f.remote.recycledFromPostId = 'original-parent'; assert.equal((await f.detail()).canEnable, false); assert.equal((await f.review()).status, 422); delete f.remote.recycledFromPostId;
    const first = await f.review(); f.remote.platforms[0].platformSpecificData.firstComment = 'Changed after review'; const stale = await f.request(f.path + '/apply', 'POST', { reviewId: first.data.review.id }); assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'RECYCLING_REVIEW_CHANGED'); assert.equal(f.writes().length, 0);
    const asset = await f.app.store.create(f.projectId, 'assets', { name: 'Approved creative', kind: 'image', approval: 'approved', deliveryUrl: 'https://cdn.example.test/image.jpg', modifiedTime: '2026-10-18T10:00:00Z' }); await f.app.store.update(f.projectId, 'posts', f.local.id, { assetId: asset.id });
    await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: true }); const approved = await f.review(); assert.equal(approved.status, 200, JSON.stringify(approved.data)); await f.app.store.update(f.projectId, 'assets', asset.id, { approval: 'pending' });
    assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: approved.data.review.id })).status, 409); assert.equal((await f.review()).data.error.code, 'RECYCLING_ASSET_APPROVAL_REQUIRED'); assert.equal(f.writes().length, 0);
    await f.app.sql.run("UPDATE memberships SET role='editor'"); assert.equal((await f.review()).status, 403); assert.equal((await f.request(f.path + '/stop', 'POST', { expectedFingerprint: (await f.detail()).fingerprint, confirmStop: true })).status, 403);
  } finally { await f.close(); }
});

test('recurring review includes account-specific assets and blocks independent account times', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const asset = await f.app.store.create(f.projectId, 'assets', { name: 'Account creative', kind: 'image', approval: 'pending', deliveryUrl: 'https://cdn.example.test/account.jpg' });
    await f.app.store.update(f.projectId, 'posts', f.local.id, { accountOverrides: { 'facebook-recycle': { platform: 'facebook', assetId: asset.id } } });
    await f.request(`${f.project}/approvals/policy`, 'POST', { requireApproval: true });
    assert.ok((await f.detail()).assets.some(row => row.id === asset.id && row.approval === 'pending'));
    assert.equal((await f.review()).data.error.code, 'RECYCLING_ASSET_APPROVAL_REQUIRED');
    await f.app.store.update(f.projectId, 'assets', asset.id, { approval: 'approved' });
    f.remote.platforms[0].scheduledFor = '2070-01-01T11:00:00Z';
    assert.equal((await f.detail()).canEnable, false);
    assert.equal((await f.review()).data.error.code, 'RECYCLING_UNAVAILABLE');
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('full scoped history enforces ten active cycles, rejects incomplete counts and does not mistake a copied post for a new seed', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (let index = 0; index < 10; index++) f.remotePosts.set(`active-${index}`, { ...structuredClone(f.remote), _id: `active-${index}`, recycling: config() });
    assert.equal((await f.review()).data.error.code, 'RECYCLING_CAPACITY'); f.remotePosts.delete('active-9'); assert.equal((await f.review()).status, 200);
    f.setHook(url => url.pathname.endsWith('/posts') ? Response.json({ posts: [], pagination: { page: 1, limit: 500, total: 9, pages: 1 } }) : undefined); assert.equal((await f.review()).status, 502); f.setHook(undefined);
    const reviewed = await f.review(); f.remote.recycling = { ...config(), recycleCount: 1, nextRecycleAt: '2070-01-15T09:00:00Z' }; assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id })).status, 409, 'A changed live cycle invalidates the reviewed prior state.');
    const storedCopy = await f.app.store.create(f.projectId, 'posts', { ...f.local, id: undefined, externalId: 'copied-provider-id' }); f.remotePosts.set('copied-provider-id', { ...structuredClone(f.remote), _id: 'copied-provider-id', recycledFromPostId: f.remote._id });
    assert.equal((await f.request(`${f.project}/integrations/recycling/posts/${storedCopy.id}`)).data.canEnable, false);
  } finally { await f.close(); }
});

test('an accepted recycling change with an unreadable receipt stays uncertain and cannot mint another automatic publishing plan', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const reviewed = await f.review(); f.setHook((url, method, body) => { if (method === 'PUT') { f.remote.recycling = body.recycling; return Response.json({ post: { ...f.remote, _id: 'wrong-post' } }); } });
    const key = randomUUID(), result = await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }, key); assert.equal(result.data.operation.status, 'uncertain'); const sent = f.writes().length; assert.equal(sent, 1, 'The accepted recycling update reached the provider exactly once.');
    assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }, key)).status, 409); assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id })).status, 409); assert.equal(f.writes().length, sent);
    f.setHook(undefined); const newReview = await f.review(); assert.equal(newReview.status, 200); const blockedKey = randomUUID(), blocked = await f.request(f.path + '/apply', 'POST', { reviewId: newReview.data.review.id }, blockedKey); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(f.writes().length, sent);
    assert.equal((await f.request(`${f.project}/operations/${result.data.operation.id}/review`, 'POST', { resolution: 'applied', confirmChecked: true, note: 'Synthetic provider confirms the original recycling settings were applied.', reference: 'provider-seed' })).status, 200);
    const closed = await f.request(f.path + '/apply', 'POST', { reviewId: newReview.data.review.id }, blockedKey); assert.equal(closed.data.error.code, 'OPERATION_NOT_SENT'); assert.deepEqual(closed.data.operation, blocked.data.operation); assert.equal(f.writes().length, sent);
    const fresh = await f.review({ ...config(), gap: 3 }); assert.equal(fresh.status, 200); assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: fresh.data.review.id })).status, 200, 'After explicit operator reconciliation, only a fresh reviewed intent may change the active cycle.'); assert.equal(f.writes().length, sent + 1);
  } finally { await f.close(); }
});

test('parallel duplicate recycling applies under one action key send one provider update', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const reviewed = await f.review(); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    const key = randomUUID(), body = { reviewId: reviewed.data.review.id };
    const results = await Promise.all([f.request(f.path + '/apply', 'POST', body, key), f.request(f.path + '/apply', 'POST', body, key)]);
    assert.equal(f.writes().length, 1, 'The key lock lets only one duplicate send the recycling update.');
    assert.ok(results.some(row => row.status === 200 && row.data.operation?.status === 'complete'), JSON.stringify(results.map(row => row.data)));
    assert.ok(results.every(row => row.status === 200 || row.data.error?.code === 'OPERATION_UNCERTAIN'), JSON.stringify(results.map(row => row.data)));
  } finally { await f.close(); }
});

test('recycling UI preserves uncertain keys and never silently replaces a reviewed plan', async () => {
  const source = await readFile(new URL('../src/ZernioRecycling.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), end = source.indexOf('  return <Card', start), keys = { current: new Map() }, calls = [], accepted = []; let failure = Object.assign(new Error('Gateway unavailable'), { status: 502 });
  const context = { current: () => true, canManage: true, path: '/projects/one/integrations/recycling', postId: 'post-one', detail: { providerId: 'provider-one' }, keys, crypto, requester: { current: async (...args) => { calls.push(args); if (failure) throw failure; return { operation: { status: 'complete' }, post: { postId: 'post-one', providerId: 'provider-one', recycling: { enabled: true } } }; } }, accept: value => accepted.push(value), setNotice() {}, setError() {}, onChanged: null };
  const write = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end))});`)(...Object.values(context));
  await assert.rejects(write('apply', { reviewId: 'review-one' }), /Gateway/); assert.equal(accepted.length, 0); failure = Object.assign(new Error('Unknown'), { status: 409, code: 'OPERATION_UNCERTAIN' }); await assert.rejects(write('apply', { reviewId: 'review-one' }), /Unknown/); failure = null; await write('apply', { reviewId: 'review-one' }); assert.equal(calls[0][3], calls[2][3]); assert.equal(keys.current.size, 0);
  failure = Object.assign(new Error('Earlier outcome unresolved'), { status: 409, code: 'RECYCLING_PREVIOUS_OUTCOME_UNRESOLVED', operation: { status: 'failed' } }); await assert.rejects(write('apply', { reviewId: 'new-review' }), /Earlier/); assert.equal(keys.current.size, 0, 'A definitively blocked new intent releases its key; the original uncertain action still retains its own key.');
  assert.match(source, /review.signature !== signature/); assert.match(source, /function change\(values: Partial<Draft>\).*setReview\(null\); setReviewed\(false\)/);
  const body = source.slice(source.indexOf('function SettingsValue('), source.indexOf('\nexport default')), { code } = await transformWithOxc(body, 'RecyclingSettings.tsx', { jsx: { runtime: 'classic' } }), ui = await import('@ten98/ui'), SettingsValue = new Function('React', 'label', ...Object.keys(ui), code + ';return SettingsValue;')(React, value => value, ...Object.values(ui));
  const html = renderToStaticMarkup(React.createElement(SettingsValue, { value: { firstComment: '<reviewed>', nested: { enabled: false, labels: ['one', 'two'] } } })); assert.match(html, /&lt;reviewed&gt;/); assert.match(html, /Off/); assert.match(html, /<dl[ >]/); assert.match(html, /<ol[ >]/); assert.doesNotMatch(html, /<pre>|<script>/);
});

test('ordinary scheduled-source and published-copy edits require stopping an enabled recurring plan first', { skip: postgresSkip }, async t => {
  for (const action of ['update', 'edit-published']) {
    const f = await fixture(t);
    try {
      if (action === 'update') { f.remote.status = 'scheduled'; f.remote.scheduledFor = '2070-01-01T08:00:00Z'; f.remote.platforms = f.remote.platforms.map(row => ({ ...row, status: 'scheduled' })); }
      const reviewed = await f.review(); assert.equal(reviewed.status, 200); assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id })).status, 200);
      await f.app.sql.run("UPDATE memberships SET role='editor'"); const before = f.calls.filter(row => row.method !== 'GET' && !row.url.pathname.includes('/tools/validate')).length;
      const body = action === 'update' ? { postId: f.local.id, content: 'Changed automatic source', mode: 'scheduled', scheduledAt: '2070-01-01T08:00:00Z' } : { postId: f.local.id, accountId: 'facebook-recycle', content: 'Changed published account caption', confirmEdit: true };
      const rejected = await f.request(`${f.project}/integrations/social/${action}`, 'POST', body); assert.equal(rejected.status, 409, JSON.stringify(rejected.data)); assert.equal(rejected.data.error.code, 'RECYCLING_SOURCE_EDIT_REQUIRES_STOP'); assert.equal(f.calls.filter(row => row.method !== 'GET' && !row.url.pathname.includes('/tools/validate')).length, before);
      await f.app.sql.run("UPDATE memberships SET role='owner'"); assert.equal((await f.request(f.path + '/stop', 'POST', { expectedFingerprint: (await f.detail()).fingerprint, confirmStop: true })).status, 200);
      await f.app.sql.run("UPDATE memberships SET role='editor'"); const changed = await f.request(`${f.project}/integrations/social/${action}`, 'POST', body); assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(f.remote.recycling.enabled, false);
    } finally { await f.close(); }
  }
});

test('in-flight source edits serialize with recurring changes and their completed content invalidates older reviews', { skip: postgresSkip }, async t => {
  const f = await fixture(t); let release;
  try {
    f.remote.status = 'scheduled'; f.remote.scheduledFor = '2070-01-01T08:00:00Z'; f.remote.platforms = f.remote.platforms.map(row => ({ ...row, status: 'scheduled' })); const reviewed = await f.review(); assert.equal(reviewed.status, 200);
    let entered; const paused = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); let held = false;
    f.setHook(async url => { if (url.pathname.endsWith('/tools/validate/post') && !held) { held = true; entered(); await gate; } });
    const edit = f.request(`${f.project}/integrations/social/update`, 'POST', { postId: f.local.id, content: 'New editor caption', mode: 'scheduled', scheduledAt: '2070-01-01T08:00:00Z' }); await paused;
    const blocked = await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(f.writes().length, 0); release(); assert.equal((await edit).status, 200); f.setHook(undefined);
    assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id })).data.error.code, 'RECYCLING_REVIEW_CHANGED'); assert.equal(f.remote.recycling, undefined);
    const fresh = await f.review(); assert.equal((await f.request(f.path + '/apply', 'POST', { reviewId: fresh.data.review.id })).status, 200); assert.equal(f.remote.content, 'New editor caption'); assert.equal(f.remote.recycling.enabled, true);
  } finally { release?.(); await f.close(); }
});

test('uncertain source and recurring writes block each other until explicit operator reconciliation', { skip: postgresSkip }, async t => {
  for (const unknown of ['source', 'recycling']) {
    const f = await fixture(t);
    try {
      const reviewed = await f.review(); f.setHook((url, method, body) => { if (unknown === 'source' ? url.pathname.endsWith('/edit') : method === 'PUT' && body.recycling) throw new Error('Synthetic accepted write may still become visible later'); });
      const editBody = { postId: f.local.id, accountId: 'facebook-recycle', content: 'Uncertain source caption', confirmEdit: true };
      const first = unknown === 'source' ? await f.request(`${f.project}/integrations/social/edit-published`, 'POST', editBody) : await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }); assert.equal(first.data.operation.status, 'uncertain'); f.setHook(undefined); const before = f.calls.filter(row => row.method !== 'GET' && !row.url.pathname.includes('/tools/validate')).length;
      const blockedKey = randomUUID(), blockedPath = unknown === 'source' ? f.path + '/apply' : `${f.project}/integrations/social/edit-published`, blockedBody = unknown === 'source' ? { reviewId: reviewed.data.review.id } : editBody;
      const blocked = await f.request(blockedPath, 'POST', blockedBody, blockedKey); assert.equal(blocked.status, 409); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, first.data.operation.id); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(f.calls.filter(row => row.method !== 'GET' && !row.url.pathname.includes('/tools/validate')).length, before);
      assert.equal((await f.request(`${f.project}/operations/${first.data.operation.id}/review`, 'POST', { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic provider confirms the deferred write did not apply.', reference: 'deferred-provider-write' })).status, 200);
      const closed = await f.request(blockedPath, 'POST', blockedBody, blockedKey); assert.equal(closed.data.error.code, 'OPERATION_NOT_SENT'); assert.deepEqual(closed.data.operation, blocked.data.operation); assert.equal(f.calls.filter(row => row.method !== 'GET' && !row.url.pathname.includes('/tools/validate')).length, before);
      const recovered = unknown === 'source' ? await f.request(f.path + '/apply', 'POST', { reviewId: reviewed.data.review.id }) : await f.request(`${f.project}/integrations/social/edit-published`, 'POST', editBody); assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    } finally { await f.close(); }
  }
});
