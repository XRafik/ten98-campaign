import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

// External contracts: current official OpenAPI 1.295.0 /accounts/{accountId}/posts,
// /posts?source=external and /posts/sync-external, checked 2026-10-19.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-external-posts-')), origin = 'https://library.example.test', originalFetch = globalThis.fetch, calls = [];
  const app = await testApp(t, { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'synthetic-library-key' }, directScheduler: false });
  const accounts = ['youtube', 'linkedin', 'googlebusiness', 'discord'].map(platform => ({ _id: 'account-' + platform, platform, profileId: 'library-profile', isActive: true, platformUserId: 'native-' + platform, displayName: platform + ' account' }));
  const post = { platform: 'youtube', platformPostId: 'video-one', platformPostUrl: 'https://www.youtube.com/watch?v=video-one', content: 'A post published on the platform', publishedAt: '2026-10-19T10:00:00.000Z', mediaType: 'video', analytics: { likes: 4, comments: 0, impressions: 0, lastUpdated: '2026-10-19T10:01:00.000Z' }, accessToken: 'never-expose' };
  const state = { post, hook: null, found: true, skipped: false, posts: [post], pages: null };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.headers.Authorization, 'Bearer synthetic-library-key');
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body, key: options.headers['Idempotency-Key'] });
    if (state.hook) { const response = await state.hook(url, options, body); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [...accounts, { _id: 'account-foreign', profileId: 'other-profile', platform: 'youtube', isActive: true }] });
    if (url.pathname.endsWith('/sync-external')) { assert.equal(method, 'POST'); assert.ok(options.headers['Idempotency-Key']); assert.deepEqual(Object.keys(body).sort(), ['accountId', body.url ? 'url' : 'postId'].sort()); return Response.json({ synced: { postsFound: 1, postsSynced: state.found ? 1 : 0, skipped: state.skipped }, found: state.found, post: state.found ? state.post : null }); }
    if (/\/accounts\/[^/]+\/posts$/.test(url.pathname)) return Response.json({ status: 'success', posts: state.posts.map(row => ({ id: row.platformPostId, platform: row.platform, message: row.content, createdTime: row.publishedAt, permalink: row.platformPostUrl, mediaType: row.mediaType, likeCount: row.analytics?.likes, commentCount: row.analytics?.comments, token: 'never-expose' })), lastUpdated: '2026-10-19T10:01:00.000Z' });
    assert.ok(url.pathname.endsWith('/posts'), url.pathname); assert.equal(url.searchParams.get('source'), 'external'); assert.equal(url.searchParams.get('profileId'), 'library-profile'); assert.equal(url.searchParams.get('limit'), '25');
    return Response.json({ posts: state.posts, pagination: state.pages || { page: Number(url.searchParams.get('page')), limit: 25, total: state.posts.length, pages: state.posts.length ? 1 : 0 } });
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}/api`; let cookie;
  async function request(path, body, key = randomUUID(), authenticated = true) { const response = await originalFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie && authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/auth/setup', { name: 'Library owner', email: 'library@example.test', password: 'Synthetic external library fixture passphrase!' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie;
  const projectId = setup.data.projectId, project = '/projects/' + projectId; await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'library-profile', projectId);
  const campaign = await app.store.create(projectId, 'campaigns', { name: 'External launch', channel: 'social', status: 'draft' });
  const route = (task, platform = 'youtube') => `${project}/integrations/publishing/accounts/account-${platform}/${task}`;
  return { app, projectId, project, campaign, accounts, state, calls, request, route, writes: () => calls.filter(row => row.method !== 'GET'), async close() { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); } };
}

test('external discovery uses live latest posts and paginated scoped history, preserving missing metrics and stripping unknown fields', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const live = await f.request(f.route('posts')); assert.equal(live.status, 200, JSON.stringify(live.data)); assert.equal(live.data.source, 'platform'); assert.equal(live.data.posts[0].platformPostId, 'video-one'); assert.equal(live.data.posts[0].analytics.comments, 0); assert.equal(live.data.posts[0].analytics.impressions, undefined);
    const history = await f.request(f.route('external-posts') + '?page=1'); assert.equal(history.status, 200, JSON.stringify(history.data)); assert.equal(history.data.source, 'external'); assert.equal(history.data.posts[0].analytics.impressions, 0); assert.equal(history.data.posts[0].analytics.reach, undefined); assert.equal(history.data.pagination.total, 1);
    assert.ok(f.calls.some(row => row.url.searchParams.get('accountId') === 'account-youtube' && row.url.searchParams.get('source') === 'external'));
    assert.equal(JSON.stringify([history.data, live.data]).includes('never-expose'), false); assert.equal(f.writes().length, 0); assert.equal((await f.app.store.list(f.projectId, 'posts')).length, 0);
    f.state.posts = []; const empty = await f.request(f.route('external-posts')); assert.equal(empty.status, 200); assert.equal(empty.data.pagination.pages, 0);
    f.state.posts = [f.state.post]; f.state.pages = { page: 2, limit: 25, total: 26, pages: 2 }; const second = await f.request(f.route('external-posts') + '?page=2'); assert.equal(second.status, 200); assert.equal(second.data.pagination.page, 2);
  } finally { await f.close(); }
});

test('external imports save separate campaign references, replay exact keys and update associations without publishing or approvals', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const draft = await f.app.store.create(f.projectId, 'posts', { content: 'Approved draft stays separate', status: 'draft', approval: 'approved' }), original = JSON.stringify(await f.app.store.get(f.projectId, 'posts', draft.id)), body = { postId: 'video-one', campaignId: f.campaign.id }, key = randomUUID();
    const result = await f.request(f.route('external-import'), body, key); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.imported, true); assert.equal(result.data.post.source, 'external'); assert.equal(JSON.stringify(result.data).includes('never-expose'), false);
    const replay = await f.request(f.route('external-import'), body, key); assert.deepEqual(replay.data, result.data); assert.equal(f.writes().length, 1);
    let refs = await f.request(f.route('external-references')); assert.equal(refs.status, 200); assert.equal(refs.data.references.length, 1); assert.equal(refs.data.references[0].campaignId, f.campaign.id); assert.equal(refs.data.references[0].campaignName, 'External launch'); assert.equal(refs.data.references[0].externalId, undefined);
    f.state.skipped = true; const update = await f.request(f.route('external-import'), { url: 'https://youtu.be/video-one', campaignId: '' }); assert.equal(update.status, 200, JSON.stringify(update.data)); assert.equal(update.data.synced.skipped, true);
    refs = await f.request(f.route('external-references')); assert.equal(refs.data.references.length, 1); assert.equal(refs.data.references[0].campaignId, ''); assert.equal(JSON.stringify(await f.app.store.get(f.projectId, 'posts', draft.id)), original);
    assert.ok(f.writes().every(row => row.url.pathname.endsWith('/posts/sync-external'))); assert.equal((await f.app.store.list(f.projectId, 'posts')).length, 1);
    const removed = await f.request(f.route('external-remove'), { postId: 'video-one', confirmed: true }); assert.equal(removed.status, 200); assert.equal(removed.data.removed, true); assert.equal((await f.request(f.route('external-references'))).data.references.length, 0); assert.equal(f.writes().length, 2);
  } finally { await f.close(); }
});

test('external library rejects foreign accounts, unsupported operations, malformed filters, invalid locators and foreign campaigns before sync', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.request(f.route('posts'), undefined, undefined, false)).status, 401); assert.equal((await f.request(f.route('posts', 'foreign'))).status, 403); assert.equal((await f.request(f.route('posts', 'discord'))).status, 422); assert.equal((await f.request(f.route('posts', 'googlebusiness'))).status, 422);
    for (const query of ['?source=zernio', '?page=0', '?page=-1', '?page=1&page=2', '?page=1.1', '?page=1000000', '?profileId=other']) assert.equal((await f.request(f.route('external-posts') + query)).status, 400, query);
    for (const body of [{}, { url: '   ' }, { url: '\t\n' }, { url: '' }, { postId: 'video-one', url: 'https://youtu.be/video-one' }, { postId: 'bad id' }, { url: 'javascript:alert(1)' }, { url: 'https://127.0.0.1/post' }, { url: 'https://[::1]/post' }, { url: 'https://test.internal/post' }, { postId: 'video-one', campaignId: 'foreign' }, { postId: 'video-one', publishNow: true }]) assert.equal((await f.request(f.route('external-import'), body)).status, 400, JSON.stringify(body));
    f.accounts[0].needsReconnection = true; assert.equal((await f.request(f.route('external-import'), { postId: 'video-one' })).status, 409); assert.equal((await f.request(f.route('external-references'))).status, 200); f.accounts[0].needsReconnection = false;
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await f.request(f.route('external-import'), { postId: 'video-one' })).status, 403); assert.equal((await f.request(f.route('external-posts'))).status, 200); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('external history fails closed on wrong platform/profile/account, invalid pagination and malformed rows', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const post of [{ ...f.state.post, platform: 'facebook' }, { ...f.state.post, accountId: 'foreign' }, { ...f.state.post, profileId: 'other-profile' }, { ...f.state.post, platformPostId: '' }, { ...f.state.post, analytics: { impressions: -1 } }, { ...f.state.post, platformPostUrl: 'javascript:alert(1)' }, { ...f.state.post, content: {} }, { ...f.state.post, publishedAt: 'invalid' }]) { f.state.posts = [post]; assert.equal((await f.request(f.route('external-posts'))).status, 502); }
    f.state.posts = [f.state.post, f.state.post]; assert.equal((await f.request(f.route('external-posts'))).status, 502);
    f.state.posts = [f.state.post]; f.state.pages = { page: 1, limit: 25, total: 26, pages: 2 }; assert.equal((await f.request(f.route('external-posts'))).status, 502, 'A truncated first page does not imply a complete history.');
    f.state.hook = url => url.pathname.endsWith('/posts') ? Response.json({ accountId: 'foreign', posts: [f.state.post], pagination: { page: 1, limit: 25, total: 1, pages: 1 } }) : undefined; assert.equal((await f.request(f.route('external-posts'))).status, 502);
  } finally { await f.close(); }
});

test('parallel duplicate imports under one action key reach the provider once', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const body = { postId: 'video-one', campaignId: f.campaign.id }, key = randomUUID();
    const results = await Promise.all([f.request(f.route('external-import'), body, key), f.request(f.route('external-import'), body, key)]);
    assert.equal(f.writes().filter(row => row.url.pathname.endsWith('/posts/sync-external')).length, 1, 'The key lock lets only one of the duplicates send the provider sync.');
    assert.ok(results.some(row => row.status === 200 && row.data.operation?.status === 'complete'), JSON.stringify(results));
    assert.ok(results.every(row => row.status === 200 || row.data.error?.code === 'OPERATION_UNCERTAIN'), JSON.stringify(results));
    assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM zernio_external_post_references')).total, 1);
  } finally { await f.close(); }
});

test('accepted imports with unreadable, mismatched or changed-access receipts remain uncertain and cannot resend the same action', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const body = { postId: 'video-one' }, key = randomUUID(); f.state.post = { ...f.state.post, platformPostId: 'different-post' };
    const bad = await f.request(f.route('external-import'), body, key); assert.equal(bad.status, 409, JSON.stringify(bad.data)); assert.equal(bad.data.operation.status, 'uncertain'); assert.equal((await f.request(f.route('external-import'), body, key)).status, 409); assert.equal((await f.request(f.route('external-import'), body)).status, 409); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(f.route('external-references'))).data.references.length, 0);
    f.state.post = { ...f.state.post, platformPostId: 'video-two' }; f.state.hook = async url => { if (url.pathname.endsWith('/sync-external')) await f.app.sql.run("UPDATE memberships SET role='viewer'"); };
    const lost = await f.request(f.route('external-import'), { postId: 'video-two' }); assert.equal(lost.data.operation.status, 'uncertain'); assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM zernio_external_post_references')).total, 0);
  } finally { await f.close(); }
});

test('not-found and LinkedIn contentless imports remain explicit and provider account changes isolate saved references', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    f.state.found = false; const missing = await f.request(f.route('external-import'), { postId: 'missing' }); assert.equal(missing.status, 200); assert.equal(missing.data.found, false); assert.equal(missing.data.imported, false); assert.equal((await f.request(f.route('external-references'))).data.references.length, 0);
    f.state.found = true; f.state.post = { platform: 'linkedin', platformPostId: 'urn:li:share:123456789', publishedAt: '2026-10-19T10:00:00.000Z', analytics: { impressions: 0 } };
    const linked = await f.request(f.route('external-import', 'linkedin'), { url: 'urn:li:share:123456789', campaignId: f.campaign.id }); assert.equal(linked.status, 200, JSON.stringify(linked.data)); assert.equal(linked.data.post.content, null); assert.equal(linked.data.post.platformPostUrl, '');
    await f.app.store.remove(f.projectId, 'campaigns', f.campaign.id); assert.equal((await f.request(f.route('external-references', 'linkedin'))).data.references[0].campaignId, '');
    f.accounts[1].platformUserId = 'new-native-linkedin'; assert.equal((await f.request(f.route('external-references', 'linkedin'))).data.references.length, 0, 'A reconnected account identity never inherits another native channel’s campaign references.');
  } finally { await f.close(); }
});

test('refresh preserves campaign links beyond the newest 250 references unless reassignment is explicit', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const first = await f.request(f.route('external-import'), { postId: 'video-one', campaignId: f.campaign.id }); assert.equal(first.status, 200);
    const insert = (...values) => f.app.sql.run('INSERT INTO zernio_external_post_references (project_id, profile_id, account_id, native_account_id, platform_post_id, data, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...values);
    for (let index = 0; index < 250; index++) await insert(f.projectId, 'library-profile', 'account-youtube', 'native-youtube', 'newer-' + index, JSON.stringify({ ...f.state.post, platformPostId: 'newer-' + index }), null, '2030-01-01T00:00:00.000Z');
    const index = await f.request(f.route('external-references')); assert.equal(index.data.references.length, 250); assert.equal(index.data.references.some(row => row.platformPostId === 'video-one'), false);
    const manual = await f.request(f.route('external-import'), { url: 'https://youtu.be/video-one' }); assert.equal(manual.status, 200, JSON.stringify(manual.data)); assert.equal(manual.data.campaignId, f.campaign.id, 'The default manual URL form retains a previously linked campaign even when its reference is outside the capped index.');
    const refreshed = await f.request(f.route('external-import'), { postId: 'video-one' }); assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data)); assert.equal(refreshed.data.campaignId, f.campaign.id);
    assert.equal((await f.app.sql.get('SELECT campaign_id FROM zernio_external_post_references WHERE platform_post_id=?', 'video-one')).campaign_id, f.campaign.id);
    const cleared = await f.request(f.route('external-import'), { postId: 'video-one', campaignId: '' }); assert.equal(cleared.status, 200); assert.equal(cleared.data.campaignId, '');
  } finally { await f.close(); }
});

test('external library UI ignores late scope responses and retries only its original uncertain import key', async () => {
  const source = await readFile(new URL('../src/ZernioPostLibrary.tsx', import.meta.url), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const accepted = [], reads = { current: 0 }; let finish, live = true;
  const load = compile(section('async function load(', '  async function importPost('), { tab: 'external-posts', page: 1, current: () => live, accountId: 'account-youtube', account: { platform: 'youtube' }, reads, available: true, target: '/publishing/account-youtube', setLoaded() {}, setPosts: value => accepted.push(value), setPagination() {}, setSaved: value => accepted.push(value), requester: { current: () => new Promise(resolve => { finish = resolve; }) } });
  const late = load(); live = false; finish({ references: [{ platformPostId: 'old-project-private' }] }); await late; assert.deepEqual(accepted, [[]], 'Only the initial clearing can update the screen after its scope changes.');
  const keys = { current: new Map() }, requests = [], pending = [], notices = []; let unknown = true;
  const importPost = compile(section('async function importPost(', '  async function removeReference('), { current: () => true, canWrite: true, available: true, accountId: 'account-youtube', target: '/publishing/account-youtube', crypto, keys, setPendingImport: value => pending.push(value), setNotice: value => notices.push(value), load: async () => {}, requester: { current: async (...args) => { requests.push(args); if (unknown) throw Object.assign(new Error('Unknown import receipt'), { status: 409, code: 'OPERATION_UNCERTAIN' }); return { operation: { status: 'complete' }, accountId: 'account-youtube', found: true, imported: true, post: { platformPostId: 'video-one' } }; } } });
  const intent = { postId: 'video-one', campaignId: '' }; await assert.rejects(importPost(intent), /Unknown import/); assert.equal(keys.current.size, 1); assert.deepEqual(pending, [intent]); unknown = false; await importPost(intent); assert.deepEqual(requests[0], requests[1]); assert.equal(keys.current.size, 0); assert.match(notices[0], /No new post was published/);
  const refreshes = [], refresh = compile(section('function refreshReference(', '  const rows ='), { saved: [{ platformPostId: 'urn:li:share:123', campaignId: 'keep-campaign' }], account: { platform: 'linkedin' }, campaignId: 'different-selected-campaign', importPost: value => refreshes.push(value) }); refresh({ platformPostId: 'urn:li:share:123', platformPostUrl: '' }); assert.deepEqual(refreshes, [{ url: 'urn:li:share:123' }], 'Refreshing a reference asks the backend to preserve its campaign and uses LinkedIn’s URL/URN import mode.');
  const formSource = /onSubmit=\{(event => \{ event.preventDefault\(\); action\(\(\) => importPost\([\s\S]+?\)\); \})\}/.exec(source)?.[1]; assert.ok(formSource);
  const submissions = [], submit = selected => compile(formSource, { action: run => run(), importPost: value => submissions.push(value), locatorType: 'url', locator: ' https://youtu.be/video-one ', campaignId: selected })({ preventDefault() {} }); submit(''); submit('__clear__'); assert.deepEqual(submissions, [{ url: 'https://youtu.be/video-one' }, { url: 'https://youtu.be/video-one', campaignId: '' }], 'Default manual imports preserve links; unlinking requires the named explicit choice.');
  for (const label of ['External post library', 'Latest platform posts', 'Synced history', 'Campaign references', 'Not reported', 'No new post was published', 'Check the same import receipt', 'LinkedIn personal', 'Insights can be delayed']) assert.ok(source.includes(label), label);
  assert.equal(source.includes('JSON.parse('), false); assert.ok(source.includes('scope.current === view')); assert.ok(source.includes('reads.current !== read')); assert.ok(source.includes('No matching post was found'));
});
