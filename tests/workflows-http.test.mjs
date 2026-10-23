import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('HTTP publishing approvals, Drive delivery links and provider outcome reviews are wired end to end', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-workflows-http-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Campaign</title>');
  const origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'private-workflows-key' } }), originalFetch = globalThis.fetch;
  const providerCalls = [], providerWrites = [], remotePosts = new Map(); let ownerCookie, failNextCreate = false, failNextPublish = false, sequence = 0, createdPosts = 0;
  const profileId = 'workflows-profile', accountId = 'workflows-account', account = { _id: accountId, profileId, platform: 'facebook', isActive: true };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer private-workflows-key');
    if (url.pathname === '/api/v1/tools/validate/post') return new Response(JSON.stringify({ valid: true, warnings: [] }));
    const method = options.method || 'GET'; providerCalls.push({ url, method }); let result;
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); result = { accounts: [account] }; }
    else if (method === 'POST' && url.pathname === '/api/v1/posts') {
      const payload = JSON.parse(options.body); providerWrites.push({ url, method, payload });
      if (failNextCreate) { failNextCreate = false; throw new Error('Provider response unavailable'); }
      const failed = failNextPublish; failNextPublish = false;
      const remote = { _id: `remote-workflow-${++createdPosts}`, content: payload.content, mediaItems: payload.mediaItems || [], status: failed ? 'failed' : 'published', platforms: payload.platforms.map(copy => ({ ...copy, status: failed ? 'failed' : 'published' })) };
      remotePosts.set(remote._id, remote); result = { post: remote };
    } else if (url.pathname.startsWith('/api/v1/posts/')) {
      const pieces = url.pathname.split('/'), remote = remotePosts.get(pieces[4]); assert.ok(remote, 'Only known submitted fixture posts reach the provider.');
      if (method === 'GET') result = { post: remote };
      else if (method === 'POST' && pieces[5] === 'retry') { providerWrites.push({ url, method, payload: JSON.parse(options.body) }); remote.status = 'publishing'; remote.platforms = remote.platforms.map(copy => ({ ...copy, status: 'pending' })); result = { post: remote }; }
      else if (method === 'POST' && pieces[5] === 'edit') { const payload = JSON.parse(options.body); providerWrites.push({ url, method, payload }); remote.content = payload.content; result = { success: true }; }
      else throw new Error('Unexpected provider mutation');
    } else throw new Error(`Unexpected provider endpoint ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, key, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const post = (path, body, options = {}) => request(path, { ...options, method: 'POST', body });
  try {
    const setup = await post('/api/auth/setup', { name: 'Workflow owner', email: 'workflow-owner@example.test', password: 'a sufficiently long workflow fixture password' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data, projectId = state.projectId, workspaceId = state.workspaces[0].id, project = `/api/projects/${projectId}`;
    assert.equal(state.user.isOperator, true);
    assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    const passwordHash = (await app.sql.get('SELECT password FROM users WHERE id=?', state.user.id)).password;
    async function member(name, role) {
      const userId = randomUUID(), email = `${name}@example.test`;
      await app.sql.run('INSERT INTO users(id,name,email,password) VALUES(?,?,?,?)', userId, name, email, passwordHash);
      const login = await post('/api/auth/login', { email, password: 'a sufficiently long workflow fixture password' }); assert.equal(login.status, 200);
      if (role) await app.sql.run('INSERT INTO memberships VALUES(?,?,?)', workspaceId, userId, role);
      return { id: userId, cookie: login.cookie, email };
    }
    const viewer = await member('workflow-viewer', 'viewer'), editor = await member('workflow-editor', 'editor'), admin = await member('workflow-admin', 'admin'), outsider = await member('workflow-outsider');
    const externalBeforeLocalChecks = providerCalls.length;
    for (const suffix of ['/approvals/policy', '/approvals/posts', '/operations']) {
      assert.equal((await request(project + suffix, { cookie: null })).status, 401);
      assert.equal((await request(project + suffix, { cookie: outsider.cookie })).status, 404);
    }
    assert.equal((await request(project + '/approvals/policy', { cookie: viewer.cookie })).status, 200);
    assert.equal((await request(project + '/approvals/posts', { cookie: viewer.cookie })).status, 200);
    assert.equal((await request(project + '/operations', { cookie: viewer.cookie })).status, 403);
    assert.equal((await request(project + '/operations', { cookie: editor.cookie })).status, 403);
    assert.equal((await request(project + '/operations', { cookie: admin.cookie })).status, 403, 'Workspace administration alone must not reveal operator recovery receipts.');
    assert.equal((await request(project + '/operations')).status, 200);
    assert.equal(providerCalls.length, externalBeforeLocalChecks, 'Local status, approval queues and recovery pages make no implicit provider calls.');
    assert.equal((await post(project + '/approvals/policy', { requireApproval: true }, { cookie: editor.cookie })).status, 403);
    assert.equal((await post(project + '/approvals/policy', { requireApproval: true })).status, 200);
    async function draft(content, extra = {}, cookie = editor.cookie) {
      const result = await post(project + '/posts', { content, platforms: ['facebook'], accounts: [accountId], ...extra }, { cookie }); assert.equal(result.status, 201); return result.data.record;
    }
    async function approve(record, cookie = ownerCookie) {
      const requested = await post(`${project}/approvals/posts/${record.id}/request`, {}, { cookie: editor.cookie }); assert.equal(requested.status, 200);
      const result = await post(`${project}/approvals/posts/${record.id}/review`, { decision: 'approved', reviewId: requested.data.item.review.id, note: 'Reviewed the content and creative.' }, { cookie }); assert.equal(result.status, 200); return result.data.item;
    }
    async function publish(record, cookie = editor.cookie, key = `publish-workflow-${++sequence}`) { return post(project + '/integrations/social/publish', { postId: record.id }, { cookie, key }); }
    const unapproved = await draft('A post that needs review'); let beforeWrites = providerWrites.length;
    let result = await publish(unapproved); assert.equal(result.status, 403); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_REQUIRED'); assert.equal(providerWrites.length, beforeWrites, 'Approval must block before the provider create request.');
    assert.equal((await post(`${project}/approvals/posts/${unapproved.id}/request`, {}, { cookie: viewer.cookie })).status, 403);
    const pending = await post(`${project}/approvals/posts/${unapproved.id}/request`, {}, { cookie: editor.cookie }); assert.equal(pending.status, 200);
    assert.equal((await post(`${project}/approvals/posts/${unapproved.id}/review`, { decision: 'approved', reviewId: pending.data.item.review.id }, { cookie: editor.cookie })).status, 403);
    assert.equal((await post(`${project}/approvals/posts/${unapproved.id}/review`, { decision: 'approved', reviewId: pending.data.item.review.id })).status, 200);
    result = await publish(unapproved); assert.equal(result.status, 200); assert.equal(providerWrites.length, beforeWrites + 1); assert.equal(result.data.post.status, 'published');
    const live = result.data.post;
    beforeWrites = providerWrites.length;
    result = await post(project + '/integrations/social/edit-published', { postId: live.id, accountId, content: 'Unreviewed provider edit', confirmEdit: true }, { cookie: editor.cookie, key: 'editor-live-edit' }); assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVED_PROVIDER_EDIT_RESTRICTED'); assert.equal(providerWrites.length, beforeWrites);
    const stale = await draft('Reviewed original text'); await approve(stale);
    assert.equal((await request(`${project}/posts/${stale.id}`, { method: 'PATCH', body: { content: 'Text edited after approval' }, cookie: editor.cookie })).status, 200);
    result = await publish(stale); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_STALE'); assert.equal(providerWrites.length, beforeWrites);
    const staleReview = await draft('Pending original text'), requested = await post(`${project}/approvals/posts/${staleReview.id}/request`, {}, { cookie: editor.cookie });
    await request(`${project}/posts/${staleReview.id}`, { method: 'PATCH', body: { content: 'Edited while review was open' }, cookie: editor.cookie });
    assert.equal((await post(`${project}/approvals/posts/${staleReview.id}/review`, { decision: 'approved', reviewId: requested.data.item.review.id })).status, 409);
    const driveAsset = await app.store.create(projectId, 'assets', { name: 'Drive original', kind: 'image', url: 'https://drive.google.com/file/d/drive-original/view', source: 'google-drive', driveId: 'drive-original', approval: 'approved', size: 1234, modifiedTime: '2026-10-18T10:00:00Z', md5Checksum: 'fixture-checksum' });
    const assetPath = `${project}/assets/${driveAsset.id}`, deliveryUrl = 'https://cdn.example.com/campaign.jpg';
    result = await request(assetPath, { method: 'PATCH', body: { deliveryUrl }, cookie: editor.cookie }); assert.equal(result.status, 200); assert.equal(result.data.record.url, driveAsset.url); assert.equal(result.data.record.driveId, 'drive-original'); assert.equal(result.data.record.source, 'google-drive'); assert.equal(result.data.record.approval, 'pending');
    assert.equal((await request(assetPath, { method: 'PATCH', body: { approval: 'approved' }, cookie: editor.cookie })).status, 403);
    assert.equal((await request(assetPath, { method: 'PATCH', body: { approval: 'approved' } })).status, 200);
    for (const unsafe of ['http://cdn.example.com/a.jpg', 'javascript:alert(1)', 'https://user:password@cdn.example.com/a.jpg', 'https://127.0.0.1/private', 'https://10.0.0.1/private', 'https://192.168.0.1/private', 'https://drive.google.com/file/d/private/view', 'https://docs.google.com/document/d/private']) assert.equal((await request(assetPath, { method: 'PATCH', body: { deliveryUrl: unsafe } })).status, 400, unsafe);
    assert.equal((await app.store.get(projectId, 'assets', driveAsset.id)).deliveryUrl, deliveryUrl, 'Invalid URLs must not replace the last good delivery link.');
    assert.equal((await post(project + '/posts', { content: 'Forged provider evidence', platforms: ['facebook'], deliveryUrl })).status, 400);
    const assetPost = await draft('Campaign with a Drive creative', { assetId: driveAsset.id }); await approve(assetPost);
    result = await publish(assetPost); assert.equal(result.status, 200); assert.deepEqual(providerWrites.at(-1).payload.mediaItems, [{ type: 'image', url: deliveryUrl, size: 1234 }]);
    const changedAssetPost = await draft('Reviewed creative changes', { assetId: driveAsset.id }); await approve(changedAssetPost);
    await request(assetPath, { method: 'PATCH', body: { deliveryUrl: 'https://cdn.example.com/replaced.jpg' } });
    beforeWrites = providerWrites.length; result = await publish(changedAssetPost); assert.equal(result.status, 409); assert.equal(providerWrites.length, beforeWrites);
    const failed = await draft('A fully failed provider post'); await approve(failed); failNextPublish = true;
    result = await publish(failed); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'failed');
    const remoteFailed = remotePosts.get(result.data.post.externalId); remoteFailed.content = 'Provider text changed outside the app'; remoteFailed.mediaItems = [{ type: 'image', url: 'https://cdn.example.com/provider-edited.jpg' }];
    beforeWrites = providerWrites.length;
    result = await post(project + '/integrations/social/retry', { postId: failed.id, confirmPublish: true }, { cookie: editor.cookie, key: 'stale-failed-retry' }); assert.equal(result.status, 409); assert.equal(providerWrites.length, beforeWrites);
    result = await request(`${project}/integrations/social/status?postId=${failed.id}`); assert.equal(result.status, 200); assert.equal(result.data.post.content, remoteFailed.content); assert.deepEqual(result.data.post.mediaItems, remoteFailed.mediaItems);
    const queue = await request(project + '/approvals/posts'); assert.equal(queue.data.posts.find(row => row.post.id === failed.id).status, 'stale');
    result = await post(project + '/integrations/social/retry', { postId: failed.id, confirmPublish: true }, { cookie: editor.cookie, key: 'unreviewed-failed-retry' }); assert.equal(result.status, 409); assert.equal(providerWrites.length, beforeWrites);
    await approve(failed); result = await post(project + '/integrations/social/retry', { postId: failed.id, confirmPublish: true }, { cookie: editor.cookie, key: 'approved-failed-retry' }); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'submitted'); assert.equal(providerWrites.at(-1).url.pathname.endsWith('/retry'), true);
    const uncertain = await draft('A provider action awaiting reconciliation'); await approve(uncertain); failNextCreate = true;
    result = await publish(uncertain, editor.cookie, 'uncertain-create-key'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const operationId = result.data.operation.id;
    const listed = await request(project + '/operations'), receipt = listed.data.operations.find(row => row.id === operationId); assert.equal(receipt.canReview, true); assert.equal(receipt.action, 'POST /integrations/social/publish'); assert.equal(JSON.stringify(listed.data).includes('private-workflows-key'), false); assert.equal(JSON.stringify(listed.data).includes(uncertain.content), false);
    const reviewPath = `${project}/operations/${operationId}/review`, review = { resolution: 'not_applied', confirmChecked: true, note: 'Checked the provider dashboard; no matching post exists.', reference: 'fixture-review-reference' };
    assert.equal((await post(reviewPath, review, { cookie: null })).status, 401); assert.equal((await post(reviewPath, review, { cookie: outsider.cookie })).status, 404); assert.equal((await post(reviewPath, review, { cookie: viewer.cookie })).status, 403); assert.equal((await post(reviewPath, review, { cookie: admin.cookie })).status, 403);
    assert.equal((await post(reviewPath, { ...review, confirmChecked: false })).status, 400);
    assert.equal((await post(reviewPath, review, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    result = await post(reviewPath, review); assert.equal(result.status, 200); assert.equal(result.data.operation.status, 'reviewed-not-applied');
    assert.equal((await post(reviewPath, review)).status, 200); assert.equal((await post(reviewPath, { ...review, resolution: 'applied' })).status, 409);
    beforeWrites = providerWrites.length; result = await publish(uncertain, editor.cookie, 'uncertain-create-key'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OPERATION_REVIEWED'); assert.equal(providerWrites.length, beforeWrites);
    result = await publish(uncertain, editor.cookie, 'manually-retried-key'); assert.equal(result.status, 200); assert.equal(providerWrites.length, beforeWrites + 1);
    const privateWorkspace = await post('/api/workspaces', { name: 'Separate team' }, { cookie: outsider.cookie }); assert.equal(privateWorkspace.status, 201);
    assert.equal((await request(`/api/projects/${privateWorkspace.data.projectId}/operations`)).status, 404);
    assert.equal((await request(`${project}/operations/not-in-this-project/review`, { method: 'POST', body: review })).status, 404);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
