import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIntegration } from '../server/integrations.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('social refresh and publishing reject malformed preview fields before persisting them', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), originalFetch = globalThis.fetch, records = new Map(), accepted = [];
  const project = { id: 'preview-project', zernioProfileId: 'preview-profile' }, account = { _id: 'preview-account', profileId: project.zernioProfileId, platform: 'facebook' };
  let remote;
  const store = {
    list() { return []; },
    get(projectId, collection, id) { return projectId === project.id && collection === 'posts' ? structuredClone(records.get(id)) : undefined; },
    update(projectId, collection, id, patch) { const saved = { ...this.get(projectId, collection, id), ...patch }; records.set(id, saved); return saved; },
    activity() {},
  };
  globalThis.fetch = async target => {
    const url = new URL(target);
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (url.pathname === '/api/v1/tools/validate/post') return Response.json({ valid: true, warnings: [] });
    return Response.json({ post: remote });
  };
  async function invoke(action, post, key) {
    let response;
    await handleIntegration({ req: { method: action === 'status' ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/${action}${action === 'status' ? '?postId=' + post.id : ''}`), body: { postId: post.id }, project, db, store, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  const copy = { platform: account.platform, accountId: account._id, status: 'published' };
  const invalid = [
    { platforms: [{ ...copy, status: {} }] },
    { platforms: [{ ...copy, customMedia: [null] }] },
    { platforms: [{ ...copy, platformSpecificData: { firstComment: { invalid: true } } }] },
    { platforms: [{ ...copy, accountId: { _id: account._id, displayName: { invalid: true } } }] },
    { mediaItems: [null] },
    { scheduledFor: { invalid: true } },
    { publishedAt: { invalid: true } },
    { platforms: [{ ...copy, errorMessage: {} }] },
    { platforms: [{ ...copy, errorCategory: [] }] },
    { platforms: [{ ...copy, errorSource: true }] },
    { platforms: [{ ...copy, platformSpecificData: { futureProviderOption: true } }] },
  ];
  try {
    for (const action of ['status', 'publish']) for (const [index, fields] of invalid.entries()) {
      const post = { id: `${action}-${index}`, content: 'Safe local caption', platforms: ['facebook'], accounts: [account._id], status: 'draft', ...(action === 'status' ? { externalId: 'remote-preview', zernioProfileId: project.zernioProfileId } : {}) };
      records.set(post.id, post); remote = { _id: 'remote-preview', status: 'published', platforms: [copy], ...fields };
      const result = await invoke(action, post, `preview-${post.id}`);
      if (result.status !== (action === 'status' ? 502 : 409)) accepted.push({ action, fields, actual: result.status });
      else {
        assert.deepEqual(records.get(post.id), post, 'An invalid provider snapshot must not replace the safe local record.');
        if (action === 'publish') {
          assert.equal(result.data.operation.status, 'uncertain');
          assert.equal((await invoke(action, post, `preview-new-${post.id}`)).status, 409, 'A fresh action key cannot duplicate an unconfirmed write.');
        }
      }
    }
    assert.deepEqual(accepted, [], 'These provider fields feed the actual post preview and must be checked at the shared receipt boundary.');
    const post = { id: 'valid-control', content: 'Safe local caption', platforms: ['facebook'], accounts: [account._id], status: 'draft' };
    records.set(post.id, post);
    remote = { _id: 'remote-preview', status: 'published', publishedAt: '2026-10-18T12:00:00Z', mediaItems: [{ type: 'video', url: 'https://cdn.example.test/creative.mp4', providerExtra: 'retained', subtitles: [{ url: 'https://cdn.example.test/en.vtt', language: 'en', providerExtra: 'retained' }] }], platforms: [{ ...copy, accountId: { _id: account._id, displayName: 'Campaign brand' }, platformSpecificData: { firstComment: 'Readable comment' }, providerMetadata: { futureField: true }, errorMessage: null, errorCategory: null, errorSource: null }] };
    assert.equal((await invoke('publish', post, 'preview-valid-control')).status, 200, 'Valid response additions and nullable diagnostic fields remain supported.');
  } finally { globalThis.fetch = originalFetch; }
});

test('a reviewed partial post retries only failed accounts and preserves published copies in a subset receipt', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-partial-retry-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const app = await testApp(t, { dataDir, appUrl: origin, env: { ZERNIO_API_KEY: 'partial-fixture-key' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, accounts = [{ _id: 'delivered-account', profileId: 'partial-profile', platform: 'instagram', isActive: false }, { _id: 'failed-account', profileId: 'partial-profile', platform: 'facebook', isActive: true }];
  const delivered = { platform: 'instagram', accountId: accounts[0]._id, status: 'published', customContent: 'A'.repeat(2300), customMedia: [], platformPostUrl: 'https://www.instagram.com/p/existing-post/' };
  const media = { type: 'image', url: 'https://cdn.example.test/retry-image.png', tiktokProcessed: true, providerExtra: { readOnly: true } };
  let cookie, writes = 0, checks = 0, remote = { _id: 'partial-remote', status: 'partial', content: 'Shared caption', mediaItems: [media], platforms: [delivered, { platform: 'facebook', accountId: accounts[1]._id, status: 'failed', customMedia: [media], platformSpecificData: { firstComment: 'Known publishing option' }, errorMessage: 'Temporary upstream failure', errorCategory: 'temporary', errorSource: 'platform' }] };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts });
    if (url.pathname === '/api/v1/tools/validate/post') { checks++; const payload = JSON.parse(options.body); assert.equal(payload.publishNow, true); assert.deepEqual(payload.platforms.map(copy => copy.accountId), ['failed-account']); assert.deepEqual(payload.mediaItems, [{ type: media.type, url: media.url }]); assert.deepEqual(payload.platforms[0].customMedia, [{ type: media.type, url: media.url }]); return Response.json({ valid: true, warnings: [] }); }
    if (url.pathname.endsWith('/retry')) {
      writes++;
      return Response.json({ post: { ...remote, status: writes === 1 ? 'partial' : 'published', platforms: [{ platform: 'facebook', status: writes === 1 ? 'failed' : 'published', ...(writes === 1 ? {} : { platformPostUrl: 'https://www.facebook.com/new-post/' }) }] } });
    }
    return Response.json({ post: remote });
  };
  async function request(path, method = 'GET', body, key) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'Partial fixture', email: 'partial@example.test', password: 'a sufficiently long fixture password' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
    const state = (await request('/api/state')).data, project = `/api/projects/${state.projectId}`;
    assert.equal((await request(project, 'PATCH', { zernioProfileId: 'partial-profile' })).status, 200);
    const post = await app.store.create(state.projectId, 'posts', { content: remote.content, status: 'partial', externalId: remote._id, zernioProfileId: 'partial-profile' }), route = project + '/integrations/social';
    const knownOptions = remote.platforms[1].platformSpecificData; remote.platforms[1].platformSpecificData = { unsupportedFutureOption: true };
    const unsupported = await request(route + '/status?postId=' + post.id); assert.equal(unsupported.status, 502); assert.equal(unsupported.data.error.code, 'UNSUPPORTED_PROVIDER_OPTIONS'); assert.deepEqual(await app.store.get(state.projectId, 'posts', post.id), post, 'Unknown effective options must fail before poisoning the working model.');
    remote.platforms[1].platformSpecificData = knownOptions;
    assert.equal((await request(route + '/status?postId=' + post.id)).status, 200);
    const refreshed = await app.store.get(state.projectId, 'posts', post.id); assert.deepEqual(refreshed.mediaItems, [{ type: media.type, url: media.url }]); assert.deepEqual(refreshed.platformOverrides.facebook.mediaItems, [{ type: media.type, url: media.url }]); assert.equal(refreshed.providerResults[1].customMedia[0].tiktokProcessed, true, 'The raw copy receipt retains provider metadata while the editable model is canonical.');
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: true })).status, 200);
    let result = await request(route + '/retry', 'POST', { postId: post.id, confirmPublish: true }, 'partial-unreviewed'); assert.equal(result.status, 403); assert.equal(writes, 0);
    const review = await request(project + '/approvals/posts/' + post.id + '/request', 'POST', {}); assert.equal(review.status, 200, JSON.stringify(review.data)); assert.equal(review.data.item.post.providerFailed, true);
    assert.equal((await request(project + '/approvals/posts/' + post.id + '/review', 'POST', { decision: 'approved', reviewId: review.data.item.review.id })).status, 200);
    result = await request(route + '/retry', 'POST', { postId: post.id, confirmPublish: true }, 'partial-reviewed'); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.post.status, 'partial'); assert.deepEqual(result.data.post.accounts, refreshed.accounts, 'A subset acknowledgement preserves target ordering and its approval fingerprint.');
    result = await request(route + '/retry', 'POST', { postId: post.id, confirmPublish: true }, 'partial-reviewed-again'); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(checks, 3); assert.equal(writes, 2); assert.equal(result.data.post.providerResults.length, 2); assert.deepEqual(result.data.post.providerResults.find(copy => copy.accountId === delivered.accountId), delivered);
    assert.deepEqual(new Set(result.data.post.accounts), new Set(accounts.map(account => account._id)));
    assert.equal((await request(route + '/retry', 'POST', { postId: post.id, confirmPublish: true }, 'partial-reviewed-again')).status, 200); assert.equal(writes, 2, 'Replaying an acknowledged action cannot publish another copy.');
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});

test('minimal retry receipts identify original accounts without duplicating successful copies or guessing ambiguous targets', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), originalFetch = globalThis.fetch, project = { id: 'minimal-project', zernioProfileId: 'minimal-profile' }, records = new Map();
  let remote, acknowledgement, writes = 0;
  const store = { list() { return []; }, get(projectId, collection, id) { return collection === 'posts' ? structuredClone(records.get(id)) : undefined; }, update(projectId, collection, id, patch) { const saved = { ...this.get(projectId, collection, id), ...patch }; records.set(id, saved); return saved; }, activity() {} };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: remote.platforms.map(copy => ({ _id: copy.accountId, platform: copy.platform, profileId: project.zernioProfileId })) });
    if (url.pathname === '/api/v1/tools/validate/post') return Response.json({ valid: true, warnings: [] });
    if (options.method === 'POST') { writes++; return Response.json({ post: acknowledgement }); }
    return Response.json({ post: remote });
  };
  async function retry(post, key) {
    let response;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/retry`), body: { postId: post.id, confirmPublish: true }, project, db, store, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    const delivered = { platform: 'facebook', accountId: 'existing-account', status: 'published', customContent: 'Existing published copy', platformPostUrl: 'https://www.facebook.com/existing/' }, failed = { platform: 'linkedin', accountId: 'retry-account', status: 'failed', errorMessage: 'Temporary failure', errorCategory: 'system_error', errorSource: 'system' };
    for (const [index, copies] of [
      [{ platform: 'linkedin', status: 'published' }],
      [{ platform: 'facebook', status: 'published' }, { platform: 'linkedin', status: 'published' }],
      [{ accountId: failed.accountId, status: 'published' }],
    ].entries()) {
      const post = { id: 'minimal-' + index, content: 'Caption', externalId: 'remote-minimal', zernioProfileId: project.zernioProfileId, status: 'partial' }; records.set(post.id, post);
      remote = { _id: post.externalId, content: post.content, status: 'partial', platforms: [delivered, failed] }; acknowledgement = { _id: post.externalId, status: 'published', platforms: copies };
      const result = await retry(post, 'minimal-valid-' + index); assert.equal(result.status, 200, JSON.stringify(result.data));
      const saved = result.data.post; assert.equal(saved.providerResults.length, 2); assert.deepEqual(new Set(saved.accounts), new Set([delivered.accountId, failed.accountId]));
      assert.deepEqual(saved.providerResults.find(copy => copy.accountId === delivered.accountId), delivered);
      const retried = saved.providerResults.find(copy => copy.accountId === failed.accountId); assert.equal(retried.platform, failed.platform); assert.equal(retried.status, 'published'); assert.equal(retried.errorMessage, undefined);
    }
    for (const duplicate of [false, true]) {
      const post = { id: 'ambiguous-' + duplicate, content: 'Caption', externalId: 'remote-ambiguous', zernioProfileId: project.zernioProfileId, status: 'partial' }; records.set(post.id, post);
      remote = { _id: post.externalId, content: post.content, status: 'partial', platforms: [delivered, { ...failed, platform: delivered.platform }] };
      acknowledgement = { _id: post.externalId, status: 'published', platforms: duplicate ? [{ platform: delivered.platform, accountId: failed.accountId, status: 'published' }, { platform: delivered.platform, accountId: failed.accountId, status: 'published' }] : [{ platform: delivered.platform, status: 'published' }] };
      const before = writes, result = await retry(post, 'minimal-ambiguous-' + duplicate); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.deepEqual(records.get(post.id), post);
      assert.equal((await retry(post, 'minimal-new-key-' + duplicate)).status, 409); assert.equal(writes, before + 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a Drive upload cannot complete with a folder receipt and no saved asset', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), originalFetch = globalThis.fetch, { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const project = { id: 'upload-project', driveFolderId: 'shared-folder' }, assets = []; let uploads = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-google-token' });
    if (options.method === 'POST') { uploads++; return Response.json({ id: 'wrong-folder', name: 'Uploaded creative.png', mimeType: 'application/vnd.google-apps.folder' }); }
    return Response.json({ id: project.driveFolderId, mimeType: 'application/vnd.google-apps.folder', driveId: 'shared-drive' });
  };
  const body = { name: 'Uploaded creative.png', mimeType: 'image/png', contentBase64: Buffer.from('fixture bytes').toString('base64') };
  async function upload(key) {
    let response;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/drive/upload`), body, project, db, store: { list() { return assets; }, create(projectId, collection, record) { assets.push(record); return record; } }, role: 'editor', config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'fixture@example.test', GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    const result = await upload('drive-folder-receipt');
    assert.equal(result.status, 409, 'A successful remote response with no uploaded file is an uncertain provider outcome.');
    assert.equal(result.data.operation.status, 'uncertain'); assert.equal(assets.length, 0);
    assert.equal((await upload('drive-folder-fresh-key')).status, 409); assert.equal(uploads, 1);
  } finally { globalThis.fetch = originalFetch; }
});
