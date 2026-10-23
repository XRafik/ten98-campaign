import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('HTTP platform variants publish, schedule, refresh, edit and retry the exact approved creative with fail-closed provider preflight', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-platform-posts-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Platform publishing test</title>');
  const origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'platform-fixture-key' } });
  const originalFetch = globalThis.fetch, calls = [], writes = [], remotePosts = new Map(), profileId = 'platform-fixture-profile';
  const accounts = ['facebook', 'instagram', 'twitter'].map(platform => ({ _id: `${platform}-fixture`, platform, profileId, isActive: true }));
  accounts.push({ ...accounts[0], _id: 'second-facebook-fixture' });
  let ownerCookie, sequence = 0, rejectValidation = false, malformedValidation = false, validationHook;
  let creatorInfo = { creator: { nickname: 'TikTok QA', isVerified: false, canPostMore: true }, privacyLevels: [{ value: 'SELF_ONLY', label: 'Only me' }], postingLimits: { maxVideoDurationSec: 30, interactionSettings: { allow_comment: { enabled: true, required: true, default: false, label: 'Comments' }, allow_duet: { enabled: false, required: true, default: false, label: 'Duets' }, allow_stitch: { enabled: true, required: true, default: false, label: 'Stitches' } } } };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer platform-fixture-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, payload }); let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [...accounts, { ...accounts[0], _id: 'foreign-account', profileId: 'other-profile' }] };
    else if (url.pathname === '/api/v1/accounts/tiktok-fixture/tiktok/creator-info') result = creatorInfo;
    else if (url.pathname === '/api/v1/tools/validate/media') result = { valid: true, size: 2000, contentType: 'image/jpeg', url: 'https://must-not-trust-a-returned-url.example.test/' };
    else if (url.pathname === '/api/v1/tools/validate/post') {
      assert.ok(payload.platforms.every(copy => accounts.some(account => account._id === copy.accountId && account.platform === copy.platform)), 'Every validation target is first scoped to the current project.');
      if (validationHook) { const hook = validationHook; validationHook = null; await hook(); }
      result = malformedValidation ? { valid: 'yes' } : rejectValidation ? { valid: false, errors: [{ platform: 'instagram', error: 'The connected platform rejected this fixture.' }], warnings: [] } : { valid: true, warnings: [] };
    } else if (url.pathname === '/api/v1/posts' && method === 'POST') {
      writes.push({ url, method, payload });
      const remote = { ...payload, _id: `remote-${++sequence}`, status: payload.scheduledFor ? 'scheduled' : 'published', mediaItems: payload.mediaItems || [], platforms: payload.platforms.map(copy => ({ ...copy, status: payload.scheduledFor ? 'pending' : 'published' })) };
      remotePosts.set(remote._id, remote); result = { post: remote };
    } else if (url.pathname.startsWith('/api/v1/posts/')) {
      const segments = url.pathname.split('/'), remote = remotePosts.get(segments[4]); assert.ok(remote);
      if (method === 'GET') result = { post: remote };
      else if (method === 'PUT') {
        writes.push({ url, method, payload });
        if (payload.platforms) payload.platforms = payload.platforms.map(target => {
          const previous = remote.platforms.find(copy => String(copy.accountId?._id || copy.accountId) === target.accountId);
          for (const namespace of ['facebookSettings', 'tiktokSettings']) if (previous?.platformSpecificData?.[namespace] && !Object.hasOwn(target.platformSpecificData || {}, namespace)) target = { ...target, platformSpecificData: { ...target.platformSpecificData, [namespace]: previous.platformSpecificData[namespace] } };
          return target;
        });
        Object.assign(remote, payload, { status: payload.isDraft ? 'draft' : 'scheduled' });
        result = { post: remote };
      } else if (method === 'POST' && segments[5] === 'retry') {
        writes.push({ url, method, payload }); remote.status = 'publishing'; remote.platforms = remote.platforms.map(copy => ({ ...copy, status: 'pending' })); result = { post: remote };
      } else throw new Error('Unexpected provider post mutation.');
    } else throw new Error(`Unexpected provider request ${method} ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, key } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const post = (path, body, options = {}) => request(path, { ...options, method: 'POST', body });
  try {
    const setup = await post('/api/auth/setup', { name: 'Platform QA', email: 'platform-qa@example.test', password: 'platform fixture password that is long enough' }); setup.data.projectId = await firstProject(app, setup);
    assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data, projectId = state.projectId, project = `/api/projects/${projectId}`, integrations = `${project}/integrations/social`;
    assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    const viewerId = randomUUID(), owner = await app.sql.get('SELECT password FROM users WHERE id=?', state.user.id);
    await app.sql.run('INSERT INTO users(id,name,email,password) VALUES(?,?,?,?)', viewerId, 'Platform viewer', 'platform-viewer@example.test', owner.password);
    await app.sql.run("INSERT INTO memberships VALUES(?,?,'viewer')", state.workspaces[0].id, viewerId);
    const viewerCookie = (await post('/api/auth/login', { email: 'platform-viewer@example.test', password: 'platform fixture password that is long enough' })).cookie;
    const image = { type: 'image', url: 'https://cdn.example.test/common.jpg', width: 1200, height: 1200, size: 2000, mimeType: 'image/jpeg', altText: 'Common creative' };
    const instagramImage = { ...image, url: 'https://cdn.example.test/instagram.jpg', altText: 'Square Instagram creative' };
    const draftFields = { content: 'Common launch caption', platforms: ['facebook', 'instagram', 'twitter'], accounts: accounts.map(account => account._id), mediaItems: [image], platformOverrides: { facebook: { content: 'Facebook launch with its own copy', mediaItems: [], options: { firstComment: 'Facebook first comment' } }, instagram: { content: 'Instagram launch #campaign', mediaItems: [instagramImage], options: { firstComment: 'Instagram first comment' } }, twitter: { content: 'Short X launch', mediaItems: [] } } };
    async function draft(fields = {}) { const result = await post(project + '/posts', { ...draftFields, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.record; }
    async function publish(record, key = `platform-publish-${++sequence}`) { return post(integrations + '/publish', { postId: record.id }, { key }); }
    async function approve(record) {
      const requested = await post(`${project}/approvals/posts/${record.id}/request`, {}); assert.equal(requested.status, 200, JSON.stringify(requested.data));
      const reviewed = await post(`${project}/approvals/posts/${record.id}/review`, { reviewId: requested.data.item.review.id, decision: 'approved', note: 'Checked all platform captions, creatives and options.' }); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data)); return reviewed.data.item;
    }
    let result = await post(integrations + '/validate', draftFields); assert.equal(result.status, 200); assert.equal(result.data.valid, true); assert.equal(writes.length, 0);
    const snapchatAccount = { _id: 'snapchat-fixture', platform: 'snapchat', profileId, isActive: true }; accounts.push(snapchatAccount);
    const snapchatFields = { content: 'Historic Snapchat draft', platforms: ['snapchat'], accounts: [snapchatAccount._id], mediaItems: [image], platformOverrides: { snapchat: { options: { contentType: 'story' } } } };
    const snapchatDraft = await draft(snapchatFields), beforeSnapchatChecks = calls.filter(call => call.method !== 'GET').length;
    for (const fields of [snapchatFields, { ...snapchatFields, status: 'scheduled', scheduledAt: '2070-02-01T10:00:00Z' }]) {
      const check = await post(integrations + '/validate', fields); assert.equal(check.status, 422); assert.match(check.data.error.message, /Snapchat.*unavailable|Snapchat.*not available/i);
    }
    const snapchatPublish = await publish(snapchatDraft); assert.equal(snapchatPublish.status, 422);
    assert.equal(calls.filter(call => call.method !== 'GET').length, beforeSnapchatChecks, 'Unavailable Snapchat does not reach validation or publication upstream.');
    assert.equal((await request('/api/state?projectId=' + projectId)).data.posts.find(record => record.id === snapchatDraft.id).content, snapchatFields.content, 'Historic draft stays readable.');
    accounts.pop();
    for (const invalid of [{ content: {} }, { platforms: 'facebook' }, { mediaItems: 'invalid' }, { scheduledAt: '2070-02-30T10:00:00Z' }]) assert.equal((await post(integrations + '/validate', { ...draftFields, ...invalid })).status, 400);
    assert.equal((await post(integrations + '/validate', draftFields, { cookie: viewerCookie })).status, 403);
    assert.equal((await post(integrations + '/validate', { ...draftFields, accounts: ['foreign-account'] })).status, 403);
    assert.equal((await post(integrations + '/validate-media', { url: 'https://127.0.0.1/private' })).status, 400);
    result = await post(integrations + '/validate-media', { url: image.url }); assert.equal(result.status, 200); assert.deepEqual(result.data, { valid: true, contentType: 'image/jpeg', size: 2000 });
    const overLimit = await draft({ platformOverrides: { ...draftFields.platformOverrides, instagram: { ...draftFields.platformOverrides.instagram, content: 'x'.repeat(2201) } } });
    result = await publish(overLimit); assert.equal(result.status, 422); assert.equal(result.data.error.code, 'POST_RESTRICTIONS'); assert.equal(writes.length, 0);
    result = await post(integrations + '/validate', { ...draftFields, platformOverrides: { ...draftFields.platformOverrides, instagram: { content: 'x'.repeat(2201), mediaItems: [instagramImage] } } }); assert.equal(result.data.valid, false); assert.ok(result.data.errors.some(error => error.platform === 'instagram'));
    const rejected = await draft(); rejectValidation = true; result = await publish(rejected); assert.equal(result.status, 422); assert.equal(writes.length, 0); rejectValidation = false;
    malformedValidation = true; result = await publish(rejected); assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_PROVIDER_RESPONSE'); assert.equal(writes.length, 0); malformedValidation = false;
    const immediate = await draft(), immediateKey = 'same-platform-publish-key';
    result = await publish(immediate, immediateKey); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'published');
    const sent = writes.at(-1).payload, wireImage = { type: image.type, url: image.url, altText: image.altText, mimeType: image.mimeType, size: image.size };
    assert.equal(sent.publishNow, true); assert.equal(sent.scheduledFor, undefined); assert.deepEqual(sent.mediaItems, [wireImage]);
    assert.deepEqual(sent.platforms.filter(copy => copy.platform === 'facebook').map(copy => ({ ...copy, accountId: 'ignored' })), Array(2).fill({ platform: 'facebook', accountId: 'ignored', customContent: draftFields.platformOverrides.facebook.content, customMedia: [], platformSpecificData: draftFields.platformOverrides.facebook.options }));
    const instagramCopy = sent.platforms.find(copy => copy.platform === 'instagram');
    assert.equal(instagramCopy.customContent, draftFields.platformOverrides.instagram.content); assert.equal(instagramCopy.customMedia[0].url, instagramImage.url); assert.equal(instagramCopy.customMedia[0].width, undefined); assert.deepEqual(instagramCopy.platformSpecificData, draftFields.platformOverrides.instagram.options);
    const beforeReplay = writes.length; assert.equal((await publish(immediate, immediateKey)).status, 200); assert.equal(writes.length, beforeReplay);
    const scheduledAt = '2070-01-01T12:00:00+04:00', scheduled = await draft({ content: '', status: 'scheduled', scheduledAt });
    result = await publish(scheduled); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'scheduled');
    assert.equal(writes.at(-1).payload.scheduledFor, '2070-01-01T08:00:00.000Z'); assert.equal(writes.at(-1).payload.timezone, 'UTC'); assert.equal(writes.at(-1).payload.publishNow, undefined);
    const remote = remotePosts.get(result.data.post.externalId), originalCopies = structuredClone(remote.platforms);
    const expiringAt = new Date(Date.now() + 3600000).toISOString(), expiring = await draft({ status: 'scheduled', scheduledAt: expiringAt }), realNow = Date.now, writesBeforeExpiry = writes.length;
    validationHook = () => { Date.now = () => Date.parse(expiringAt) + 1000; };
    try { result = await publish(expiring); } finally { Date.now = realNow; }
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'SCHEDULE_PASSED'); assert.equal(writes.length, writesBeforeExpiry, 'A schedule that expires during provider checks cannot become immediate publication.');
    remote.platforms.find(copy => copy.platform === 'instagram').customContent = 'Caption edited in Zernio';
    result = await request(`${integrations}/status?postId=${scheduled.id}`); assert.equal(result.status, 200); assert.equal(result.data.post.platformOverrides.instagram.content, 'Caption edited in Zernio');
    result = await post(integrations + '/update', { postId: scheduled.id, content: 'Changed fallback', mode: 'scheduled', scheduledAt: '2070-02-01T09:00:00Z' }, { key: 'preserve-provider-copies' }); assert.equal(result.status, 200);
    assert.equal(writes.at(-1).payload.platforms, undefined, 'A reschedule and shared caption update leaves each remote copy untouched.'); assert.equal(remote.platforms.find(copy => copy.platform === 'instagram').customContent, 'Caption edited in Zernio');
    const changedVariants = { ...draftFields.platformOverrides, instagram: { content: 'New per-platform copy', mediaItems: [instagramImage], options: { firstComment: 'Updated first comment' } } };
    remote.platforms.filter(copy => copy.platform === 'facebook').forEach(copy => { copy.platformSpecificData.facebookSettings = { textFormatPresetId: '123' }; });
    result = await post(integrations + '/update', { postId: scheduled.id, content: 'Shared fallback', platformOverrides: changedVariants, mode: 'scheduled', scheduledAt: '2070-03-01T09:00:00Z' }, { key: 'replace-provider-copies' }); assert.equal(result.status, 200);
    assert.equal(writes.at(-1).payload.platforms.find(copy => copy.platform === 'instagram').customContent, 'New per-platform copy'); assert.deepEqual(writes.at(-1).payload.platforms.find(copy => copy.platform === 'instagram').platformSpecificData, changedVariants.instagram.options);
    assert.deepEqual(writes.at(-1).payload.platforms.find(copy => copy.platform === 'facebook').platformSpecificData.facebookSettings, {}, 'Clearing a provider settings namespace must send an explicit empty object; omission preserves the old values.');
    let beforeWrites = writes.length;
    remote.platforms.find(copy => copy.accountId === 'second-facebook-fixture').customContent = 'Provider caption for the second Facebook account';
    remote.platforms.find(copy => copy.accountId === 'second-facebook-fixture').scheduledFor = '2070-03-02T09:00:00Z';
    result = await post(integrations + '/update', { postId: scheduled.id, platformOverrides: changedVariants, mode: 'scheduled', scheduledAt: '2070-03-01T09:00:00Z' }, { key: 'reject-silent-copy-collapse' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROVIDER_VARIANT_CONFIRMATION_REQUIRED'); assert.equal(writes.length, beforeWrites);
    result = await post(integrations + '/update', { postId: scheduled.id, platformOverrides: changedVariants, confirmReplaceVariants: true, mode: 'scheduled', scheduledAt: '2070-03-01T09:00:00Z' }, { key: 'confirm-account-copy-replacement' }); assert.equal(result.status, 200); assert.equal(writes.at(-1).payload.platforms.find(copy => copy.accountId === 'second-facebook-fixture').customContent, changedVariants.facebook.content); assert.equal(writes.at(-1).payload.platforms.find(copy => copy.accountId === 'second-facebook-fixture').scheduledFor, '2070-03-02T09:00:00Z');
    beforeWrites = writes.length;
    const horizontalReel = { type: 'video', url: 'https://cdn.example.test/horizontal-reel.mp4', width: 1920, height: 1080, duration: 10, size: 2000, mimeType: 'video/mp4' };
    result = await post(integrations + '/update', { postId: scheduled.id, platformOverrides: { ...changedVariants, facebook: { content: 'Bad horizontal Reel', mediaItems: [horizontalReel], options: { contentType: 'reel' } } }, mode: 'scheduled', scheduledAt: '2070-04-01T09:00:00Z' }, { key: 'reject-known-bad-reel-dimensions' }); assert.equal(result.status, 422); assert.equal(writes.length, beforeWrites, 'Known metadata must remain available to restriction checks after preparing the provider wire body.');
    result = await post(integrations + '/update', { postId: scheduled.id, platformOverrides: { instagram: { content: 'Missing Instagram creative', mediaItems: [] } }, mode: 'scheduled', scheduledAt: '2070-04-01T09:00:00Z' }, { key: 'reject-invalid-update' }); assert.equal(result.status, 422); assert.equal(writes.length, beforeWrites);
    remote.status = 'partial'; remote.platforms[0].status = 'published';
    result = await post(integrations + '/retry', { postId: scheduled.id, confirmPublish: true }, { key: 'reject-partial-retry' }); assert.equal(result.status, 409); assert.equal(writes.length, beforeWrites);
    remote.status = 'failed'; remote.platforms.forEach(copy => { copy.status = 'failed'; });
    accounts[0].isActive = false;
    result = await post(integrations + '/retry', { postId: scheduled.id, confirmPublish: true }, { key: 'reject-disconnected-retry' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'ACCOUNT_UNAVAILABLE'); assert.equal(writes.length, beforeWrites);
    assert.equal((await request(`${integrations}/status?postId=${scheduled.id}`)).status, 200, 'Disconnected accounts still allow reading the existing provider receipt.'); accounts[0].isActive = true;
    assert.equal((await request(`${integrations}/status?postId=${scheduled.id}`)).status, 200);
    assert.equal((await post(`${project}/approvals/policy`, { requireApproval: true })).status, 200); await approve(scheduled);
    remote.platforms.find(copy => copy.accountId === 'second-facebook-fixture').scheduledFor = '2070-03-03T09:00:00Z';
    result = await post(integrations + '/retry', { postId: scheduled.id, confirmPublish: true }, { key: 'reject-stale-account-schedule' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_POST_CHANGED'); assert.equal(writes.length, beforeWrites);
    assert.equal((await request(`${integrations}/status?postId=${scheduled.id}`)).status, 200); const reviewedSchedules = await approve(scheduled); assert.equal(reviewedSchedules.post.accountOverrides['second-facebook-fixture'].scheduledAt, '2070-03-03T09:00:00Z');
    remote.platforms.find(copy => copy.platform === 'instagram').customContent = 'Unreviewed provider variant';
    result = await post(integrations + '/retry', { postId: scheduled.id, confirmPublish: true }, { key: 'reject-stale-provider-variant' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_POST_CHANGED'); assert.equal(writes.length, beforeWrites);
    assert.equal((await request(`${integrations}/status?postId=${scheduled.id}`)).status, 200); await approve(scheduled);
    result = await post(integrations + '/retry', { postId: scheduled.id, confirmPublish: true }, { key: 'retry-reviewed-variants' }); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'submitted'); assert.equal(writes.at(-1).url.pathname.endsWith('/retry'), true); assert.equal(remote.platforms.find(copy => copy.platform === 'instagram').customContent, 'Unreviewed provider variant');
    assert.equal((await post(`${project}/approvals/policy`, { requireApproval: false })).status, 200);
    const asset = await app.store.create(projectId, 'assets', { name: 'Platform creative', kind: 'image', url: 'https://cdn.example.test/dam.jpg', width: 1080, height: 1080, approval: 'approved', size: 2000 });
    const remoteDraft = await draft({ status: 'scheduled', scheduledAt: '2070-06-01T10:00:00Z' }); result = await publish(remoteDraft); assert.equal(result.status, 200);
    assert.equal((await request(`/api/workspaces/${state.workspaces[0].id}/members/${viewerId}`, { method: 'PATCH', body: { role: 'editor' } })).status, 200);
    validationHook = () => app.sql.run('UPDATE project_approval_policy SET require_approval=true WHERE project_id=?', projectId); beforeWrites = writes.length;
    result = await post(integrations + '/update', { postId: remoteDraft.id, content: 'Edit racing the approval policy', mode: 'scheduled', scheduledAt: '2070-07-01T10:00:00Z' }, { cookie: viewerCookie, key: 'recheck-edit-policy-after-preflight' });
    assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVED_PROVIDER_EDIT_RESTRICTED'); assert.equal(writes.length, beforeWrites);
    assert.equal((await post(`${project}/approvals/policy`, { requireApproval: false })).status, 200);
    result = await post(integrations + '/update', { postId: remoteDraft.id, content: 'A shared DAM fallback', mediaItems: null, assetId: asset.id, platformOverrides: {}, mode: 'draft' }, { key: 'reset-shared-media-to-dam' }); assert.equal(result.status, 200); assert.equal(writes.at(-1).payload.mediaItems[0].url, asset.url); assert.ok(writes.at(-1).payload.platforms.every(copy => copy.customMedia === undefined));
    const retainedDraft = remotePosts.get(result.data.post.externalId); assert.ok(retainedDraft.scheduledFor, 'The provider fixture retains its historical scheduled time when demoted to draft.');
    result = await request(`${integrations}/status?postId=${remoteDraft.id}`); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'draft'); assert.equal(result.data.post.scheduledAt, '', 'Refreshing an unscheduled provider draft cannot resurrect its historical schedule.');
    const pendingAsset = await app.store.create(projectId, 'assets', { name: 'Unapproved platform creative', kind: 'image', url: 'https://cdn.example.test/pending.jpg', approval: 'pending' });
    const bothAssets = await draft({ platformOverrides: { facebook: { assetId: pendingAsset.id }, instagram: { assetId: asset.id } } });
    assert.equal((await post(`${project}/approvals/policy`, { requireApproval: true })).status, 200);
    const assetReview = await post(`${project}/approvals/posts/${bothAssets.id}/request`, {}); assert.equal(assetReview.status, 200); assert.equal(assetReview.data.item.assets.length, 2);
    result = await post(`${project}/approvals/posts/${bothAssets.id}/review`, { reviewId: assetReview.data.item.review.id, decision: 'approved', note: 'This must wait for approval of both platform assets.' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_ASSET_REQUIRED');
    await app.store.update(projectId, 'assets', pendingAsset.id, { approval: 'approved' }); await approve(bothAssets);
    await request(`${project}/posts/${bothAssets.id}`, { method: 'PATCH', body: { platformOverrides: { facebook: { assetId: pendingAsset.id }, instagram: { assetId: asset.id, options: { firstComment: 'Changed after review' } } } } });
    beforeWrites = writes.length; result = await publish(bothAssets); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_STALE'); assert.equal(writes.length, beforeWrites);
    assert.equal((await post(`${project}/approvals/policy`, { requireApproval: false })).status, 200);
    const linked = await draft({ platforms: ['instagram'], accounts: ['instagram-fixture'], mediaItems: [], platformOverrides: { instagram: { content: 'DAM variant', assetId: asset.id } } });
    validationHook = () => app.store.update(projectId, 'assets', asset.id, { url: 'https://cdn.example.test/replaced-during-preflight.jpg' }); beforeWrites = writes.length;
    result = await publish(linked); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_POST_CHANGED'); assert.equal(writes.length, beforeWrites, 'Even with optional approval, asset changes during preflight cannot publish stale creative.');
    const missing = await post(project + '/posts', { ...draftFields, platformOverrides: { instagram: { assetId: 'not-in-project' } } }); assert.equal(missing.status, 400);
    const sampleAsset = await app.store.create(projectId, 'assets', { name: 'Sample fixture', kind: 'image', url: 'https://cdn.example.test/sample.jpg', sample: true });
    const samplePost = await draft({ platformOverrides: { instagram: { assetId: sampleAsset.id } } }); result = await publish(samplePost); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'SAMPLE_RECORD');
    accounts.push({ _id: 'tiktok-fixture', platform: 'tiktok', profileId, isActive: true });
    result = await request(integrations + '/tiktok-creator-info?accountId=facebook-fixture&mediaType=video'); assert.equal(result.status, 400);
    result = await request(integrations + '/tiktok-creator-info?accountId=tiktok-fixture&mediaType=video'); assert.equal(result.status, 200); assert.deepEqual(result.data.privacyLevels, creatorInfo.privacyLevels);
    const tiktokVideo = { type: 'video', url: 'https://cdn.example.test/tiktok.mp4', width: 1080, height: 1920, duration: 10, size: 2000, mimeType: 'video/mp4' };
    const tiktokOptions = { privacyLevel: 'SELF_ONLY', allowComment: false, allowDuet: false, allowStitch: false, contentPreviewConfirmed: true, expressConsentGiven: true };
    const tiktokDraft = overrides => draft({ content: 'TikTok caption', platforms: ['tiktok'], accounts: ['tiktok-fixture'], mediaItems: [tiktokVideo], platformOverrides: { tiktok: { options: { ...tiktokOptions, ...overrides } } } });
    beforeWrites = writes.length;
    const invalidPrivacy = await tiktokDraft({ privacyLevel: 'PUBLIC_TO_EVERYONE' }); result = await publish(invalidPrivacy); assert.equal(result.status, 422); assert.equal(result.data.error.code, 'TIKTOK_ACCOUNT_RESTRICTIONS'); assert.equal(writes.length, beforeWrites);
    const invalidDuet = await tiktokDraft({ allowDuet: true }); result = await publish(invalidDuet); assert.equal(result.status, 422); assert.equal(writes.length, beforeWrites);
    const validTiktok = await tiktokDraft(); creatorInfo.creator.canPostMore = false; result = await publish(validTiktok); assert.equal(result.status, 422); assert.equal(writes.length, beforeWrites); creatorInfo.creator.canPostMore = true;
    const longTiktok = await draft({ content: 'TikTok longer than this account permits', platforms: ['tiktok'], accounts: ['tiktok-fixture'], mediaItems: [{ ...tiktokVideo, duration: 31 }], platformOverrides: { tiktok: { options: tiktokOptions } } }); result = await publish(longTiktok); assert.equal(result.status, 422); assert.equal(writes.length, beforeWrites);
    result = await publish(validTiktok); assert.equal(result.status, 200); assert.deepEqual(writes.at(-1).payload.platforms[0].platformSpecificData, tiktokOptions);
    const tiktokDraftUpload = await tiktokDraft({ draft: true, privacyLevel: 'PUBLIC_TO_EVERYONE', allowDuet: true });
    result = await publish(tiktokDraftUpload); assert.equal(result.status, 200, 'Draft delivery lets the creator choose final privacy and interaction settings in TikTok.');
    const remoteTiktokDraft = remotePosts.get(result.data.post.externalId); remoteTiktokDraft.platforms[0].platformSpecificData = { tiktokSettings: { draft: true, content_preview_confirmed: true, express_consent_given: true }, isDraft: true };
    result = await request(`${integrations}/status?postId=${tiktokDraftUpload.id}`); assert.equal(result.status, 200); assert.equal(result.data.post.platformOverrides.tiktok.options.draft, true); assert.equal(result.data.post.platformOverrides.tiktok.options.isDraft, undefined);
    assert.equal(result.data.post.platformOverrides.tiktok.options.expressConsentGiven, true); assert.equal(result.data.post.platformOverrides.tiktok.options.tiktokSettings, undefined);
    assert.equal((await request(`${project}/approvals/posts`)).status, 200, 'A provider-only TikTok draft receipt must not break the approval queue.');
    const unconsentedDraft = await tiktokDraft({ draft: true, expressConsentGiven: false }); beforeWrites = writes.length; result = await publish(unconsentedDraft); assert.equal(result.status, 422); assert.equal(writes.length, beforeWrites);
    const remapping = await draft(); validationHook = () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'changed-profile', projectId); beforeWrites = writes.length;
    result = await publish(remapping); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROJECT_CONNECTION_CHANGED'); assert.equal(writes.length, beforeWrites);
    assert.ok(calls.some(call => call.url.pathname === '/api/v1/tools/validate/post')); assert.ok(originalCopies.length > 1);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
