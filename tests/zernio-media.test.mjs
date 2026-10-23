import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.ts';
import { MEDIA_DELIVERY_FIELDS } from '../server/zernio-media.ts';
import { postgresSkip, singleConnection, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const appUrl = 'https://hosted-media.example.test', profileId = 'media-profile', storageHost = 'a'.repeat(32) + '.r2.cloudflarestorage.com';
const until = async check => { for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('Synthetic upload did not reach the expected state'); };
// Restart closes the app and opens another on the same injected database, so process-local grants and active
// transfers are lost exactly as in a real process restart while durable attempt rows remain.
async function fixture(t, poolOptions) {
  const database = await testDatabase(t, poolOptions), dataDir = await mkdtemp(join(tmpdir(), 'ten98-zernio-media-')), originalFetch = globalThis.fetch, env = { ZERNIO_API_KEY: 'synthetic-media-key' }, calls = [], objects = new Map(), state = { counter: 0, storageCalls: 0, chunks: 0, bytes: 0, presignHook: null, validateHook: null, storageHook: null, chunkHook: null, grantHook: null, lostAck: false, invalidMetadata: null, socialPreflight: null, postWrites: 0, posts: new Map(), postReadHook: null };
  let app, origin, cookie, projectId, base;
  const start = async () => { app = Object.assign(await createApp({ dataDir, appUrl, env, directScheduler: false, database }), { database, sql: database.sql }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`; };
  await start();
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET'; calls.push({ origin: url.origin, path: url.pathname, method, body: url.hostname === 'zernio.com' && options.body ? JSON.parse(options.body) : undefined });
    if (url.hostname === 'zernio.com') {
      assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic-media-key');
      const body = options.body ? JSON.parse(options.body) : undefined;
      if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [{ _id: 'facebook-one', profileId, platform: 'facebook', isActive: true }] });
      if (url.pathname === '/api/v1/tools/validate/post') { await state.socialPreflight?.(); return Response.json({ valid: true }); }
      if (url.pathname === '/api/v1/posts') { state.postWrites++; const post = { ...body, _id: 'provider-post-' + state.postWrites, profileId, status: body.scheduledFor ? 'scheduled' : 'published', mediaItems: body.mediaItems || [], platforms: body.platforms.map(row => ({ ...row, status: body.scheduledFor ? 'pending' : 'published' })) }; state.posts.set(post._id, post); return Response.json({ post }); }
      if (url.pathname.startsWith('/api/v1/posts/')) {
        const parts = url.pathname.split('/'), post = state.posts.get(parts[4]); assert.ok(post, 'Only synthetic scoped posts may be accessed.');
        if (method === 'GET') { await state.postReadHook?.(post); return Response.json({ post }); }
        state.postWrites++;
        if (method === 'PUT') { Object.assign(post, body, { status: body.isDraft ? 'draft' : 'scheduled' }); return Response.json({ post }); }
        if (parts[5] === 'retry') { assert.deepEqual(body, {}, 'Retry must reuse the native post without resending its media.'); post.status = 'publishing'; post.platforms = post.platforms.map(target => ({ ...target, status: target.status === 'failed' ? 'pending' : target.status })); return Response.json({ post }); }
        if (parts[5] === 'edit') { const target = post.platforms.find(target => target.accountId === body.accountId); target.customContent = body.content; return Response.json({ success: true }); }
        assert.fail('Unsupported synthetic post write');
      }
      if (url.pathname === '/api/v1/media/presign') {
        state.counter++; await state.presignHook?.(body);
        const key = `temp/${state.counter}_${body.filename}`, uploadUrl = new URL(`https://${storageHost}/synthetic-bucket/${key}`);
        const query = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Date': new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), 'X-Amz-Expires': '3600', 'X-Amz-SignedHeaders': 'content-type;host', 'X-Amz-Signature': 'b'.repeat(64), 'X-Amz-Credential': 'SECRET_SYNTHETIC_SIGNING_CREDENTIAL' }; for (const [key, value] of Object.entries(query)) uploadUrl.searchParams.set(key, value);
        const grant = { uploadUrl: uploadUrl.href, publicUrl: new URL(`https://media.zernio.com/${key}`).href, key, expiresIn: 3600 }; state.grantHook?.(grant); return Response.json(grant);
      }
      assert.equal(url.pathname, '/api/v1/tools/validate/media'); assert.equal(method, 'POST'); await state.validateHook?.(body);
      const found = objects.get(body.url); return Response.json(state.invalidMetadata || (found ? { valid: true, url: body.url, size: found.size, contentType: found.contentType } : { valid: false, url: body.url, error: 'Not available yet' }));
    }
    assert.equal(url.hostname, storageHost, 'No untrusted or live host may receive a request.'); assert.equal(method, 'PUT'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers['X-Api-Key'], undefined); assert.equal(options.duplex, 'half'); assert.ok(options.body?.[Symbol.asyncIterator]); assert.equal(Buffer.isBuffer(options.body), false);
    state.storageCalls++; let bytes = 0, chunks = 0; const hash = createHash('sha256');
    for await (const chunk of options.body) { assert.ok(chunk instanceof Uint8Array); bytes += chunk.byteLength; chunks++; hash.update(chunk); await state.chunkHook?.(chunks); }
    assert.equal(bytes, Number(options.headers['Content-Length'])); state.bytes = bytes; state.chunks = chunks; const digest = hash.digest('hex'); await state.storageHook?.(options);
    const key = decodeURIComponent(url.pathname.slice('/synthetic-bucket/'.length)), publicUrl = new URL('https://media.zernio.com/' + key).href; objects.set(publicUrl, { size: bytes, contentType: options.headers['Content-Type'], hash: digest });
    if (state.lostAck) throw new Error('Synthetic storage acknowledgement was lost');
    return new Response('', { status: 200, headers: { ETag: '"synthetic-object-etag"' } });
  };
  async function request(path, { method = 'GET', body, key = randomUUID(), authenticated = true, matchingOrigin = true, headers = {} } = {}) {
    const raw = body instanceof Uint8Array, response = await originalFetch(origin + path, { method, headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(matchingOrigin ? { Origin: appUrl } : {}), ...(body === undefined ? {} : raw ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }), ...headers }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
    const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; return { status: response.status, data: await response.json() };
  }
  let created; try { created = await request('/api/auth/setup', { method: 'POST', body: { name: 'Hosted media owner', email: 'media@example.test', password: 'Synthetic hosted media passphrase 2026!' } }); created.data.projectId = await firstProject(app, created, { cookie }); assert.equal(created.status, 201); projectId = created.data.projectId; await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId); base = `/api/projects/${projectId}/integrations/media/uploads`; } catch (error) { globalThis.fetch = originalFetch; await app.close(); throw error; }
  const options = async assetId => request(base + '/options' + (assetId ? '?assetId=' + assetId : ''));
  const prepare = async (input = {}, key) => request(base, { method: 'POST', body: { attemptId: randomUUID(), filename: 'creative.jpg', contentType: 'image/jpeg', size: 3, ...input }, ...(key ? { key } : {}) });
  const put = async (attempt, bytes = Buffer.from('abc'), settings = {}) => request(base + '/' + attempt.id + '/content', { method: 'PUT', body: bytes, headers: { 'Content-Type': attempt.contentType, ...settings.headers }, ...settings });
  const action = (attempt, task, key) => request(base + '/' + attempt.id + '/' + task, { method: 'POST', body: {}, ...(key ? { key } : {}) });
  return { get app() { return app; }, get projectId() { return projectId; }, get base() { return base; }, state, objects, calls, request, options, prepare, put, action, async restart() { await app.close(); await start(); }, async close() { globalThis.fetch = originalFetch; await app.close(); assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep)); await rm(dataDir, { recursive: true, force: true }); } };
}

test('authenticated hosted upload streams exact bytes without storage credentials and saves one pending asset only after validation', { skip: postgresSkip }, async t => {
  // One pool connection: the prepare and save transactions must re-check access on their own connection.
  const f = await fixture(t, singleConnection);
  try {
    const capabilities = await f.options(); assert.equal(capabilities.status, 200); assert.equal(capabilities.data.maxSize, 5_000_000_000); assert.ok(capabilities.data.formats.some(row => row.contentType === 'application/pdf'));
    const bytes = Buffer.alloc(600000, 0x71), attemptId = randomUUID(), input = { attemptId, size: bytes.length }, first = await f.prepare(input, 'stable-prepare-key'); assert.equal(first.status, 200, JSON.stringify(first.data)); let attempt = first.data.attempt; assert.equal(attempt.status, 'awaiting_upload'); assert.equal(attempt.projectId, f.projectId); assert.equal(attempt.id, attemptId); assert.equal(f.state.counter, 1);
    assert.equal((await f.prepare(input, 'stable-prepare-key')).status, 200); assert.equal(f.state.counter, 1); assert.equal((await f.prepare(input)).data.attempt.id, attemptId); assert.equal(f.state.counter, 1);
    const uploaded = await f.put(attempt, bytes); assert.equal(uploaded.status, 200); attempt = uploaded.data.attempt; assert.equal(attempt.status, 'uploaded'); assert.ok(f.state.chunks > 1); assert.equal(f.state.bytes, bytes.length); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 0);
    f.state.invalidMetadata = { valid: true, size: bytes.length, contentType: 'image/jpeg' }; // The pinned contract permits omitting the URL echo; the request remains bound to the exact saved URL.
    const result = await f.action(attempt, 'recover', 'stable-save-key'); assert.equal(result.status, 200, JSON.stringify(result.data)); const saved = result.data.attempt; assert.equal(saved.status, 'completed'); assert.equal(saved.assetId, saved.asset.id); assert.equal(saved.asset.approval, 'pending'); assert.equal(saved.asset.source, 'zernio'); assert.equal(saved.asset.deliveryUrl, attempt.publicUrl); assert.equal(saved.asset.deliverySize, bytes.length); assert.equal(saved.asset.deliveryFilename, 'creative.jpg'); assert.equal(Date.parse(saved.asset.deliveryExpiresAt) - Date.parse(saved.asset.deliveryUploadedAt), 7 * 86400000);
    assert.equal((await f.action(attempt, 'recover', 'stable-save-key')).data.attempt.assetId, saved.asset.id); assert.equal((await f.action(attempt, 'recover')).data.attempt.assetId, saved.asset.id); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 1);
    assert.equal((await f.prepare(input, 'stable-prepare-key')).data.attempt.status, 'completed', 'Preparing with the same client ID returns authoritative current state rather than a cached readiness receipt.');
    const stored = JSON.stringify(await f.app.sql.all('SELECT data FROM zernio_media_uploads')) + JSON.stringify(await f.app.sql.all('SELECT response FROM integration_operations')) + JSON.stringify(first.data) + JSON.stringify(result.data);
    assert.doesNotMatch(stored, /uploadUrl|X-Amz|SECRET_SYNTHETIC|cloudflarestorage/); assert.ok(f.calls.filter(call => call.path === '/api/v1/tools/validate/media').every(call => call.body.url === attempt.publicUrl));
  } finally { await f.close(); }
});

test('upload trust boundaries reject bad filenames, MIME extensions, sizes, storage hosts and mismatched object paths before any transfer', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const input of [{ filename: '../creative.jpg' }, { filename: 'creative.mp4' }, { contentType: '' }, { contentType: 'application/octet-stream' }, { size: 0 }, { size: 5_000_000_001 }, { size: 1.5 }, { filename: 'creative.svg', contentType: 'image/svg+xml' }, { filename: 'sound.mp3', contentType: 'audio/mpeg' }]) assert.equal((await f.prepare(input)).status, 400);
    assert.equal(f.state.counter, 0);
    for (const change of [grant => { grant.uploadUrl = grant.uploadUrl.replace(storageHost, storageHost + '.attacker.example'); }, grant => { grant.uploadUrl = grant.uploadUrl.replace('https:', 'http:'); }, grant => { grant.publicUrl = grant.publicUrl.replace('media.zernio.com', 'attacker.example'); }, grant => { grant.key = 'temp/another-file.jpg'; }, grant => { grant.expiresIn = 7200; }, grant => { grant.uploadUrl = grant.uploadUrl.replace('/temp/', '/other/'); }]) {
      f.state.grantHook = change; const result = await f.prepare(); assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_MEDIA_UPLOAD_GRANT'); assert.equal(f.state.storageCalls, 0);
    }
    f.state.grantHook = null; assert.equal((await f.prepare({ size: 5_000_000_000 })).status, 200); assert.equal(f.state.storageCalls, 0);
  } finally { await f.close(); }
});

test('only the exact authenticated same-origin content PUT bypasses JSON and its byte length and type must match the reviewed file', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const attempt = (await f.prepare()).data.attempt, path = f.base + '/' + attempt.id + '/content';
    assert.equal((await f.put(attempt, Buffer.from('abc'), { authenticated: false })).status, 401); assert.equal((await f.put(attempt, Buffer.from('abc'), { matchingOrigin: false })).status, 403);
    assert.equal((await f.request(path + '/unexpected', { method: 'PUT', body: Buffer.from('abc'), headers: { 'Content-Type': 'image/jpeg' } })).status, 415);
    assert.equal((await f.put(attempt, Buffer.from('ab'))).status, 400); assert.equal((await f.put(attempt, Buffer.from('abc'), { headers: { 'Content-Type': 'image/png' } })).status, 400); assert.equal((await f.put(attempt, Buffer.from('abc'), { headers: { 'Content-Type': 'image/jpeg', 'Content-Encoding': 'gzip' } })).status, 400);
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await f.put(attempt)).status, 403); await f.app.sql.run("UPDATE memberships SET role='owner'");
    const other = await f.request('/api/workspaces', { method: 'POST', body: { name: 'Other upload project' } }); assert.equal(other.status, 201); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'other-profile', other.data.projectId);
    assert.equal((await f.request(f.base.replace(f.projectId, other.data.projectId) + '/' + attempt.id)).status, 404); assert.equal(f.state.storageCalls, 0);
    assert.equal((await f.put(attempt)).data.attempt.status, 'uploaded');
  } finally { await f.close(); }
});

test('replacement uploads preserve Drive originals and project metadata, reset approval, and protect managed metadata from generic writes', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const original = await f.app.store.create(f.projectId, 'assets', { name: 'Drive original', url: 'https://drive.google.com/file/d/original/view', source: 'google-drive', driveId: 'original', mimeType: 'image/png', kind: 'image', size: 9000, width: 1080, height: 1080, modifiedTime: '2026-10-18T00:00:00Z', md5Checksum: 'c'.repeat(32), tags: ['brand'], description: 'Reviewed project description', approval: 'approved' }), snapshot = (await f.options(original.id)).data;
    const prepared = await f.prepare({ assetId: original.id, assetVersion: snapshot.assetVersion }); assert.equal(prepared.status, 200); let attempt = prepared.data.attempt; assert.equal((await f.put(attempt)).data.attempt.status, 'uploaded'); const result = await f.action(attempt, 'recover'); assert.equal(result.status, 200); const asset = result.data.attempt.asset;
    for (const key of ['id', 'url', 'source', 'driveId', 'mimeType', 'kind', 'size', 'width', 'height', 'modifiedTime', 'md5Checksum', 'tags', 'description']) assert.deepEqual(asset[key], original[key], key);
    assert.equal(asset.approval, 'pending'); assert.equal(asset.deliverySize, 3); assert.equal(asset.deliveryMimeType, 'image/jpeg'); assert.equal(asset.deliverySource, 'zernio');
    const path = `/api/projects/${f.projectId}/assets/${asset.id}`; assert.equal((await f.request(path, { method: 'PATCH', body: { deliveryExpiresAt: '2099-01-01T00:00:00Z' } })).status, 400); assert.equal((await f.request(`/api/projects/${f.projectId}/assets`, { method: 'POST', body: { name: 'Forged', url: asset.url, deliverySource: 'zernio' } })).status, 400);
    assert.equal((await f.request(path, { method: 'PATCH', body: { description: 'Updated description' } })).data.record.deliveryKey, asset.deliveryKey);
    const sameUrl = await f.request(path, { method: 'PATCH', body: { deliveryUrl: '  ' + asset.deliveryUrl.replace('media.zernio.com/', 'media.zernio.com:443/') + '  ' } }); assert.equal(sameUrl.status, 200); assert.equal(sameUrl.data.record.deliverySource, 'zernio'); assert.equal(sameUrl.data.record.deliveryExpiresAt, asset.deliveryExpiresAt, 'Equivalent URL formatting must not erase the managed expiry.');
    const manual = await f.request(path, { method: 'PATCH', body: { deliveryUrl: 'https://cdn.example.test/manual.jpg' } }); assert.equal(manual.status, 200); assert.ok(MEDIA_DELIVERY_FIELDS.every(key => manual.data.record[key] === null));
  } finally { await f.close(); }
});

test('lost transfer acknowledgements recover by checking the exact public file without resending bytes or creating duplicate assets', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    let attempt = (await f.prepare()).data.attempt; f.state.lostAck = true; const result = await f.put(attempt); assert.equal(result.status, 200); attempt = result.data.attempt; assert.equal(attempt.status, 'transfer_uncertain'); assert.equal(f.state.storageCalls, 1);
    assert.equal((await f.put(attempt)).status, 409); assert.equal(f.state.storageCalls, 1);
    f.state.lostAck = false; const found = await f.action(attempt, 'retry'); assert.equal(found.status, 200); assert.equal(found.data.attempt.status, 'uploaded'); assert.equal(f.state.counter, 1, 'A present file must not mint another upload grant.');
    const saved = await f.action(attempt, 'recover'); assert.equal(saved.status, 200); assert.equal(saved.data.attempt.status, 'completed'); assert.equal(f.state.storageCalls, 1); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 1);
    assert.equal((await f.action(attempt, 'cancel')).data.attempt.status, 'completed'); assert.equal((await f.action(attempt, 'recover')).data.attempt.assetId, saved.data.attempt.assetId);
  } finally { await f.close(); }
});

test('restart recovery never persists a signed grant and rechecks before preparing another transfer', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    let attempt = (await f.prepare()).data.attempt; await f.restart(); assert.equal((await f.put(attempt)).status, 409); assert.equal(f.state.storageCalls, 0);
    const retry = await f.action(attempt, 'retry'); assert.equal(retry.status, 200); attempt = retry.data.attempt; assert.equal(attempt.status, 'awaiting_upload'); assert.equal(f.state.counter, 2); assert.ok(f.calls.some(call => call.path === '/api/v1/tools/validate/media'));
    await f.put(attempt); await f.restart(); assert.equal((await f.request(f.base + '/' + attempt.id)).data.attempt.status, 'uploaded'); const saved = await f.action(attempt, 'recover'); assert.equal(saved.data.attempt.status, 'completed'); assert.equal(f.state.storageCalls, 1);
  } finally { await f.close(); }
});

test('restart during preparation leaves no nonterminal operation fence and the same attempt can recover to one saved asset', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    let attempt = (await f.prepare()).data.attempt; assert.equal((await f.app.sql.get('SELECT count(*) AS count FROM integration_operations')).count, 0, 'Preparation uses the durable client attempt ID instead of caching a nonterminal operation.');
    const stored = (await f.app.sql.get('SELECT data FROM zernio_media_uploads WHERE id=?', attempt.id)).data; stored.status = 'preparing'; for (const key of ['publicUrl', 'key', 'uploadExpiresAt']) delete stored[key]; await f.app.sql.run('UPDATE zernio_media_uploads SET data=? WHERE id=?', JSON.stringify(stored), attempt.id);
    await f.restart(); let result = await f.request(f.base + '/' + attempt.id); assert.equal(result.data.attempt.status, 'preparation_failed'); assert.equal(result.data.attempt.errorCode, 'MEDIA_PREPARATION_INTERRUPTED');
    result = await f.action(attempt, 'retry', 'same-interrupted-preparation-key'); assert.equal(result.status, 200); attempt = result.data.attempt; assert.equal(attempt.status, 'awaiting_upload'); assert.equal(f.state.counter, 2); await f.put(attempt);
    result = await f.action(attempt, 'recover', 'same-interrupted-preparation-key'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.attempt.status, 'completed'); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 1); assert.equal((await f.app.sql.get('SELECT count(*) AS count FROM integration_operations')).count, 1, 'Only the final atomic asset save needs a durable operation receipt.');
  } finally { await f.close(); }
});

test('cancellation wins late preparation and storage acknowledgements without claiming remote deletion', { skip: postgresSkip }, async t => {
  const f = await fixture(t); let release;
  try {
    const attemptId = randomUUID(); let reached = false; f.state.presignHook = async () => { reached = true; await new Promise(resolve => { release = resolve; }); };
    const preparing = f.prepare({ attemptId }); await until(() => reached); const cancelled = await f.action({ id: attemptId }, 'cancel'); assert.equal(cancelled.data.attempt.status, 'cancelled'); assert.equal(cancelled.data.storageRevoked, false); release(); assert.equal((await preparing).data.attempt.status, 'cancelled');
    const rejectedId = randomUUID(); reached = false; f.state.presignHook = async () => { reached = true; await new Promise(resolve => { release = resolve; }); throw new Error('Synthetic preparation failed after cancellation'); };
    const rejecting = f.prepare({ attemptId: rejectedId }); await until(() => reached); assert.equal((await f.action({ id: rejectedId }, 'cancel')).data.attempt.status, 'cancelled'); release(); assert.equal((await rejecting).data.attempt.status, 'cancelled'); assert.equal((await f.request(f.base + '/' + rejectedId)).data.attempt.status, 'cancelled');
    f.state.presignHook = null; let attempt = (await f.prepare()).data.attempt; reached = false; f.state.storageHook = async () => { reached = true; await new Promise(resolve => { release = resolve; }); };
    const transferring = f.put(attempt); await until(() => reached); assert.equal((await f.action(attempt, 'retry')).status, 409); const result = await f.action(attempt, 'cancel'); assert.equal(result.data.attempt.status, 'cancelled'); assert.equal(result.data.attempt.storageMayContainFile, true); release(); assert.equal((await transferring).data.attempt.status, 'cancelled');
    assert.equal((await f.action(attempt, 'recover')).data.attempt.status, 'cancelled'); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 0); assert.equal(f.objects.size, 1, 'A late storage commit is possible and is not mislabeled as revoked.');
  } finally { release?.(); await f.close(); }
});

test('save fails closed for wrong inspection URL, size or MIME and fresh role, mapping and replacement-version changes', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    let attempt = (await f.prepare()).data.attempt; await f.put(attempt);
    for (const bad of [{ valid: true, url: 'https://media.zernio.com/temp/wrong.jpg', size: 3, contentType: 'image/jpeg' }, { valid: true, url: attempt.publicUrl, size: 4, contentType: 'image/jpeg' }, { valid: true, url: attempt.publicUrl, size: 3, contentType: 'image/png' }, { valid: true, url: attempt.publicUrl, size: null, contentType: 'image/jpeg' }]) { f.state.invalidMetadata = bad; const result = await f.action(attempt, 'recover'); assert.equal(result.status, 409); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 0); }
    f.state.invalidMetadata = null; f.state.validateHook = async () => { await f.app.sql.run("UPDATE memberships SET role='viewer'"); }; const revoked = await f.action(attempt, 'recover'); assert.equal(revoked.status, 409); assert.equal(revoked.data.operation, undefined); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 0); await f.app.sql.run("UPDATE memberships SET role='owner'");
    f.state.validateHook = async () => { await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'changed-profile', f.projectId); }; assert.equal((await f.action(attempt, 'recover')).status, 409); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 0); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, f.projectId); f.state.validateHook = null;
    const original = await f.app.store.create(f.projectId, 'assets', { name: 'Original', url: 'https://cdn.example.test/original.jpg', kind: 'image', approval: 'approved', tags: ['old'] }), snapshot = (await f.options(original.id)).data;
    attempt = (await f.prepare({ assetId: original.id, assetVersion: snapshot.assetVersion })).data.attempt; await f.put(attempt); f.state.validateHook = async () => { await f.app.store.update(f.projectId, 'assets', original.id, { tags: ['changed during validation'] }); }; assert.equal((await f.action(attempt, 'recover')).status, 409); assert.equal((await f.app.store.get(f.projectId, 'assets', original.id)).deliveryUrl, undefined); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 1);
  } finally { await f.close(); }
});

test('same action keys recheck changing readiness and can prepare a new grant after a second failed transfer', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    let attempt = (await f.prepare()).data.attempt; await f.put(attempt); f.state.invalidMetadata = { valid: false, url: attempt.publicUrl };
    let result = await f.action(attempt, 'recover', 'same-recover-readiness-key'); assert.equal(result.status, 200); assert.equal(result.data.attempt.status, 'transfer_uncertain'); assert.equal(result.data.operation, undefined);
    f.state.invalidMetadata = null; result = await f.action(attempt, 'recover', 'same-recover-readiness-key'); assert.equal(result.status, 200); assert.equal(result.data.attempt.status, 'completed'); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 1);
    attempt = (await f.prepare()).data.attempt; f.state.storageHook = () => { throw new Error('Synthetic transfer failed before storage commit'); }; assert.equal((await f.put(attempt)).data.attempt.status, 'transfer_uncertain');
    result = await f.action(attempt, 'retry', 'same-retry-readiness-key'); const firstRetry = result.data.attempt; assert.equal(firstRetry.status, 'awaiting_upload'); assert.equal(firstRetry.storageMayContainFile, true, 'A new grant cannot revoke any copy that an earlier uncertain transfer may have stored.'); assert.equal((await f.put(firstRetry)).data.attempt.status, 'transfer_uncertain');
    result = await f.action(attempt, 'retry', 'same-retry-readiness-key'); const secondRetry = result.data.attempt; assert.equal(secondRetry.status, 'awaiting_upload'); assert.notEqual(secondRetry.publicUrl, firstRetry.publicUrl); const preparedCount = f.state.counter;
    assert.equal((await f.action(attempt, 'retry', 'same-retry-readiness-key')).data.attempt.publicUrl, secondRetry.publicUrl); assert.equal(f.state.counter, preparedCount, 'A still-live, unused retry grant is reused.');
    f.state.storageHook = null; assert.equal((await f.put(secondRetry)).data.attempt.status, 'uploaded'); assert.equal((await f.action(attempt, 'recover')).data.attempt.status, 'completed'); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 2);
  } finally { await f.close(); }
});

test('streaming stops on the next chunk when workspace access changes', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const bytes = Buffer.alloc(600000), attempt = (await f.prepare({ size: bytes.length })).data.attempt; let chunks = 0;
    f.state.chunkHook = async count => { chunks = count; if (count === 1) await f.app.sql.run("UPDATE memberships SET role='viewer'"); };
    const result = await f.put(attempt, bytes); assert.equal(result.status, 403); assert.equal(chunks, 1); assert.equal(f.objects.size, 0); assert.equal((await f.app.store.list(f.projectId, 'assets')).length, 0);
    await f.app.sql.run("UPDATE memberships SET role='owner'"); const readback = await f.request(f.base + '/' + attempt.id); assert.equal(readback.data.attempt.status, 'transfer_uncertain'); assert.ok(readback.data.attempt.receivedBytes < bytes.length);
  } finally { await f.close(); }
});

test('completed readbacks report current approval, changed delivery and removed asset without replaying an upload', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const attempt = (await f.prepare({ filename: 'c'.repeat(251) + '.jpg' })).data.attempt; await f.put(attempt); const saved = (await f.action(attempt, 'recover')).data.attempt.asset; assert.equal(saved.name.length, 250); assert.equal(saved.deliveryFilename.length, 255);
    await f.app.store.update(f.projectId, 'assets', saved.id, { approval: 'approved' }); let result = await f.request(f.base + '/' + attempt.id); assert.equal(result.data.attempt.asset.approval, 'approved'); assert.equal(result.data.attempt.deliveryChanged, undefined);
    const path = `/api/projects/${f.projectId}/assets/${saved.id}`; await f.request(path, { method: 'PATCH', body: { deliveryUrl: 'https://cdn.example.test/replaced.jpg' } }); result = await f.request(f.base + '/' + attempt.id); assert.equal(result.data.attempt.status, 'completed'); assert.equal(result.data.attempt.deliveryChanged, true);
    assert.equal((await f.request(path, { method: 'DELETE' })).status, 200); result = await f.request(f.base + '/' + attempt.id); assert.equal(result.data.attempt.status, 'completed'); assert.equal(result.data.attempt.savedAssetMissing, true); assert.equal(result.data.attempt.asset, undefined); assert.equal(f.state.storageCalls, 1);
  } finally { await f.close(); }
});

test('publishing checks known hosted expiry for asset references, pasted URLs and expiry during provider preflight', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const attempt = (await f.prepare()).data.attempt; await f.put(attempt); const saved = (await f.action(attempt, 'recover')).data.attempt.asset;
    const expired = { deliveryUploadedAt: new Date(Date.now() - 8 * 86400000).toISOString(), deliveryExpiresAt: new Date(Date.now() - 1000).toISOString() }; await f.app.store.update(f.projectId, 'assets', saved.id, { approval: 'approved', ...expired });
    const create = async data => f.request(`/api/projects/${f.projectId}/posts`, { method: 'POST', body: { content: 'Reviewed creative', platforms: ['facebook'], accounts: ['facebook-one'], status: 'draft', ...data } }), publish = async postId => f.request(`/api/projects/${f.projectId}/integrations/social/publish`, { method: 'POST', body: { postId } });
    for (const data of [{ assetId: saved.id }, { mediaItems: [{ type: 'image', url: saved.deliveryUrl, mimeType: 'image/jpeg', size: 3 }] }]) { const post = (await create(data)).data.record; const result = await publish(post.id); assert.equal(result.status, 422, JSON.stringify(result.data)); assert.equal(f.state.postWrites, 0); }
    await f.app.store.update(f.projectId, 'assets', saved.id, { deliveryUploadedAt: new Date().toISOString(), deliveryExpiresAt: new Date(Date.now() + 3600000).toISOString() }); const post = (await create({ assetId: saved.id })).data.record;
    f.state.socialPreflight = async () => { await f.app.store.update(f.projectId, 'assets', saved.id, expired); }; const result = await publish(post.id); assert.equal(result.status, 422, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'failed'); assert.equal(f.state.postWrites, 0);
    f.state.socialPreflight = null; const safe = (await create({ assetId: saved.id, platformOverrides: { facebook: { mediaItems: [{ type: 'image', url: 'https://cdn.example.test/permanent-copy.jpg', mimeType: 'image/jpeg', size: 3 }] } } })).data.record; const accepted = await publish(safe.id); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(f.state.postWrites, 1, 'An unused expired shared asset does not block an effective permanent copy.');
  } finally { await f.close(); }
});

test('provider-owned expired media remains usable for rescheduling, retry and text edits while new, draft and no-longer-owned media remain blocked', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const attempt = (await f.prepare()).data.attempt; await f.put(attempt); const saved = (await f.action(attempt, 'recover')).data.attempt.asset; await f.app.store.update(f.projectId, 'assets', saved.id, { approval: 'approved' });
    const created = await f.request(`/api/projects/${f.projectId}/posts`, { method: 'POST', body: { content: 'Scheduled owned creative', platforms: ['facebook'], accounts: ['facebook-one'], status: 'scheduled', scheduledAt: '2070-01-01T10:00:00Z', assetId: saved.id } }); assert.equal(created.status, 201);
    const social = `/api/projects/${f.projectId}/integrations/social`, published = await f.request(social + '/publish', { method: 'POST', body: { postId: created.data.record.id } }); assert.equal(published.status, 200, JSON.stringify(published.data));
    const postId = published.data.post.id, remote = f.state.posts.get(published.data.post.externalId), expiry = { deliveryUploadedAt: new Date(Date.now() - 8 * 86400000).toISOString(), deliveryExpiresAt: new Date(Date.now() - 1000).toISOString() }; await f.app.store.update(f.projectId, 'assets', saved.id, expiry); f.objects.delete(saved.deliveryUrl);
    const beforeChecks = f.calls.filter(call => call.path === '/api/v1/tools/validate/post').length;
    let result = await f.request(social + '/update', { method: 'POST', body: { postId, mode: 'scheduled', scheduledAt: '2070-01-02T10:00:00Z', mediaItems: structuredClone(remote.mediaItems) } }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.ok(result.data.validationWarnings.some(message => message.includes('Existing provider media was retained'))); assert.equal(remote.mediaItems[0].url, saved.deliveryUrl); assert.equal(f.calls.findLast(call => call.method === 'PUT' && call.path.endsWith('/' + remote._id)).body.mediaItems, undefined, 'Unchanged provider-owned root media is not resubmitted.');
    remote.status = 'failed'; remote.platforms[0].status = 'failed'; result = await f.request(social + '/retry', { method: 'POST', body: { postId, confirmPublish: true } }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.ok(result.data.validationWarnings.length); assert.equal(f.calls.findLast(call => call.path.endsWith('/retry')).body && Object.keys(f.calls.findLast(call => call.path.endsWith('/retry')).body).length, 0);
    remote.status = 'published'; remote.platforms[0].status = 'published'; result = await f.request(social + '/edit-published', { method: 'POST', body: { postId, accountId: 'facebook-one', content: 'Reviewed text edit', confirmEdit: true } }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.ok(result.data.validationWarnings.length); const checks = f.calls.filter(call => call.path === '/api/v1/tools/validate/post'); assert.equal(checks.length, beforeChecks + 3, 'Every update, retry and text edit retains the complete account-aware provider dry run; it does not fetch expired media.'); assert.ok(checks.slice(-3).every(call => call.body.platforms.length === 1 && call.body.platforms[0].accountId === 'facebook-one' && call.body.mediaItems[0].url === saved.deliveryUrl));
    const newUrl = 'https://media.zernio.com/temp/new-expired-file.jpg'; await f.app.store.create(f.projectId, 'assets', { name: 'Expired other creative', kind: 'image', deliverySource: 'zernio', deliveryUrl: newUrl, ...expiry, deliveryMimeType: 'image/jpeg', deliverySize: 3, approval: 'approved' }); remote.status = 'scheduled'; remote.platforms[0].status = 'pending'; const writes = f.state.postWrites;
    result = await f.request(social + '/update', { method: 'POST', body: { postId, assetId: '', mediaItems: [{ type: 'image', url: newUrl }], mode: 'scheduled', scheduledAt: '2070-01-03T10:00:00Z' } }); assert.equal(result.status, 422, JSON.stringify(result.data)); assert.equal(f.state.postWrites, writes);
    remote.status = 'draft'; remote.isDraft = true; result = await f.request(social + '/update', { method: 'POST', body: { postId, mode: 'scheduled', scheduledAt: '2070-01-03T10:00:00Z' } }); assert.equal(result.status, 422, JSON.stringify(result.data)); assert.equal(f.state.postWrites, writes, 'A provider draft has not acquired a permanent copy.');
    remote.status = 'scheduled'; remote.isDraft = false; let reads = 0; f.state.postReadHook = current => { if (++reads === 2) { current.status = 'draft'; current.isDraft = true; } }; result = await f.request(social + '/update', { method: 'POST', body: { postId, mode: 'scheduled', scheduledAt: '2070-01-03T10:00:00Z' } }); assert.equal(result.status, 422, JSON.stringify(result.data)); assert.equal(f.state.postWrites, writes, 'Ownership is checked again after preflight and before dispatch.');
  } finally { await f.close(); }
});

test('parallel duplicate preparation, transfer and completion mint one grant, send one transfer and save one asset', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const presigns = () => f.calls.filter(call => call.method === 'POST' && call.path === '/api/v1/media/presign').length, transfers = () => f.calls.filter(call => call.method === 'PUT' && call.origin === 'https://' + storageHost).length;
    const attemptId = randomUUID(), prepared = await Promise.all([f.prepare({ attemptId }, 'parallel-prepare-key-one'), f.prepare({ attemptId }, 'parallel-prepare-key-two')]);
    assert.ok(prepared.every(result => result.status === 200 || result.status === 409 && result.data.error.code === 'MEDIA_UPLOAD_IN_PROGRESS'), JSON.stringify(prepared.map(result => result.data)));
    const ready = prepared.filter(result => result.status === 200); assert.ok(ready.length >= 1); assert.ok(ready.every(result => result.data.attempt.id === attemptId));
    assert.equal(presigns(), 1, 'Parallel preparation of one attempt ID reaches the provider presign endpoint exactly once.'); assert.equal((await f.app.sql.get('SELECT count(*) AS count FROM zernio_media_uploads WHERE id=?', attemptId)).count, 1);
    const attempt = ready[0].data.attempt, sent = await Promise.all([f.put(attempt), f.put(attempt)]); assert.ok(sent.some(result => result.status === 200 && result.data.attempt.status === 'uploaded'), JSON.stringify(sent.map(result => result.data)));
    assert.equal(transfers(), 1, 'Parallel duplicate content PUTs send the bytes to storage exactly once.'); assert.equal(f.state.storageCalls, 1);
    const saved = await Promise.all([f.action(attempt, 'recover', 'parallel-save-key-one'), f.action(attempt, 'recover', 'parallel-save-key-two'), f.action(attempt, 'recover', 'parallel-save-key-one')]);
    assert.ok(saved.every(result => result.status === 200 || result.status === 409), JSON.stringify(saved.map(result => result.data)));
    const assets = await f.app.store.list(f.projectId, 'assets'); assert.equal(assets.length, 1, 'Parallel completion saves exactly one asset.'); assert.ok(saved.filter(result => result.status === 200).every(result => result.data.attempt.assetId === assets[0].id));
    assert.equal((await f.app.sql.get("SELECT count(*) AS count FROM integration_operations WHERE status='complete'")).count, 1, 'Exactly one completion receipt records the save.'); assert.equal((await f.app.sql.get('SELECT count(*) AS count FROM integration_operations')).count, 1);
    assert.equal((await f.app.sql.get('SELECT count(*) AS count FROM activity WHERE project_id=? AND message=?', f.projectId, 'Hosted delivery asset saved for review.')).count, 1); assert.equal(presigns(), 1); assert.equal(transfers(), 1);
  } finally { await f.close(); }
});
