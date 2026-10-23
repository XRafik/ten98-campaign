import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('HTTP account copies retain separate caption, DAM media, options, approvals and schedules through publication, edit, status and retry', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-account-posts-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<title>Account publishing check</title>');
  const origin = 'http://127.0.0.1:3000', profileId = 'account-fixture-profile', app = await testApp(t, { dataDir, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'account-fixture-key' } });
  const originalFetch = globalThis.fetch, writes = [], remotePosts = new Map(), groups = [], accounts = ['first', 'second'].map(id => ({ _id: id, platform: 'facebook', displayName: `Brand ${id}`, profileId, isActive: true }));
  let sequence = 0, ownerCookie, loseReceipt = false, validationHook, omitTagReadback = false, omitCreateTags = false, readbackTags;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer account-fixture-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [...accounts, { ...accounts[0], _id: 'foreign', profileId: 'other-project' }] };
    else if (url.pathname === '/api/v1/account-groups') result = { groups };
    else if (url.pathname === '/api/v1/profiles/' + profileId) result = { profile: { _id: profileId, name: 'Account publishing fixture', timezone: 'UTC' } };
    else if (url.pathname === '/api/v1/tools/validate/post') { if (validationHook) { const hook = validationHook; validationHook = null; hook(); } result = { valid: true, warnings: [] }; }
    else if (url.pathname === '/api/v1/posts' && method === 'POST') {
      writes.push({ method, payload });
      const remote = { ...payload, _id: `remote-${++sequence}`, status: payload.scheduledFor ? 'scheduled' : 'published', mediaItems: payload.mediaItems || [], platforms: payload.platforms.map(copy => ({ ...copy, status: payload.scheduledFor ? 'pending' : 'published' })) };
      remotePosts.set(remote._id, remote); result = { post: omitCreateTags ? Object.fromEntries(Object.entries(remote).filter(([key]) => key !== 'tags')) : remote };
      if (loseReceipt) { loseReceipt = false; return new Response(JSON.stringify({ error: 'Synthetic response lost after acceptance' }), { status: 502 }); }
    } else if (url.pathname.startsWith('/api/v1/posts/')) {
      const parts = url.pathname.split('/'), remote = remotePosts.get(parts[4]); assert.ok(remote, 'Only fixture post IDs may be read or written.');
      if (method === 'GET') result = { post: omitTagReadback ? Object.fromEntries(Object.entries(remote).filter(([key]) => key !== 'tags')) : readbackTags ? { ...remote, tags: readbackTags } : remote };
      else if (method === 'PUT') { writes.push({ method, payload }); Object.assign(remote, payload, { status: payload.isDraft ? 'draft' : 'scheduled' }); result = { post: remote }; }
      else if (method === 'POST' && parts[5] === 'retry') { writes.push({ method, payload }); remote.status = 'publishing'; remote.platforms = remote.platforms.map(copy => copy.status === 'failed' ? { ...copy, status: 'pending' } : copy); result = { post: remote }; }
      else throw new Error(`Unexpected synthetic post write: ${method} ${url.pathname}`);
    } else throw new Error(`Unknown external request blocked: ${method} ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, key) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(ownerCookie ? { Cookie: ownerCookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'Account publishing QA', email: 'account-publishing@example.test', password: 'synthetic publishing password long enough' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data, project = `/api/projects/${state.projectId}`, social = project + '/integrations/social';
    assert.equal((await request(project, 'PATCH', { zernioProfileId: profileId })).status, 200);
    const assetResult = await request(project + '/assets', 'POST', { name: 'Second brand creative', kind: 'image', url: 'https://cdn.example.test/account.jpg', deliveryUrl: 'https://cdn.example.test/account.jpg', approval: 'approved', width: 1080, height: 1080, size: 1000 }); assert.equal(assetResult.status, 201, JSON.stringify(assetResult.data)); const asset = assetResult.data.record;
    const fields = { content: '', platforms: ['facebook'], accounts: ['first', 'second'], mediaItems: [], platformOverrides: { facebook: { options: { firstComment: 'Platform comment' } } }, accountOverrides: { first: { platform: 'facebook', content: 'First brand caption', mediaItems: [], options: { firstComment: 'First brand comment' } }, second: { platform: 'facebook', content: '', assetId: asset.id, options: {} } } };
    async function draft(extra = {}) { const result = await request(project + '/posts', 'POST', { ...fields, ...extra }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.record; }
    async function approve(record) {
      const asked = await request(`${project}/approvals/posts/${record.id}/request`, 'POST', {}); assert.equal(asked.status, 200, JSON.stringify(asked.data));
      // An approved proposed update (#30 Q2) may already cover this exact content; it is not reviewed twice.
      if (asked.data.item.review.status === 'approved') return asked.data.item;
      const approved = await request(`${project}/approvals/posts/${record.id}/review`, 'POST', { reviewId: asked.data.item.review.id, decision: 'approved', note: 'Reviewed each distinct account copy and fixed time.' }); assert.equal(approved.status, 200, JSON.stringify(approved.data)); return approved.data.item;
    }
    // Council decision #30 (Q2): with the policy on, a submitted post's update is requested as a proposal and approved first.
    // The fixture owner is the project's single owner/admin, so this is the recorded self-approval exception.
    async function approveUpdate({ postId, ...proposal }) {
      const asked = await request(`${project}/approvals/posts/${postId}/request`, 'POST', { proposal }); assert.equal(asked.status, 200, JSON.stringify(asked.data));
      if (asked.data.item.review.status === 'approved') return;
      const approved = await request(`${project}/approvals/posts/${postId}/review`, 'POST', { reviewId: asked.data.item.review.id, decision: 'approved', note: 'Reviewed the proposed provider update.' });
      assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.item.review.selfApproved, true);
    }
    async function approvedUpdate(body, key) { await approveUpdate(body); return request(social + '/update', 'POST', body, key); }
    async function reviewSyntheticReceipt(key) {
      // These fixture writes were accepted by the mock; close only their exact receipts between independent scenarios.
      const receipt = await app.sql.get('SELECT id,response FROM integration_operations WHERE project_id=? AND request_key=? AND status=?', state.projectId, key, 'uncertain'); assert.ok(receipt, key);
      assert.equal((await app.sql.run("UPDATE integration_operations SET status='reviewed-applied' WHERE id=? AND status='uncertain'", receipt.id)).changes, 1); assert.equal((await app.sql.get('SELECT response FROM integration_operations WHERE id=?', receipt.id)).response, receipt.response);
    }
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: true })).status, 200);
    const immediate = await draft(), reviewed = await approve(immediate);
    assert.equal(reviewed.post.accountOverrides.first.content, fields.accountOverrides.first.content); assert.equal(reviewed.post.accountOverrides.second.content, ''); assert.equal(reviewed.post.accountOverrides.second.mediaItems[0].url, asset.deliveryUrl); assert.deepEqual(reviewed.post.accountOverrides.second.options, {});
    assert.equal((await request(project + '/assets/' + asset.id, 'DELETE')).status, 409, 'An account-only DAM reference prevents deleting the creative.');
    await app.store.update(state.projectId, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed.jpg' });
    let result = await request(social + '/publish', 'POST', { postId: immediate.id }, 'account-stale-asset'); assert.equal(result.status, 409); assert.equal(writes.length, 0, 'Changing account-only creative invalidates its approved publication.'); await app.store.update(state.projectId, 'assets', asset.id, asset);
    result = await request(social + '/publish', 'POST', { postId: immediate.id }, 'account-immediate'); assert.equal(result.status, 200, JSON.stringify(result.data));
    let sent = writes.at(-1).payload; assert.equal(sent.publishNow, true); assert.equal(sent.platforms.length, 2);
    assert.equal(sent.platforms[0].customContent, fields.accountOverrides.first.content); assert.deepEqual(sent.platforms[0].customMedia, []); assert.deepEqual(sent.platforms[0].platformSpecificData, { firstComment: 'First brand comment' });
    assert.equal(sent.platforms[1].customContent, ''); assert.equal(sent.platforms[1].customMedia[0].url, asset.deliveryUrl); assert.deepEqual(sent.platforms[1].platformSpecificData, {});
    const beforeReplay = writes.length; assert.equal((await request(social + '/publish', 'POST', { postId: immediate.id }, 'account-immediate')).status, 200); assert.equal(writes.length, beforeReplay);
    const firstRemote = remotePosts.get(result.data.post.externalId); firstRemote.status = 'failed'; firstRemote.platforms = firstRemote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    result = await request(social + '/status?postId=' + immediate.id); assert.equal(result.status, 200);
    result = await request(social + '/retry', 'POST', { postId: immediate.id, confirmPublish: true }, 'account-unchanged-approved-retry'); assert.equal(result.status, 200, 'Refreshing unchanged account copies must preserve their existing approval: ' + JSON.stringify(result.data));
    const timed = { ...fields.accountOverrides, second: { ...fields.accountOverrides.second, scheduledAt: '2070-02-02T09:00:00Z' } }, scheduled = await draft({ status: 'scheduled', scheduledAt: '2070-02-01T09:00:00Z', accountOverrides: timed }); await approve(scheduled);
    result = await request(social + '/publish', 'POST', { postId: scheduled.id }, 'account-schedule'); assert.equal(result.status, 200, JSON.stringify(result.data));
    sent = writes.at(-1).payload; assert.equal(sent.scheduledFor, '2070-02-01T09:00:00.000Z'); assert.equal(sent.platforms[1].scheduledFor, timed.second.scheduledAt); assert.equal(sent.platforms[0].scheduledFor, undefined);
    assert.equal(result.data.post.accountOverrides.second.scheduledAt, timed.second.scheduledAt); const remote = remotePosts.get(result.data.post.externalId);
    const ownTime = new Date(Date.now() + 3600000).toISOString(), expiring = await draft({ status: 'scheduled', scheduledAt: '2070-01-01T09:00:00Z', accountOverrides: { ...fields.accountOverrides, first: { ...fields.accountOverrides.first, scheduledAt: ownTime } } }); await approve(expiring);
    const realNow = Date.now, beforeExpired = writes.length; validationHook = () => { Date.now = () => Date.parse(ownTime) + 1000; };
    try { result = await request(social + '/publish', 'POST', { postId: expiring.id }, 'account-expiring-time'); } finally { Date.now = realNow; }
    assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(writes.length, beforeExpired, 'An account schedule that expires during preflight must not reach the provider write.');
    const singleRemote = { _id: 'single-own-time', profileId, status: 'scheduled', content: 'Single-target upstream post', mediaItems: [], scheduledFor: '2070-03-01T09:00:00Z', platforms: [{ platform: 'facebook', accountId: 'first', status: 'scheduled', scheduledFor: '2070-03-02T09:00:00Z' }] }; remotePosts.set(singleRemote._id, singleRemote);
    const single = await app.store.create(state.projectId, 'posts', { content: singleRemote.content, platforms: ['facebook'], accounts: ['first'], status: 'scheduled', scheduledAt: singleRemote.scheduledFor, mediaItems: [], externalId: singleRemote._id, zernioProfileId: profileId });
    result = await request(social + '/status?postId=' + single.id); assert.equal(result.status, 200); assert.equal(result.data.post.accountOverrides.first.scheduledAt, singleRemote.platforms[0].scheduledFor, 'A platform with one account still exposes its separate upstream time.');
    const recurrence = project + '/integrations/recycling/posts/' + single.id, detail = await request(recurrence); assert.equal(detail.status, 200); assert.equal(detail.data.canEnable, false); assert.match(detail.data.unavailable, /Separate account times/);
    result = await request(recurrence + '/review', 'POST', { expectedFingerprint: detail.data.fingerprint, confirmReview: true, configuration: { enabled: true, gap: 1, gapFreq: 'week', startDate: '2070-04-01T09:00:00Z', expireDate: null, expireCount: 3, contentVariations: [] } }); assert.equal(result.status, 422); assert.equal(writes.length, beforeExpired, 'Unsupported recurring account offsets are rejected before writes.');
    const updatedCopies = { first: { platform: 'facebook', content: 'Edited first account', mediaItems: [], options: {} }, second: { platform: 'facebook', content: 'Edited second account', mediaItems: [{ type: 'image', url: asset.deliveryUrl }], options: { firstComment: 'Second account only' }, scheduledAt: '2070-02-03T09:00:00Z' } };
    result = await approvedUpdate({ postId: scheduled.id, content: 'Shared unchanged fallback', platformOverrides: {}, accountOverrides: updatedCopies, mode: 'scheduled', scheduledAt: '2070-02-01T09:00:00Z' }, 'account-edit'); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(writes.at(-1).payload.platforms[0].customContent, updatedCopies.first.content); assert.equal(writes.at(-1).payload.platforms[1].customContent, updatedCopies.second.content); assert.equal(remote.platforms[1].scheduledFor, updatedCopies.second.scheduledAt);
    result = await request(social + '/status?postId=' + scheduled.id); assert.equal(result.status, 200); assert.equal(result.data.post.accountOverrides.first.content, updatedCopies.first.content); assert.equal(result.data.post.accountOverrides.second.content, updatedCopies.second.content);
    result = await approvedUpdate({ postId: scheduled.id, mode: 'scheduled', scheduledAt: '2070-02-05T09:00:00Z' }, 'account-parent-reschedule'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(remote.platforms[1].scheduledFor, updatedCopies.second.scheduledAt, 'Changing only the parent time preserves a separate account time.');
    result = await approvedUpdate({ postId: scheduled.id, accountOverrides: { ...updatedCopies, second: { ...updatedCopies.second, scheduledAt: '' } }, mode: 'scheduled', scheduledAt: '2070-02-04T09:00:00Z' }, 'account-clear-time'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.notEqual(remote.platforms[1].scheduledFor, updatedCopies.second.scheduledAt, 'An explicit inherited-time choice cannot retain the obsolete account time.');
    const beforeInvalid = writes.length;
    for (const overrides of [{ foreign: { platform: 'facebook', content: 'Wrong project' } }, { first: { platform: 'twitter', content: 'Wrong platform' } }]) { result = await request(social + '/validate', 'POST', { ...fields, accountOverrides: overrides }); assert.ok([400, 403, 422].includes(result.status), JSON.stringify(result)); }
    const queueTimed = await request(social + '/validate', 'POST', { ...fields, queueId: 'synthetic-queue', queueVersion: 'a'.repeat(64), accountOverrides: timed }); assert.ok(queueTimed.status >= 400); assert.equal(writes.length, beforeInvalid);
    remote.platforms.push({ ...structuredClone(remote.platforms[0]), customContent: 'Second destination on first account' });
    result = await approvedUpdate({ postId: scheduled.id, accountOverrides: updatedCopies, mode: 'scheduled', scheduledAt: '2070-02-04T09:00:00Z' }, 'account-ambiguous-edit'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'AMBIGUOUS_POST_DESTINATIONS'); assert.equal(writes.length, beforeInvalid); remote.platforms.pop();
    remote.status = 'failed'; remote.platforms = remote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    remote.status = 'partial'; remote.platforms[1].status = 'published';
    result = await request(social + '/status?postId=' + scheduled.id); assert.equal(result.status, 200); await approve(result.data.post);
    const reviewedRetry = structuredClone(remote), beforeChangedRetry = writes.length;
    accounts.push({ ...accounts[0], _id: 'replacement-facebook-fixture' });
    for (const [change, mutate, code = 'POST_CHANGED'] of [
      ['caption', () => { remote.platforms[0].customContent = 'Changed during retry preflight'; }],
      ['shared-caption', () => { remote.content = 'Changed shared caption'; }],
      ['remove-shared-caption', () => { delete remote.content; }],
      ['remove-shared-media', () => { delete remote.mediaItems; }],
      ['remove-copy-caption', () => { delete remote.platforms[0].customContent; }],
      ['remove-copy-media', () => { delete remote.platforms[0].customMedia; }],
      ['remove-copy-options', () => { delete remote.platforms[0].platformSpecificData; }],
      ['media', () => { remote.platforms[0].customMedia = [{ type: 'image', url: 'https://cdn.example.test/unreviewed.jpg' }]; }],
      ['options', () => { remote.platforms[0].platformSpecificData = { firstComment: 'Changed comment' }; }],
      ['account-time', () => { remote.platforms[0].scheduledFor = '2070-03-01T09:00:00Z'; }],
      ['shared-time', () => { remote.scheduledFor = '2070-03-01T09:00:00Z'; }],
      ['terminal-status', () => { remote.platforms[0].status = 'cancelled'; }],
      ['pending-status', () => { remote.platforms[0].status = 'pending'; }],
      ['post-status', () => { remote.status = 'scheduled'; }],
      ['destination', () => { remote.platforms[0].accountId = 'replacement-facebook-fixture'; }],
      ['inactive-failed-account', () => { accounts[0].isActive = false; }, 'ACCOUNT_UNAVAILABLE'],
    ]) {
      validationHook = mutate;
      result = await request(social + '/retry', 'POST', { postId: scheduled.id, confirmPublish: true }, 'account-retry-preflight-' + change);
      assert.equal(result.status, 409, change + ': ' + JSON.stringify(result.data)); assert.equal(result.data.error.code, code); assert.equal(writes.length, beforeChangedRetry, change + ' changed during validation must not reach the retry write.');
      Object.assign(remote, structuredClone(reviewedRetry));
      accounts[0].isActive = true;
    }
    validationHook = () => { remote.updatedAt = '2026-10-19T12:00:00Z'; remote.platforms.reverse(); remote.platforms[0].errorMessage = 'Additional diagnostic detail'; remote.platforms[0].attempts = 3; accounts[1].isActive = false; };
    result = await request(social + '/retry', 'POST', { postId: scheduled.id, confirmPublish: true }, 'account-retry'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.post.accountOverrides.first.content, updatedCopies.first.content); assert.equal(result.data.post.accountOverrides.second.content, updatedCopies.second.content);
    accounts[1].isActive = true;
    const bulk = Array.from({ length: 25 }, (_, index) => ({ ...accounts[0], _id: `bulk-${index}`, displayName: `Campaign page ${index}` })); accounts.push(...bulk); groups.push({ _id: 'bulk-group', name: 'Twenty-five campaign pages', accountIds: bulk.map(row => row._id) });
    const overview = await request(project + '/integrations/admin/overview'); assert.equal(overview.status, 200, JSON.stringify(overview.data)); assert.equal(overview.data.groups[0].accountIds.length, 25);
    const groupDraft = await draft({ accounts: [...overview.data.groups[0].accountIds], accountOverrides: {} }); assert.equal(groupDraft.accounts.length, 25, 'A reviewed group larger than twenty accounts can be saved.'); groups[0].accountIds.pop();
    assert.equal((await app.store.get(state.projectId, 'posts', groupDraft.id)).accounts.length, 25, 'Later provider group edits do not alter saved explicit recipient IDs.');
    assert.equal((await request(project + '/posts', 'POST', { ...fields, accountOverrides: {}, accounts: Array.from({ length: 51 }, (_, index) => 'account-' + index) })).status, 400, 'Fifty-one recipients are rejected before publication.');
    accounts.push(...['youtube-one', 'youtube-two'].map(_id => ({ _id, platform: 'youtube', profileId, isActive: true })));
    const youtubeFields = { content: 'Video tutorial', platforms: ['youtube'], accounts: ['youtube-one', 'youtube-two'], platformOverrides: {}, accountOverrides: {}, mediaItems: [{ type: 'video', url: 'https://cdn.example.test/tutorial.mp4', width: 1920, height: 1080, duration: 60, size: 1000000 }], tags: ['#launch, product', 'launch'] };
    const tagged = await draft(youtubeFields); assert.deepEqual(tagged.tags, ['launch', 'product']);
    const taggedReview = await approve(tagged); assert.deepEqual(taggedReview.post.tags, tagged.tags); assert.deepEqual(taggedReview.review.snapshot.tags, tagged.tags);
    result = await request(project + '/posts/' + tagged.id, 'PATCH', { tags: ['review changed'] }); assert.equal(result.status, 200);
    const beforeTags = writes.length;
    result = await request(social + '/publish', 'POST', { postId: tagged.id }, 'tags-stale-review'); assert.equal(result.status, 409); assert.equal(writes.length, beforeTags, 'Changing keyword tags invalidates the review before any provider write.');
    await approve(await app.store.get(state.projectId, 'posts', tagged.id));
    omitCreateTags = true;
    result = await request(social + '/publish', 'POST', { postId: tagged.id }, 'tags-immediate'); omitCreateTags = false;
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(writes.at(-1).payload.tags, ['review changed']); assert.deepEqual(result.data.post.tags, ['review changed'], 'A minimal create receipt must read back keywords before confirming success.');
    assert.ok(writes.at(-1).payload.platforms.every(target => !Object.hasOwn(target.platformSpecificData || {}, 'tags')), 'Both channels inherit request-level keywords.');
    const tagScheduled = await draft({ ...youtubeFields, status: 'scheduled', scheduledAt: '2070-01-01T09:00:00Z' }); await approve(tagScheduled);
    result = await request(social + '/publish', 'POST', { postId: tagScheduled.id }, 'tags-scheduled'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(writes.at(-1).payload.tags, ['launch', 'product']); assert.ok(writes.at(-1).payload.scheduledFor);
    const tagRemote = remotePosts.get(result.data.post.externalId);
    tagRemote.tags = ['launch, product']; tagRemote.status = 'failed'; tagRemote.platforms = tagRemote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    result = await request(social + '/status?postId=' + tagScheduled.id); assert.equal(result.status, 200); assert.deepEqual(result.data.post.tags, ['launch, product'], 'Status must preserve provider keyword strings.');
    const changedTagQueue = await request(project + '/approvals/posts'); assert.equal(changedTagQueue.status, 200); const changedTagReview = changedTagQueue.data.posts.find(item => item.post.id === tagScheduled.id); assert.equal(changedTagReview.status, 'stale', 'A comma-joined provider keyword cannot retain approval for separate keywords.'); assert.deepEqual(changedTagReview.post.tags, ['launch, product']);
    result = await approvedUpdate({ postId: tagScheduled.id, tags: ['new keyword'], mode: 'scheduled', scheduledAt: '2070-01-02T09:00:00Z' }, 'tags-update'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(writes.at(-1).payload.tags, ['new keyword']); assert.deepEqual(result.data.post.tags, ['new keyword']);
    result = await approvedUpdate({ postId: tagScheduled.id, tags: [], mode: 'draft' }, 'tags-clear'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(tagRemote.tags, []); assert.deepEqual(result.data.post.tags, []);
    tagRemote.status = 'failed'; tagRemote.platforms = tagRemote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    result = await request(social + '/status?postId=' + tagScheduled.id); assert.equal(result.status, 200); await approve(result.data.post);
    const beforeEmptyTags = writes.length; omitTagReadback = true;
    result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry-empty-missing'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'POST_TAGS_CHANGED'); assert.equal(writes.length, beforeEmptyTags, 'An intentionally cleared keyword list still needs exact readback before retry.'); omitTagReadback = false;
    tagRemote.tags = ['upstream keyword'];
    result = await request(social + '/status?postId=' + tagScheduled.id); assert.equal(result.status, 200); assert.deepEqual(result.data.post.tags, tagRemote.tags); await approve(result.data.post);
    const beforeTagRetry = writes.length; let tagPreflighted = false; validationHook = () => { tagPreflighted = true; }; omitTagReadback = true;
    result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry-missing'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'POST_TAGS_CHANGED'); assert.equal(tagPreflighted, false); assert.equal(writes.length, beforeTagRetry); assert.deepEqual((await app.store.get(state.projectId, 'posts', tagScheduled.id)).tags, ['upstream keyword']); omitTagReadback = false;
    result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry-missing'); assert.equal(result.status, 409); assert.equal(tagPreflighted, false); assert.equal(writes.length, beforeTagRetry, 'Replaying a failed operation retains its no-write result.');
    tagRemote.tags = ['changed upstream']; result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry-mismatch'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'POST_TAGS_CHANGED'); assert.equal(tagPreflighted, false); assert.equal(writes.length, beforeTagRetry); assert.deepEqual((await app.store.get(state.projectId, 'posts', tagScheduled.id)).tags, ['upstream keyword']);
    tagRemote.tags = ['upstream keyword']; validationHook = () => { tagRemote.tags = ['changed during preflight']; };
    result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry-changed-preflight'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'POST_TAGS_CHANGED'); assert.equal(writes.length, beforeTagRetry); assert.deepEqual((await app.store.get(state.projectId, 'posts', tagScheduled.id)).tags, ['upstream keyword']); tagRemote.tags = ['upstream keyword'];
    validationHook = () => { omitTagReadback = true; }; result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry-missing-preflight'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'POST_TAGS_CHANGED'); assert.equal(writes.length, beforeTagRetry); assert.deepEqual((await app.store.get(state.projectId, 'posts', tagScheduled.id)).tags, ['upstream keyword']); omitTagReadback = false;
    result = await request(social + '/retry', 'POST', { postId: tagScheduled.id, confirmPublish: true }, 'tags-retry'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data.post.tags, ['upstream keyword']); assert.deepEqual(writes.at(-1).payload, {}, 'Retry uses stored provider metadata and cannot submit replacement keywords.');
    tagRemote.status = 'failed'; tagRemote.platforms = tagRemote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    const beforeBadTag = writes.length;
    result = await request(social + '/update', 'POST', { postId: tagScheduled.id, tags: ['x'.repeat(101)], mode: 'draft' }, 'tags-invalid'); assert.equal(result.status, 400); assert.equal(writes.length, beforeBadTag);
    result = await request(project + '/posts', 'POST', { ...youtubeFields, tags: [123] }); assert.equal(result.status, 400);
    result = await request(social + '/status?postId=' + tagScheduled.id); assert.equal(result.status, 200);
    omitTagReadback = true;
    result = await approvedUpdate({ postId: tagScheduled.id, tags: ['unverified change'], mode: 'draft' }, 'tags-missing-update-readback'); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN');
    const afterMissingTag = writes.length; result = await approvedUpdate({ postId: tagScheduled.id, tags: ['unverified change'], mode: 'draft' }, 'tags-missing-update-readback'); assert.ok(result.status >= 400); assert.equal(writes.length, afterMissingTag); assert.deepEqual((await app.store.get(state.projectId, 'posts', tagScheduled.id)).tags, ['upstream keyword'], 'Unverified keywords must not replace the last confirmed local state.');
    await reviewSyntheticReceipt('tags-missing-update-readback');
    omitTagReadback = false;
    tagRemote.tags = null; result = await request(social + '/status?postId=' + tagScheduled.id); assert.equal(result.status, 502); assert.deepEqual((await app.store.get(state.projectId, 'posts', tagScheduled.id)).tags, ['upstream keyword']); tagRemote.tags = ['upstream keyword'];
    const unverifiedTags = await draft(youtubeFields); await approve(unverifiedTags); omitCreateTags = true; omitTagReadback = true;
    result = await request(social + '/publish', 'POST', { postId: unverifiedTags.id }, 'tags-unverified-create'); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN');
    const afterUnverifiedCreate = writes.length; result = await request(social + '/publish', 'POST', { postId: unverifiedTags.id }, 'tags-unverified-create'); assert.ok(result.status >= 400); assert.equal(writes.length, afterUnverifiedCreate); assert.equal((await app.store.get(state.projectId, 'posts', unverifiedTags.id)).externalId, undefined);
    await reviewSyntheticReceipt('tags-unverified-create');
    omitCreateTags = false; omitTagReadback = false;
    for (const action of ['create', 'update']) {
      const alteredTags = await draft({ ...youtubeFields, ...(action === 'update' ? { status: 'scheduled', scheduledAt: '2070-01-01T09:00:00Z' } : {}) }); await approve(alteredTags);
      if (action === 'update') { result = await request(social + '/publish', 'POST', { postId: alteredTags.id }, 'tags-altered-update-setup'); assert.equal(result.status, 200, JSON.stringify(result.data)); }
      omitCreateTags = true; readbackTags = ['launch, product'];
      const path = action === 'create' ? '/publish' : '/update', body = { postId: alteredTags.id, ...(action === 'update' ? { tags: ['launch', 'product'], mode: 'draft' } : {}) }, key = `tags-altered-${action}`;
      if (action === 'update') await approveUpdate(body);
      const beforeAlteredTags = writes.length; result = await request(social + path, 'POST', body, key); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes.length, beforeAlteredTags + 1, 'The altered receipt is rejected after exactly one provider write.');
      if (action === 'update') await approveUpdate(body);
      const afterAlteredTags = writes.length; result = await request(social + path, 'POST', body, key); assert.ok(result.status >= 400); assert.equal(writes.length, afterAlteredTags); assert.deepEqual((await app.store.get(state.projectId, 'posts', alteredTags.id)).tags, ['launch', 'product'], 'Altered keyword receipts must preserve the approved local copy.');
      if (action === 'create') assert.equal((await app.store.get(state.projectId, 'posts', alteredTags.id)).externalId, undefined);
      await reviewSyntheticReceipt(key);
      omitCreateTags = false; readbackTags = undefined;
    }
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: false })).status, 200);
    const legacyFields = { content: 'Legacy platform-only draft', platforms: ['facebook'], mediaItems: [], status: 'draft' };
    const legacy = (await request(project + '/posts', 'POST', legacyFields)).data.record; await approve(legacy);
    const legacyPending = (await request(project + '/posts', 'POST', legacyFields)).data.record;
    const legacyReview = await request(`${project}/approvals/posts/${legacyPending.id}/request`, 'POST', {}); assert.equal(legacyReview.status, 200);
    accounts.push({ _id: 'newly-connected', platform: 'facebook', profileId, isActive: true });
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: true })).status, 200);
    const beforeLegacy = writes.length;
    for (const [path, body] of [[`/approvals/posts/${legacy.id}/request`, {}], [`/approvals/posts/${legacyPending.id}/review`, { reviewId: legacyReview.data.item.review.id, decision: 'approved' }], ['/integrations/social/publish', { postId: legacy.id }]]) {
      result = await request(project + path, 'POST', body, 'legacy-required-accounts'); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'APPROVAL_ACCOUNTS_REQUIRED'); assert.match(result.data.error.message, /[Ee]dit.*select.*account/);
      assert.equal(writes.length, beforeLegacy, 'A legacy review must never authorize newly connected accounts.');
    }
    const emptyRecipients = (await request(project + '/posts', 'POST', { ...legacyFields, accounts: [] })).data.record;
    result = await request(`${project}/approvals/posts/${emptyRecipients.id}/request`, 'POST', {}); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_ACCOUNTS_REQUIRED');
    const selectedLegacy = await request(`${project}/posts/${legacy.id}`, 'PATCH', { accounts: ['first'] }); assert.equal(selectedLegacy.status, 200); await approve(selectedLegacy.data.record);
    result = await request(social + '/publish', 'POST', { postId: legacy.id }, 'legacy-explicit-accounts'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(writes.at(-1).payload.platforms.map(copy => copy.accountId), ['first']);
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: false })).status, 200);
    const optionalLegacy = (await request(project + '/posts', 'POST', legacyFields)).data.record;
    result = await request(social + '/publish', 'POST', { postId: optionalLegacy.id }, 'legacy-optional-accounts'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(writes.at(-1).payload.platforms.map(copy => copy.accountId), accounts.filter(account => account.platform === 'facebook').map(account => account._id));
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: true })).status, 200);
    const uncertain = await draft(); await approve(uncertain); loseReceipt = true;
    result = await request(social + '/publish', 'POST', { postId: uncertain.id }, 'account-uncertain'); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); const writesAfterLostReceipt = writes.length;
    result = await request(social + '/publish', 'POST', { postId: uncertain.id }, 'account-uncertain'); assert.ok(result.status >= 400); assert.equal(writes.length, writesAfterLostReceipt, 'Replaying an uncertain logical publication must not create another provider post.');
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});
