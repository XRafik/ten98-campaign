// Content approval of edits to published posts (council decision ten98-code-system#30, Q2 amendment): with Require
// approval on, social/edit-published and social/update-metadata need an approved review of exactly the proposed edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../server/database.ts';
import { handleApprovals, assertPublishingApproval } from '../server/approvals.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const profileId = 'review-profile';
const accounts = [['fb-a', 'facebook'], ['fb-b', 'facebook'], ['yt-a', 'youtube'], ['yt-b', 'youtube']].map(([_id, platform]) => ({ _id, profileId, platform, isActive: true }));
const video = { type: 'video', url: 'https://cdn.example.test/launch.mp4', mimeType: 'video/mp4', size: 1048576, duration: 30, width: 1920, height: 1080 };

// The app over HTTP with a stubbed Zernio. Paid calls are never made; `writes` lists every provider mutation.
async function fixture(t, { admin = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-published-edit-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Campaign</title>');
  const origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'fixture-key' } }), originalFetch = globalThis.fetch;
  const writes = [], remotePosts = new Map(); let ownerCookie, created = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    if (url.pathname === '/api/v1/tools/validate/post') return Response.json({ valid: true, warnings: [] });
    const method = options.method || 'GET'; let result;
    if (method === 'GET' && url.pathname === '/api/v1/accounts') result = { accounts };
    else if (method === 'POST' && url.pathname === '/api/v1/posts') {
      const payload = JSON.parse(options.body); writes.push({ path: url.pathname, payload });
      const remote = { _id: `remote-${++created}`, content: payload.content, mediaItems: payload.mediaItems || [], status: 'published', platforms: payload.platforms.map(copy => ({ ...copy, status: 'published' })) };
      remotePosts.set(remote._id, remote); result = { post: remote };
    } else if (url.pathname.startsWith('/api/v1/posts/')) {
      const [, , , , id, action] = url.pathname.split('/'), remote = remotePosts.get(id); assert.ok(remote, url.pathname);
      if (method === 'GET' && !action) result = { post: remote };
      else if (method === 'POST' && ['edit', 'update-metadata', 'unpublish'].includes(action)) {
        const payload = JSON.parse(options.body); writes.push({ path: url.pathname, payload });
        const copy = remote.platforms.find(item => item.accountId === payload.accountId);
        if (action === 'edit') copy.customContent = payload.content;
        if (action === 'unpublish') copy.status = 'cancelled';
        result = action === 'update-metadata' ? { success: true, updatedFields: ['title', 'tags'].filter(field => Object.hasOwn(payload, field)) } : { success: true };
      } else throw new Error(`Unexpected provider call ${method} ${url.pathname}`);
    } else throw new Error(`Unexpected provider call ${method} ${url.pathname}`);
    return Response.json(result);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, key } = {}) {
    const result = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0] };
  }
  const post = (path, body, options = {}) => request(path, { ...options, method: 'POST', body });
  const password = 'a sufficiently long published edit fixture password';
  const setup = await post('/api/auth/setup', { name: 'Fixture Owner', email: 'owner@example.test', password }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
  const state = (await request('/api/state')).data, projectId = state.projectId, project = `/api/projects/${projectId}`, workspaceId = state.workspaces[0].id;
  assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
  const passwordHash = (await app.sql.get('SELECT password FROM users WHERE id=?', state.user.id)).password;
  async function member(name, role) {
    const userId = randomUUID(), email = `${name}@example.test`;
    await app.sql.run('INSERT INTO users(id,name,email,password) VALUES(?,?,?,?)', userId, name, email, passwordHash);
    await app.sql.run('INSERT INTO memberships VALUES(?,?,?)', workspaceId, userId, role);
    const login = await post('/api/auth/login', { email, password }); assert.equal(login.status, 200);
    return login.cookie;
  }
  const cookies = { owner: ownerCookie, editor: await member('fixture-editor', 'editor'), ...(admin ? { admin: await member('fixture-admin', 'admin') } : {}) };
  const setPolicy = async requireApproval => assert.equal((await post(project + '/approvals/policy', { requireApproval })).status, 200);
  // A post already published on the given copies, as a provider refresh stores it.
  async function seedPublished(copies, extra = {}) {
    const remote = { _id: `remote-${++created}`, content: 'Live text', status: 'published', ...extra, platforms: copies.map(copy => ({ ...copy, status: 'published' })) };
    remotePosts.set(remote._id, remote);
    const local = await app.store.create(projectId, 'posts', { content: remote.content, platforms: [...new Set(copies.map(copy => copy.platform))], accounts: copies.map(copy => copy.accountId), mediaItems: remote.mediaItems || [], ...(remote.tags ? { tags: remote.tags } : {}), status: 'published', providerStatus: 'published', externalId: remote._id, zernioProfileId: profileId, providerResults: structuredClone(remote.platforms) });
    return local.id;
  }
  const action = (route, body, role = 'owner') => post(`${project}/integrations/${route}`, body, { cookie: cookies[role], key: `${route.slice(7)}-${randomUUID()}` });
  const propose = (postId, route, proposal, role = 'editor') => post(`${project}/approvals/posts/${postId}/request`, { action: route, proposal }, { cookie: cookies[role] });
  const review = (postId, reviewId, role = 'admin') => post(`${project}/approvals/posts/${postId}/review`, { decision: 'approved', reviewId, note: 'Checked the edit.' }, { cookie: cookies[role] });
  async function approveProposal(postId, route, proposal, requester = 'editor', reviewer = 'admin') {
    const requested = await propose(postId, route, proposal, requester); assert.equal(requested.status, 200, JSON.stringify(requested.data));
    const reviewed = await review(postId, requested.data.item.review.id, reviewer); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    return reviewed.data.item.review;
  }
  return { app, request, post, project, projectId, cookies, writes, remotePosts, setPolicy, seedPublished, action, propose, review, approveProposal };
}
const facebookCopies = [{ platform: 'facebook', accountId: 'fb-a' }, { platform: 'facebook', accountId: 'fb-b' }];
const youtubeCopies = [{ platform: 'youtube', accountId: 'yt-a', platformPostId: 'aaaaaaaaaaa' }, { platform: 'youtube', accountId: 'yt-b', platformPostId: 'bbbbbbbbbbb' }];
const seedYouTube = f => f.seedPublished(youtubeCopies, { content: 'Video description', tags: ['launch'], mediaItems: [video] });

test('with approval required, editing a published post\'s text needs an approved review of that edit', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  await f.setPolicy(true);
  const draft = await f.post(f.project + '/posts', { content: 'Reviewed launch text', platforms: ['facebook'], accounts: ['fb-a'] }, { cookie: f.cookies.editor }); assert.equal(draft.status, 201);
  const requested = await f.post(`${f.project}/approvals/posts/${draft.data.record.id}/request`, {}, { cookie: f.cookies.editor }); assert.equal(requested.status, 200);
  assert.equal((await f.review(draft.data.record.id, requested.data.item.review.id)).status, 200);
  const published = await f.post(f.project + '/integrations/social/publish', { postId: draft.data.record.id }, { cookie: f.cookies.editor, key: 'published-edit-publish' }); assert.equal(published.status, 200, JSON.stringify(published.data));
  const writes = f.writes.length;
  // The publish approval covers the post as published, not a later change to its text.
  for (const role of ['admin', 'owner']) {
    const result = await f.action('social/edit-published', { postId: draft.data.record.id, accountId: 'fb-a', content: 'Replacement text', confirmEdit: true }, role);
    assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_STALE');
  }
  assert.equal(f.writes.length, writes, 'No edit reaches the provider.');
  assert.equal(f.remotePosts.get(published.data.post.externalId).platforms[0].customContent, undefined);
});

test('an approved published-text edit is sent once, and an edit differing in any field is refused before the provider', { skip: postgresSkip }, async t => {
  const f = await fixture(t), postId = await f.seedPublished(facebookCopies);
  await f.setPolicy(true);
  const approved = { accountId: 'fb-a', content: 'Approved replacement text' };
  const stored = await f.approveProposal(postId, 'social/edit-published', approved);
  for (const [field, changed] of [['content', { content: 'Approved replacement text, then changed' }], ['accountId', { accountId: 'fb-b' }]]) {
    const result = await f.action('social/edit-published', { postId, ...approved, ...changed, confirmEdit: true });
    assert.equal(result.status, 409, `${field}: ${JSON.stringify(result.data)}`); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_STALE', field);
  }
  assert.equal(f.writes.length, 0);
  const result = await f.action('social/edit-published', { postId, ...approved, confirmEdit: true });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(f.writes.map(write => write.payload), [{ platform: 'facebook', ...approved }]);
  // The review stores the proposal, the edit it fingerprints, and the edited copy for the reviewer.
  assert.deepEqual(stored.snapshot.proposal, approved);
  assert.deepEqual(stored.snapshot.publishedEdit, { path: 'social/edit-published', accountId: 'fb-a', platform: 'facebook', content: approved.content });
  assert.equal(stored.snapshot.accountOverrides['fb-a'].content, approved.content, 'The reviewer sees the edited copy.');
});

test('an approved YouTube metadata edit is sent once, and an edit differing in any field is refused before the provider', { skip: postgresSkip }, async t => {
  const f = await fixture(t), postId = await seedYouTube(f);
  await f.setPolicy(true);
  const approved = { accountId: 'yt-a', videoId: 'aaaaaaaaaaa', title: 'Approved title', tags: ['approved', 'launch'] };
  const stored = await f.approveProposal(postId, 'social/update-metadata', approved);
  const { title, tags, ...withoutMetadata } = approved;
  for (const [field, body] of [['title', { ...approved, title: 'Changed title' }], ['title omitted', { ...withoutMetadata, tags }], ['tags', { ...approved, tags: ['approved'] }], ['tags omitted', { ...withoutMetadata, title }], ['accountId and videoId', { ...approved, accountId: 'yt-b', videoId: 'bbbbbbbbbbb' }], ['videoId', { ...approved, videoId: 'bbbbbbbbbbb' }]]) {
    const result = await f.action('social/update-metadata', { postId, ...body, confirmEdit: true });
    assert.equal(result.status, 409, `${field}: ${JSON.stringify(result.data)}`); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_STALE', field);
  }
  assert.equal(f.writes.length, 0);
  const result = await f.action('social/update-metadata', { postId, ...approved, confirmEdit: true });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(f.writes.map(write => write.payload), [{ platform: 'youtube', accountId: 'yt-a', title, tags }]);
  assert.deepEqual(stored.snapshot.publishedEdit, { path: 'social/update-metadata', platform: 'youtube', ...approved });
});

test('without a review, published edits are refused while approval is required, and removal is never gated', { skip: postgresSkip }, async t => {
  const f = await fixture(t), textPost = await f.seedPublished(facebookCopies), videoPost = await seedYouTube(f);
  const edit = { postId: textPost, accountId: 'fb-a', content: 'Edited text', confirmEdit: true }, metadata = { postId: videoPost, accountId: 'yt-a', videoId: 'aaaaaaaaaaa', title: 'Edited title', confirmEdit: true };
  // Approval optional: unchanged behaviour, no review needed.
  assert.equal((await f.action('social/edit-published', edit)).status, 200);
  assert.equal((await f.action('social/update-metadata', metadata)).status, 200);
  assert.equal(f.writes.length, 2);
  await f.setPolicy(true);
  for (const [route, body] of [['social/edit-published', { ...edit, content: 'Edited again' }], ['social/update-metadata', { ...metadata, title: 'Edited again' }]]) {
    const result = await f.action(route, body);
    assert.equal(result.status, 403, `${route}: ${JSON.stringify(result.data)}`); assert.equal(result.data.error.code, 'PUBLISHING_APPROVAL_REQUIRED', route);
  }
  assert.equal(f.writes.length, 2, 'No unreviewed edit reaches the provider.');
  const removed = await f.action('social/unpublish', { postId: textPost, accountId: 'fb-b', confirmRemoval: true });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(f.writes.length, 3); assert.match(f.writes[2].path, /\/unpublish$/);
});

test('a published-edit proposal follows the self-review rule and its single-administrator exception', { skip: postgresSkip }, async t => {
  await t.test('another owner or administrator is active', async t => {
    const f = await fixture(t), postId = await f.seedPublished(facebookCopies), proposal = { accountId: 'fb-a', content: 'Administrator edit' };
    await f.setPolicy(true);
    const requested = await f.propose(postId, 'social/edit-published', proposal, 'admin'); assert.equal(requested.status, 200, JSON.stringify(requested.data));
    let result = await f.review(postId, requested.data.item.review.id, 'admin');
    assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVAL_SELF_REVIEW'); assert.match(result.data.error.message, /: Fixture Owner\.$/);
    assert.equal((await f.action('social/edit-published', { postId, ...proposal, confirmEdit: true }, 'admin')).data.error.code, 'PUBLISHING_APPROVAL_REQUIRED');
    result = await f.review(postId, requested.data.item.review.id, 'owner'); assert.equal(result.status, 200); assert.equal(result.data.item.review.selfApproved, false);
    assert.equal((await f.action('social/edit-published', { postId, ...proposal, confirmEdit: true }, 'admin')).status, 200);
    assert.equal(f.writes.length, 1);
  });
  await t.test('the single owner or administrator', async t => {
    const f = await fixture(t, { admin: false }), postId = await seedYouTube(f), proposal = { accountId: 'yt-a', videoId: 'aaaaaaaaaaa', tags: ['solo'] };
    await f.setPolicy(true);
    const reviewed = await f.approveProposal(postId, 'social/update-metadata', proposal, 'owner', 'owner');
    assert.equal(reviewed.selfApproved, true);
    assert.equal((await f.app.sql.get('SELECT self_approved FROM post_approval_reviews WHERE id = ?', reviewed.id)).self_approved, true);
    assert.equal((await f.action('social/update-metadata', { postId, ...proposal, confirmEdit: true })).status, 200);
    assert.equal(f.writes.length, 1);
  });
});

test('an invalid published-edit proposal opens no review', { skip: postgresSkip }, async t => {
  const f = await fixture(t), textPost = await f.seedPublished([{ platform: 'facebook', accountId: 'fb-a' }]), videoPost = await seedYouTube(f);
  await f.setPolicy(true);
  for (const [postId, body, code] of [
    [textPost, { action: 'social/unpublish', proposal: { accountId: 'fb-a' } }, 'INVALID_APPROVAL_FIELDS'],
    [textPost, { action: ['social/edit-published'], proposal: { accountId: 'fb-a', content: 'Text' } }, 'INVALID_APPROVAL_FIELDS'],
    [textPost, { action: 'social/edit-published', proposal: { accountId: 'fb-a', content: 'Text', confirmEdit: true } }, 'INVALID_APPROVAL_FIELDS'],
    [textPost, { action: 'social/edit-published', proposal: { accountId: 'fb-b', content: 'Text' } }, 'POST_ACCOUNT_NOT_PUBLISHED'],
    [textPost, { action: 'social/update-metadata', proposal: { accountId: 'fb-a', videoId: 'aaaaaaaaaaa', title: 'Title' } }, 'POST_ACTION_UNSUPPORTED'],
    [videoPost, { action: 'social/update-metadata', proposal: { accountId: 'yt-a', videoId: 'aaaaaaaaaaa' } }, 'EMPTY_METADATA_UPDATE'],
    [videoPost, { action: 'social/update-metadata', proposal: { accountId: 'yt-a', videoId: 'short', title: 'Title' } }, 'INVALID_VIDEO'],
    [videoPost, { proposal: { content: 'Published posts are not rescheduled', mode: 'draft' } }, 'POST_NOT_EDITABLE'],
  ]) {
    const result = await f.post(`${f.project}/approvals/posts/${postId}/request`, body, { cookie: f.cookies.editor });
    assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result.data)); assert.equal(result.data.error.code, code, JSON.stringify(body));
  }
  assert.equal(Number((await f.app.sql.get('SELECT count(*) AS count FROM post_approval_reviews')).count), 0);
  assert.equal(f.writes.length, 0);
});

// Snapshots only gain a key for a proposed published edit, so reviews approved before that coverage keep matching.
test('an approved local post keeps its fingerprint and stays approved', { skip: postgresSkip }, async t => {
  const { db, pool, sql } = await testDatabase(t);
  await pool.query("INSERT INTO users (id, name, email) VALUES ('blair','Blair Owner','blair@example.test'),('casey','Casey Editor','casey@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('project-a','w','A'); INSERT INTO memberships VALUES ('w','blair','owner'),('w','casey','editor')");
  const store = createStore(db), project = { id: 'project-a' }, roles = { blair: 'owner', casey: 'editor' };
  const invoke = async (path, userId, body = {}) => { let result; await handleApprovals({ db, store, project, role: roles[userId], user: { id: userId, name: userId }, req: { method: 'POST' }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } }); return result; };
  assert.equal((await invoke('policy', 'blair', { requireApproval: true })).status, 200);
  const post = await store.create(project.id, 'posts', { content: 'Stable fingerprint fixture', platforms: ['facebook', 'linkedin'], accounts: ['facebook-a', 'linkedin-a'], tags: ['launch'], status: 'draft', mediaItems: [], accountOverrides: { 'linkedin-a': { platform: 'linkedin', content: 'LinkedIn copy' } } });
  const requested = await invoke(`posts/${post.id}/request`, 'casey'); assert.equal(requested.status, 200, JSON.stringify(requested.data));
  // Recorded with the approvals code before published edits were covered (cabc2f4).
  assert.equal((await sql.get('SELECT fingerprint FROM post_approval_reviews WHERE id = ?', requested.data.item.review.id)).fingerprint, 'c1ac6df89d6e937743a36ee30f6e95fe8ce6d155cf07dd1841057045c62db5c9');
  assert.equal((await invoke(`posts/${post.id}/review`, 'blair', { decision: 'approved', reviewId: requested.data.item.review.id })).status, 200);
  await assertPublishingApproval({ db, store, project }, post);
});
