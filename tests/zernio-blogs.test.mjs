import test from 'node:test';
import assert from 'node:assert/strict';
import { handleZernioBlogs } from '../server/zernio-blogs.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../server/index.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

// Contract: cached official Zernio OpenAPI 1.295.0 Blogs; WordPress scheduling
// requires native future status and an exact publication time, without a content write.
async function fixture(t, platform = 'wordpress', db) {
  db ??= (await testDatabase(t)).db;
  const profileId = 'profile-a', accountId = platform + '-account', blogId = platform === 'wordpress' ? '91' : '327';
  const account = { _id: accountId, profileId, platform, username: 'site.example.test', platformUserId: 'native-site', displayName: 'Brand site', isActive: true };
  const blog = { id: blogId, platform, title: 'Brand journal', handle: 'journal', token: 'never-expose' };
  const article = { id: '561', blogId, platform, title: 'A draft', bodyHtml: '<p>Original draft</p>', isPublished: false, ...(platform === 'wordpress' ? { status: 'draft', publishDate: null } : {}), publishedAt: null, updatedAt: '2026-10-19T09:00:00Z', secret: 'never-expose' };
  const state = { accounts: [account, { ...account, _id: 'foreign', profileId: 'other-profile' }], blog, article, blogs: [blog], articles: [article], nextCursor: null, onCall: null, receipt: null, postError: null, mappingChanged: false };
  const calls = [];
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    const call = { path, query: structuredClone(query), body: structuredClone(body), key, method }; calls.push(call);
    const override = await state.onCall?.(call);
    if (override !== undefined) return structuredClone(override);
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: structuredClone(state.accounts) }; }
    if (method === 'POST') {
      assert.equal(path, `/accounts/${accountId}/blogs/${blogId}/articles`); assert.ok(key);
      state.article = { ...state.article, ...body };
      if (state.postError) throw state.postError;
      return structuredClone(state.receipt || { platform, article: state.article });
    }
    if (path.endsWith('/articles/561')) return { platform, article: structuredClone(state.article) };
    if (path.endsWith('/articles')) return { platform, articles: structuredClone(state.articles), nextCursor: state.nextCursor };
    if (path === `/accounts/${accountId}/blogs/${blogId}`) return { platform, blog: structuredClone(state.blog) };
    if (path.endsWith('/blogs')) return { platform, blogs: structuredClone(state.blogs), nextCursor: state.nextCursor };
    assert.fail('Unexpected provider path: ' + path);
  };
  let counter = 0;
  async function request(action, { method = 'GET', body = {}, role = 'owner', key = `blog-action-${++counter}`, projectId = 'project-a', assertMapping } = {}) {
    let response;
    const context = { db, project: { id: projectId, zernioProfileId: profileId }, role, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`https://campaign.example.test/api/projects/${projectId}/integrations/blogs/${action}`), body, assertProjectMapping: expected => { assert.equal(expected, profileId); if (state.mappingChanged) throw Object.assign(new Error('Mapping changed'), { status: 409 }); assertMapping?.(); }, send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioBlogs(context, api, profileId, action.split('?')[0]); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  const route = `${accountId}/${blogId}`;
  return { db, state, account, calls, request, accountId, blogId, route, writes: () => calls.filter(call => call.method !== 'GET'), async reviewBody() { const result = await request(route); assert.equal(result.status, 200, JSON.stringify(result)); return { title: 'Reviewed draft', bodyHtml: '<p>Raw <strong>HTML</strong></p>', version: result.data.version, confirmCreate: true }; } };
}

test('blogs browse scoped provider IDs, normalize read-only articles and preserve opaque pagination', { skip: postgresSkip }, async t => {
  for (const platform of ['wordpress', 'shopify']) {
    const f = await fixture(t, platform);
    const accounts = await f.request('accounts', { role: 'viewer' }); assert.equal(accounts.status, 200); assert.deepEqual(accounts.data.accounts, [{ id: f.accountId, platform, name: 'Brand site', isActive: true, needsReconnection: false }]);
    const blogs = await f.request(f.accountId); assert.equal(blogs.status, 200); assert.equal(blogs.data.blogs[0].id, f.blogId);
    const detail = await f.request(f.route); assert.equal(detail.status, 200); assert.match(detail.data.version, /^[a-f0-9]{64}$/);
    const list = await f.request(`${f.route}/articles?limit=1&cursor=${encodeURIComponent('opaque:+/= cursor')}`); assert.equal(list.status, 200); assert.equal(list.data.articles[0].blogId, f.blogId);
    assert.deepEqual(f.calls.findLast(call => call.path.endsWith('/articles')).query, { limit: 1, cursor: 'opaque:+/= cursor' });
    const article = await f.request(`${f.route}/articles/561`); assert.equal(article.status, 200); assert.equal(article.data.article.bodyHtml, '<p>Original draft</p>'); assert.equal(article.data.article.status, platform === 'wordpress' ? 'draft' : null);
    assert.equal(JSON.stringify([accounts, blogs, detail, list, article]).includes('never-expose'), false); assert.equal(f.writes().length, 0);
    f.state.articles = []; f.state.nextCursor = 'next:2'; const next = await f.request(`${f.route}/articles`); assert.deepEqual(next.data, { articles: [], nextCursor: 'next:2' });
  }
});

test('only reviewed explicit create actions send forced-draft title and HTML, with readback and exact replay', { skip: postgresSkip }, async t => {
  for (const platform of ['wordpress', 'shopify']) {
    const f = await fixture(t, platform);
    const body = await f.reviewBody(), action = `${f.route}/create`, key = 'create-reviewed-key';
    const result = await f.request(action, { method: 'POST', body, key, role: 'editor' }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.accountId, f.accountId); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.article.isPublished, false); assert.equal(result.data.article.publishedAt, null); assert.equal(result.data.blog.id, f.blogId);
    assert.deepEqual(f.writes()[0].body, { title: body.title, bodyHtml: body.bodyHtml, isPublished: false });
    const replay = await f.request(action, { method: 'POST', body, key }); assert.deepEqual(replay, result); assert.equal(f.writes().length, 1);
    assert.equal(JSON.stringify(result).includes('never-expose'), false);
    assert.equal((await f.request(action, { method: 'POST', body: { ...body, title: 'Different' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await f.request(`${f.route}/articles/561`, { method: 'POST', body })).status, 405); assert.equal((await f.request(`${f.route}/articles/561`, { method: 'PATCH', body })).status, 405); assert.equal(f.writes().length, 1);
  }
});

test('scope, roles, inactive/revoked connections, malformed queries and unreviewed payloads fail before creation', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const body = await f.reviewBody(), action = `${f.route}/create`;
  assert.equal((await f.request(action, { method: 'POST', body, role: 'viewer' })).status, 403);
  for (const bad of [{ ...body, profileId: 'other' }, { ...body, isPublished: true }, { ...body, publishDate: '2027-01-01T00:00:00Z' }, { ...body, status: 'draft' }, { ...body, confirmCreate: false }, { ...body, title: ' ' }, { ...body, title: 'New\nTitle' }, { ...body, bodyHtml: {} }, { ...body, version: '' }]) assert.equal((await f.request(action, { method: 'POST', body: bad })).status, 400);
  for (const query of ['?limit=0', '?limit=51', '?limit=1.1', '?limit=1&limit=2', '?cursor=', '?profileId=other', '?cursor=a&cursor=b']) assert.equal((await f.request(f.accountId + query)).status, 400, query);
  assert.equal((await f.request('accounts?profileId=other')).status, 400); assert.equal((await f.request(f.route + '?limit=2')).status, 400); assert.equal((await f.request(`${f.accountId}/not-numeric`)).status, 400); assert.equal((await f.request('foreign')).status, 403);
  f.account.isActive = false; assert.equal((await f.request(f.accountId)).status, 409); assert.equal((await f.request('accounts')).data.accounts[0].isActive, false); f.account.isActive = true;
  f.account.needsReconnection = true; assert.equal((await f.request(action, { method: 'POST', body })).status, 409); f.account.needsReconnection = false;
  f.account.profileId = 'other'; assert.equal((await f.request(f.accountId)).status, 403); assert.equal(f.writes().length, 0);
});

test('blog and article envelopes, nested identities, duplicate rows and malformed pagination fail closed', { skip: postgresSkip }, async t => {
  const f = await fixture(t, 'shopify');
  for (const override of [{ platform: 'wordpress', blogs: [f.state.blog], nextCursor: null }, { platform: 'shopify', accountId: 'foreign', blogs: [f.state.blog], nextCursor: null }, { platform: 'shopify', blogs: [{ ...f.state.blog, profileId: 'other' }], nextCursor: null }, { platform: 'shopify', blogs: [f.state.blog, f.state.blog], nextCursor: null }, { platform: 'shopify', blogs: [f.state.blog] }]) {
    f.state.onCall = call => call.path.endsWith('/blogs') ? override : undefined; assert.equal((await f.request(f.accountId)).status, 502);
  }
  f.state.onCall = null;
  for (const change of [{ blogId: '999' }, { id: 'not-numeric' }, { platform: 'wordpress' }, { accountId: 'foreign' }, { profileId: 'foreign' }, { bodyHtml: {} }, { isPublished: 'false' }, { publishedAt: 'bad-date' }]) {
    f.state.article = { ...f.state.articles[0], ...change }; assert.equal((await f.request(`${f.route}/articles/561`)).status, 502, JSON.stringify(change));
  }
  f.state.nextCursor = 'same'; assert.equal((await f.request(`${f.route}/articles?cursor=same`)).status, 502);
});

test('review versions detect renamed blogs, replaced native sites and mapping changes across reads', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  let body = await f.reviewBody(); f.state.blog.title = 'Renamed blog'; assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body })).data.error.code, 'BLOG_CHANGED');
  body = await f.reviewBody(); f.account.platformUserId = 'other-site'; assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body })).status, 409); assert.equal(f.writes().length, 0);
  f.state.onCall = call => { if (call.path.endsWith('/blogs')) f.account.username = 'replaced.example.test'; }; assert.equal((await f.request(f.accountId)).status, 409);
  f.state.onCall = call => { if (call.path.endsWith('/blogs')) f.state.mappingChanged = true; }; assert.equal((await f.request(f.accountId)).status, 409);
});

test('missing stable site identity allows reading but prevents unverifiable draft creation', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  for (const nativeIdentity of [undefined, '', ' \t ']) {
    f.account.platformUserId = nativeIdentity;
    const body = await f.reviewBody();
    assert.equal((await f.request(`${f.route}/articles`)).status, 200);
    const result = await f.request(`${f.route}/create`, { method: 'POST', body });
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'BLOG_SITE_IDENTITY_UNAVAILABLE');
    assert.equal(result.data.operation.status, 'failed'); assert.equal(f.writes().length, 0);
  }
});

test('existing scheduled, public, private and pending articles remain readable but create receipts cannot claim them as drafts', { skip: postgresSkip }, async t => {
  for (const change of [{ status: 'future', publishDate: '2027-01-01T00:00:00Z' }, { status: 'publish', isPublished: true, publishedAt: '2026-10-19T09:00:00Z' }, { status: 'private' }, { status: 'pending' }]) {
    const f = await fixture(t);
    f.state.article = { ...f.state.article, ...change }; assert.equal((await f.request(`${f.route}/articles/561`)).status, 200);
    const body = await f.reviewBody(); f.state.receipt = { platform: 'wordpress', article: f.state.article };
    const result = await f.request(`${f.route}/create`, { method: 'POST', body }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(f.writes().length, 1);
  }
  const f = await fixture(t, 'shopify');
  const body = await f.reviewBody(); f.state.receipt = { platform: 'shopify', article: { ...f.state.article, publishedAt: '2027-01-01T00:00:00Z' } }; assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body })).data.operation.status, 'uncertain');
});

test('lost acknowledgement is durable across same-key replay, changed bodies, new keys and native-site connection aliases', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const body = await f.reviewBody(), action = `${f.route}/create`, key = 'lost-acknowledgement'; f.state.postError = new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Lost acknowledgement', true);
  const result = await f.request(action, { method: 'POST', body, key }); assert.equal(result.data.operation.status, 'uncertain');
  assert.equal((await f.request(action, { method: 'POST', body, key })).status, 409);
  assert.equal((await f.request(action, { method: 'POST', body: { ...body, title: 'Changed draft' } })).status, 409);
  const alias = await fixture(t, 'wordpress', f.db); alias.account._id = 'alias-account'; alias.accountId = 'alias-account'; alias.account.username = 'renamed-site.example.test';
  // The alias uses another app route but the same documented native site/blog identity.
  alias.state.onCall = call => {
    if (call.path === '/accounts/alias-account/blogs/91') return { platform: 'wordpress', blog: alias.state.blog };
    if (call.path === '/accounts/alias-account/blogs/91/articles') assert.fail('Alias must not resend a create');
  };
  const reviewed = await alias.request('alias-account/91'); assert.equal(reviewed.status, 200);
  const blocked = await alias.request('alias-account/91/create', { method: 'POST', body: { ...body, version: reviewed.data.version }, projectId: 'project-alias' }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED');
  assert.equal(f.writes().length, 1); assert.equal(alias.writes().length, 0);
});

test('receipt or exact readback mismatch and post-write access loss preserve an uncertain operation without resend', { skip: postgresSkip }, async t => {
  for (const scenario of ['receipt-scope', 'receipt-account', 'receipt-body', 'receipt-published-missing', 'readback-scope', 'readback-content', 'readback-unavailable', 'revoked', 'mapping']) {
    const f = await fixture(t);
    const body = await f.reviewBody(); let written = false;
    f.state.onCall = call => {
      if (call.method === 'POST') {
        written = true;
        if (scenario === 'mapping') f.state.mappingChanged = true;
        if (scenario === 'revoked') f.account.needsReconnection = true;
        if (scenario === 'receipt-scope') return { platform: 'shopify', article: f.state.article };
        if (scenario === 'receipt-account') return { platform: 'wordpress', accountId: 'foreign', article: f.state.article };
        if (scenario === 'receipt-body') return { platform: 'wordpress', article: { ...f.state.article, bodyHtml: null } };
        if (scenario === 'receipt-published-missing') { const article = { ...f.state.article }; delete article.publishedAt; return { platform: 'wordpress', article }; }
      }
      if (written && call.path.endsWith('/articles/561')) {
        if (scenario === 'readback-unavailable') throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Read unavailable');
        if (scenario === 'readback-scope') return { platform: 'wordpress', article: { ...f.state.article, blogId: '999' } };
        if (scenario === 'readback-content') return { platform: 'wordpress', article: { ...f.state.article, bodyHtml: '<p>Different content</p>' } };
      }
    };
    const result = await f.request(`${f.route}/create`, { method: 'POST', body, key: 'receipt-mismatch-key' }); assert.equal(result.status, 409, scenario); assert.equal(result.data.operation.status, 'uncertain', scenario); assert.equal(f.writes().length, 1);
    f.state.mappingChanged = false; f.account.needsReconnection = false; f.state.onCall = null;
    assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body: { ...body, title: 'Changed' } })).status, 409); assert.equal(f.writes().length, 1);
  }
});

test('a concurrent alias is blocked while the original create is pending, and definite rejections can be reviewed afresh', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const body = await f.reviewBody(); let release, started;
  const hold = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { started = resolve; });
  f.state.onCall = async call => { if (call.method === 'POST') { started(); await hold; } };
  const original = f.request(`${f.route}/create`, { method: 'POST', body }); await pending;
  assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body: { ...body, title: 'Concurrent draft' } })).status, 409);
  release(); assert.equal((await original).data.operation.status, 'complete'); assert.equal(f.writes().length, 1);
  f.state.onCall = null; f.state.postError = new IntegrationError(400, 'PROVIDER_REJECTED', 'Permission denied');
  assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body: { ...body, title: 'Rejected draft' } })).data.operation.status, 'failed');
  f.state.postError = null; assert.equal((await f.request(`${f.route}/create`, { method: 'POST', body: { ...body, title: 'Fresh manual draft' } })).data.operation.status, 'complete');
  assert.equal(f.writes().length, 3);
});

test('a parallel same-key draft create reaches the provider once', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const body = await f.reviewBody(), key = 'parallel-create-key'; let release, started;
  const hold = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { started = resolve; });
  // The first create is held at the provider, so the duplicate arrives while its receipt is still pending.
  f.state.onCall = async call => { if (call.method === 'POST') { started(); await hold; } };
  const results = await Promise.all([f.request(`${f.route}/create`, { method: 'POST', body, key }), pending.then(async () => { const duplicate = await f.request(`${f.route}/create`, { method: 'POST', body, key }); release(); return duplicate; })]);
  assert.deepEqual(results.map(result => result.data.error?.code ?? result.data.operation.status), ['complete', 'OPERATION_UNCERTAIN']);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path === `/accounts/${f.accountId}/blogs/${f.blogId}/articles`).length, 1);
});

test('HTTP draft edits, publication and WordPress scheduling share scoped PATCH, fresh reviews and one durable native-article fence', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-blog-edit-')), origin = 'http://127.0.0.1:3000';
  const appOptions = { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'blog-http-fixture-key' } }, originalFetch = globalThis.fetch;
  const first = await testApp(t, appOptions), { sql } = first, database = { pool: first.database.pool, db: first.database.db }; let app = first;
  const profileId = 'blog-http-profile', calls = [], articles = new Map();
  const accounts = ['wordpress', 'shopify'].map(platform => ({ _id: platform + '-account', profileId, platform, platformUserId: platform + '-native-site', username: 'site.example.test', isActive: true }));
  const blogs = { wordpress: { id: '91', platform: 'wordpress', title: 'WP journal', handle: 'journal' }, shopify: { id: '327', platform: 'shopify', title: 'Store journal', handle: 'journal' } };
  let ownerCookie, projectId, sequence = 560, keySequence = 0, providerHook;
  const addArticle = platform => { const row = { id: String(++sequence), blogId: blogs[platform].id, platform, title: 'Existing draft', bodyHtml: '<p>Original</p>', isPublished: false, publishedAt: null, ...(platform === 'wordpress' ? { status: 'draft', publishDate: null } : {}), updatedAt: '2026-10-19T09:00:00Z' }; articles.set(platform + ':' + row.id, row); return row; };
  const addPublished = () => Object.assign(addArticle('wordpress'), { status: 'publish', isPublished: true, publishedAt: '2026-10-18T09:00:00Z' });
  const writes = () => calls.filter(call => call.method !== 'GET');
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    const method = options.method || 'GET', payload = options.body === undefined ? undefined : JSON.parse(options.body), call = { url, method, payload, headers: options.headers }; calls.push(call);
    let result;
    if (url.pathname === '/api/v1/accounts') { assert.ok(url.searchParams.get('profileId') === profileId || url.searchParams.get('profileId').endsWith('alias-profile')); result = { accounts }; }
    else {
      const match = url.pathname.match(/^\/api\/v1\/accounts\/([^/]+)\/blogs\/(\d+)(?:\/articles\/(\d+))?$/);
      assert.ok(match, 'Unexpected provider path: ' + url.pathname);
      const account = accounts.find(row => row._id === match[1]); assert.ok(account); assert.equal(match[2], blogs[account.platform].id);
      const article = match[3] && articles.get(account.platform + ':' + match[3]);
      if (method !== 'GET') {
        assert.equal(method, 'PATCH'); assert.ok(article); assert.ok(options.headers['Idempotency-Key']);
        assert.deepEqual(Object.keys(payload).sort(), Object.hasOwn(payload, 'isPublished') ? ['isPublished'] : Object.hasOwn(payload, 'publishDate') ? ['publishDate'] : ['bodyHtml', 'title']); Object.assign(article, payload);
        if (Object.hasOwn(payload, 'isPublished')) { article.publishedAt = payload.isPublished ? '2026-10-18T09:00:00Z' : null; if (account.platform === 'wordpress') { article.status = payload.isPublished ? 'publish' : 'draft'; article.publishDate = null; } }
        if (Object.hasOwn(payload, 'publishDate')) { assert.equal(account.platform, 'wordpress'); article.publishDate = new Date(payload.publishDate).toISOString(); article.status = 'future'; article.isPublished = false; article.publishedAt = null; }
      }
      result = match[3] ? { platform: account.platform, article } : { platform: account.platform, blog: blogs[account.platform] };
    }
    result = structuredClone(result);
    return await providerHook?.(call, result) || Response.json(result);
  };
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    let base = `http://127.0.0.1:${app.server.address().port}`;
    async function request(path, { body, method = body === undefined ? 'GET' : 'POST', cookie = ownerCookie, key = 'blog-http-key-' + ++keySequence } = {}) {
      const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const setupBody = { name: 'Blog QA', email: 'blog-qa@example.test', password: 'a long local blog fixture password', sample: false };
    const setup = await request('/api/auth/setup', { body: setupBody }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie; projectId = setup.data.projectId;
    await sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId);
    const route = (article, accountId = article.platform + '-account') => `/api/projects/${projectId}/integrations/blogs/${accountId}/${article.blogId}/articles/${article.id}`;
    const review = async article => { const result = await request(route(article)); assert.equal(result.status, 200, JSON.stringify(result)); assert.match(result.data.version, /^[a-f0-9]{64}$/); return { title: 'Reviewed title', bodyHtml: '<p>Reviewed <strong>HTML</strong></p>', version: result.data.version, confirmUpdate: true }; };
    const publicationReview = async (article, action, accountId) => { const result = await request(route(article, accountId)); assert.equal(result.status, 200, JSON.stringify(result)); return { version: result.data.version, [action === 'schedule' ? 'confirmSchedule' : action === 'cancel-schedule' ? 'confirmCancelSchedule' : action === 'publish' ? 'confirmPublish' : 'confirmUnpublish']: true }; };
    for (const platform of ['wordpress', 'shopify']) {
      // One article read makes five provider calls, each guarded before and after; guards with no I/O between them share one
      // database read, so the read costs a bounded number of queries (#54: it was 32, mostly repeated guards).
      let queries = 0; const query = pg.Client.prototype.query; pg.Client.prototype.query = function (...args) { queries++; return query.apply(this, args); };
      const article = addArticle(platform); let body; try { body = await review(article); } finally { pg.Client.prototype.query = query; }
      assert.ok(queries <= 12, `One article read ran ${queries} queries.`);
      const key = 'successful-http-edit-' + platform, before = writes().length;
      const result = await request(route(article) + '/update', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.article.id, article.id); assert.equal(result.data.article.title, body.title); assert.equal(result.data.article.bodyHtml, body.bodyHtml); assert.equal(result.data.article.isPublished, false); assert.equal(result.data.blog.id, article.blogId); assert.equal(result.data.accountId, platform + '-account');
      assert.equal(writes().length, before + 1); assert.equal(writes().at(-1).method, 'PATCH'); assert.deepEqual(writes().at(-1).payload, { title: body.title, bodyHtml: body.bodyHtml });
      assert.deepEqual((await request(route(article) + '/update', { body, key })).data, result.data); assert.equal(writes().length, before + 1);
      assert.equal((await request(route(article) + '/update', { body: { ...body, title: 'Different' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
      const stale = await review(article); article.bodyHtml = '<p>Edited elsewhere</p>'; assert.equal((await request(route(article) + '/update', { body: stale })).data.error.code, 'BLOG_ARTICLE_CHANGED'); assert.equal(writes().length, before + 1);
      for (const change of platform === 'wordpress' ? [{ status: 'future', publishDate: '2027-01-01T00:00:00Z' }, { status: 'private' }, { status: 'pending' }, { publishedAt: undefined }] : [{ publishedAt: '2027-01-01T00:00:00Z' }, { isPublished: true, publishedAt: '2026-10-19T09:00:00Z' }, { publishedAt: undefined }]) {
        const other = addArticle(platform); Object.assign(other, change); const reviewed = await review(other);
        const rejected = await request(route(other) + '/update', { body: reviewed }); assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'BLOG_EXISTING_DRAFT_REQUIRED'); assert.equal(rejected.data.operation.status, 'failed');
      }
      assert.equal(writes().length, before + 1);
    }
    const published = addPublished(); published.bodyHtml = null;
    const publishedBody = await review(published), publishedKey = 'published-content-success', publishedCount = writes().length, originalPublishedAt = published.publishedAt;
    providerHook = (call, result) => {
      if (call.method === 'PATCH') {
        Object.assign(published, { title: 'Provider canonical public title', bodyHtml: '<p>Provider canonical public HTML</p>', publishedAt: '2026-10-18T13:00:00+04:00', updatedAt: '2026-10-19T10:00:00Z' });
        return Response.json({ ...result, article: published });
      }
    };
    const publishedResult = await request(route(published) + '/update', { body: publishedBody, key: publishedKey }); providerHook = undefined;
    assert.equal(publishedResult.status, 200, JSON.stringify(publishedResult)); assert.equal(publishedResult.data.operation.status, 'complete'); assert.equal(publishedResult.data.article.publicationState, 'published'); assert.equal(publishedResult.data.article.canEditPublished, true); assert.equal(publishedResult.data.article.status, 'publish'); assert.equal(publishedResult.data.article.isPublished, true); assert.equal(publishedResult.data.article.publishDate, null); assert.equal(Date.parse(publishedResult.data.article.publishedAt), Date.parse(originalPublishedAt)); assert.equal(publishedResult.data.article.title, published.title); assert.equal(publishedResult.data.article.bodyHtml, published.bodyHtml); assert.equal(publishedResult.data.article.updatedAt, published.updatedAt);
    assert.equal(writes().length, publishedCount + 1); assert.equal(writes().at(-1).method, 'PATCH'); assert.deepEqual(writes().at(-1).payload, { title: publishedBody.title, bodyHtml: publishedBody.bodyHtml });
    assert.deepEqual((await request(route(published) + '/update', { body: publishedBody, key: publishedKey })).data, publishedResult.data); assert.equal(writes().length, publishedCount + 1);
    assert.equal((await request(route(published) + '/update', { body: { ...publishedBody, title: 'Changed' }, key: publishedKey })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    for (const change of [{ publishedAt: undefined }, { publishedAt: null }, { publishedAt: '2099-01-01T00:00:00Z' }, { publishedAt: '2026-10-18T09:00:00' }, { publishedAt: '2026-10-18' }, { publishedAt: '2026-02-30T09:00:00Z' }, { publishDate: undefined }, { publishDate: '2099-01-01T00:00:00Z' }]) {
      const current = Object.assign(addPublished(), change), reviewed = await review(current), count = writes().length;
      assert.equal((await request(route(current))).data.article.canEditPublished, false, JSON.stringify(change));
      const rejected = await request(route(current) + '/update', { body: reviewed }); assert.equal(rejected.status, 409, JSON.stringify(change)); assert.equal(rejected.data.operation.status, 'failed'); assert.equal(writes().length, count);
    }
    for (const change of [{ publishedAt: '2026-10-18T09:00:00.001Z' }, { status: 'draft', isPublished: false, publishedAt: null }, { status: 'publish', isPublished: false }]) {
      const current = addPublished(), reviewed = await review(current), count = writes().length; Object.assign(current, change);
      const rejected = await request(route(current) + '/update', { body: reviewed }); assert.ok([409, 502].includes(rejected.status), JSON.stringify(rejected)); assert.equal(writes().length, count);
    }
    const missingReadyProof = addPublished(), missingReadyBody = await review(missingReadyProof), missingReadyCount = writes().length; let missingReadyReads = 0;
    providerHook = call => { if (call.method === 'GET' && call.url.pathname.endsWith('/articles/' + missingReadyProof.id) && ++missingReadyReads === 1) delete missingReadyProof.publishDate; };
    assert.equal((await request(route(missingReadyProof) + '/update', { body: missingReadyBody })).data.error.code, 'BLOG_ARTICLE_CHANGED'); assert.equal(writes().length, missingReadyCount); providerHook = undefined;
    for (const scenario of ['receipt-missing-date', 'receipt-missing-published', 'receipt-null-published', 'receipt-time-drift', 'receipt-state', 'receipt-null-html', 'receipt-empty-title', 'both-time-drift', 'readback-missing-date', 'readback-time-drift', 'readback-content', 'lost-ack', 'post-write-access']) {
      const current = addPublished(), reviewed = await review(current), key = 'published-content-uncertain-' + scenario, count = writes().length; let written = false;
      providerHook = async (call, result) => {
        if (call.method === 'PATCH') {
          written = true;
          if (scenario === 'receipt-missing-date') delete result.article.publishDate;
          if (scenario === 'receipt-missing-published') delete result.article.publishedAt;
          if (scenario === 'receipt-null-published') result.article.publishedAt = null;
          if (scenario === 'receipt-time-drift') result.article.publishedAt = '2026-10-18T09:00:00.001Z';
          if (scenario === 'receipt-state') Object.assign(result.article, { status: 'draft', isPublished: false, publishedAt: null });
          if (scenario === 'receipt-null-html') result.article.bodyHtml = null;
          if (scenario === 'receipt-empty-title') result.article.title = '';
          if (scenario === 'both-time-drift') { current.publishedAt = '2026-10-18T09:00:01Z'; result.article.publishedAt = current.publishedAt; }
          if (scenario === 'lost-ack') throw new Error('Published content acknowledgement lost');
          if (scenario === 'post-write-access') await sql.run("UPDATE memberships SET role='viewer'");
          return Response.json(result);
        }
        if (written && call.method === 'GET' && call.url.pathname.endsWith('/articles/' + current.id)) {
          if (scenario === 'readback-missing-date') delete result.article.publishDate;
          if (scenario === 'readback-time-drift') result.article.publishedAt = '2026-10-18T09:00:00.001Z';
          if (scenario === 'readback-content') result.article.bodyHtml += ' external';
          return Response.json(result);
        }
      };
      const result = await request(route(current) + '/update', { body: reviewed, key }); providerHook = undefined; await sql.run("UPDATE memberships SET role='owner'");
      assert.equal(result.status, 409, scenario + JSON.stringify(result)); assert.equal(result.data.operation.status, 'uncertain', scenario); assert.equal(writes().length, count + 1);
      assert.equal((await request(route(current) + '/update', { body: reviewed, key })).data.error.code, 'OPERATION_UNCERTAIN');
      const blocked = await request(route(current) + '/unpublish', { body: await publicationReview(current, 'unpublish') }); assert.equal(blocked.status, 409); assert.equal(writes().length, count + 1);
    }
    for (const platform of ['wordpress', 'shopify']) {
      const current = addArticle(platform), originalContent = [current.title, current.bodyHtml];
      for (const action of ['publish', 'unpublish']) {
        const body = await publicationReview(current, action), count = writes().length, key = 'publication-success-' + platform + '-' + action;
        const result = await request(route(current) + '/' + action, { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.article.publicationState, action === 'publish' ? 'published' : 'draft'); assert.deepEqual([current.title, current.bodyHtml], originalContent);
        assert.deepEqual(writes().at(-1).payload, { isPublished: action === 'publish' }); assert.equal(writes().length, count + 1);
        assert.deepEqual((await request(route(current) + '/' + action, { body, key })).data, result.data); assert.equal(writes().length, count + 1);
        assert.equal((await request(route(current) + '/' + action, { body: { ...body, version: 'a'.repeat(64) }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
      }
      const stale = await publicationReview(current, 'publish'); current.bodyHtml += ' external'; const count = writes().length;
      assert.equal((await request(route(current) + '/publish', { body: stale })).data.error.code, 'BLOG_ARTICLE_CHANGED');
      assert.equal((await request(route(current) + '/unpublish', { body: await publicationReview(current, 'unpublish') })).data.error.code, 'BLOG_PUBLISHED_ARTICLE_REQUIRED');
      for (const action of ['publish', 'unpublish']) {
        const body = await publicationReview(current, action);
        for (const extra of [{ title: 'Overwrite' }, { bodyHtml: '<p>Overwrite</p>' }, { isPublished: true }, { publishDate: '2027-01-01T00:00:00Z' }, { status: 'publish' }, { confirmUpdate: true }, { version: 'bad' }, { [action === 'publish' ? 'confirmPublish' : 'confirmUnpublish']: false }]) assert.equal((await request(route(current) + '/' + action, { body: { ...body, ...extra } })).status, 400, action + JSON.stringify(extra));
        for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(route(current) + '/' + action, { method })).status, 405);
      }
      assert.equal(writes().length, count);
    }
    const timestampOptional = addArticle('shopify'); timestampOptional.isPublished = true; delete timestampOptional.publishedAt;
    assert.equal((await request(route(timestampOptional))).data.article.publicationState, 'published');
    const timestampOptionalBody = await publicationReview(timestampOptional, 'unpublish'); assert.equal((await request(route(timestampOptional) + '/unpublish', { body: timestampOptionalBody })).status, 200);
    const article = addArticle('wordpress'), body = await review(article), initialWrites = writes().length;
    for (const extra of [{ isPublished: false }, { publishDate: null }, { status: 'draft' }, { articleId: article.id }, { confirmUpdate: false }, { title: '' }, { title: 'Bad\nTitle' }, { bodyHtml: null }, { version: 'bad' }, { confirmCreate: true }]) assert.equal((await request(route(article) + '/update', { body: { ...body, ...extra } })).status, 400, JSON.stringify(extra));
    for (const method of ['PUT', 'PATCH', 'DELETE', 'GET']) assert.equal((await request(route(article) + '/update', { method })).status, 405);
    assert.equal((await request(route(article), { cookie: null })).status, 401);
    assert.equal((await request(route(article).replace('/articles/' + article.id, '/articles/not-numeric'))).status, 400);
    assert.equal((await request(route(article, 'foreign') + '/update', { body })).status, 403);
    const account = accounts[0]; account.profileId = 'foreign-profile'; assert.equal((await request(route(article) + '/update', { body })).status, 403); account.profileId = profileId;
    delete account.platformUserId; const missingIdentity = await review(article); assert.equal((await request(route(article) + '/update', { body: missingIdentity })).data.error.code, 'BLOG_SITE_IDENTITY_UNAVAILABLE'); account.platformUserId = 'wordpress-native-site';
    await sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(article) + '/update', { body })).status, 403); await sql.run("UPDATE memberships SET role='editor'");
    assert.equal((await request(route(article) + '/update', { body: await review(article) })).status, 200); await sql.run("UPDATE memberships SET role='owner'");
    assert.equal(writes().length, initialWrites + 1);

    for (const publishedMode of [false, true]) for (const scenario of ['between-reads', 'role', 'mapping', 'credentials', 'session', 'native-site', 'revoked']) {
      const current = publishedMode ? addPublished() : addArticle('wordpress'), reviewed = await review(current), count = writes().length; let fired = false;
      providerHook = async call => {
        if (fired || call.method !== 'GET' || !call.url.pathname.endsWith('/articles/' + current.id)) return;
        fired = true;
        if (scenario === 'between-reads') current.bodyHtml = '<p>Concurrent edit before dispatch</p>';
        if (scenario === 'role') await sql.run("UPDATE memberships SET role='admin'");
        if (scenario === 'mapping') await sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'changed-profile', projectId);
        if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-fixture-key-' + publishedMode } } })).status, 200);
        if (scenario === 'session') await sql.run('DELETE FROM sessions');
        if (scenario === 'native-site') account.platformUserId = 'replaced-native-site';
        if (scenario === 'revoked') account.needsReconnection = true;
      };
      const result = await request(route(current) + '/update', { body: reviewed }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, count, scenario); providerHook = undefined;
      await sql.run("UPDATE memberships SET role='owner'"); await sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId); account.platformUserId = 'wordpress-native-site'; account.needsReconnection = false;
      if (scenario === 'session') { const login = await request('/api/auth/login', { body: { email: setupBody.email, password: setupBody.password } }); assert.equal(login.status, 200); ownerCookie = login.cookie; }
    }
    for (const scenario of ['missing-receipt', 'malformed-receipt', 'receipt-account', 'receipt-article', 'receipt-scheduled', 'receipt-missing-publication', 'readback-content', 'readback-scope', 'readback-unavailable', 'lost-ack', 'post-write-access']) {
      const current = addArticle('shopify'), reviewed = await review(current), count = writes().length; let written = false;
      providerHook = async (call, result) => {
        if (call.method === 'PATCH') {
          written = true;
          if (scenario === 'missing-receipt') return Response.json({ platform: 'shopify' });
          if (scenario === 'malformed-receipt') return new Response('broken json');
          if (scenario === 'receipt-account') return Response.json({ ...result, accountId: 'foreign' });
          if (scenario === 'receipt-article') return Response.json({ ...result, article: { ...result.article, id: '999999' } });
          if (scenario === 'receipt-scheduled') return Response.json({ ...result, article: { ...result.article, publishedAt: '2027-01-01T00:00:00Z' } });
          if (scenario === 'receipt-missing-publication') { delete result.article.publishedAt; return Response.json(result); }
          if (scenario === 'lost-ack') throw new Error('Lost remote acknowledgement');
          if (scenario === 'post-write-access') await sql.run("UPDATE memberships SET role='viewer'");
        }
        if (written && call.method === 'GET' && call.url.pathname.endsWith('/articles/' + current.id)) {
          if (scenario === 'readback-content') return Response.json({ ...result, article: { ...result.article, bodyHtml: reviewed.bodyHtml + ' ' } });
          if (scenario === 'readback-scope') return Response.json({ ...result, article: { ...result.article, blogId: '999' } });
          if (scenario === 'readback-unavailable') return Response.json({}, { status: 503 });
        }
      };
      const key = 'uncertain-http-' + scenario, result = await request(route(current) + '/update', { body: reviewed, key }); assert.equal(result.status, 409, scenario + JSON.stringify(result)); assert.equal(result.data.operation.status, 'uncertain', scenario); assert.equal(writes().length, count + 1);
      providerHook = undefined; await sql.run("UPDATE memberships SET role='owner'");
      assert.equal((await request(route(current) + '/update', { body: reviewed, key })).status, 409); assert.equal((await request(route(current) + '/update', { body: { ...await review(current), title: 'Fresh key changed body' } })).status, 409);
      const alias = { ...accounts[1], _id: 'shopify-alias-' + scenario, username: 'renamed-site.example.test' }; accounts.push(alias);
      const aliasDetail = await request(route(current, alias._id)); assert.equal(aliasDetail.status, 200);
      const blocked = await request(route(current, alias._id) + '/update', { body: { ...reviewed, version: aliasDetail.data.version, title: 'Alias edit' } }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, count + 1);
      if (scenario === 'lost-ack') {
        const originalProject = projectId, workspaceId = (await sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
        await sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'alias-project', workspaceId, 'Alias site', 'alias-profile');
        const other = { ...alias, _id: 'cross-project-alias', profileId: 'alias-profile' }; accounts.push(other); projectId = 'alias-project';
        const detail = await request(route(current, other._id)); assert.equal(detail.status, 200);
        assert.equal((await request(route(current, other._id) + '/update', { body: { ...reviewed, version: detail.data.version } })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, count + 1); projectId = originalProject;
      }
    }
    const pendingArticle = addArticle('shopify'), pendingBody = await review(pendingArticle), pendingAlias = { ...accounts[1], _id: 'pending-alias', username: 'pending-alias.example.test' }; accounts.push(pendingAlias);
    let release, started; const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    providerHook = async call => { if (call.method === 'PATCH') { started(); await held; } };
    const pendingRequest = request(route(pendingArticle) + '/update', { body: pendingBody }); await entered;
    const pendingDetail = await request(route(pendingArticle, pendingAlias._id)), pendingWrites = writes().length;
    const concurrent = await request(route(pendingArticle, pendingAlias._id) + '/update', { body: { ...pendingBody, version: pendingDetail.data.version } });
    release(); assert.equal(concurrent.data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal((await pendingRequest).status, 200); assert.equal(writes().length, pendingWrites); providerHook = undefined;
    assert.equal(calls.filter(call => call.method === 'PATCH' && call.url.pathname.endsWith('/articles/' + pendingArticle.id)).length, 1);
    const raced = addArticle('shopify'), racedBody = await review(raced), raceAlias = { ...accounts[1], _id: 'final-read-race-alias' }; accounts.push(raceAlias);
    const aliasReview = await request(route(raced, raceAlias._id)); let releaseRead, reachedRead, articleReads = 0;
    const finalReadHeld = new Promise(resolve => { reachedRead = resolve; }), finalReadRelease = new Promise(resolve => { releaseRead = resolve; });
    providerHook = async call => {
      if (call.method === 'GET' && call.url.pathname.endsWith('/shopify-account/blogs/' + raced.blogId + '/articles/' + raced.id) && ++articleReads === 2) { reachedRead(); await finalReadRelease; }
      if (call.method === 'PATCH') throw new Error('Alias update lost acknowledgement');
    };
    const countBeforeRace = writes().length, waitingUpdate = request(route(raced) + '/update', { body: racedBody }); await finalReadHeld;
    const aliasOutcome = await request(route(raced, raceAlias._id) + '/update', { body: { ...racedBody, version: aliasReview.data.version } }); assert.equal(aliasOutcome.data.operation.status, 'uncertain');
    releaseRead(); const fencedAfterFinalRead = await waitingUpdate; assert.equal(fencedAfterFinalRead.data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforeRace + 1); providerHook = undefined;
    const nullable = addArticle('wordpress'); nullable.bodyHtml = null; const replacement = await review(nullable); assert.equal((await request(route(nullable) + '/update', { body: replacement })).status, 200);
    const canonical = addArticle('wordpress'), canonicalBody = await review(canonical);
    providerHook = (call, result) => { if (call.method === 'PATCH') { canonical.title = 'Provider canonical title'; canonical.bodyHtml = '<p>Provider canonical HTML</p>'; return Response.json({ ...result, article: canonical }); } };
    const accepted = await request(route(canonical) + '/update', { body: canonicalBody }); assert.equal(accepted.status, 200); assert.equal(accepted.data.article.title, canonical.title); assert.equal(accepted.data.article.bodyHtml, canonical.bodyHtml);
    providerHook = undefined;
    for (const action of ['publish', 'unpublish']) {
      for (const scenario of ['missing-receipt', 'foreign-receipt', 'wrong-receipt', 'unknown-receipt', 'scheduled-receipt', 'wrong-readback', 'lost-ack']) {
        const current = addArticle('shopify'); if (action === 'unpublish') { current.isPublished = true; current.publishedAt = '2026-10-18T09:00:00Z'; }
        const body = await publicationReview(current, action), count = writes().length, key = 'publication-uncertain-' + action + '-' + scenario; let written = false;
        providerHook = (call, result) => {
          if (call.method === 'PATCH') {
            written = true;
            if (scenario === 'missing-receipt') return Response.json({ platform: 'shopify' });
            if (scenario === 'foreign-receipt') return Response.json({ ...result, profileId: 'foreign' });
            if (scenario === 'wrong-receipt') return Response.json({ ...result, article: { ...result.article, id: '999999' } });
            if (scenario === 'unknown-receipt') { delete result.article.isPublished; return Response.json(result); }
            if (scenario === 'scheduled-receipt') return Response.json({ ...result, article: { ...result.article, publishDate: '2099-01-01T00:00:00Z' } });
            if (scenario === 'lost-ack') throw new Error('Publication acknowledgement lost');
          }
          if (written && scenario === 'wrong-readback' && call.method === 'GET' && call.url.pathname.endsWith('/articles/' + current.id)) return Response.json({ ...result, article: { ...result.article, isPublished: !current.isPublished, publishedAt: current.isPublished ? null : '2026-10-18T09:00:00Z' } });
        };
        const result = await request(route(current) + '/' + action, { body, key }); assert.equal(result.status, 409, action + scenario + JSON.stringify(result)); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(writes().length, count + 1); providerHook = undefined;
        assert.equal((await request(route(current) + '/' + action, { body, key })).status, 409); assert.equal(writes().length, count + 1);
        const alias = { ...accounts[1], _id: 'publication-alias-' + action + '-' + scenario }; accounts.push(alias);
        for (const next of ['update', 'publish', 'unpublish']) {
          const reviewed = await publicationReview(current, next, alias._id), nextBody = next === 'update' ? { ...await review(current), version: reviewed.version } : reviewed;
          const blocked = await request(route(current, alias._id) + '/' + next, { body: nextBody }); assert.equal(blocked.status, 409); assert.equal(writes().length, count + 1);
        }
      }
    }
    for (const platform of ['wordpress', 'shopify']) {
      for (const change of platform === 'wordpress' ? [{ status: 'future', publishDate: '2099-01-01T00:00:00Z' }, { status: 'pending' }, { status: 'private' }, { publishedAt: undefined }] : [{ publishedAt: '2099-01-01T00:00:00Z' }, { publishedAt: undefined }]) {
        const current = addArticle(platform); Object.assign(current, change); const count = writes().length;
        for (const action of ['publish', 'unpublish']) assert.equal((await request(route(current) + '/' + action, { body: await publicationReview(current, action) })).status, 409);
        assert.equal((await request(route(current))).data.article.publicationState, platform === 'wordpress' && change.status === 'future' ? 'scheduled' : 'unverified'); assert.equal(writes().length, count);
      }
    }
    const numericArticle = addArticle('wordpress'); numericArticle.id = Number(numericArticle.id); numericArticle.blogId = Number(numericArticle.blogId);
    const numericResult = await request(route(numericArticle)); assert.equal(numericResult.status, 200); assert.equal(typeof numericResult.data.article.id, 'string'); assert.equal(typeof numericResult.data.article.blogId, 'string');
    for (const action of ['publish', 'unpublish']) {
      const current = addArticle('wordpress'); if (action === 'unpublish') { current.status = 'publish'; current.isPublished = true; current.publishedAt = '2026-10-18T09:00:00Z'; }
      const body = await publicationReview(current, action), count = writes().length;
      await sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(current) + '/' + action, { body })).status, 403); await sql.run("UPDATE memberships SET role='owner'");
      let changed = false; providerHook = async call => { if (!changed && call.method === 'GET' && call.url.pathname.endsWith('/articles/' + current.id)) { changed = true; await sql.run("UPDATE memberships SET role='editor'"); } };
      assert.equal((await request(route(current) + '/' + action, { body })).status, 403); providerHook = undefined; await sql.run("UPDATE memberships SET role='owner'"); assert.equal(writes().length, count);
    }
    const scheduled = addArticle('wordpress'), scheduledContent = [scheduled.title, scheduled.bodyHtml];
    const scheduleBody = async (article, publishDate, accountId) => ({ ...await publicationReview(article, 'schedule', accountId), publishDate });
    for (const [index, [publishDate, expectedUtc]] of [['2099-11-01T01:30:00-04:00', '2099-11-01T05:30:00.000Z'], ['2099-11-01T01:30:00-05:00', '2099-11-01T06:30:00.000Z'], ['2099-11-02T09:45:00+04:00', '2099-11-02T05:45:00.000Z'], ['2099-11-03T06:15:00.125Z', '2099-11-03T06:15:00.125Z']].entries()) {
      const body = await scheduleBody(scheduled, publishDate), key = 'schedule-exact-offset-' + index, count = writes().length;
      const result = await request(route(scheduled) + '/schedule', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.accountId, 'wordpress-account'); assert.equal(result.data.blog.id, scheduled.blogId); assert.equal(result.data.article.id, scheduled.id); assert.equal(result.data.article.publicationState, 'scheduled'); assert.equal(result.data.article.status, 'future'); assert.equal(result.data.article.isPublished, false); assert.equal(result.data.article.publishedAt, null); assert.equal(result.data.article.publishDate, expectedUtc); assert.deepEqual([scheduled.title, scheduled.bodyHtml], scheduledContent);
      assert.deepEqual(writes().at(-1).payload, { publishDate }); assert.equal(writes().length, count + 1); assert.deepEqual((await request(route(scheduled) + '/schedule', { body, key })).data, result.data); assert.equal(writes().length, count + 1);
      assert.equal((await request(route(scheduled) + '/schedule', { body: { ...body, publishDate: '2099-12-01T00:00:00Z' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    const cancelBody = await publicationReview(scheduled, 'cancel-schedule'), cancelKey = 'cancel-schedule-success', cancelCount = writes().length;
    const cancelled = await request(route(scheduled) + '/cancel-schedule', { body: cancelBody, key: cancelKey }); assert.equal(cancelled.status, 200, JSON.stringify(cancelled)); assert.equal(cancelled.data.article.publicationState, 'draft'); assert.equal(cancelled.data.article.publishDate, null); assert.equal(cancelled.data.article.publishedAt, null); assert.deepEqual(writes().at(-1).payload, { isPublished: false }); assert.deepEqual([scheduled.title, scheduled.bodyHtml], scheduledContent);
    assert.deepEqual((await request(route(scheduled) + '/cancel-schedule', { body: cancelBody, key: cancelKey })).data, cancelled.data); assert.equal(writes().length, cancelCount + 1);
    const historical = addArticle('wordpress'), historicalAt = Date.now() + 60000, historicalDate = new Date(historicalAt).toISOString(), historicalBody = await scheduleBody(historical, historicalDate), historicalKey = 'historical-schedule-complete';
    const historicalResult = await request(route(historical) + '/schedule', { body: historicalBody, key: historicalKey }); assert.equal(historicalResult.status, 200);
    const historicalUnknown = addArticle('wordpress'), historicalUnknownBody = await scheduleBody(historicalUnknown, historicalDate), historicalUnknownKey = 'historical-schedule-unknown';
    providerHook = call => { if (call.method === 'PATCH') throw new Error('Historical schedule acknowledgement lost'); };
    assert.equal((await request(route(historicalUnknown) + '/schedule', { body: historicalUnknownBody, key: historicalUnknownKey })).data.operation.status, 'uncertain'); providerHook = undefined;
    const expiredNew = addArticle('wordpress'), expiredNewBody = await scheduleBody(expiredNew, historicalDate), historicalWrites = writes().length, historicalNow = Date.now;
    try {
      Date.now = () => historicalAt + 1;
      assert.deepEqual((await request(route(historical) + '/schedule', { body: historicalBody, key: historicalKey })).data, historicalResult.data);
      assert.equal((await request(route(historicalUnknown) + '/schedule', { body: historicalUnknownBody, key: historicalUnknownKey })).data.error.code, 'OPERATION_UNCERTAIN');
      const expired = await request(route(expiredNew) + '/schedule', { body: expiredNewBody }); assert.equal(expired.status, 409); assert.equal(expired.data.error.code, 'BLOG_SCHEDULE_DATE_ELAPSED'); assert.equal(expired.data.operation.status, 'failed'); assert.equal(writes().length, historicalWrites);
    } finally { Date.now = historicalNow; }
    const invalidSchedule = addArticle('wordpress'), invalidBody = await scheduleBody(invalidSchedule, '2099-11-01T00:00:00Z'), invalidCount = writes().length;
    for (const publishDate of [undefined, null, '', '2099-11-01', '2099-11-01T00:00', '2099-02-30T00:00:00Z', '2099-13-01T00:00:00Z', '2099-11-01T24:00:00Z', '2099-11-01T00:00:00+24:00', '2099-11-01T00:00:00+04:60', '2099-11-01T00:00:00Z ']) assert.equal((await request(route(invalidSchedule) + '/schedule', { body: { ...invalidBody, publishDate } })).status, 400, String(publishDate));
    assert.equal((await request(route(invalidSchedule) + '/schedule', { body: { ...invalidBody, publishDate: '2000-01-01T00:00:00Z' } })).data.error.code, 'BLOG_SCHEDULE_DATE_ELAPSED');
    for (const action of ['schedule', 'cancel-schedule']) {
      const valid = action === 'schedule' ? invalidBody : await publicationReview(invalidSchedule, action);
      for (const extra of [{ title: 'Overwrite' }, { bodyHtml: 'Overwrite' }, { isPublished: false }, { status: 'future' }, { confirmPublish: true }, { version: 'bad' }, { [action === 'schedule' ? 'confirmSchedule' : 'confirmCancelSchedule']: false }, ...(action === 'cancel-schedule' ? [{ publishDate: invalidBody.publishDate }] : [])]) assert.equal((await request(route(invalidSchedule) + '/' + action, { body: { ...valid, ...extra } })).status, 400);
      for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) assert.equal((await request(route(invalidSchedule) + '/' + action, { method })).status, 405);
      await sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(invalidSchedule) + '/' + action, { body: valid })).status, 403); await sql.run("UPDATE memberships SET role='owner'");
      const shopify = addArticle('shopify'), unsupported = await request(route(shopify) + '/' + action, { body: action === 'schedule' ? await scheduleBody(shopify, invalidBody.publishDate) : await publicationReview(shopify, action) }); assert.equal(unsupported.status, 409); assert.equal(unsupported.data.error.code, 'BLOG_SCHEDULING_UNSUPPORTED');
    }
    assert.equal((await request(route(invalidSchedule) + '/cancel-schedule', { body: await publicationReview(invalidSchedule, 'cancel-schedule') })).data.error.code, 'BLOG_SCHEDULED_ARTICLE_REQUIRED');
    for (const change of [{ status: 'future', publishDate: '2099-11-01T00:00:00Z', publishedAt: undefined }, { status: 'future', publishDate: undefined }, { status: 'future', publishDate: null }, { status: 'future', publishDate: '2000-01-01T00:00:00Z' }, { status: 'future', publishDate: '2099-11-01T00:00:00' }, { status: 'pending' }, { status: 'private' }, { status: 'publish', isPublished: true }]) {
      const current = addArticle('wordpress'); Object.assign(current, change); assert.equal((await request(route(current))).data.article.publicationState, change.status === 'publish' ? 'published' : 'unverified');
      for (const action of ['schedule', 'cancel-schedule']) assert.equal((await request(route(current) + '/' + action, { body: action === 'schedule' ? await scheduleBody(current, invalidBody.publishDate) : await publicationReview(current, action) })).status, 409);
    }
    const staleSchedule = await scheduleBody(invalidSchedule, invalidBody.publishDate); invalidSchedule.bodyHtml += ' external'; assert.equal((await request(route(invalidSchedule) + '/schedule', { body: staleSchedule })).data.error.code, 'BLOG_ARTICLE_CHANGED'); assert.equal(writes().length, invalidCount);
    const elapsed = addArticle('wordpress'), realNow = Date.now, elapsedAt = realNow() + 60000, elapsedBody = await scheduleBody(elapsed, new Date(elapsedAt).toISOString()); let elapsedReads = 0;
    try {
      providerHook = call => { if (call.method === 'GET' && call.url.pathname.endsWith('/articles/' + elapsed.id)) elapsedReads++; if (elapsedReads === 2 && call.url.pathname === '/api/v1/accounts') Date.now = () => elapsedAt; };
      const result = await request(route(elapsed) + '/schedule', { body: elapsedBody }); assert.equal(result.data.error.code, 'BLOG_SCHEDULE_DATE_ELAPSED'); assert.equal(result.data.operation.status, 'failed'); assert.equal(writes().length, invalidCount);
    } finally { Date.now = realNow; providerHook = undefined; }
    for (const action of ['schedule', 'cancel-schedule']) {
      for (const scenario of ['missing-receipt', 'foreign-receipt', 'wrong-article', 'wrong-time', 'missing-published-at', 'wrong-state', 'wrong-readback', 'lost-ack', 'post-write-access']) {
        const current = addArticle('wordpress'); if (action === 'cancel-schedule') Object.assign(current, { status: 'future', publishDate: '2099-12-01T00:00:00Z' });
        const body = action === 'schedule' ? await scheduleBody(current, invalidBody.publishDate) : await publicationReview(current, action), key = 'schedule-uncertain-' + action + '-' + scenario, count = writes().length; let written = false;
        providerHook = async (call, result) => {
          if (call.method === 'PATCH') {
            written = true;
            if (scenario === 'missing-receipt') return Response.json({ platform: 'wordpress' });
            if (scenario === 'foreign-receipt') return Response.json({ ...result, accountId: 'foreign' });
            if (scenario === 'wrong-article') return Response.json({ ...result, article: { ...result.article, id: '999999' } });
            if (scenario === 'wrong-time') return Response.json({ ...result, article: { ...result.article, publishDate: '2099-11-01T00:00:01Z' } });
            if (scenario === 'missing-published-at') { delete result.article.publishedAt; return Response.json(result); }
            if (scenario === 'wrong-state') return Response.json({ ...result, article: { ...result.article, status: 'pending' } });
            if (scenario === 'lost-ack') throw new Error('Schedule acknowledgement lost');
            if (scenario === 'post-write-access') await sql.run("UPDATE memberships SET role='viewer'");
          }
          if (written && scenario === 'wrong-readback' && call.method === 'GET' && call.url.pathname.endsWith('/articles/' + current.id)) return Response.json({ ...result, article: { ...result.article, blogId: '999' } });
        };
        const result = await request(route(current) + '/' + action, { body, key }); assert.equal(result.status, 409, action + scenario + JSON.stringify(result)); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(writes().length, count + 1); providerHook = undefined; await sql.run("UPDATE memberships SET role='owner'");
        assert.equal((await request(route(current) + '/' + action, { body, key })).data.error.code, 'OPERATION_UNCERTAIN');
        const alias = { ...accounts[0], _id: 'schedule-alias-' + action + '-' + scenario }; accounts.push(alias);
        for (const next of ['update', 'publish', 'unpublish', 'schedule', 'cancel-schedule']) {
          const reviewed = await publicationReview(current, next, alias._id), nextBody = next === 'update' ? { ...await review(current), version: reviewed.version } : next === 'schedule' ? { ...reviewed, publishDate: invalidBody.publishDate } : reviewed;
          assert.equal((await request(route(current, alias._id) + '/' + next, { body: nextBody })).status, 409); assert.equal(writes().length, count + 1);
        }
      }
    }
    const scheduleRace = addArticle('wordpress'), scheduleRaceBody = await scheduleBody(scheduleRace, invalidBody.publishDate), scheduleAlias = { ...accounts[0], _id: 'schedule-final-read-alias' }; accounts.push(scheduleAlias);
    const scheduleAliasBody = await scheduleBody(scheduleRace, invalidBody.publishDate, scheduleAlias._id); let releaseScheduleRead, enteredScheduleRead, scheduleReads = 0;
    const scheduleReadHeld = new Promise(resolve => { enteredScheduleRead = resolve; }), scheduleReadRelease = new Promise(resolve => { releaseScheduleRead = resolve; });
    providerHook = async call => { if (call.method === 'GET' && call.url.pathname.endsWith('/wordpress-account/blogs/' + scheduleRace.blogId + '/articles/' + scheduleRace.id) && ++scheduleReads === 2) { enteredScheduleRead(); await scheduleReadRelease; } if (call.method === 'PATCH') throw new Error('Schedule alias lost acknowledgement'); };
    const countBeforeScheduleRace = writes().length, waitingSchedule = request(route(scheduleRace) + '/schedule', { body: scheduleRaceBody }); await scheduleReadHeld;
    const lostScheduleKey = 'schedule-restart-lost-ack'; assert.equal((await request(route(scheduleRace, scheduleAlias._id) + '/schedule', { body: scheduleAliasBody, key: lostScheduleKey })).data.operation.status, 'uncertain'); releaseScheduleRead();
    assert.equal((await waitingSchedule).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforeScheduleRace + 1); providerHook = undefined;
    const scheduleOriginalProject = projectId, scheduleWorkspaceId = (await sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
    await sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'schedule-alias-project', scheduleWorkspaceId, 'Schedule alias site', 'schedule-alias-profile');
    const scheduleProjectAlias = { ...scheduleAlias, _id: 'schedule-cross-project-alias', profileId: 'schedule-alias-profile' }; accounts.push(scheduleProjectAlias); projectId = 'schedule-alias-project';
    assert.equal((await request(route(scheduleRace, scheduleProjectAlias._id) + '/cancel-schedule', { body: await publicationReview(scheduleRace, 'cancel-schedule', scheduleProjectAlias._id) })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforeScheduleRace + 1); projectId = scheduleOriginalProject;
    await app.close(); app = await createApp({ ...appOptions, database }); await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await request(route(scheduleRace, scheduleAlias._id) + '/schedule', { body: scheduleAliasBody, key: lostScheduleKey })).data.error.code, 'OPERATION_UNCERTAIN');
    assert.equal((await request(route(scheduleRace) + '/cancel-schedule', { body: await publicationReview(scheduleRace, 'cancel-schedule') })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforeScheduleRace + 1);
    const racePublication = addArticle('shopify'), raceBody = await publicationReview(racePublication, 'publish'), publicationAlias = { ...accounts[1], _id: 'publication-final-read-alias' }; accounts.push(publicationAlias);
    const aliasBody = await publicationReview(racePublication, 'publish', publicationAlias._id); let releasePublicationRead, enteredPublicationRead, readsBeforePublication = 0;
    const publicationReadHeld = new Promise(resolve => { enteredPublicationRead = resolve; }), publicationReadRelease = new Promise(resolve => { releasePublicationRead = resolve; });
    providerHook = async call => { if (call.method === 'GET' && call.url.pathname.endsWith('/shopify-account/blogs/' + racePublication.blogId + '/articles/' + racePublication.id) && ++readsBeforePublication === 2) { enteredPublicationRead(); await publicationReadRelease; } if (call.method === 'PATCH') throw new Error('Publication alias lost acknowledgement'); };
    const countBeforePublicationRace = writes().length, waitingPublication = request(route(racePublication) + '/publish', { body: raceBody }); await publicationReadHeld;
    const lostPublicationKey = 'publication-restart-lost-ack';
    assert.equal((await request(route(racePublication, publicationAlias._id) + '/publish', { body: aliasBody, key: lostPublicationKey })).data.operation.status, 'uncertain'); releasePublicationRead();
    assert.equal((await waitingPublication).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforePublicationRace + 1); providerHook = undefined;
    const originalProject = projectId, workspaceId = (await sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
    await sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'publication-alias-project', workspaceId, 'Publication alias site', 'publication-alias-profile');
    const projectAlias = { ...publicationAlias, _id: 'publication-cross-project-alias', profileId: 'publication-alias-profile' }; accounts.push(projectAlias); projectId = 'publication-alias-project';
    const crossProjectBody = await publicationReview(racePublication, 'unpublish', projectAlias._id);
    assert.equal((await request(route(racePublication, projectAlias._id) + '/unpublish', { body: crossProjectBody })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforePublicationRace + 1); projectId = originalProject;
    await app.close(); app = await createApp({ ...appOptions, database }); await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await request(route(racePublication, publicationAlias._id) + '/publish', { body: aliasBody, key: lostPublicationKey })).data.error.code, 'OPERATION_UNCERTAIN');
    const restartBody = await publicationReview(racePublication, 'unpublish');
    assert.equal((await request(route(racePublication) + '/unpublish', { body: restartBody })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, countBeforePublicationRace + 1);
    const publicRace = addPublished(), publicRaceBody = await review(publicRace), publicAlias = { ...accounts[0], _id: 'public-content-final-read-alias' }; accounts.push(publicAlias);
    const publicAliasDetail = await request(route(publicRace, publicAlias._id)), publicAliasBody = { ...publicRaceBody, version: publicAliasDetail.data.version };
    let publicReads = 0, releasePublicRead, enteredPublicRead;
    const publicReadHeld = new Promise(resolve => { enteredPublicRead = resolve; }), publicReadRelease = new Promise(resolve => { releasePublicRead = resolve; });
    providerHook = async call => { if (call.method === 'GET' && call.url.pathname.endsWith('/wordpress-account/blogs/' + publicRace.blogId + '/articles/' + publicRace.id) && ++publicReads === 2) { enteredPublicRead(); await publicReadRelease; } if (call.method === 'PATCH') throw new Error('Published content alias lost acknowledgement'); };
    const publicRaceCount = writes().length, waitingPublic = request(route(publicRace) + '/update', { body: publicRaceBody }); await publicReadHeld;
    const publicLostKey = 'published-content-restart-lost-ack';
    assert.equal((await request(route(publicRace, publicAlias._id) + '/update', { body: publicAliasBody, key: publicLostKey })).data.operation.status, 'uncertain'); releasePublicRead();
    assert.equal((await waitingPublic).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, publicRaceCount + 1); providerHook = undefined;
    const publicState = { status: 'publish', isPublished: true, publishedAt: publicRace.publishedAt, publishDate: null };
    for (const next of ['update', 'unpublish', 'publish', 'schedule', 'cancel-schedule']) {
      Object.assign(publicRace, next === 'publish' || next === 'schedule' ? { status: 'draft', isPublished: false, publishedAt: null, publishDate: null } : next === 'cancel-schedule' ? { status: 'future', isPublished: false, publishedAt: null, publishDate: '2099-12-01T00:00:00Z' } : publicState);
      const detail = await request(route(publicRace, publicAlias._id)), nextBody = next === 'update' ? { ...publicRaceBody, title: 'Different alias content', version: detail.data.version } : next === 'schedule' ? { version: detail.data.version, confirmSchedule: true, publishDate: '2099-12-02T00:00:00Z' } : { version: detail.data.version, [next === 'publish' ? 'confirmPublish' : next === 'unpublish' ? 'confirmUnpublish' : 'confirmCancelSchedule']: true };
      const blocked = await request(route(publicRace, publicAlias._id) + '/' + next, { body: nextBody }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT', next); assert.equal(blocked.data.operation.status, 'failed', next); assert.notEqual(blocked.data.operation.id, (await sql.get('SELECT id FROM integration_operations WHERE request_key=?', publicLostKey)).id); assert.equal(writes().length, publicRaceCount + 1);
    }
    Object.assign(publicRace, publicState);
    const publicOriginalProject = projectId;
    await sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'public-content-alias-project', workspaceId, 'Public content alias site', 'public-content-alias-profile');
    const publicProjectAlias = { ...publicAlias, _id: 'public-content-cross-project-alias', profileId: 'public-content-alias-profile' }; accounts.push(publicProjectAlias); projectId = 'public-content-alias-project';
    assert.equal((await request(route(publicRace, publicProjectAlias._id) + '/unpublish', { body: await publicationReview(publicRace, 'unpublish', publicProjectAlias._id) })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, publicRaceCount + 1); projectId = publicOriginalProject;
    await app.close(); app = await createApp({ ...appOptions, database }); await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await request(route(publicRace, publicAlias._id) + '/update', { body: publicAliasBody, key: publicLostKey })).data.error.code, 'OPERATION_UNCERTAIN');
    const publicRestartReview = await review(publicRace);
    assert.equal((await request(route(publicRace) + '/update', { body: publicRestartReview })).data.error.code, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, publicRaceCount + 1);
  } finally { globalThis.fetch = originalFetch; if (app !== first) await app.close(); await rm(directory, { recursive: true, force: true }); }
});
