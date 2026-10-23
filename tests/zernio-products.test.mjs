import test from 'node:test';
import assert from 'node:assert/strict';
import { handleZernioProducts } from '../server/zernio-products.ts';
import { handleIntegration } from '../server/integrations.ts';
import { IntegrationError, operation } from '../server/provider-core.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

// A restart keeps the test database: the replacement app shares the injected pool and the test's finally closes it.
async function reopen(app, options) {
  await app.close();
  return Object.assign(await createApp({ ...options, database: { pool: app.database.pool, db: app.database.db } }), { database: app.database, sql: app.sql });
}

// Synthetic replies exercise the pinned Commerce contract without contacting a store.
function fixture() {
  const profileId = 'profile-a', accountId = 'shopify-a';
  const account = { _id: accountId, profileId, platform: 'shopify', platformUserId: 'native-store', username: 'brand.myshopify.com', displayName: 'Brand store', isActive: true };
  const store = { accountId, platform: 'shopify', name: 'Brand store', domain: 'brand.myshopify.com', url: 'https://brand.example.test', currency: 'AED', country: 'AE', capabilities: ['products.read'], missingCapabilities: [], grantPermissionsUrl: null, token: 'never-expose' };
  const product = { id: '123', accountId, platform: 'shopify', title: 'Original product', descriptionHtml: '<img src=x onerror=alert(1)>', status: 'draft', platformStatus: 'DRAFT', tags: ['summer'], featuredImage: null, images: [{ id: 'image-1', url: 'javascript:alert(1)', altText: 'Image' }], options: [{ name: 'Size', values: ['S'] }], variants: [{ id: 'variant-1', title: 'S', price: { amount: '0019.9000', currency: 'AED', secret: 'never-expose' }, compareAtPrice: null, inventoryQuantity: null, availableForSale: null, options: [{ name: 'Size', value: 'S' }] }], totalInventory: null, createdAt: '2026-10-19T09:00:00Z', secret: 'never-expose' };
  const collection = { id: 'gid://shopify/Collection/000123', accountId, platform: 'shopify', title: 'Summer', handle: 'summer', descriptionHtml: '<img src=x onerror=alert(1)>', image: { id: null, url: 'javascript:alert(1)', altText: null }, sortOrder: 'manual', productCount: 0, seo: { title: null, description: '' }, updatedAt: '2026-10-19T09:00:00+04:00', platformData: { secret: 'never-expose', published: true }, products: [product], rules: ['never-expose'], secret: 'never-expose' };
  const state = { accounts: [account, { ...account, _id: 'foreign', profileId: 'profile-b' }, { ...account, _id: 'wordpress-a', platform: 'wordpress' }], store, product, products: [product], collection, collections: [collection], nextCursor: null, onCall: null, mappingChanged: false, settingsChanged: false, accessLost: false };
  const calls = [];
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    const call = { path, query: structuredClone(query), body, key, method }; calls.push(call);
    const override = await state.onCall?.(call); if (override !== undefined) return structuredClone(override);
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: structuredClone(state.accounts) }; }
    if (path === '/commerce/store') { assert.deepEqual(query, { accountId }); return { store: structuredClone(state.store) }; }
    if (path === '/commerce/products') return { products: structuredClone(state.products), nextCursor: state.nextCursor };
    if (path === '/commerce/products/123') return { product: structuredClone(state.product) };
    if (path === '/commerce/collections') return { collections: structuredClone(state.collections), nextCursor: state.nextCursor };
    if (path === '/commerce/collections/' + encodeURIComponent(state.collection.id)) return { collection: structuredClone(state.collection) };
    assert.fail('Unexpected provider path: ' + path);
  };
  async function request(action, { method = 'GET', role = 'viewer', body = {}, headers = {} } = {}) {
    let response;
    const context = { req: { method, headers }, role, body, url: new URL('https://campaign.example.test/api/projects/project-a/integrations/products/' + action), assertProjectMapping: expected => { assert.equal(expected, profileId); if (state.mappingChanged) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings: () => { if (state.accessLost) throw Object.assign(new Error('Access lost'), { status: 403 }); if (state.settingsChanged) throw Object.assign(new Error('Credentials changed'), { status: 409 }); }, send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioProducts(context, api, profileId, action.split('?')[0]); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { state, account, accountId, calls, request };
}

test('HTTP Shopify collection title rename uses exact partial PATCH, independent readback and a durable native fence', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-collection-rename-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const appOptions = { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'collection-rename-fixture-key' } };
  let app = await testApp(t, appOptions), base, cookie, projectId, providerHook, sequence = 1000, keySequence = 0;
  const f = fixture(), account = { ...f.account, profileId: 'collection-rename-profile' }, accounts = [account], collections = new Map(), calls = [];
  const store = { ...f.state.store, capabilities: ['collections.read', 'collections.write'] }, writes = () => calls.filter(call => call.method !== 'GET');
  const addCollection = (id = 'gid://shopify/Collection/000' + ++sequence) => { const row = { ...structuredClone(f.state.collection), id }; collections.set(id, row); return row; };
  const grants = () => { Object.assign(store, { capabilities: ['collections.read', 'collections.write'], missingCapabilities: [], domain: f.state.store.domain }); Object.assign(account, f.account, { profileId: 'collection-rename-profile', needsReconnection: false }); };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    const method = options.method || 'GET', payload = options.body === undefined ? undefined : JSON.parse(options.body), call = { url, method, payload }; calls.push(call);
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: structuredClone(accounts) };
    else {
      const accountId = method === 'GET' ? url.searchParams.get('accountId') : payload.accountId; assert.ok(accounts.some(row => row._id === accountId));
      if (url.pathname === '/api/v1/commerce/store') result = { store: { ...structuredClone(store), accountId } };
      else {
        assert.ok(url.pathname.startsWith('/api/v1/commerce/collections/'), url.pathname);
        const id = decodeURIComponent(url.pathname.slice('/api/v1/commerce/collections/'.length)), collection = collections.get(id); assert.ok(collection, id);
        if (method !== 'GET') { assert.equal(method, 'PATCH'); assert.equal(url.search, ''); assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'title']); assert.ok(options.headers['Idempotency-Key']); collection.title = payload.title; }
        else assert.deepEqual([...url.searchParams.keys()], ['accountId']);
        result = { collection: { ...structuredClone(collection), id, accountId } };
      }
    }
    return await providerHook?.(call, result) || Response.json(result);
  };
  async function listen() { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', key = 'collection-rename-key-' + ++keySequence } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const route = (collection, accountId = account._id) => `/api/projects/${projectId}/integrations/products/${accountId}/collections/${encodeURIComponent(collection.id)}`;
  async function review(collection, accountId = account._id, title = 'Renamed collection') { const result = await request(route(collection, accountId) + '/edit'); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.accountId, accountId); assert.match(result.data.version, /^[a-f0-9]{64}$/); return { version: result.data.version, title }; }
  try {
    await listen(); const setup = await request('/api/auth/setup', { body: { name: 'Collection QA', email: 'collection-rename@example.test', password: 'a long local collection rename password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', account.profileId, projectId);
    for (const id of ['gid://shopify/Collection/000123', '00124', 'opaque:collection/+=?#']) {
      const collection = addCollection(id), original = structuredClone(collection), body = await review(collection, account._id, '  Autumn  '), key = 'collection-success-' + ++keySequence, before = writes().length, readCount = calls.length;
      const result = await request(route(collection) + '/rename', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.readback, true); assert.equal(result.data.collection.title, 'Autumn'); assert.equal(result.data.collection.id, id);
      assert.deepEqual(writes().at(-1).payload, { accountId: account._id, title: 'Autumn' }); assert.equal(writes().length, before + 1); assert.equal(calls.slice(readCount).filter(call => call.method === 'GET' && call.url.pathname.endsWith(encodeURIComponent(id))).length, 3);
      assert.deepEqual({ ...collection, title: original.title }, original); assert.equal(JSON.stringify(result).includes('never-expose'), false); assert.equal(Object.hasOwn(result.data.collection, 'visibility'), false);
      assert.deepEqual((await request(route(collection) + '/rename', { body, key })).data, result.data); assert.equal(writes().length, before + 1);
      assert.equal((await request(route(collection) + '/rename', { body: { ...body, title: 'Different' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    const invalid = addCollection(), valid = await review(invalid), beforeInvalid = writes().length;
    for (const fields of [{ title: '' }, { title: ' ' }, { title: 'line\nbreak' }, { title: '\tTab' }, { title: '\u0000' }, { title: null }, { title: 3 }, { title: 'x'.repeat(10001) }, { version: 'bad' }, { status: 'active' }, { descriptionHtml: '' }, { handle: 'other' }, { accountId: 'foreign' }, { productIds: [] }, { confirmRename: true }]) assert.equal((await request(route(invalid) + '/rename', { body: { ...valid, ...fields } })).status, 400, JSON.stringify(fields));
    for (const field of ['version', 'title']) { const body = { ...valid }; delete body[field]; assert.equal((await request(route(invalid) + '/rename', { body })).status, 400); }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(route(invalid) + '/rename', { method })).status, 405);
    assert.equal((await request(route(invalid) + '/rename?accountId=foreign', { body: valid })).status, 400); assert.equal((await request(route(invalid) + '/edit?title=x')).status, 400);
    assert.equal((await request(route(invalid) + '/rename', { body: { ...valid, title: 'Summer' } })).data.error.code, 'EMPTY_COLLECTION_RENAME');
    await app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(invalid) + '/rename', { body: valid })).status, 403); await app.sql.run("UPDATE memberships SET role='owner'"); assert.equal(writes().length, beforeInvalid);
    for (const capability of ['collections.read', 'collections.write']) { store.capabilities = store.capabilities.filter(item => item !== capability); assert.equal((await request(route(invalid) + '/edit')).status, 403); assert.equal((await request(route(invalid) + '/rename', { body: valid })).status, 403); grants(); }
    for (const scenario of ['stale', 'native-missing', 'inactive', 'reconnect', 'between-reads', 'read-grant', 'write-grant', 'native-store', 'domain', 'role', 'mapping', 'credentials', 'session']) {
      grants(); const collection = addCollection(), body = await review(collection), before = writes().length; let storeReads = 0;
      if (scenario === 'stale') collection.title = 'External title'; if (scenario === 'native-missing') delete account.platformUserId; if (scenario === 'inactive') account.isActive = false; if (scenario === 'reconnect') account.needsReconnection = true;
      providerHook = async (call, result) => {
        if (call.url.pathname !== '/api/v1/commerce/store' || ++storeReads !== 4) return;
        if (scenario === 'between-reads') collection.title = 'Changed before send';
        if (scenario.endsWith('-grant')) { store.capabilities = store.capabilities.filter(item => item !== (scenario === 'read-grant' ? 'collections.read' : 'collections.write')); result.store.capabilities = [...store.capabilities]; }
        if (scenario === 'native-store') account.platformUserId = 'changed-native-store'; if (scenario === 'domain') result.store.domain = store.domain = 'changed.myshopify.com';
        if (scenario === 'role') await app.sql.run("UPDATE memberships SET role='viewer'");
        if (scenario === 'mapping') await app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id=?", projectId);
        if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-collection-fixture-key' } } })).status, 200);
        if (scenario === 'session') await app.sql.run('DELETE FROM sessions');
      };
      // Changing the collection before the second native read must invalidate its original review.
      if (scenario === 'between-reads') { let reads = 0; providerHook = (call, result) => { if (call.url.pathname.endsWith(encodeURIComponent(collection.id)) && ++reads === 2) result.collection.updatedAt = collection.updatedAt = '2026-10-19T10:00:00Z'; }; }
      const result = await request(route(collection) + '/rename', { body }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, before, scenario); providerHook = undefined;
      await app.sql.run("UPDATE memberships SET role='owner'"); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'collection-rename-profile', projectId);
      if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'collection-rename-fixture-key' } } })).status, 200);
      if (scenario === 'session') { const login = await request('/api/auth/login', { body: { email: 'collection-rename@example.test', password: 'a long local collection rename password' } }); assert.equal(login.status, 200); cookie = login.cookie; }
    }
    for (const scenario of ['missing-receipt', 'foreign-envelope', 'foreign-account', 'foreign-platform', 'wrong-id', 'wrong-title', 'wrong-readback', 'lost-readback', 'lost-ack', 'post-role', 'post-grants', 'post-store']) {
      grants(); const collection = addCollection(), body = await review(collection), before = writes().length, key = 'collection-unknown-' + scenario; let written = false;
      providerHook = async (call, result) => {
        if (call.method === 'PATCH') {
          written = true; if (scenario === 'missing-receipt') return Response.json({}); if (scenario === 'foreign-envelope') result.accountId = 'foreign'; if (scenario === 'foreign-account') result.collection.accountId = 'foreign'; if (scenario === 'foreign-platform') result.collection.platform = 'woocommerce'; if (scenario === 'wrong-id') result.collection.id = 'other'; if (scenario === 'wrong-title') result.collection.title = 'Wrong'; if (scenario === 'lost-ack') throw new Error('Lost rename acknowledgement');
          if (scenario === 'post-role') await app.sql.run("UPDATE memberships SET role='viewer'"); if (scenario === 'post-grants') store.capabilities = ['collections.read']; if (scenario === 'post-store') store.domain = 'changed-after-write.myshopify.com';
        }
        if (written && call.method === 'GET' && call.url.pathname.endsWith(encodeURIComponent(collection.id))) { if (scenario === 'wrong-readback') result.collection.title = 'Wrong'; if (scenario === 'lost-readback') return Response.json({ error: 'private provider detail' }, { status: 404 }); }
      };
      const result = await request(route(collection) + '/rename', { body, key }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, before + 1); providerHook = undefined; grants(); await app.sql.run("UPDATE memberships SET role='owner'");
      assert.equal((await app.sql.get('SELECT status FROM integration_operations WHERE project_id=? AND request_key=?', projectId, key)).status, 'uncertain', scenario); assert.equal((await request(route(collection) + '/rename', { body, key })).data.error.code, 'OPERATION_UNCERTAIN');
      const alias = { ...account, _id: 'collection-alias-' + scenario }; accounts.push(alias); assert.equal((await request(route(collection, alias._id) + '/rename', { body: await review(collection, alias._id, 'Another title') })).data.error.code, 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, before + 1);
    }
    grants(); const raced = addCollection('gid://shopify/Collection/0009999'), alias = { ...account, _id: 'collection-race-alias' }; accounts.push(alias); collections.set('009999', raced);
    const body = await review(raced), aliasCollection = { ...raced, id: '009999' }, beforeRace = writes().length;
    let entered, release; const held = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
    providerHook = async call => { if (call.method === 'PATCH') { entered(); await resume; throw new Error('Lost acknowledgement during native write'); } };
    const pendingKey = 'collection-pending-restart', blockedKey = 'collection-terminal-blocked', pending = request(route(raced) + '/rename', { body, key: pendingKey }); await held;
    try {
      const blocked = await request(route(raced) + '/rename', { body, key: blockedKey }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT');
      const aliasBlocked = await request(route(aliasCollection, alias._id) + '/rename', { body: await review(aliasCollection, alias._id, 'Another title') }); assert.equal(aliasBlocked.data.error.code, 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRace + 1);
    } finally { release(); }
    assert.equal((await pending).data.operation.status, 'uncertain'); providerHook = undefined;
    const workspaceId = (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id, originalProject = projectId;
    await app.sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'collection-alias-project', workspaceId, 'Same collection', 'collection-alias-profile'); const other = { ...account, _id: 'collection-project-alias', profileId: 'collection-alias-profile' }; accounts.push(other); projectId = 'collection-alias-project';
    assert.equal((await request(route(aliasCollection, other._id) + '/rename', { body: await review(aliasCollection, other._id, 'Cross project') })).data.error.code, 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED'); projectId = originalProject;
    app = await reopen(app, appOptions); await listen(); const beforeReopen = writes().length;
    assert.equal((await request(route(raced) + '/rename', { body, key: pendingKey })).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal((await request(route(raced) + '/rename', { body, key: blockedKey })).data.error.code, 'OPERATION_NOT_SENT');
    assert.equal((await request(route(aliasCollection, alias._id) + '/rename', { body: await review(aliasCollection, alias._id, 'After restart') })).data.error.code, 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeReopen);
    const orphan = addCollection('orphan-native-collection'); await app.sql.run('INSERT INTO zernio_collection_updates (resource, project_id, request_key) VALUES (?, ?, ?)', JSON.stringify(['shopify', account.platformUserId, orphan.id]), 'missing-project', 'missing-request'); assert.equal((await request(route(orphan) + '/rename', { body: await review(orphan) })).data.error.code, 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED');
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('collection reads use exact GET payloads, opaque IDs, platform search and bounded pagination without product permission', async () => {
  const f = fixture(); f.state.store.capabilities = ['collections.read'];
  const action = `${f.accountId}/collections`, id = f.state.collection.id, cursor = 'opaque:+/= cursor', query = 'title:Summer collection_type:custom';
  const list = await f.request(`${action}?limit=1&cursor=${encodeURIComponent(cursor)}&query=${encodeURIComponent(query)}`);
  assert.equal(list.status, 200); assert.equal(list.data.accountId, f.accountId); assert.equal(list.data.store.accountId, f.accountId);
  assert.deepEqual(f.calls.find(call => call.path === '/commerce/collections').query, { accountId: f.accountId, limit: 1, cursor, query });
  const detail = await f.request(`${action}/${encodeURIComponent(id)}`);
  assert.equal(detail.status, 200); assert.equal(detail.data.collection.id, id); assert.equal(detail.data.collection.productCount, 0);
  assert.equal(detail.data.collection.descriptionHtml, '<img src=x onerror=alert(1)>'); assert.equal(detail.data.collection.image.url, 'javascript:alert(1)');
  assert.equal(detail.data.collection.updatedAt, '2026-10-19T09:00:00+04:00'); assert.deepEqual(detail.data.collection.seo, { title: null, description: '' });
  assert.deepEqual(f.calls.find(call => call.path === '/commerce/collections/' + encodeURIComponent(id)).query, { accountId: f.accountId });
  assert.equal(JSON.stringify([list, detail]).includes('never-expose'), false);
  assert.equal(['platformData', 'products', 'rules', 'published', 'visibility', 'type'].some(key => Object.hasOwn(detail.data.collection, key)), false);
  for (const key of ['handle', 'descriptionHtml', 'image', 'sortOrder', 'productCount', 'seo', 'updatedAt']) delete f.state.collection[key];
  const missing = (await f.request(`${action}/${encodeURIComponent(id)}`)).data.collection;
  assert.deepEqual(missing, { id, accountId: f.accountId, platform: 'shopify', title: 'Summer', handle: null, descriptionHtml: null, image: null, sortOrder: null, productCount: null, seo: { title: null, description: null }, updatedAt: null });
  Object.assign(f.state.collection, { handle: '', descriptionHtml: '', image: null, productCount: null, updatedAt: null, seo: { title: '', description: null } });
  assert.equal((await f.request(`${action}/${encodeURIComponent(id)}`)).data.collection.handle, '');
  f.state.collections = []; f.state.nextCursor = 'next:2';
  assert.deepEqual((await f.request(action)).data, { accountId: f.accountId, store: list.data.store, collections: [], nextCursor: 'next:2' });
  assert.equal(f.calls.filter(call => call.path === '/commerce/collections').at(-1).query.limit, 20);
  assert.equal(f.calls.every(call => call.method === 'GET' && call.body === undefined && call.key === undefined && !call.path.startsWith('/commerce/products')), true);
});

test('collection method, body, filter, identity and explicit capability guards stop before provider collection reads', async () => {
  const f = fixture(); f.state.store.capabilities = ['collections.read'];
  const action = `${f.accountId}/collections`, detail = action + '/' + encodeURIComponent(f.state.collection.id);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) for (const path of [action, detail]) assert.equal((await f.request(path, { method })).status, 405);
  for (const suffix of ['?limit=0', '?limit=101', '?limit=01', '?limit=1.5', '?limit=1&limit=2', '?cursor=', '?cursor=a&cursor=b', '?query=a&query=b', '?query=' + 'a'.repeat(501), '?query=a%0Ab', '?status=active', '?collectionId=1', '?accountId=other', '?profileId=other']) assert.equal((await f.request(action + suffix)).status, 400, suffix);
  for (const suffix of ['?limit=1', '?query=a', '?cursor=a']) assert.equal((await f.request(detail + suffix)).status, 400);
  for (const options of [{ body: { productIds: [] } }, { body: [] }, { headers: { 'content-length': '2' } }, { headers: { 'transfer-encoding': 'chunked' } }]) assert.equal((await f.request(action, options)).status, 400);
  for (const id of ['', '.', '%2e', '..', '%2e%2e', '%ZZ', '%0A', '%00', 'ordinary%20space', 'nonbreaking%C2%A0space', 'gid%3A%2F%2Fshopify%2F.%2F7001', 'gid%3A%2F%2Fshopify%2F..%2F7001']) assert.equal((await f.request(action + '/' + id)).status, 400, id);
  assert.equal((await f.request('foreign/collections')).status, 403); assert.equal((await f.request('wordpress-a/collections')).status, 403);
  assert.equal(f.calls.some(call => call.path.startsWith('/commerce/collections')), false);
  for (const capabilities of [[], ['products.read']]) { const denied = fixture(); denied.state.store.capabilities = capabilities; assert.equal((await denied.request(`${denied.accountId}/collections`)).data.error.code, 'COLLECTION_READ_PERMISSION_REQUIRED'); assert.equal(denied.calls.some(call => call.path.startsWith('/commerce/collections')), false); }
  const missing = fixture(); missing.state.store.capabilities = []; missing.state.store.missingCapabilities = ['collections.read']; assert.equal((await missing.request(`${missing.accountId}/collections`)).status, 403);
  for (const change of [{ isActive: false }, { needsReconnection: true }]) { const unavailable = fixture(); Object.assign(unavailable.account, change); unavailable.state.store.capabilities = ['collections.read']; assert.equal((await unavailable.request(`${unavailable.accountId}/collections`)).status, 409); assert.equal(unavailable.calls.some(call => call.path.startsWith('/commerce/collections')), false); }
});

test('collection replies reject contradictory fields, wrong scopes, duplicate IDs, oversized pages and cursor loops', async () => {
  for (const change of [{ id: '' }, { id: 12 }, { title: null }, { title: {} }, { accountId: undefined }, { accountId: 'foreign' }, { platform: 'woocommerce' }, { profileId: 'profile-b' }, { handle: {} }, { descriptionHtml: [] }, { productCount: '0' }, { productCount: 1.5 }, { productCount: Number.MAX_SAFE_INTEGER + 1 }, { sortOrder: null }, { sortOrder: 'automatic' }, { updatedAt: '2026-02-30T00:00:00Z' }, { updatedAt: 1 }, { image: [] }, { image: { id: 1, url: 'https://example.test' } }, { image: { url: {} } }, { image: { url: '' } }, { image: { url: 'literal', accountId: 'foreign' } }, { seo: null }, { seo: [] }, { seo: { title: 3 } }, { seo: { description: [], platform: 'woocommerce' } }]) {
    const f = fixture(); f.state.store.capabilities = ['collections.read']; Object.assign(f.state.collection, change);
    assert.equal((await f.request(`${f.accountId}/collections`)).status, 502, JSON.stringify(change));
  }
  for (const collections of [undefined, {}, [null]]) { const f = fixture(); f.state.store.capabilities = ['collections.read']; f.state.collections = collections; assert.equal((await f.request(`${f.accountId}/collections`)).status, 502); }
  for (const nextCursor of [undefined, '', {}, 'same', 'x'.repeat(4097)]) { const f = fixture(); f.state.store.capabilities = ['collections.read']; f.state.nextCursor = nextCursor; assert.equal((await f.request(`${f.accountId}/collections?cursor=same`)).status, 502); }
  const duplicate = fixture(); duplicate.state.store.capabilities = ['collections.read']; duplicate.state.collections.push(duplicate.state.collection); assert.equal((await duplicate.request(`${duplicate.accountId}/collections`)).status, 502);
  duplicate.state.collections[1] = { ...duplicate.state.collection, id: 'second' }; assert.equal((await duplicate.request(`${duplicate.accountId}/collections?limit=1`)).status, 502);
  const wrong = fixture(); wrong.state.store.capabilities = ['collections.read']; wrong.state.onCall = call => call.path.startsWith('/commerce/collections/') ? { collection: { ...wrong.state.collection, id: 'other' } } : undefined;
  assert.equal((await wrong.request(`${wrong.accountId}/collections/${encodeURIComponent(wrong.state.collection.id)}`)).status, 502);
  for (const envelope of [{ accountId: 'foreign' }, { profileId: 'profile-b' }, { platform: 'woocommerce' }]) { const f = fixture(); f.state.store.capabilities = ['collections.read']; f.state.onCall = call => call.path === '/commerce/collections' ? { ...envelope, collections: f.state.collections, nextCursor: null } : undefined; assert.equal((await f.request(`${f.accountId}/collections`)).status, 502); }
});

test('collection reads recheck project access, exact native account and fresh collection grants through the final await', async () => {
  for (const detail of [false, true]) for (const scenario of ['mapping', 'session', 'credentials', 'profile', 'native-store', 'alias', 'revoked', 'permission', 'domain']) {
    const f = fixture(); f.state.store.capabilities = ['collections.read'];
    f.state.onCall = call => {
      if (!call.path.startsWith('/commerce/collections')) return;
      if (scenario === 'mapping') f.state.mappingChanged = true;
      if (scenario === 'session') f.state.accessLost = true;
      if (scenario === 'credentials') f.state.settingsChanged = true;
      if (scenario === 'profile') f.account.profileId = 'profile-b';
      if (scenario === 'native-store') f.account.platformUserId = 'changed-store';
      if (scenario === 'alias') f.account.username = 'changed.myshopify.com';
      if (scenario === 'revoked') f.account.needsReconnection = true;
      if (scenario === 'permission') f.state.store.capabilities = [];
      if (scenario === 'domain') f.state.store.domain = 'changed.myshopify.com';
    };
    const result = await f.request(`${f.accountId}/collections${detail ? '/' + encodeURIComponent(f.state.collection.id) : ''}`);
    assert.ok([403, 409].includes(result.status), scenario); if (scenario === 'permission') assert.equal(result.data.error.code, 'COLLECTION_READ_PERMISSION_REQUIRED');
  }
  for (const stage of ['/accounts', '/commerce/store']) { const f = fixture(); f.state.store.capabilities = ['collections.read']; f.state.onCall = call => { if (call.path === stage) f.state.accessLost = true; }; assert.equal((await f.request(`${f.accountId}/collections`)).status, 403); assert.equal(f.calls.some(call => call.path.startsWith('/commerce/collections')), false); }
  for (const scenario of ['account', 'mapping', 'session', 'credentials']) {
    const f = fixture(); f.state.store.capabilities = ['collections.read']; let storeReads = 0;
    f.state.onCall = call => {
      if (call.path === '/commerce/store') storeReads++;
      if (call.path !== '/accounts' || storeReads !== 2) return;
      if (scenario === 'account') f.account.platformUserId = 'changed-at-final-await';
      if (scenario === 'mapping') f.state.mappingChanged = true;
      if (scenario === 'session') f.state.accessLost = true;
      if (scenario === 'credentials') f.state.settingsChanged = true;
    };
    assert.ok([403, 409].includes((await f.request(`${f.accountId}/collections`)).status), scenario);
  }
});

test('collection provider 403, 404, 429 and the shared 8 MiB ceiling remain sanitized through the app router', async t => {
  const f = fixture(), originalFetch = globalThis.fetch, calls = []; f.state.store.capabilities = ['collections.read'];
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const stage of ['/accounts', '/commerce/store', '/commerce/collections']) for (const status of [403, 404, 429]) {
    calls.length = 0;
    globalThis.fetch = async (target, options = {}) => {
      const url = new URL(target); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.method || 'GET', 'GET'); assert.equal(options.body, undefined); calls.push(url.pathname);
      if (url.pathname === '/api/v1' + stage) return Response.json({ error: 'Private provider detail must not leak' }, { status });
      if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: f.state.accounts });
      if (url.pathname.endsWith('/commerce/store')) return Response.json({ store: f.state.store });
      assert.fail(url.pathname);
    };
    let response;
    await handleIntegration({ req: { method: 'GET' }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/products/${f.accountId}/collections`), project: { id: 'project-a', zernioProfileId: 'profile-a' }, role: 'viewer', config: { env: { ZERNIO_API_KEY: 'synthetic-key' } }, send(status, data) { response = { status, data }; } });
    assert.equal(response.status, status); if (status === 403) { assert.equal(response.data.error.code, 'COLLECTION_READ_PERMISSION_REQUIRED'); assert.match(response.data.error.message, /collection/); assert.doesNotMatch(response.data.error.message, /product/); }
    assert.equal(JSON.stringify(response).includes('Private provider detail'), false); assert.equal(calls.some(path => path.includes('/commerce/products')), false);
  }
  globalThis.fetch = async target => {
    const url = new URL(target);
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: f.state.accounts });
    if (url.pathname.endsWith('/commerce/store')) return Response.json({ store: f.state.store });
    return new Response('{"collections":[],"nextCursor":null,"extra":"' + 'x'.repeat(8 * 1024 * 1024) + '"}');
  };
  let response;
  await handleIntegration({ req: { method: 'GET' }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/products/${f.accountId}/collections`), project: { id: 'project-a', zernioProfileId: 'profile-a' }, role: 'viewer', config: { env: { ZERNIO_API_KEY: 'synthetic-key' } }, send(status, data) { response = { status, data }; } });
  assert.equal(response.status, 502); assert.equal(response.data.error.code, 'INVALID_PROVIDER_RESPONSE');
});

test('viewers browse only scoped Shopify stores with exact money, inert content, provider caps and opaque pagination', async () => {
  const f = fixture();
  assert.deepEqual((await f.request('accounts')).data.accounts, [{ id: f.accountId, platform: 'shopify', name: 'Brand store', isActive: true, needsReconnection: false }]);
  assert.equal((await f.request(`${f.accountId}/store`)).data.store.accountId, f.accountId);
  const search = 'title:*shirt* vendor:Acme tag:summer', cursor = 'opaque:+/= cursor';
  const result = await f.request(`${f.accountId}?limit=1&cursor=${encodeURIComponent(cursor)}&status=draft&query=${encodeURIComponent(search)}`);
  assert.equal(result.status, 200); assert.equal(result.data.products[0].variants[0].price.amount, '0019.9000'); assert.equal(result.data.products[0].variants[0].price.currency, 'AED');
  assert.equal(result.data.products[0].descriptionHtml, '<img src=x onerror=alert(1)>'); assert.equal(result.data.products[0].images[0].url, 'javascript:alert(1)');
  assert.deepEqual(result.data.coverage, { imagesLimit: 20, variantsLimit: 100 });
  assert.deepEqual(f.calls.find(call => call.path === '/commerce/products').query, { accountId: f.accountId, limit: 1, cursor, status: 'draft', query: search });
  const detail = await f.request(`${f.accountId}/123`); assert.equal(detail.status, 200); assert.equal(detail.data.product.id, '123'); assert.deepEqual(detail.data.product.seo, { title: null, description: null });
  assert.equal(detail.data.product.handle, null); assert.equal(JSON.stringify([result, detail]).includes('never-expose'), false);
  assert.equal(f.calls.every(call => call.method === 'GET' && call.body === undefined && call.key === undefined), true);
  f.state.products = []; f.state.nextCursor = 'next:2'; assert.deepEqual((await f.request(f.accountId)).data, { products: [], nextCursor: 'next:2', coverage: { imagesLimit: 20, variantsLimit: 100 } });
});

test('collection member pages pass the native filter with all product filters and trust provider membership rather than counts or custom fields', async () => {
  const f = fixture(); f.state.store.capabilities.push('collections.read');
  const id = f.state.collection.id, cursor = 'opaque:+/= cursor', query = 'title:*shirt* vendor:Acme tag:summer';
  f.state.product.collectionIds = ['unrelated-custom-field'];
  const result = await f.request(`${f.accountId}?collectionId=${encodeURIComponent(id)}&limit=1&cursor=${encodeURIComponent(cursor)}&status=draft&query=${encodeURIComponent(query)}`);
  assert.equal(result.status, 200); assert.equal(result.data.accountId, f.accountId); assert.equal(result.data.store.accountId, f.accountId);
  assert.equal(result.data.collection.id, id); assert.equal(result.data.collection.productCount, 0); assert.equal(result.data.products.length, 1);
  assert.deepEqual(result.data.collection, (await f.request(`${f.accountId}/collections/${encodeURIComponent(id)}`)).data.collection);
  assert.deepEqual(result.data.coverage, { imagesLimit: 20, variantsLimit: 100 }); assert.equal(result.data.products[0].variants[0].price.amount, '0019.9000');
  assert.equal(JSON.stringify(result).includes('never-expose'), false); assert.equal(Object.hasOwn(result.data.products[0], 'collectionIds'), false);
  assert.deepEqual(f.calls.find(call => call.path === '/commerce/products').query, { accountId: f.accountId, limit: 1, cursor, status: 'draft', query, collectionId: id });
  assert.deepEqual(f.calls.filter(call => call.path.startsWith('/commerce/collections/') || call.path === '/commerce/products').slice(0, 3).map(call => [call.path, call.query.accountId]), [['/commerce/collections/' + encodeURIComponent(id), f.accountId], ['/commerce/products', f.accountId], ['/commerce/collections/' + encodeURIComponent(id), f.accountId]]);
  for (const count of [7, null]) {
    f.state.collection.productCount = count; f.state.products = []; f.state.nextCursor = count === null ? null : 'next:+/= page';
    const empty = await f.request(`${f.accountId}?collectionId=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(empty.status, 200); assert.deepEqual(empty.data.products, []); assert.equal(empty.data.nextCursor, f.state.nextCursor); assert.equal(empty.data.collection.productCount, count);
  }
  assert.equal(f.calls.every(call => call.method === 'GET' && call.body === undefined && call.key === undefined), true);
});

test('collection member filtering alone needs both grants and rejects malformed exact collection and product replies', async () => {
  for (const capabilities of [[], ['products.read'], ['collections.read']]) {
    const f = fixture(); f.state.store.capabilities = capabilities;
    const result = await f.request(`${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}`);
    assert.equal(result.status, 403); assert.equal(result.data.error.code, capabilities.includes('products.read') ? 'COLLECTION_READ_PERMISSION_REQUIRED' : 'PRODUCT_READ_PERMISSION_REQUIRED');
    assert.equal(f.calls.some(call => call.path.startsWith('/commerce/collections/') || call.path === '/commerce/products'), false);
  }
  const ordinary = fixture(); ordinary.state.store.missingCapabilities = ['collections.read'];
  assert.equal((await ordinary.request(ordinary.accountId)).status, 200); assert.equal(ordinary.calls.some(call => call.path.startsWith('/commerce/collections')), false);
  assert.equal(Object.hasOwn(ordinary.calls.find(call => call.path === '/commerce/products').query, 'collectionId'), false);
  for (const change of [{ id: 'other' }, { id: 'gid://shopify/Collection/123' }, { accountId: 'foreign' }, { platform: 'woocommerce' }, { profileId: 'other' }, { title: {} }, { productCount: 1.5 }]) {
    const f = fixture(); f.state.store.capabilities.push('collections.read');
    f.state.onCall = call => call.path.startsWith('/commerce/collections/') ? { collection: { ...f.state.collection, ...change } } : undefined;
    assert.equal((await f.request(`${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}`)).status, 502, JSON.stringify(change));
    assert.equal(f.calls.some(call => call.path === '/commerce/products'), false);
  }
  for (const reply of [{ products: {}, nextCursor: null }, { products: [null], nextCursor: null }, { products: [], nextCursor: '' }, { products: [], nextCursor: 'same' }]) {
    const f = fixture(); f.state.store.capabilities.push('collections.read'); f.state.onCall = call => call.path === '/commerce/products' ? reply : undefined;
    assert.equal((await f.request(`${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}&cursor=same`)).status, 502);
  }
});

test('collection member pages suppress stale collection, project, account, store and grant results through the final await', async () => {
  for (const stage of ['before-collection', 'products', 'after-collection', 'final-store', 'final-account']) for (const scenario of ['mapping', 'session', 'credentials', 'native-store', 'profile', 'alias', 'revoked']) {
    const f = fixture(); f.state.store.capabilities.push('collections.read'); let collectionReads = 0, storeReads = 0;
    f.state.onCall = call => {
      if (call.path.startsWith('/commerce/collections/')) collectionReads++;
      if (call.path === '/commerce/store') storeReads++;
      const trigger = stage === 'before-collection' ? call.path.startsWith('/commerce/collections/') && collectionReads === 1 : stage === 'products' ? call.path === '/commerce/products' : stage === 'after-collection' ? call.path.startsWith('/commerce/collections/') && collectionReads === 2 : stage === 'final-store' ? call.path === '/commerce/store' && storeReads === 2 : call.path === '/accounts' && storeReads === 2;
      if (!trigger) return;
      if (scenario === 'mapping') f.state.mappingChanged = true;
      if (scenario === 'session') f.state.accessLost = true;
      if (scenario === 'credentials') f.state.settingsChanged = true;
      if (scenario === 'native-store') f.account.platformUserId = 'changed-native-store';
      if (scenario === 'profile') f.account.profileId = 'other';
      if (scenario === 'alias') f.account.username = 'other.myshopify.com';
      if (scenario === 'revoked') f.account.needsReconnection = true;
    };
    const result = await f.request(`${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}`);
    assert.ok([403, 409].includes(result.status), stage + ':' + scenario); assert.equal(Object.hasOwn(result.data, 'products'), false);
  }
  for (const stage of ['products', 'after-collection', 'final-store']) for (const scenario of ['products-grant', 'collections-grant', 'domain', 'currency']) {
    const f = fixture(); f.state.store.capabilities.push('collections.read'); let collectionReads = 0, storeReads = 0;
    f.state.onCall = call => {
      if (call.path.startsWith('/commerce/collections/')) collectionReads++;
      if (call.path === '/commerce/store') storeReads++;
      if (!(stage === 'products' ? call.path === '/commerce/products' : stage === 'after-collection' ? call.path.startsWith('/commerce/collections/') && collectionReads === 2 : call.path === '/commerce/store' && storeReads === 2)) return;
      if (scenario === 'products-grant') f.state.store.capabilities = ['collections.read'];
      if (scenario === 'collections-grant') f.state.store.capabilities = ['products.read'];
      if (scenario === 'domain') f.state.store.domain = 'other.myshopify.com';
      if (scenario === 'currency') f.state.store.currency = 'USD';
    };
    assert.ok([403, 409].includes((await f.request(`${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}`)).status), stage + ':' + scenario);
  }
  for (const change of [{ title: 'Changed' }, { updatedAt: '2026-10-19T10:00:00Z' }, { productCount: 1 }]) {
    const f = fixture(); f.state.store.capabilities.push('collections.read');
    f.state.onCall = call => { if (call.path === '/commerce/products') Object.assign(f.state.collection, change); };
    const result = await f.request(`${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}`);
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'COLLECTION_CHANGED');
  }
});

test('collection member provider requests preserve encoded native IDs, sanitized errors and the 8 MiB cap through the router', async t => {
  const f = fixture(), originalFetch = globalThis.fetch; f.state.store.capabilities.push('collections.read');
  t.after(() => { globalThis.fetch = originalFetch; });
  const id = f.state.collection.id, path = '/api/v1/commerce/collections/' + encodeURIComponent(id), cursor = 'cursor:+/= with spaces', query = 'vendor:Acme tag:summer';
  for (const scenario of ['success', 'before-403', 'before-404', 'after-403', 'after-404', 'products-403', 'products-429', 'large']) {
    let collectionReads = 0; const calls = [];
    globalThis.fetch = async (target, options = {}) => {
      const url = new URL(target); calls.push(url); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.method || 'GET', 'GET'); assert.equal(options.body, undefined);
      if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: f.state.accounts });
      assert.equal(url.searchParams.get('accountId'), f.accountId);
      if (url.pathname.endsWith('/commerce/store')) return Response.json({ store: f.state.store });
      if (url.pathname === path) {
        collectionReads++; assert.deepEqual([...url.searchParams.keys()], ['accountId']);
        if (scenario.startsWith(collectionReads === 1 ? 'before-' : 'after-')) return Response.json({ error: 'Private detail must never leak' }, { status: Number(scenario.split('-')[1]) });
        return Response.json({ collection: f.state.collection });
      }
      assert.equal(url.pathname, '/api/v1/commerce/products');
      assert.deepEqual(Object.fromEntries(url.searchParams), { accountId: f.accountId, limit: '1', cursor, status: 'draft', query, collectionId: id });
      if (scenario.startsWith('products-')) return Response.json({ error: 'Private detail must never leak' }, { status: Number(scenario.split('-')[1]) });
      if (scenario === 'large') return new Response('{"products":[],"nextCursor":null,"extra":"' + 'x'.repeat(8 * 1024 * 1024) + '"}');
      return Response.json({ products: f.state.products, nextCursor: null });
    };
    let result;
    await handleIntegration({ req: { method: 'GET' }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/products/${f.accountId}?collectionId=${encodeURIComponent(id)}&limit=1&cursor=${encodeURIComponent(cursor)}&status=draft&query=${encodeURIComponent(query)}`), project: { id: 'project-a', zernioProfileId: 'profile-a' }, role: 'viewer', config: { env: { ZERNIO_API_KEY: 'synthetic-key' } }, send(status, data) { result = { status, data }; } });
    const expected = scenario === 'success' ? 200 : scenario === 'large' ? 502 : Number(scenario.split('-')[1]);
    assert.equal(result.status, expected, scenario); assert.equal(JSON.stringify(result).includes('Private detail'), false);
    if (scenario === 'success') { assert.equal(collectionReads, 2); assert.equal(result.data.collection.id, id); }
    else { assert.equal(Object.hasOwn(result.data, 'products'), false); if (expected === 403) assert.equal(result.data.error.code, scenario.startsWith('products') ? 'PRODUCT_READ_PERMISSION_REQUIRED' : 'COLLECTION_READ_PERMISSION_REQUIRED'); if (expected === 404) assert.equal(result.data.error.code, 'COLLECTION_NOT_FOUND'); }
    if (scenario.startsWith('before-')) assert.equal(calls.some(url => url.pathname.endsWith('/commerce/products')), false);
  }
});

test('HTTP collection member pages support scoped viewers and suppress final-await role, mapping, native account and collection grant changes', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-collection-members-')), originalFetch = globalThis.fetch, origin = 'http://127.0.0.1:3000';
  const app = await testApp(t, { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'collection-http-fixture-key' } }), f = fixture();
  f.state.store.capabilities.push('collections.read');
  let base, cookie, projectId, scenario, storeReads = 0; const calls = [];
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.method || 'GET', 'GET'); assert.equal(options.body, undefined); calls.push(url);
    if (url.pathname.endsWith('/accounts')) {
      assert.equal(url.searchParams.get('profileId'), 'profile-a');
      if (storeReads === 2) {
        if (scenario === 'role') await app.sql.run("UPDATE memberships SET role='owner'");
        if (scenario === 'mapping') await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'other-profile', projectId);
        if (scenario === 'native-account') f.account.platformUserId = 'other-native-store';
      }
      return Response.json({ accounts: f.state.accounts });
    }
    assert.equal(url.searchParams.get('accountId'), f.accountId);
    if (url.pathname.endsWith('/commerce/store')) {
      if (++storeReads === 2 && scenario === 'collection-grant') f.state.store.capabilities = ['products.read'];
      return Response.json({ store: f.state.store });
    }
    if (url.pathname === '/api/v1/commerce/collections/' + encodeURIComponent(f.state.collection.id)) return Response.json({ collection: f.state.collection });
    assert.equal(url.pathname, '/api/v1/commerce/products'); assert.equal(url.searchParams.get('collectionId'), f.state.collection.id);
    return Response.json({ products: f.state.products, nextCursor: null });
  };
  async function request(path, body, session = cookie) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(session ? { Cookie: session } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await request('/api/auth/setup', { name: 'Collection QA', email: 'collection-qa@example.test', password: 'a long local collection fixture password' }); setup.data.projectId = await firstProject(app, setup);
    assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'profile-a', projectId); await app.sql.run("UPDATE memberships SET role='viewer'");
    const route = `/api/projects/${projectId}/integrations/products/${f.accountId}?collectionId=${encodeURIComponent(f.state.collection.id)}`;
    const result = await request(route); assert.equal(result.status, 200); assert.equal(result.data.collection.id, f.state.collection.id); assert.equal(result.data.accountId, f.accountId); assert.equal(result.data.products[0].id, f.state.product.id);
    assert.equal((await request(route, undefined, null)).status, 401);
    for (scenario of ['role', 'mapping', 'native-account', 'collection-grant']) {
      storeReads = 0; const rejected = await request(route); assert.ok([403, 409].includes(rejected.status), scenario); assert.equal(Object.hasOwn(rejected.data, 'products'), false);
      await app.sql.run("UPDATE memberships SET role='viewer'"); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'profile-a', projectId); f.account.platformUserId = 'native-store'; f.state.store.capabilities = ['products.read', 'collections.read'];
    }
    assert.ok(calls.some(url => url.pathname.endsWith('/commerce/products')));
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('mutations, unsupported accounts, identifiers, duplicate/unknown filters and malformed pages do not reach products', async () => {
  const f = fixture();
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) for (const action of ['accounts', f.accountId, `${f.accountId}/123`, `${f.accountId}/store`]) assert.equal((await f.request(action, { method })).status, 405);
  for (const suffix of ['?limit=0', '?limit=101', '?limit=01', '?limit=1.5', '?limit=1&limit=2', '?cursor=', '?cursor=a&cursor=b', '?status=publish', '?status=draft&status=active', '?query=a&query=b', '?query=' + 'a'.repeat(501), '?query=a%0Ab', '?collectionId=', '?collectionId=a&collectionId=b', '?collectionId=ordinary%20space', '?collectionId=%00', '?collectionId=gid%3A%2F%2Fshopify%2F..%2F1', '?collectionId=' + 'a'.repeat(501), '?accountId=foreign', '?profileId=other']) assert.equal((await f.request(f.accountId + suffix)).status, 400, suffix);
  for (const action of ['accounts?limit=1', `${f.accountId}/store?limit=1`, `${f.accountId}/123?cursor=a`, '%ZZ', '%2F', `${f.accountId}/%23`, `${f.accountId}/.`, `${f.accountId}/..`, `${f.accountId}/%2e%2e`]) assert.equal((await f.request(action)).status, 400, action);
  assert.equal((await f.request('foreign')).status, 403); assert.equal((await f.request('wordpress-a')).status, 403); assert.equal((await f.request('a/b/c')).handled, false);
  assert.equal(f.calls.some(call => call.path.startsWith('/commerce/products')), false);
});

test('missing capabilities and inactive/revoked accounts fail before product reads', async () => {
  for (const scenario of ['inactive', 'reconnect', 'missing-read', 'ungranted-read']) {
    const f = fixture();
    if (scenario === 'inactive') f.account.isActive = false;
    if (scenario === 'reconnect') f.account.needsReconnection = true;
    if (scenario.endsWith('read')) f.state.store.capabilities = [];
    if (scenario === 'ungranted-read') f.state.store.missingCapabilities = ['products.read'];
    const result = await f.request(f.accountId); assert.equal(result.status, scenario.endsWith('read') ? 403 : 409, scenario);
    assert.equal(f.calls.some(call => call.path === '/commerce/products'), false);
    assert.equal((await f.request('accounts')).status, 200);
  }
});

test('foreign/missing product account identity, platform mismatch, wrong ID and nested scope are rejected', async () => {
  for (const change of [{ accountId: 'foreign' }, { accountId: undefined }, { accountId: null }, { profileId: 'profile-b' }, { platform: 'woocommerce' }, { id: 'other' }, { variants: [{ id: '1', title: 'A', accountId: 'foreign', price: { amount: '1', currency: 'AED' }, options: [] }] }]) {
    const f = fixture(); f.state.product = { ...f.state.product, ...change }; assert.equal((await f.request(`${f.accountId}/123`)).status, 502, JSON.stringify(change));
  }
  for (const store of [{ accountId: 'foreign' }, { accountId: undefined }, { platform: 'woocommerce' }, { profileId: 'profile-b' }, { url: undefined }, { grantPermissionsUrl: undefined }]) { const f = fixture(); Object.assign(f.state.store, store); assert.equal((await f.request(f.accountId)).status, 502); assert.equal(f.calls.some(call => call.path === '/commerce/products'), false); }
  for (const envelope of [{ accountId: 'foreign' }, { profileId: 'profile-b' }, { platform: 'woocommerce' }]) { const f = fixture(); f.state.onCall = call => call.path === '/commerce/products' ? { ...envelope, products: f.state.products, nextCursor: null } : undefined; assert.equal((await f.request(f.accountId)).status, 502); }
});

test('invalid scalar, money, inventory, arrays, duplicate product/variant and pagination replies fail closed', async () => {
  for (const change of [{ title: {} }, { status: 'publish' }, { platformStatus: false }, { descriptionHtml: {} }, { tags: ['ok', 2] }, { createdAt: 'not-a-date' }, { createdAt: '1' }, { totalInventory: 1.5 }, { images: Array(21).fill({ url: 'https://example.test/x' }) }, { images: [{ url: {}, altText: null }] }, { variants: undefined }, { variants: Array(101).fill({}) }, { options: [{ name: 'Size', values: [1] }] }, { seo: { title: {} } }]) {
    const f = fixture(); f.state.product = { ...f.state.product, ...change }; assert.equal((await f.request(`${f.accountId}/123`)).status, 502, JSON.stringify(change));
  }
  for (const price of [{ amount: 19.9, currency: 'AED' }, { amount: 'NaN', currency: 'AED' }, { amount: '-1', currency: 'AED' }, { amount: '1e2', currency: 'AED' }, { amount: '1', currency: null }, { amount: '1', currency: 'USD' }]) {
    const f = fixture(); f.state.product.variants[0].price = price; assert.equal((await f.request(`${f.accountId}/123`)).status, 502, JSON.stringify(price));
  }
  for (const nextCursor of [undefined, '', {}, 'same']) { const f = fixture(); f.state.nextCursor = nextCursor; assert.equal((await f.request(`${f.accountId}?cursor=same`)).status, 502); }
  const f = fixture(); f.state.products.push(f.state.product); assert.equal((await f.request(f.accountId)).status, 502); f.state.products = [f.state.product]; assert.equal((await f.request(`${f.accountId}?limit=1`)).status, 200);
  f.state.product.variants.push(f.state.product.variants[0]); assert.equal((await f.request(`${f.accountId}/123`)).status, 502);
});

test('project access, account identity and read permission are rechecked across provider awaits', async () => {
  for (const scenario of ['mapping', 'session', 'credentials', 'profile', 'native-store', 'alias', 'revoked', 'permission', 'currency']) {
    const f = fixture();
    f.state.onCall = call => {
      if (call.path !== '/commerce/products') return;
      if (scenario === 'mapping') f.state.mappingChanged = true;
      if (scenario === 'credentials') f.state.settingsChanged = true;
      if (scenario === 'session') f.state.accessLost = true;
      if (scenario === 'profile') f.account.profileId = 'profile-b';
      if (scenario === 'native-store') f.account.platformUserId = 'changed-store';
      if (scenario === 'alias') f.account.username = 'other.myshopify.com';
      if (scenario === 'revoked') f.account.needsReconnection = true;
      if (scenario === 'permission') f.state.store.capabilities = [];
      if (scenario === 'currency') f.state.store.currency = 'USD';
    };
    assert.ok([403, 409].includes((await f.request(f.accountId)).status), scenario);
  }
  for (const stage of ['/accounts', '/commerce/store']) { const f = fixture(); f.state.onCall = call => { if (call.path === stage) f.state.accessLost = true; }; assert.equal((await f.request(f.accountId)).status, 403); assert.equal(f.calls.some(call => call.path === '/commerce/products'), false); }
});

test('provider permission and rate-limit errors remain sanitized without sending a write', async () => {
  for (const status of [403, 429]) {
    const f = fixture(); f.state.onCall = call => { if (call.path === '/commerce/products') throw new IntegrationError(status, status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_REJECTED', 'Provider request failed.'); };
    const result = await f.request(f.accountId); assert.equal(result.status, status); assert.equal(f.calls.every(call => call.method === 'GET'), true);
  }
});

test('Commerce timestamps preserve RFC3339 offsets and reject nonexistent dates', async () => {
  const f = fixture();
  for (const value of ['2026-10-19T09:00:00Z', '2026-10-19T09:00:00+04:00', '2026-10-19T09:00:00-05:00']) {
    f.state.product.createdAt = value;
    const result = await f.request(`${f.accountId}/123`); assert.equal(result.status, 200); assert.equal(result.data.product.createdAt, value);
  }
  f.state.product.createdAt = '2026-02-30T09:00:00Z'; assert.equal((await f.request(`${f.accountId}/123`)).status, 502);
});

test('real provider 403 responses become product permission errors through the app router', async t => {
  const f = fixture(), originalFetch = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.method || 'GET', 'GET'); calls.push(url.pathname);
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: f.state.accounts });
    if (url.pathname.endsWith('/commerce/store')) return Response.json({ store: f.state.store });
    assert.equal(url.pathname, '/api/v1/commerce/products');
    return Response.json({ error: 'Private provider detail must not leak' }, { status: 403 });
  };
  let response;
  await handleIntegration({ req: { method: 'GET' }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/products/${f.accountId}`), project: { id: 'project-a', zernioProfileId: 'profile-a' }, role: 'viewer', config: { env: { ZERNIO_API_KEY: 'synthetic-key' } }, send(status, data) { response = { status, data }; } });
  assert.equal(response.status, 403); assert.equal(response.data.error.code, 'PRODUCT_READ_PERMISSION_REQUIRED');
  assert.equal(JSON.stringify(response).includes('Private provider detail'), false); assert.ok(calls.includes('/api/v1/commerce/products'));
});

test('HTTP Shopify content and classification updates use fresh reviews, exact PATCH fields and a durable native-product fence', { skip: postgresSkip }, async t => {
  // Official cached OpenAPI 1.295.0: PATCH /v1/commerce/products/{productId}
  // accepts accountId plus partial fields and returns {product}; it has no success flag.
  const directory = await mkdtemp(join(tmpdir(), 'ten98-product-edit-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const appOptions = { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'product-http-fixture-key' } };
  let app = await testApp(t, appOptions), base, cookie, projectId, providerHook, sequence = 100, keySequence = 0;
  const f = fixture(), account = { ...f.account, profileId: 'product-http-profile' }, accounts = [account], products = new Map(), calls = [];
  const store = { ...f.state.store, capabilities: ['products.read', 'products.update'] };
  const addProduct = () => { const row = { ...structuredClone(f.state.product), id: String(++sequence), descriptionHtml: '<p>Original</p>', vendor: 'Original vendor' }; products.set(row.id, row); return row; };
  const writes = () => calls.filter(call => call.method !== 'GET');
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    const method = options.method || 'GET', payload = options.body === undefined ? undefined : JSON.parse(options.body), call = { url, method, payload, headers: options.headers }; calls.push(call);
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts };
    else {
      const accountId = method === 'GET' ? url.searchParams.get('accountId') : payload.accountId, selected = accounts.find(row => row._id === accountId); assert.ok(selected);
      if (url.pathname === '/api/v1/commerce/store') result = { store: { ...store, accountId } };
      else {
        const match = url.pathname.match(/^\/api\/v1\/commerce\/products\/(\d+)$/); assert.ok(match, url.pathname);
        const product = products.get(match[1]); assert.ok(product);
        if (method !== 'GET') {
          assert.equal(method, 'PATCH'); assert.equal(url.search, ''); assert.ok(options.headers['Idempotency-Key']);
          assert.ok(Object.keys(payload).every(key => ['accountId', 'title', 'descriptionHtml', 'vendor', 'productType', 'tags'].includes(key))); assert.ok(Object.keys(payload).length > 1);
          Object.assign(product, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'accountId')));
        }
        result = { product: { ...product, accountId } };
      }
    }
    return await providerHook?.(call, structuredClone(result)) || Response.json(result);
  };
  async function listen() { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', session = cookie, key = 'product-http-key-' + ++keySequence } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session } : {}), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const route = (product, accountId = account._id) => `/api/projects/${projectId}/integrations/products/${accountId}/${product.id}`;
  const review = async (product, fields = { title: 'Reviewed title' }, accountId) => { const result = await request(route(product, accountId)); assert.equal(result.status, 200, JSON.stringify(result)); assert.match(result.data.version, /^[a-f0-9]{64}$/); assert.equal(result.data.store.accountId, accountId || account._id); return { version: result.data.version, confirmUpdate: true, ...fields }; };
  try {
    await listen();
    const setup = await request('/api/auth/setup', { body: { name: 'Product QA', email: 'product-qa@example.test', password: 'a long local product fixture password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', account.profileId, projectId);
    for (const fields of [{ title: '  Reviewed title  ' }, { descriptionHtml: '<p>Reviewed <strong>HTML</strong></p>' }, { title: 'Reviewed title', descriptionHtml: '' }, { vendor: 'Reviewed vendor' }, { vendor: '' }, { title: 'Reviewed title', vendor: 'Reviewed vendor' }, { productType: '  Exact, Product Type  ' }, { productType: '' }, { tags: ['Blue,Red', ' Case ', 'case', 'case', '', 'line\nbreak', 'tab\tlabel'] }, { tags: [] }, { productType: 'Shirts', tags: ['<script>literal tag</script>', 'summer'] }]) {
      const product = addProduct(), body = await review(product, fields), key = 'product-success-' + product.id, before = writes().length;
      const result = await request(route(product) + '/update', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.accountId, account._id); assert.equal(result.data.readback, true); assert.equal(result.data.product.id, product.id);
      assert.deepEqual(writes().at(-1).payload, { accountId: account._id, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, key === 'title' ? value.trim() : value])) }); assert.equal(writes().length, before + 1);
      assert.equal(result.data.product.title, product.title); assert.equal(result.data.product.descriptionHtml, product.descriptionHtml); assert.equal(result.data.product.vendor, product.vendor); assert.equal(result.data.product.productType, product.productType ?? null); assert.deepEqual(result.data.product.tags, product.tags); assert.equal(JSON.stringify(result).includes('never-expose'), false);
      assert.deepEqual((await request(route(product) + '/update', { body, key })).data, result.data); assert.equal(writes().length, before + 1);
      assert.equal((await request(route(product) + '/update', { body: { ...body, title: 'Different' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    const nullable = addProduct(); nullable.descriptionHtml = null;
    assert.equal((await request(route(nullable) + '/update', { body: await review(nullable, { descriptionHtml: '' }) })).status, 200);
    const reordered = addProduct(), exactTags = ['z, exact', ' A ', 'a', 'a'];
    providerHook = (call, result) => { if (call.method === 'PATCH') { reordered.tags = [...reordered.tags].sort(); return Response.json({ product: { ...result.product, tags: [...reordered.tags].reverse() } }); } };
    const reorderedResult = await request(route(reordered) + '/update', { body: await review(reordered, { tags: exactTags }) }); assert.equal(reorderedResult.status, 200, JSON.stringify(reorderedResult)); assert.deepEqual(reorderedResult.data.product.tags, [...exactTags].sort()); assert.deepEqual(writes().at(-1).payload, { accountId: account._id, tags: exactTags }); providerHook = undefined;
    assert.equal((await request(route(reordered) + '/update', { body: await review(reordered, { tags: [...exactTags].reverse() }) })).data.error.code, 'EMPTY_PRODUCT_UPDATE');
    const unknownType = addProduct(); unknownType.productType = null;
    const untouchedType = await request(route(unknownType) + '/update', { body: await review(unknownType, { title: 'Only title', tags: [...unknownType.tags] }) }); assert.equal(untouchedType.status, 200); assert.equal(untouchedType.data.product.productType, null); assert.deepEqual(writes().at(-1).payload, { accountId: account._id, title: 'Only title' });
    const emptyTypeBody = await review(unknownType, { productType: '', tags: ['summer'] }); assert.equal((await request(route(unknownType) + '/update', { body: emptyTypeBody })).status, 200); assert.deepEqual(writes().at(-1).payload, { accountId: account._id, productType: '' });
    for (const fields of [{ productType: '' }, { tags: ['summer'] }, { productType: '', tags: ['summer'] }]) assert.equal((await request(route(unknownType) + '/update', { body: await review(unknownType, fields) })).data.error.code, 'EMPTY_PRODUCT_UPDATE');
    const unknownVendor = addProduct(); unknownVendor.vendor = null;
    const preservedVendor = await request(route(unknownVendor) + '/update', { body: await review(unknownVendor, { title: 'Only title' }) }); assert.equal(preservedVendor.status, 200); assert.equal(preservedVendor.data.product.vendor, null); assert.deepEqual(writes().at(-1).payload, { accountId: account._id, title: 'Only title' });
    assert.equal((await request(route(unknownVendor) + '/update', { body: await review(unknownVendor, { vendor: '' }) })).status, 200); assert.deepEqual(writes().at(-1).payload, { accountId: account._id, vendor: '' });
    const vendorOnly = addProduct(), vendorBody = await review(vendorOnly, { title: vendorOnly.title, descriptionHtml: vendorOnly.descriptionHtml, vendor: '<script>Vendor</script>' }), vendorKey = 'vendor-only-exact';
    const acceptedVendor = await request(route(vendorOnly) + '/update', { body: vendorBody, key: vendorKey }); assert.equal(acceptedVendor.status, 200); assert.equal(acceptedVendor.data.product.vendor, '<script>Vendor</script>'); assert.deepEqual(writes().at(-1).payload, { accountId: account._id, vendor: '<script>Vendor</script>' });
    const vendorWrites = writes().length; assert.deepEqual((await request(route(vendorOnly) + '/update?check=1', { body: vendorBody, key: vendorKey })).data, acceptedVendor.data); assert.equal(writes().length, vendorWrites);
    const normalized = addProduct(), normalizedBody = await review(normalized, { descriptionHtml: '<p>Source HTML</p>' });
    providerHook = (call, result) => { if (call.method === 'PATCH') { normalized.descriptionHtml = '<p>Provider normalized HTML</p>'; return Response.json({ product: { ...result.product, descriptionHtml: normalized.descriptionHtml } }); } };
    const canonical = await request(route(normalized) + '/update', { body: normalizedBody }); assert.equal(canonical.status, 200); assert.equal(canonical.data.product.descriptionHtml, normalized.descriptionHtml); providerHook = undefined;
    const deleted = addProduct(); deleted.status = 'deleted'; deleted.platformStatus = 'DELETED';
    const deletedBody = await review(deleted), beforeDeleted = writes().length;
    const deletedResult = await request(route(deleted) + '/update', { body: deletedBody }); assert.equal(deletedResult.status, 409); assert.equal(deletedResult.data.error.code, 'PRODUCT_DELETED'); assert.equal(writes().length, beforeDeleted);
    for (const status of ['active', 'pending_review', 'rejected', 'inactive', 'archived']) {
      const current = addProduct(); current.status = status;
      assert.equal((await request(route(current) + '/update', { body: await review(current) })).status, 200, status);
    }
    const product = addProduct(), body = await review(product), before = writes().length;
    for (const extra of [{ status: 'active' }, { price: '9' }, { totalInventory: 4 }, { seo: { title: '' } }, { handle: 'new-handle' }, { accountId: 'foreign' }, { productId: product.id }, { confirmUpdate: false }, { title: '' }, { title: ' ' }, { title: 'Bad\nTitle' }, { title: 'x'.repeat(10001) }, { descriptionHtml: null }, { descriptionHtml: {} }, { descriptionHtml: 'x'.repeat(1000001) }, ...[null, {}, 3, 'bad\nvendor', 'bad\tvendor', 'bad\u0000vendor', 'x'.repeat(10001)].map(vendor => ({ vendor })), ...[null, {}, 3, 'bad\ntype', 'bad\ttype', 'bad\u0000type', 'x'.repeat(10001)].map(productType => ({ productType })), ...[null, {}, 'tag', [3], ['bad\u0000tag'], ['x'.repeat(2001)], Array(1001).fill('tag')].map(tags => ({ tags })), { version: 'bad' }]) assert.equal((await request(route(product) + '/update', { body: { ...body, ...extra } })).status, extra.descriptionHtml?.length > 1000000 ? 413 : 400, JSON.stringify(extra).slice(0, 100));
    assert.equal((await request(route(product) + '/update', { body: { version: body.version, confirmUpdate: true } })).status, 400);
    assert.equal((await request(route(product) + '/update', { body: await review(product, { title: product.title }) })).data.error.code, 'EMPTY_PRODUCT_UPDATE'); assert.equal((await request(route(product) + '/update', { body: await review(product, { vendor: product.vendor }) })).data.error.code, 'EMPTY_PRODUCT_UPDATE');
    const unchanged = await review(product, { title: product.title, descriptionHtml: '<p>Changed only HTML</p>' }); assert.equal((await request(route(product) + '/update', { body: unchanged })).status, 200); assert.deepEqual(Object.keys(writes().at(-1).payload).sort(), ['accountId', 'descriptionHtml']);
    for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) assert.equal((await request(route(product) + '/update', { method })).status, 405);
    assert.equal((await request(route(product), { session: null })).status, 401); assert.equal(writes().length, before + 1);
    await app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(product) + '/update', { body })).status, 403); await app.sql.run("UPDATE memberships SET role='owner'");
    for (const scenario of ['ungranted', 'missing-update', 'grant-link', 'native-missing', 'native-blank', 'foreign-profile', 'inactive', 'reconnect']) {
      const current = addProduct(), reviewed = await review(current, { productType: 'Scoped type', tags: ['exact, tag', ' Case '] }), count = writes().length;
      if (['ungranted', 'missing-update', 'grant-link'].includes(scenario)) { store.capabilities = ['products.read']; store.missingCapabilities = scenario === 'missing-update' ? ['products.update'] : []; store.grantPermissionsUrl = scenario === 'grant-link' ? 'https://brand.myshopify.com/admin/oauth/authorize' : null; }
      if (scenario === 'native-missing') delete account.platformUserId;
      if (scenario === 'native-blank') account.platformUserId = ' ';
      if (scenario === 'foreign-profile') account.profileId = 'foreign';
      if (scenario === 'inactive') account.isActive = false;
      if (scenario === 'reconnect') account.needsReconnection = true;
      assert.ok([403, 409].includes((await request(route(current) + '/update', { body: reviewed })).status), scenario); assert.equal(writes().length, count);
      Object.assign(account, f.account, { profileId: 'product-http-profile', needsReconnection: false }); Object.assign(store, { capabilities: ['products.read', 'products.update'], missingCapabilities: [], grantPermissionsUrl: null });
    }
    for (const scenario of ['stale-product', 'stale-type', 'stale-tags', 'between-reads', 'type-between-reads', 'tags-between-reads', 'deleted-between-reads', 'role', 'mapping', 'credentials', 'session', 'native-store', 'store-domain', 'currency', 'permissions']) {
      const current = addProduct(), reviewed = await review(current, { productType: 'Scoped type', tags: ['exact, tag', ' Case '] }), count = writes().length; let changed = false;
      if (scenario === 'stale-product') current.vendor = 'External vendor edit';
      if (scenario === 'stale-type') current.productType = 'External type edit';
      if (scenario === 'stale-tags') current.tags = ['External tag edit'];
      providerHook = async call => {
        if (call.method !== 'GET' || !call.url.pathname.endsWith('/commerce/products/' + current.id) || changed) return;
        changed = true;
        if (scenario === 'between-reads') current.descriptionHtml = '<p>External edit</p>';
        if (scenario === 'type-between-reads') current.productType = 'External type edit';
        if (scenario === 'tags-between-reads') current.tags = ['External tag edit'];
        if (scenario === 'deleted-between-reads') current.status = 'deleted';
        if (scenario === 'role') await app.sql.run("UPDATE memberships SET role='editor'");
        if (scenario === 'mapping') await app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id=?", projectId);
        if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-fixture-key' } } })).status, 200);
        if (scenario === 'session') await app.sql.run('DELETE FROM sessions');
        if (scenario === 'native-store') account.platformUserId = 'other-native-store';
        if (scenario === 'store-domain') store.domain = 'other.myshopify.com';
        if (scenario === 'currency') store.currency = 'USD';
        if (scenario === 'permissions') store.capabilities = ['products.read'];
      };
      const rejected = await request(route(current) + '/update', { body: reviewed }); assert.ok([403, 409].includes(rejected.status), scenario + JSON.stringify(rejected)); assert.equal(writes().length, count); providerHook = undefined;
      await app.sql.run("UPDATE memberships SET role='owner'"); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'product-http-profile', projectId); account.platformUserId = 'native-store'; store.domain = f.state.store.domain; store.currency = 'AED'; store.capabilities = ['products.read', 'products.update'];
      if (scenario === 'session') { const login = await request('/api/auth/login', { body: { email: 'product-qa@example.test', password: 'a long local product fixture password' } }); assert.equal(login.status, 200); cookie = login.cookie; }
      if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'product-http-fixture-key' } } })).status, 200);
    }
    for (const scenario of ['missing-receipt', 'foreign-envelope', 'foreign-product', 'wrong-product', 'wrong-title', 'wrong-vendor', 'vendor-readback', 'null-vendor', 'wrong-type', 'null-type', 'type-readback', 'wrong-tags', 'tags-readback', 'null-html', 'wrong-readback', 'deleted-receipt', 'deleted-readback', 'lost-ack', 'post-write-access', 'post-write-permissions']) {
      const current = addProduct(), reviewed = await review(current, { title: 'Selected title', descriptionHtml: '<p>Selected HTML</p>', vendor: 'Selected vendor', productType: 'Selected type', tags: ['exact, tag', ' Case ', 'case'] }), count = writes().length, key = 'product-uncertain-' + scenario; let written = false;
      providerHook = async (call, result) => {
        if (call.method === 'PATCH') {
          written = true;
          if (scenario === 'missing-receipt') return Response.json({});
          if (scenario === 'foreign-envelope') return Response.json({ ...result, accountId: 'foreign' });
          if (scenario === 'foreign-product') return Response.json({ product: { ...result.product, accountId: 'foreign' } });
          if (scenario === 'wrong-product') return Response.json({ product: { ...result.product, id: '999999' } });
          if (scenario === 'wrong-title') { current.title = 'Provider changed selected title'; return Response.json({ product: { ...result.product, title: current.title } }); }
          if (scenario === 'wrong-vendor') return Response.json({ product: { ...result.product, vendor: 'Different vendor' } });
          if (scenario === 'null-vendor') return Response.json({ product: { ...result.product, vendor: null } });
          if (scenario === 'wrong-type') return Response.json({ product: { ...result.product, productType: 'Different type' } });
          if (scenario === 'null-type') return Response.json({ product: { ...result.product, productType: null } });
          if (scenario === 'wrong-tags') return Response.json({ product: { ...result.product, tags: ['exact', 'tag', 'case'] } });
          if (scenario === 'null-html') return Response.json({ product: { ...result.product, descriptionHtml: null } });
          if (scenario === 'deleted-receipt' || scenario === 'deleted-readback') { current.status = 'deleted'; if (scenario === 'deleted-receipt') return Response.json({ product: { ...result.product, status: 'deleted' } }); }
          if (scenario === 'lost-ack') throw new Error('Lost acknowledgement');
          if (scenario === 'post-write-access') await app.sql.run("UPDATE memberships SET role='viewer'");
          if (scenario === 'post-write-permissions') store.capabilities = ['products.read'];
        }
        if (written && scenario === 'vendor-readback' && call.method === 'GET' && call.url.pathname.endsWith('/commerce/products/' + current.id)) return Response.json({ product: { ...result.product, vendor: 'Different vendor readback' } });
        if (written && scenario === 'type-readback' && call.method === 'GET' && call.url.pathname.endsWith('/commerce/products/' + current.id)) return Response.json({ product: { ...result.product, productType: 'Different type readback' } });
        if (written && scenario === 'tags-readback' && call.method === 'GET' && call.url.pathname.endsWith('/commerce/products/' + current.id)) return Response.json({ product: { ...result.product, tags: ['Different tag readback'] } });
        if (written && scenario === 'wrong-readback' && call.method === 'GET' && call.url.pathname.endsWith('/commerce/products/' + current.id)) return Response.json({ product: { ...result.product, descriptionHtml: '<p>Different readback</p>' } });
      };
      const result = await request(route(current) + '/update', { body: reviewed, key }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, count + 1); providerHook = undefined; await app.sql.run("UPDATE memberships SET role='owner'"); store.capabilities = ['products.read', 'products.update'];
      assert.equal((await request(route(current) + '/update', { body: reviewed, key })).data.error.code, 'OPERATION_UNCERTAIN');
      if (scenario === 'deleted-receipt' || scenario === 'deleted-readback') {
        const blocked = await request(route(current) + '/update', { body: await review(current, { title: 'New request for deleted product' }) }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation?.id); assert.equal(writes().length, count + 1);
        // A later provider status change must not release the earlier unknown write.
        current.status = 'draft';
      }
      const alias = { ...account, _id: 'alias-' + scenario }; accounts.push(alias);
      const blocked = await request(route(current, alias._id) + '/update', { body: await review(current, { title: 'Different next request' }, alias._id) }); assert.equal(blocked.data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, count + 1);
    }
    const raced = addProduct(), raceBody = await review(raced, { productType: 'Raced type', tags: ['raced, exact tag'] }), alias = { ...account, _id: 'final-await-alias' }; accounts.push(alias);
    const aliasBody = await review(raced, { title: 'Alias reviewed title' }, alias._id); let entered, release, productReads = 0, finalAccounts = 0;
    const held = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
    providerHook = async call => {
      if (call.method === 'GET' && call.url.pathname.endsWith('/commerce/products/' + raced.id) && call.url.searchParams.get('accountId') === account._id) productReads++;
      if (productReads === 2 && call.url.pathname === '/api/v1/accounts' && ++finalAccounts === 2) { entered(); await resume; }
      if (call.method === 'PATCH') throw new Error('Alias final-await lost acknowledgement');
    };
    const count = writes().length, waiting = request(route(raced) + '/update', { body: raceBody }); await held;
    const lostKey = 'product-reopen-lost-ack'; assert.equal((await request(route(raced, alias._id) + '/update', { body: aliasBody, key: lostKey })).data.operation.status, 'uncertain'); release();
    assert.equal((await waiting).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, count + 1); providerHook = undefined;
    const originalProject = projectId, workspaceId = (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
    await app.sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'product-alias-project', workspaceId, 'Same native store', 'alias-profile');
    const projectAlias = { ...account, _id: 'cross-project-alias', profileId: 'alias-profile' }; accounts.push(projectAlias); projectId = 'product-alias-project';
    assert.equal((await request(route(raced, projectAlias._id) + '/update', { body: await review(raced, { descriptionHtml: '<p>Changed request body</p>' }, projectAlias._id) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); projectId = originalProject;
    app = await reopen(app, appOptions); await listen();
    assert.equal((await request(route(raced, alias._id) + '/update', { body: aliasBody, key: lostKey })).data.error.code, 'OPERATION_UNCERTAIN');
    assert.equal((await request(route(raced) + '/update', { body: await review(raced, { title: 'After reopen' }) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, count + 1);
    const orphan = addProduct(); await app.sql.run('INSERT INTO zernio_product_updates (resource, project_id, request_key) VALUES (?, ?, ?)', JSON.stringify(['shopify', account.platformUserId, orphan.id]), 'missing-project', 'missing-request');
    assert.equal((await request(route(orphan) + '/update', { body: await review(orphan) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, count + 1);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP Shopify draft creation forces one priced variant, fresh store review, durable receipts and a global native-store fence', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-product-create-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const appOptions = { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'product-create-fixture-key' } };
  let app = await testApp(t, appOptions), base, cookie, projectId, providerHook, sequence = 200, keySequence = 0, storeSequence = 0;
  const f = fixture(), account = { ...f.account, profileId: 'product-create-profile' }, accounts = [account], products = new Map(), calls = [];
  const store = { ...f.state.store, capabilities: ['products.read', 'products.create'] }, writes = () => calls.filter(call => call.method !== 'GET');
  const freshStore = () => { account.platformUserId = 'native-create-store-' + ++storeSequence; account.isActive = true; account.needsReconnection = false; Object.assign(store, { currency: 'AED', domain: 'brand.myshopify.com', capabilities: ['products.read', 'products.create'], missingCapabilities: [] }); };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    const method = options.method || 'GET', payload = options.body === undefined ? undefined : JSON.parse(options.body), call = { url, method, payload }; calls.push(call);
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: structuredClone(accounts) };
    else {
      const accountId = method === 'GET' ? url.searchParams.get('accountId') : payload.accountId; assert.ok(accounts.some(row => row._id === accountId));
      if (url.pathname === '/api/v1/commerce/store') result = { store: { ...structuredClone(store), accountId } };
      else if (url.pathname === '/api/v1/commerce/products') {
        assert.equal(method, 'POST'); assert.equal(url.search, ''); assert.ok(options.headers['Idempotency-Key']);
        const product = { ...structuredClone(f.state.product), id: String(++sequence), accountId, title: payload.title, descriptionHtml: payload.descriptionHtml ?? null, tags: [], images: [], options: [{ name: 'Title', values: ['Default Title'] }], url: null, publishedAt: null, variants: [{ id: String(sequence + 10000), title: 'Default Title', price: { amount: payload.variants[0].price === '00019.90' ? '19.9000' : payload.variants[0].price, currency: store.currency }, compareAtPrice: null, options: [] }] };
        products.set(product.id, product); result = { product: structuredClone(product) };
      } else {
        assert.equal(method, 'GET'); const match = url.pathname.match(/^\/api\/v1\/commerce\/products\/(\d+)$/); assert.ok(match, url.pathname);
        const product = products.get(match[1]); assert.ok(product); result = { product: { ...structuredClone(product), accountId } };
      }
    }
    return await providerHook?.(call, result) || Response.json(result);
  };
  async function listen() { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', key = 'product-create-key-' + ++keySequence, session = cookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session } : {}), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const route = (accountId = account._id) => `/api/projects/${projectId}/integrations/products/${accountId}`;
  async function review(fields = {}, accountId = account._id) { const result = await request(route(accountId) + '/store'); assert.equal(result.status, 200, JSON.stringify(result)); assert.match(result.data.creationVersion, /^[a-f0-9]{64}$/); return { version: result.data.creationVersion, confirmCreate: true, title: '  Reviewed draft  ', price: '00019.90', ...fields }; }
  const evidence = key => app.sql.get('SELECT account_id,native_product_id FROM zernio_product_create_receipts WHERE project_id=? AND request_key=?', projectId, key);
  try {
    await listen(); const setup = await request('/api/auth/setup', { body: { name: 'Create QA', email: 'product-create@example.test', password: 'a long local product creation password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', account.profileId, projectId);
    for (const fields of [{}, { descriptionHtml: '' }, { descriptionHtml: '<p>Reviewed HTML</p>' }, { price: '0' }, { price: '9'.repeat(80) + '.10' }]) {
      freshStore(); const body = await review(fields), key = 'product-created-' + storeSequence, count = writes().length;
      const result = await request(route() + '/create', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.readback, true); assert.equal(result.data.product.status, 'draft'); assert.equal(result.data.product.platformStatus, 'DRAFT');
      assert.deepEqual(writes().at(-1).payload, { accountId: account._id, title: 'Reviewed draft', ...(Object.hasOwn(fields, 'descriptionHtml') ? { descriptionHtml: fields.descriptionHtml } : {}), status: 'draft', variants: [{ price: body.price }] }); assert.equal(writes().length, count + 1);
      assert.deepEqual(await evidence(key), { account_id: account._id, native_product_id: result.data.product.id }); assert.equal(JSON.stringify(result).includes('never-expose'), false);
      assert.deepEqual((await request(route() + '/create', { body, key })).data, result.data); assert.equal(writes().length, count + 1);
      assert.equal((await request(route() + '/create', { body: { ...body, price: '20' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    // Parallel duplicates with one Idempotency-Key create one native product and share one sent outcome.
    freshStore(); const creates = () => calls.filter(call => call.method === 'POST' && call.url.pathname === '/api/v1/commerce/products').length;
    const parallelBody = await review(), parallelKey = 'product-create-parallel', createsBefore = creates();
    const parallel = await Promise.all([1, 2].map(() => request(route() + '/create', { body: parallelBody, key: parallelKey })));
    assert.equal(creates(), createsBefore + 1, JSON.stringify(parallel)); assert.equal(new Set(parallel.filter(result => result.status === 200).map(result => result.data.operation.id)).size, 1, JSON.stringify(parallel));
    assert.ok(parallel.every(result => result.status === 200 ? result.data.operation.status === 'complete' : result.data.error.code === 'OPERATION_UNCERTAIN'), JSON.stringify(parallel));
    freshStore(); const valid = await review(), count = writes().length;
    for (const fields of [{ status: 'active' }, { variants: [{ price: '1' }] }, { inventoryQuantity: 1 }, { images: [] }, { tags: [] }, { accountId: 'foreign' }, { confirmCreate: false }, { title: '' }, { title: ' ' }, { title: 'Bad\nTitle' }, { title: 'x'.repeat(10001) }, { descriptionHtml: null }, { descriptionHtml: {} }, { version: 'bad' }, { price: 19.9 }, { price: '-1' }, { price: '1.001' }, { price: '1e2' }, { price: ' 1' }, { price: '19.90\n' }, { price: '1'.repeat(101) }]) assert.equal((await request(route() + '/create', { body: { ...valid, ...fields } })).status, 400, JSON.stringify(fields).slice(0, 100));
    for (const field of ['title', 'price', 'version', 'confirmCreate']) { const body = { ...valid }; delete body[field]; assert.equal((await request(route() + '/create', { body })).status, 400); }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(route() + '/create', { method })).status, 405);
    assert.equal((await request(route() + '/create?status=draft', { body: valid })).status, 400); assert.equal((await request(route() + '/create', { body: valid, session: null })).status, 401);
    await app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route() + '/create', { body: valid })).status, 403); await app.sql.run("UPDATE memberships SET role='owner'"); assert.equal(writes().length, count);
    for (const scenario of ['missing-create', 'missing-read', 'ungranted', 'native-missing', 'native-blank', 'inactive', 'reconnect', 'currency', 'domain', 'between-reads', 'mapping', 'role', 'credentials', 'session']) {
      freshStore(); const body = await review(), before = writes().length; let changed = false;
      if (scenario.startsWith('missing-')) store.capabilities = [scenario === 'missing-create' ? 'products.read' : 'products.create'];
      if (scenario === 'ungranted') { store.capabilities = ['products.read']; store.missingCapabilities = ['products.create']; }
      if (scenario === 'native-missing') delete account.platformUserId;
      if (scenario === 'native-blank') account.platformUserId = ' ';
      if (scenario === 'inactive') account.isActive = false;
      if (scenario === 'reconnect') account.needsReconnection = true;
      if (scenario === 'currency') store.currency = 'USD';
      if (scenario === 'domain') store.domain = 'changed.myshopify.com';
      providerHook = async call => {
        if (call.url.pathname !== '/api/v1/commerce/store' || changed) return; changed = true;
        if (scenario === 'between-reads') store.currency = 'USD';
        if (scenario === 'mapping') await app.sql.run("UPDATE projects SET zernio_profile_id='other-profile' WHERE id=?", projectId);
        if (scenario === 'role') await app.sql.run("UPDATE memberships SET role='viewer'");
        if (scenario === 'session') await app.sql.run('DELETE FROM sessions');
        if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-create-fixture-key' } } })).status, 200);
      };
      assert.ok([403, 409].includes((await request(route() + '/create', { body })).status), scenario); assert.equal(writes().length, before); providerHook = undefined;
      await app.sql.run("UPDATE memberships SET role='owner'"); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', account.profileId, projectId);
      if (scenario === 'session') { const login = await request('/api/auth/login', { body: { email: 'product-create@example.test', password: 'a long local product creation password' } }); assert.equal(login.status, 200); cookie = login.cookie; }
      if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'product-create-fixture-key' } } })).status, 200);
    }
    for (const scenario of ['missing-receipt', 'foreign-envelope', 'foreign-product', 'missing-id', 'active', 'wrong-platform-status', 'wrong-title', 'wrong-price', 'wrong-currency', 'two-variants', 'null-html', 'wrong-readback', 'readback-404', 'lost-ack', 'post-write-access', 'post-write-permissions']) {
      freshStore(); const body = await review({ descriptionHtml: '<p>Authored HTML</p>' }), before = writes().length, key = 'create-uncertain-' + scenario; let written = false;
      providerHook = async (call, result) => {
        if (call.method === 'POST') {
          written = true;
          if (scenario === 'missing-receipt') return Response.json({});
          if (scenario === 'foreign-envelope') result.accountId = 'foreign';
          if (scenario === 'foreign-product') result.product.accountId = 'foreign';
          if (scenario === 'missing-id') delete result.product.id;
          if (scenario === 'active') result.product.status = 'active';
          if (scenario === 'wrong-platform-status') result.product.platformStatus = 'ACTIVE';
          if (scenario === 'wrong-title') result.product.title = 'Wrong title';
          if (scenario === 'wrong-price') result.product.variants[0].price.amount = '19.91';
          if (scenario === 'wrong-currency') result.product.variants[0].price.currency = 'USD';
          if (scenario === 'two-variants') result.product.variants.push({ ...result.product.variants[0], id: 'second' });
          if (scenario === 'null-html') result.product.descriptionHtml = null;
          if (scenario === 'lost-ack') throw new Error('Lost create acknowledgement');
          if (scenario === 'post-write-access') await app.sql.run("UPDATE memberships SET role='viewer'");
          if (scenario === 'post-write-permissions') store.capabilities = ['products.read'];
        }
        if (written && call.method === 'GET' && call.url.pathname.includes('/commerce/products/')) {
          if (scenario === 'wrong-readback') result.product.descriptionHtml = '<p>Other HTML</p>';
          if (scenario === 'readback-404') return Response.json({ error: 'not found' }, { status: 404 });
        }
      };
      const result = await request(route() + '/create', { body, key }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, before + 1); providerHook = undefined; await app.sql.run("UPDATE memberships SET role='owner'"); store.capabilities = ['products.read', 'products.create'];
      const operation = await app.sql.get('SELECT id,status FROM integration_operations WHERE project_id=? AND request_key=?', projectId, key); assert.equal(operation.status, 'uncertain', scenario);
      assert.deepEqual(await evidence(key), { account_id: account._id, native_product_id: ['missing-receipt', 'foreign-envelope', 'foreign-product', 'missing-id', 'lost-ack'].includes(scenario) ? null : String(sequence) });
      assert.equal((await request(route() + '/create', { body, key })).data.error.code, 'OPERATION_UNCERTAIN');
      const blocked = await request(route() + '/create', { body: await review({ title: 'New attempt' }) }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, operation.id); assert.equal(writes().length, before + 1);
      const alias = { ...account, _id: 'creation-alias-' + scenario, username: 'renamed.myshopify.com' }; accounts.push(alias);
      assert.equal((await request(route(alias._id) + '/create', { body: await review({ title: 'Alias draft' }, alias._id) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, before + 1);
      await app.sql.run("UPDATE integration_operations SET status='reviewed-not-applied' WHERE id=?", operation.id);
      assert.equal((await request(route() + '/create', { body, key })).data.error.code, 'OPERATION_REVIEWED');
      assert.equal((await request(route() + '/create', { body: await review({ title: 'New reviewed draft' }) })).status, 200); assert.equal(writes().length, before + 2);
      assert.equal((await evidence(key)).native_product_id, ['missing-receipt', 'foreign-envelope', 'foreign-product', 'missing-id', 'lost-ack'].includes(scenario) ? null : String(sequence - 1), 'Older evidence survives fence replacement.');
    }
    freshStore(); const originalBody = await review(), alias = { ...account, _id: 'create-race-alias' }; accounts.push(alias); const aliasBody = await review({}, alias._id); let storesRead = 0, entered, release, heldOnce = false;
    const held = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
    providerHook = async call => { if (call.url.pathname === '/api/v1/commerce/store' && call.url.searchParams.get('accountId') === account._id) storesRead++; if (!heldOnce && storesRead === 4 && call.url.pathname === '/api/v1/accounts') { heldOnce = true; entered(); await resume; } if (call.method === 'POST') throw new Error('Alias lost acknowledgement'); };
    const beforeRace = writes().length, waiting = request(route() + '/create', { body: originalBody }); await held;
    const lostKey = 'create-restart-lost-ack'; assert.equal((await request(route(alias._id) + '/create', { body: aliasBody, key: lostKey })).data.operation.status, 'uncertain'); release(); assert.equal((await waiting).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRace + 1); providerHook = undefined;
    const originalProject = projectId, workspaceId = (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
    await app.sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'creation-alias-project', workspaceId, 'Same native store', 'creation-alias-profile'); const other = { ...account, _id: 'create-project-alias', profileId: 'creation-alias-profile' }; accounts.push(other); projectId = 'creation-alias-project';
    assert.equal((await request(route(other._id) + '/create', { body: await review({}, other._id) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); projectId = originalProject;
    app = await reopen(app, appOptions); await listen(); assert.equal((await request(route(alias._id) + '/create', { body: aliasBody, key: lostKey })).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal((await evidence(lostKey)).native_product_id, null);
    assert.equal((await request(route() + '/create', { body: await review({ title: 'After restart' }) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRace + 1);
    freshStore(); await app.sql.run('INSERT INTO zernio_product_creates (resource, project_id, request_key) VALUES (?, ?, ?)', JSON.stringify(['shopify', account.platformUserId]), 'missing-project', 'missing-request'); assert.equal((await request(route() + '/create', { body: await review() })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRace + 1);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP Shopify single-variant price uses exact native fields, verified readback and the shared content fence', { skip: postgresSkip }, async t => {
  // Cached OpenAPI 1.295.0: POST /v1/commerce/products/{productId}/price
  // accepts accountId and variants [{id,price}], and returns {product}.
  const directory = await mkdtemp(join(tmpdir(), 'ten98-product-price-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const appOptions = { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'product-price-fixture-key' } };
  let app = await testApp(t, appOptions), base, cookie, projectId, providerHook, sequence = 400, keySequence = 0;
  const f = fixture(), account = { ...f.account, profileId: 'product-price-profile' }, accounts = [account], products = new Map(), calls = [];
  const store = { ...f.state.store, capabilities: ['products.read', 'products.price'] }, writes = () => calls.filter(call => call.method !== 'GET');
  const addProduct = () => { const row = { ...structuredClone(f.state.product), id: String(++sequence) }; row.variants.push({ ...structuredClone(row.variants[0]), id: 'variant-2', title: 'M', price: { amount: '50.000', currency: 'AED' } }); products.set(row.id, row); return row; };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    const method = options.method || 'GET', payload = options.body === undefined ? undefined : JSON.parse(options.body), call = { url, method, payload }; calls.push(call);
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: structuredClone(accounts) };
    else {
      const accountId = method === 'GET' ? url.searchParams.get('accountId') : payload.accountId; assert.ok(accounts.some(row => row._id === accountId));
      if (url.pathname === '/api/v1/commerce/store') result = { store: { ...structuredClone(store), accountId } };
      else {
        const match = url.pathname.match(/^\/api\/v1\/commerce\/products\/(\d+)(\/price)?$/); assert.ok(match, url.pathname);
        const product = products.get(String(BigInt(match[1]))); assert.ok(product);
        if (method !== 'GET') {
          assert.equal(url.search, ''); assert.ok(options.headers['Idempotency-Key']);
          if (match[2]) {
            assert.equal(method, 'POST'); assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'variants']); assert.equal(payload.variants.length, 1); assert.deepEqual(Object.keys(payload.variants[0]).sort(), ['id', 'price']);
            const selected = product.variants.find(row => row.id === payload.variants[0].id); assert.ok(selected);
            selected.price.amount = payload.variants[0].price === '00029.90' ? '29.9000' : payload.variants[0].price;
          } else { assert.equal(method, 'PATCH'); assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'title']); product.title = payload.title; }
        }
        result = { product: { ...structuredClone(product), id: match[1], accountId } };
      }
    }
    return await providerHook?.(call, result) || Response.json(result);
  };
  async function listen() { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', key = 'product-price-key-' + ++keySequence, session = cookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session } : {}), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const route = (product, accountId = account._id) => `/api/projects/${projectId}/integrations/products/${accountId}/${product.id}`;
  async function review(product, fields = {}, accountId = account._id, content = false) { const result = await request(route(product, accountId)); assert.equal(result.status, 200, JSON.stringify(result)); assert.match(result.data.version, /^[a-f0-9]{64}$/); return { version: result.data.version, ...(content ? { confirmUpdate: true, title: 'Reviewed content title' } : { confirmPrice: true, variantId: 'variant-2', price: '00029.90' }), ...fields }; }
  const grants = () => { Object.assign(store, { capabilities: ['products.read', 'products.price'], missingCapabilities: [], currency: 'AED', domain: f.state.store.domain }); Object.assign(account, f.account, { profileId: 'product-price-profile', needsReconnection: false }); };
  try {
    await listen(); const setup = await request('/api/auth/setup', { body: { name: 'Price QA', email: 'product-price@example.test', password: 'a long local product price password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', account.profileId, projectId);
    for (const price of ['00029.90', '0', '9'.repeat(80) + '.10']) {
      const product = addProduct(), original = structuredClone(product), body = await review(product, { price }), key = 'price-success-' + product.id, count = writes().length;
      const result = await request(route(product) + '/price', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.readback, true); assert.equal(result.data.accountId, account._id);
      assert.deepEqual(writes().at(-1).payload, { accountId: account._id, variants: [{ id: 'variant-2', price }] }); assert.equal(writes().length, count + 1);
      assert.equal(result.data.product.variants[1].price.amount, price === '00029.90' ? '29.9000' : price); assert.equal(result.data.product.variants[1].price.currency, 'AED'); assert.deepEqual(product.variants[0], original.variants[0]); assert.equal(product.title, original.title); assert.equal(product.descriptionHtml, original.descriptionHtml); assert.equal(product.variants[1].compareAtPrice, null); assert.equal(JSON.stringify(result).includes('never-expose'), false);
      assert.deepEqual((await request(route(product) + '/price', { body, key })).data, result.data); assert.equal(writes().length, count + 1); assert.equal((await request(route(product) + '/price', { body: { ...body, price: '30' }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    }
    const invalidProduct = addProduct(), valid = await review(invalidProduct), count = writes().length;
    for (const fields of [{ status: 'active' }, { compareAtPrice: null }, { variants: [{ id: 'variant-2', price: '1' }] }, { title: 'Extra' }, { descriptionHtml: '' }, { inventoryQuantity: 1 }, { images: [] }, { accountId: 'foreign' }, { confirmPrice: false }, { version: 'bad' }, { variantId: '' }, { variantId: 'bad/id' }, { variantId: 'bad\nid' }, ...[29.9, null, '', '-1', '+1', '1e2', '.5', '1.', '1.001', ' 1', '1 ', '1\n', '1\r\n', '1\t', '1\u0000', '1'.repeat(101)].map(price => ({ price }))]) assert.equal((await request(route(invalidProduct) + '/price', { body: { ...valid, ...fields } })).status, 400, JSON.stringify(fields));
    for (const field of ['version', 'confirmPrice', 'variantId', 'price']) { const body = { ...valid }; delete body[field]; assert.equal((await request(route(invalidProduct) + '/price', { body })).status, 400); }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(route(invalidProduct) + '/price', { method })).status, 405);
    assert.equal((await request(route(invalidProduct) + '/price?accountId=foreign', { body: valid })).status, 400); assert.equal((await request(route(invalidProduct) + '/price', { body: valid, session: null })).status, 401);
    await app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(invalidProduct) + '/price', { body: valid })).status, 403); await app.sql.run("UPDATE memberships SET role='owner'");
    assert.equal((await request(route(invalidProduct) + '/price', { body: { ...valid, price: '00050.00' } })).data.error.code, 'EMPTY_PRODUCT_PRICE_UPDATE'); assert.equal((await request(route(invalidProduct) + '/price', { body: { ...valid, variantId: 'unreturned-variant' } })).data.error.code, 'PRODUCT_VARIANT_CHANGED'); assert.equal(writes().length, count);
    for (const scenario of ['missing-price', 'ungranted-price', 'missing-read', 'native-missing', 'native-blank', 'native-untrimmed', 'inactive', 'reconnect', 'deleted', 'stale', 'between-reads', 'removed-variant', 'currency', 'domain', 'native-store', 'role', 'mapping', 'credentials', 'session']) {
      grants(); const product = addProduct();
      if (scenario === 'missing-price') store.capabilities = ['products.read'];
      if (scenario === 'ungranted-price') { store.capabilities = ['products.read']; store.missingCapabilities = ['products.price']; }
      if (scenario === 'native-missing') delete account.platformUserId;
      if (scenario === 'native-blank') account.platformUserId = ' ';
      if (scenario === 'native-untrimmed') account.platformUserId = ' native-store ';
      if (scenario === 'deleted') { product.status = 'deleted'; product.platformStatus = 'DELETED'; }
      const body = await review(product), before = writes().length; let changed = false;
      if (scenario === 'missing-read') store.capabilities = ['products.price'];
      if (scenario === 'inactive') account.isActive = false;
      if (scenario === 'reconnect') account.needsReconnection = true;
      if (scenario === 'stale') product.title = 'External title';
      providerHook = async call => {
        if (call.method !== 'GET' || call.url.pathname !== '/api/v1/commerce/products/' + product.id || changed) return; changed = true;
        if (scenario === 'between-reads') product.variants[1].price.amount = '60';
        if (scenario === 'removed-variant') product.variants.pop();
        if (scenario === 'currency') store.currency = 'USD';
        if (scenario === 'domain') store.domain = 'changed.myshopify.com';
        if (scenario === 'native-store') account.platformUserId = 'changed-native-store';
        if (scenario === 'role') await app.sql.run("UPDATE memberships SET role='viewer'");
        if (scenario === 'mapping') await app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id=?", projectId);
        if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-price-fixture-key' } } })).status, 200);
        if (scenario === 'session') await app.sql.run('DELETE FROM sessions');
      };
      const result = await request(route(product) + '/price', { body }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); if (scenario.endsWith('price')) assert.equal(result.data.error.code, 'PRODUCT_PRICE_PERMISSION_REQUIRED'); assert.equal(writes().length, before); providerHook = undefined;
      await app.sql.run("UPDATE memberships SET role='owner'"); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'product-price-profile', projectId);
      if (scenario === 'credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'product-price-fixture-key' } } })).status, 200);
      if (scenario === 'session') { const login = await request('/api/auth/login', { body: { email: 'product-price@example.test', password: 'a long local product price password' } }); assert.equal(login.status, 200); cookie = login.cookie; }
    }
    for (const scenario of ['missing-receipt', 'foreign-envelope', 'foreign-product', 'wrong-product', 'missing-variant', 'duplicate-variant', 'wrong-price', 'wrong-currency', 'deleted', 'wrong-readback', 'missing-readback-variant', 'readback-currency', 'readback-404', 'lost-ack', 'post-write-access', 'post-write-grants', 'post-write-store']) {
      grants(); store.capabilities.push('products.update'); const product = addProduct(), body = await review(product), before = writes().length, key = 'price-uncertain-' + scenario; let written = false;
      providerHook = async (call, result) => {
        if (call.method === 'POST') {
          written = true;
          if (scenario === 'missing-receipt') return Response.json({});
          if (scenario === 'foreign-envelope') result.accountId = 'foreign';
          if (scenario === 'foreign-product') result.product.accountId = 'foreign';
          if (scenario === 'wrong-product') result.product.id = '999';
          if (scenario === 'missing-variant') result.product.variants.pop();
          if (scenario === 'duplicate-variant') result.product.variants.push(result.product.variants[1]);
          if (scenario === 'wrong-price') result.product.variants[1].price.amount = '29.91';
          if (scenario === 'wrong-currency') result.product.variants[1].price.currency = 'USD';
          if (scenario === 'deleted') result.product.status = 'deleted';
          if (scenario === 'lost-ack') throw new Error('Lost price acknowledgement');
          if (scenario === 'post-write-access') await app.sql.run("UPDATE memberships SET role='viewer'");
          if (scenario === 'post-write-grants') store.capabilities = ['products.read'];
          if (scenario === 'post-write-store') store.domain = 'changed-after-write.myshopify.com';
        }
        if (written && call.method === 'GET' && call.url.pathname === '/api/v1/commerce/products/' + product.id) {
          if (scenario === 'wrong-readback') result.product.variants[1].price.amount = '29.91';
          if (scenario === 'missing-readback-variant') result.product.variants.pop();
          if (scenario === 'readback-currency') result.product.variants[1].price.currency = 'USD';
          if (scenario === 'readback-404') return Response.json({ error: 'not found' }, { status: 404 });
        }
      };
      const result = await request(route(product) + '/price', { body, key }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, before + 1); providerHook = undefined; grants(); store.capabilities.push('products.update'); await app.sql.run("UPDATE memberships SET role='owner'");
      assert.equal((await app.sql.get('SELECT status FROM integration_operations WHERE project_id=? AND request_key=?', projectId, key)).status, 'uncertain', scenario); assert.equal((await request(route(product) + '/price', { body, key })).data.error.code, 'OPERATION_UNCERTAIN');
      const alias = { ...account, _id: 'price-alias-' + scenario }; accounts.push(alias);
      assert.equal((await request(route(product, alias._id) + '/update', { body: await review(product, {}, alias._id, true) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, before + 1);
    }
    let reopenedProduct, reopenedAlias, reopenedBody, reopenedKey;
    for (const waitingKind of ['price', 'update']) {
      grants(); store.capabilities.push('products.update'); const product = addProduct(), alias = { ...account, _id: 'price-race-alias-' + waitingKind }; accounts.push(alias);
      const otherKind = waitingKind === 'price' ? 'update' : 'price', body = await review(product, {}, account._id, waitingKind === 'update'), aliasBody = await review(product, {}, alias._id, otherKind === 'update'); let productReads = 0, finalAccounts = 0, entered, release, heldOnce = false;
      const held = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
      providerHook = async call => { if (call.method === 'GET' && call.url.pathname === '/api/v1/commerce/products/' + product.id && call.url.searchParams.get('accountId') === account._id) productReads++; if (!heldOnce && productReads === 2 && call.url.pathname === '/api/v1/accounts' && ++finalAccounts === 2) { heldOnce = true; entered(); await resume; } if (call.method !== 'GET') throw new Error('Cross-action lost acknowledgement'); };
      const before = writes().length, waiting = request(route(product) + '/' + waitingKind, { body }); await held;
      const key = 'price-reopen-' + otherKind; const unknown = await request(route(product, alias._id) + '/' + otherKind, { body: aliasBody, key }); assert.equal(unknown.data.operation.status, 'uncertain', JSON.stringify(unknown)); release(); assert.equal((await waiting).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, before + 1); providerHook = undefined;
      reopenedProduct = product; reopenedAlias = alias; reopenedBody = aliasBody; reopenedKey = key;
    }
    const originalProject = projectId, workspaceId = (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
    await app.sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'price-alias-project', workspaceId, 'Same native product', 'price-alias-profile'); const other = { ...account, _id: 'price-project-alias', profileId: 'price-alias-profile' }; accounts.push(other); projectId = 'price-alias-project';
    for (const kind of ['price', 'update']) assert.equal((await request(route(reopenedProduct, other._id) + '/' + kind, { body: await review(reopenedProduct, { ...(kind === 'price' ? { price: '30' } : {}) }, other._id, kind === 'update') })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); projectId = originalProject;
    app = await reopen(app, appOptions); await listen(); const beforeRestart = writes().length;
    assert.equal((await request(route(reopenedProduct, reopenedAlias._id) + '/price', { body: reopenedBody, key: reopenedKey })).data.error.code, 'OPERATION_UNCERTAIN');
    const padded = { ...reopenedProduct, id: '000' + reopenedProduct.id }; assert.equal((await request(route(padded) + '/price', { body: await review(padded, { price: '30' }) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRestart);
    const orphan = addProduct(); await app.sql.run('INSERT INTO zernio_product_updates (resource, project_id, request_key) VALUES (?, ?, ?)', JSON.stringify(['shopify', account.platformUserId, orphan.id]), 'missing-project', 'missing-request'); assert.equal((await request(route(orphan) + '/price', { body: await review(orphan) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRestart);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const stateAction of ['deactivate', 'archive', 'activate', 'delete']) test(`HTTP Shopify ${stateAction} uses exact native state receipt, fresh grants and the shared durable product fence`, { skip: postgresSkip }, async t => {
  const deleting = stateAction === 'delete', startingState = deleting ? 'archived' : stateAction === 'activate' ? 'draft' : 'active', targetState = stateAction === 'archive' ? 'archived' : stateAction === 'activate' ? 'active' : 'draft', confirmation = deleting ? 'confirmDelete' : stateAction === 'archive' ? 'confirmArchive' : stateAction === 'activate' ? 'confirmActivate' : 'confirmDeactivate';
  const directory = await mkdtemp(join(tmpdir(), 'ten98-product-state-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const appOptions = { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'product-state-fixture-key' } };
  let app = await testApp(t, appOptions), base, cookie, projectId, providerHook, sequence = 700, keySequence = 0;
  const f = fixture(), account = { ...f.account, profileId: 'product-state-profile' }, accounts = [account], products = new Map(), absent = new Set(), calls = [];
  const store = { ...f.state.store, capabilities: ['products.read', 'products.status', 'products.update', 'products.price'] }, writes = () => calls.filter(call => call.method !== 'GET');
  const addProduct = () => { const row = { ...structuredClone(f.state.product), id: String(++sequence), status: startingState, platformStatus: startingState.toUpperCase(), url: 'https://brand.example.test/existing', publishedAt: '2026-10-19T09:00:00Z' }; products.set(row.id, row); return row; };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    const method = options.method || 'GET', payload = options.body === undefined ? undefined : JSON.parse(options.body), call = { url, method, payload, headers: options.headers }; calls.push(call);
    let result, responseStatus = 200;
    if (url.pathname === '/api/v1/accounts') result = { accounts: structuredClone(accounts) };
    else {
      const accountId = method === 'GET' ? url.searchParams.get('accountId') : payload.accountId; assert.ok(accounts.some(row => row._id === accountId));
      if (url.pathname === '/api/v1/commerce/store') result = { store: { ...structuredClone(store), accountId } };
      else if (url.pathname === '/api/v1/commerce/products/state') {
        assert.equal(method, 'POST'); assert.equal(url.search, ''); assert.ok(options.headers['Idempotency-Key']);
        assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'action', 'productIds']); assert.equal(payload.action, stateAction); assert.equal(payload.productIds.length, 1);
        const product = products.get(String(BigInt(payload.productIds[0]))); assert.ok(product); if (deleting) absent.add(product.id); else Object.assign(product, { status: targetState, platformStatus: targetState.toUpperCase() });
        result = { action: stateAction, succeeded: [...payload.productIds], failed: [] };
      } else {
        const match = url.pathname.match(/^\/api\/v1\/commerce\/products\/(\d+)(\/price)?$/); assert.ok(match, url.pathname);
        const product = products.get(String(BigInt(match[1]))); assert.ok(product);
        if (method !== 'GET') {
          assert.equal(url.search, ''); assert.ok(options.headers['Idempotency-Key']);
          if (match[2]) { assert.equal(method, 'POST'); assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'variants']); product.variants[0].price.amount = payload.variants[0].price; }
          else { assert.equal(method, 'PATCH'); assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'title']); product.title = payload.title; }
        }
        if (method === 'GET' && absent.has(product.id)) { result = { error: 'Product not found', type: 'not_found', code: 'product_not_found' }; responseStatus = 404; }
        else result = { product: { ...structuredClone(product), id: match[1], accountId } };
      }
    }
    return await providerHook?.(call, result) || Response.json(result, { status: responseStatus });
  };
  async function listen() { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', key = 'product-state-key-' + ++keySequence, session = cookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session } : {}), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const route = (product, accountId = account._id) => `/api/projects/${projectId}/integrations/products/${accountId}/${product.id}`;
  async function review(product, kind = stateAction, accountId = account._id) { const result = await request(route(product, accountId)); assert.equal(result.status, 200, JSON.stringify(result)); return { version: kind === 'delete' ? result.data.deleteVersion : kind === 'archive' ? result.data.archiveVersion : kind === 'activate' ? result.data.activateVersion : result.data.version, ...(kind === 'delete' ? { confirmDelete: true } : kind === 'archive' ? { confirmArchive: true } : kind === 'activate' ? { confirmActivate: true } : kind === 'deactivate' ? { confirmDeactivate: true } : kind === 'update' ? { confirmUpdate: true, title: 'Reviewed content' } : { confirmPrice: true, variantId: 'variant-1', price: '30' }) }; }
  const grants = () => { Object.assign(store, { capabilities: ['products.read', 'products.status', 'products.update', 'products.price'], missingCapabilities: [], currency: 'AED', domain: f.state.store.domain }); Object.assign(account, f.account, { profileId: 'product-state-profile', needsReconnection: false }); };
  try {
    await listen(); const setup = await request('/api/auth/setup', { body: { name: 'State QA', email: 'product-state@example.test', password: 'a long local product state password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', account.profileId, projectId);
    const product = addProduct(), body = await review(product), key = 'deactivate-success', before = writes().length;
    const result = await request(route(product) + '/' + stateAction, { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.readback, true); if (!deleting) assert.match(result.data.version, /^[a-f0-9]{64}$/);
    if (deleting) { assert.deepEqual(result.data.deletionAcceptance, { productId: product.id, platform: 'shopify', action: 'delete', absenceVerified: true, checkedAt: result.data.deletionAcceptance.checkedAt }); assert.equal(new Date(result.data.deletionAcceptance.checkedAt).toISOString(), result.data.deletionAcceptance.checkedAt); assert.equal(Object.hasOwn(result.data, 'product'), false); }
    else { assert.equal(result.data.product.status, targetState); assert.equal(result.data.product.platformStatus, targetState.toUpperCase()); assert.equal(result.data.product.url, product.url); assert.equal(result.data.product.publishedAt, product.publishedAt); }
    assert.deepEqual(writes().at(-1).payload, { accountId: account._id, productIds: [product.id], action: stateAction }); assert.equal(writes().length, before + 1); assert.equal(JSON.stringify(result).includes('never-expose'), false);
    assert.deepEqual((await request(route(product) + '/' + stateAction, { body, key })).data, result.data); assert.equal(writes().length, before + 1);
    assert.equal((await request(route(product) + '/' + stateAction, { body: { ...body, version: '0'.repeat(64) }, key })).data.error.code, 'IDEMPOTENCY_CONFLICT');
    if (stateAction === 'archive') {
      const draft = addProduct(); Object.assign(draft, { status: 'draft', platformStatus: 'DRAFT' }); const draftBody = await review(draft), beforeDraft = writes().length;
      const archived = await request(route(draft) + '/archive', { body: draftBody }); assert.equal(archived.status, 200, JSON.stringify(archived)); assert.equal(archived.data.product.status, 'archived'); assert.equal(archived.data.product.platformStatus, 'ARCHIVED'); assert.equal(writes().length, beforeDraft + 1);
      assert.deepEqual(writes().at(-1).payload, { accountId: account._id, productIds: [draft.id], action: 'archive' });
      for (const startingState of ['active', 'draft']) {
        const changed = addProduct(); Object.assign(changed, { status: startingState, platformStatus: startingState.toUpperCase() });
        const changedBody = await review(changed), beforeChange = writes().length; let reads = 0;
        providerHook = (call, reply) => { if (call.url.pathname === '/api/v1/commerce/products/' + changed.id && ++reads === 2) { const status = startingState === 'active' ? 'draft' : 'active'; Object.assign(reply.product, { status, platformStatus: status.toUpperCase() }); } };
        const blocked = await request(route(changed) + '/archive', { body: changedBody }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'PRODUCT_STATE_CHANGED'); assert.equal(writes().length, beforeChange); providerHook = undefined;
      }
    }
    const bound = addProduct(); Object.assign(bound, { status: 'active', platformStatus: 'ACTIVE' }); const detail = (await request(route(bound))).data, beforeTamper = writes().length;
    assert.notEqual(detail.archiveVersion, detail.version);
    assert.equal((await request(route(bound) + '/archive', { body: { version: detail.version, confirmArchive: true } })).data.error.code, 'PRODUCT_CHANGED');
    assert.equal((await request(route(bound) + '/deactivate', { body: { version: detail.archiveVersion, confirmDeactivate: true } })).data.error.code, 'PRODUCT_CHANGED');
    assert.equal((await request(route(bound) + '/' + stateAction, { body: { version: detail.archiveVersion, confirmDeactivate: true, confirmArchive: true } })).status, 400); assert.equal(writes().length, beforeTamper);
    if (stateAction === 'activate') {
      const draft = addProduct(), detail = (await request(route(draft))).data, before = writes().length;
      assert.notEqual(detail.activateVersion, detail.version); assert.notEqual(detail.activateVersion, detail.archiveVersion);
      for (const version of [detail.version, detail.archiveVersion]) assert.equal((await request(route(draft) + '/activate', { body: { version, confirmActivate: true } })).data.error.code, 'PRODUCT_CHANGED');
      assert.equal((await request(route(draft) + '/activate', { body: { version: detail.activateVersion, confirmArchive: true } })).status, 400); assert.equal(writes().length, before);
      for (const status of ['active', 'archived', 'deleted', 'inactive', 'pending_review', 'rejected', 'unknown']) {
        const product = addProduct(), body = await review(product); Object.assign(product, { status, platformStatus: status.toUpperCase() });
        const blocked = await request(route(product) + '/activate', { body }); assert.equal(blocked.data.error.code, 'PRODUCT_STATE_CHANGED', status); assert.equal(writes().length, before);
      }
      const changed = addProduct(), changedBody = await review(changed); let reads = 0;
      providerHook = (call, reply) => { if (call.url.pathname === '/api/v1/commerce/products/' + changed.id && ++reads === 2) Object.assign(reply.product, { status: 'active', platformStatus: 'ACTIVE' }); };
      assert.equal((await request(route(changed) + '/activate', { body: changedBody })).data.error.code, 'PRODUCT_STATE_CHANGED'); assert.equal(writes().length, before); providerHook = undefined;
      const revoked = addProduct(), revokedBody = await review(revoked), revokedKey = 'activation-postwrite-access';
      providerHook = async call => { if (call.url.pathname === '/api/v1/commerce/products/state') await app.sql.run("UPDATE memberships SET role='viewer'"); };
      const revokedResult = await request(route(revoked) + '/activate', { body: revokedBody, key: revokedKey }); assert.ok([403, 409].includes(revokedResult.status)); providerHook = undefined; await app.sql.run("UPDATE memberships SET role='owner'");
      assert.equal((await app.sql.get('SELECT status FROM integration_operations WHERE project_id=? AND request_key=?', projectId, revokedKey)).status, 'uncertain'); assert.equal(writes().length, before + 1);
      assert.equal((await request(route(revoked) + '/activate', { body: revokedBody, key: revokedKey })).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes().length, before + 1);
    }
    if (deleting) {
      const archived = addProduct(), detail = (await request(route(archived))).data, before = writes().length;
      for (const version of [detail.version, detail.archiveVersion, detail.activateVersion]) assert.equal((await request(route(archived) + '/delete', { body: { version, confirmDelete: true } })).data.error.code, 'PRODUCT_CHANGED');
      const body = await review(archived); let reads = 0;
      providerHook = (call, reply) => { if (call.url.pathname === '/api/v1/commerce/products/' + archived.id && ++reads === 2) Object.assign(reply.product, { status: 'draft', platformStatus: 'DRAFT' }); };
      assert.equal((await request(route(archived) + '/delete', { body })).data.error.code, 'PRODUCT_STATE_CHANGED'); providerHook = undefined; assert.equal(writes().length, before);
    }
    const invalidProduct = addProduct(), valid = await review(invalidProduct), count = writes().length;
    for (const fields of [{ action: 'activate' }, { action: 'delete' }, { productIds: [invalidProduct.id] }, { accountId: 'foreign' }, { status: 'draft' }, { [confirmation]: false }, { version: 'bad' }, { version: valid.version + '\n' }]) assert.equal((await request(route(invalidProduct) + '/' + stateAction, { body: { ...valid, ...fields } })).status, 400, JSON.stringify(fields));
    for (const field of ['version', confirmation]) { const body = { ...valid }; delete body[field]; assert.equal((await request(route(invalidProduct) + '/' + stateAction, { body })).status, 400); }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(route(invalidProduct) + '/' + stateAction, { method })).status, 405);
    assert.equal((await request(route(invalidProduct) + '/' + stateAction + '?accountId=foreign', { body: valid })).status, 400); assert.equal((await request(route(invalidProduct) + '/' + stateAction, { body: valid, session: null })).status, 401);
    await app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await request(route(invalidProduct) + '/' + stateAction, { body: valid })).status, 403); await app.sql.run("UPDATE memberships SET role='owner'"); assert.equal(writes().length, count);
    for (const scenario of ['missing-status', 'ungranted-status', 'missing-read', 'native-missing', 'native-blank', 'native-untrimmed', 'inactive', 'reconnect', 'draft', 'active', 'archived', 'deleted', 'inactive-product', 'conflicting-active', 'conflicting-draft', 'stale', 'second-read-state', 'second-read-version', 'final-grants', 'final-domain', 'final-account', 'final-role', 'final-mapping', 'final-credentials', 'final-session'].filter(scenario => (scenario !== 'draft' || stateAction === 'deactivate' || deleting) && (scenario !== 'active' || stateAction === 'activate' || deleting) && (scenario !== 'archived' || !deleting))) {
      grants(); const product = addProduct();
      if (scenario === 'missing-status') store.capabilities = ['products.read'];
      if (scenario === 'ungranted-status') { store.capabilities = ['products.read']; store.missingCapabilities = ['products.status']; }
      if (scenario === 'native-missing') delete account.platformUserId;
      if (scenario === 'native-blank') account.platformUserId = ' ';
      if (scenario === 'native-untrimmed') account.platformUserId = ' native-store ';
      if (['draft', 'active', 'archived', 'deleted', 'inactive-product'].includes(scenario)) { product.status = scenario === 'inactive-product' ? 'inactive' : scenario; product.platformStatus = product.status.toUpperCase(); }
      if (scenario === 'conflicting-active') Object.assign(product, { status: 'active', platformStatus: 'DRAFT' });
      if (scenario === 'conflicting-draft') Object.assign(product, { status: 'draft', platformStatus: 'ACTIVE' });
      const body = await review(product), before = writes().length; let productReads = 0, storeReads = 0, finalAccounts = 0;
      if (scenario === 'stale') product.title = 'Changed externally';
      if (scenario === 'missing-read') store.capabilities = ['products.status'];
      if (scenario === 'inactive') account.isActive = false;
      if (scenario === 'reconnect') account.needsReconnection = true;
      providerHook = async (call, reply) => {
        if (call.method !== 'GET') return;
        if (call.url.pathname === '/api/v1/commerce/store') storeReads++;
        if (call.url.pathname === '/api/v1/commerce/products/' + product.id && ++productReads === 2) {
          if (scenario === 'second-read-state') reply.product.platformStatus = deleting ? 'DRAFT' : stateAction === 'activate' ? 'ACTIVE' : 'DRAFT';
          if (scenario === 'second-read-version') reply.product.title = 'Changed on final product read';
        }
        if (storeReads === 4 && call.url.pathname === '/api/v1/commerce/store') {
          if (scenario === 'final-grants') { reply.store.capabilities = ['products.read']; reply.store.missingCapabilities = ['products.status']; }
          if (scenario === 'final-domain') reply.store.domain = 'changed.myshopify.com';
        }
        if (productReads === 2 && call.url.pathname === '/api/v1/accounts' && ++finalAccounts === 2) {
          if (scenario === 'final-account') reply.accounts[0].platformUserId = 'changed-native-store';
          if (scenario === 'final-role') await app.sql.run("UPDATE memberships SET role='viewer'");
          if (scenario === 'final-mapping') await app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id=?", projectId);
          if (scenario === 'final-credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-state-key' } } })).status, 200);
          if (scenario === 'final-session') await app.sql.run('DELETE FROM sessions');
        }
      };
      const result = await request(route(product) + '/' + stateAction, { body }); assert.ok([403, 409].includes(result.status), scenario + JSON.stringify(result)); assert.equal(writes().length, before, scenario); providerHook = undefined;
      await app.sql.run("UPDATE memberships SET role='owner'"); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'product-state-profile', projectId);
      if (scenario === 'final-credentials') assert.equal((await request('/api/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'product-state-fixture-key' } } })).status, 200);
      if (scenario === 'final-session') { const login = await request('/api/auth/login', { body: { email: 'product-state@example.test', password: 'a long local product state password' } }); assert.equal(login.status, 200); cookie = login.cookie; }
    }
    let unknownProduct, unknownBody, unknownKey;
    for (const scenario of ['missing-receipt', 'wrong-action', 'missing-succeeded', 'wrong-id', 'extra-id', 'duplicate-id', 'failed-id', 'missing-failed', 'foreign-receipt', 'readback-active', 'readback-conflict', 'readback-missing', 'readback-foreign', 'readback-404', 'postwrite-grants', 'postwrite-store', 'lost-ack', ...(deleting ? ['absence-account', 'absence-generic', 'absence-malformed', 'absence-permission', 'absence-failure', 'absence-still-present', 'absence-post-grants', 'absence-post-account', 'absence-post-mapping'] : [])].filter(scenario => !deleting || !['readback-active', 'readback-conflict', 'readback-missing', 'readback-foreign'].includes(scenario))) {
      grants(); const product = addProduct(), body = await review(product), before = writes().length, key = 'state-uncertain-' + scenario; let written = false;
      providerHook = async (call, reply) => {
        if (call.url.pathname === '/api/v1/commerce/products/state') {
          written = true;
          if (scenario === 'missing-receipt') return Response.json({});
          if (scenario === 'wrong-action') reply.action = stateAction === 'activate' ? 'archive' : 'activate';
          if (scenario === 'missing-succeeded') delete reply.succeeded;
          if (scenario === 'wrong-id') reply.succeeded = ['other'];
          if (scenario === 'extra-id') reply.succeeded.push('other');
          if (scenario === 'duplicate-id') reply.succeeded.push(product.id);
          if (scenario === 'failed-id') reply.failed = [{ productId: product.id, message: 'Unconfirmed' }];
          if (scenario === 'missing-failed') delete reply.failed;
          if (scenario === 'foreign-receipt') reply.accountId = 'foreign';
          if (scenario === 'postwrite-grants') store.capabilities = ['products.read'];
          if (scenario === 'postwrite-store') store.domain = 'changed-after-write.myshopify.com';
          if (scenario === 'lost-ack') throw new Error('Lost state acknowledgement');
        }
        if (written && call.url.pathname === '/api/v1/commerce/products/' + product.id) {
          if (scenario === 'absence-account') return Response.json({ error: 'Account not found', type: 'not_found', code: 'account_not_found' }, { status: 404 });
          if (scenario === 'absence-generic') return Response.json({ error: 'product_not_found' }, { status: 404 });
          if (scenario === 'absence-malformed') return Response.json({ error: 'Missing', code: { code: 'product_not_found' } }, { status: 404 });
          if (scenario === 'absence-permission') return Response.json({ error: 'Forbidden', code: 'product_not_found' }, { status: 403 });
          if (scenario === 'absence-failure') throw new Error('Absence read failed');
          if (scenario === 'absence-still-present') return Response.json({ product: { ...structuredClone(product), accountId: account._id } });
          if (scenario === 'absence-post-grants') store.capabilities = ['products.read'];
          if (scenario === 'absence-post-account') account.platformUserId = 'changed-after-absence';
          if (scenario === 'absence-post-mapping') await app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id=?", projectId);
          if (scenario === 'readback-active') Object.assign(reply.product, { status: startingState, platformStatus: startingState.toUpperCase() });
          if (scenario === 'readback-conflict') reply.product.platformStatus = startingState.toUpperCase();
          if (scenario === 'readback-missing') delete reply.product.status;
          if (scenario === 'readback-foreign') reply.product.accountId = 'foreign';
          if (scenario === 'readback-404') return Response.json({ error: 'not found' }, { status: 404 });
        }
      };
      const result = await request(route(product) + '/' + stateAction, { body, key }); if (scenario === 'absence-post-mapping') assert.ok([403, 409].includes(result.status), JSON.stringify(result)); else assert.equal(result.data.operation?.status, 'uncertain', scenario + JSON.stringify(result)); assert.equal(writes().length, before + 1); providerHook = undefined; grants(); absent.delete(product.id); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'product-state-profile', projectId);
      assert.equal((await app.sql.get('SELECT status FROM integration_operations WHERE project_id=? AND request_key=?', projectId, key)).status, 'uncertain');
      assert.equal((await request(route(product) + '/' + stateAction, { body, key })).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes().length, before + 1);
      const alias = { ...account, _id: 'state-alias-' + scenario }; accounts.push(alias);
      for (const kind of ['update', 'price']) assert.equal((await request(route(product, alias._id) + '/' + kind, { body: await review(product, kind, alias._id) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED');
      assert.equal(writes().length, before + 1); unknownProduct = product; unknownBody = body; unknownKey = key;
    }
    for (const [waitingKind, otherKind] of [[stateAction, 'update'], [stateAction, 'price'], ['update', stateAction], ['price', stateAction]]) {
      grants(); const product = addProduct(), alias = { ...account, _id: 'state-race-alias-' + product.id }; accounts.push(alias);
      const body = await review(product, waitingKind), aliasBody = await review(product, otherKind, alias._id); let productReads = 0, finalAccounts = 0, entered, release, heldOnce = false;
      const held = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
      providerHook = async call => { if (call.method === 'GET' && call.url.pathname === '/api/v1/commerce/products/' + product.id && call.url.searchParams.get('accountId') === account._id) productReads++; if (!heldOnce && productReads === 2 && call.url.pathname === '/api/v1/accounts' && ++finalAccounts === 2) { heldOnce = true; entered(); await resume; } if (call.method !== 'GET') throw new Error('Cross-action lost acknowledgement'); };
      const before = writes().length, waiting = request(route(product) + '/' + waitingKind, { body }); await held;
      const blocked = await request(route(product) + '/' + otherKind, { body: await review(product, otherKind) }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(writes().length, before);
      const unknown = await request(route(product, alias._id) + '/' + otherKind, { body: aliasBody }); assert.equal(unknown.data.operation.status, 'uncertain'); release(); assert.equal((await waiting).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, before + 1); providerHook = undefined;
    }
    const originalProject = projectId, workspaceId = (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id;
    await app.sql.run('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)', 'state-alias-project', workspaceId, 'Same native product', 'state-alias-profile'); const other = { ...account, _id: 'state-project-alias', profileId: 'state-alias-profile' }; accounts.push(other); projectId = 'state-alias-project';
    Object.assign(unknownProduct, { status: startingState, platformStatus: startingState.toUpperCase() });
    for (const kind of [stateAction, 'price', 'update']) assert.equal((await request(route(unknownProduct, other._id) + '/' + kind, { body: await review(unknownProduct, kind, other._id) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); projectId = originalProject;
    app = await reopen(app, appOptions); await listen(); const beforeRestart = writes().length;
    assert.equal((await request(route(unknownProduct) + '/' + stateAction, { body: unknownBody, key: unknownKey })).data.error.code, 'OPERATION_UNCERTAIN');
    const padded = { ...unknownProduct, id: '000' + unknownProduct.id }; assert.equal((await request(route(padded) + '/' + stateAction, { body: await review(padded) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(writes().length, beforeRestart);
    const orphan = addProduct(); await app.sql.run('INSERT INTO zernio_product_updates (resource, project_id, request_key) VALUES (?, ?, ?)', JSON.stringify(['shopify', account.platformUserId, orphan.id]), 'missing-project', 'missing-request'); assert.equal((await request(route(orphan) + '/' + stateAction, { body: await review(orphan) })).data.error.code, 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED');
    await app.sql.run("UPDATE integration_operations SET status='reviewed-not-applied' WHERE project_id=? AND request_key=?", projectId, unknownKey);
    assert.equal((await request(route(unknownProduct) + '/' + stateAction, { body: unknownBody, key: unknownKey })).data.error.code, 'OPERATION_REVIEWED'); assert.equal(writes().length, beforeRestart);
    assert.equal((await request(route(unknownProduct) + '/' + stateAction, { body: await review(unknownProduct) })).status, 200); assert.equal(writes().length, beforeRestart + 1);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

function stockFixture() {
  const f = fixture(); f.state.store.capabilities.push('inventory.read');
  Object.assign(f.state, { locations: [{ id: 'location-1', name: 'Warehouse', isActive: false, fulfillsOnlineOrders: false, address: { line1: '<img src=x onerror=alert(1)>', city: 'Dubai', countryCode: 'AE', private: 'never-expose' } }], inventory: [{ productId: '123', variantId: 'variant-1', sku: null, tracked: true, levels: [{ locationId: 'location-1', available: 0, onHand: -2, committed: 3, incoming: null, private: 'never-expose' }] }], stockHook: null });
  f.state.onCall = async call => {
    const override = await f.state.stockHook?.(call); if (override !== undefined) return override;
    if (call.path === '/commerce/locations') { assert.deepEqual(call.query, { accountId: f.accountId }); return { locations: f.state.locations }; }
    if (call.path === '/commerce/inventory') { assert.deepEqual(call.query, { accountId: f.accountId, productId: '123' }); return { inventory: f.state.inventory }; }
  };
  return f;
}

test('stock read preserves unknown, zero and negative values with exact read-only requests and unknown coverage', async () => {
  const f = stockFixture(); f.state.locations.push({ id: 'location-unknown' }, { id: 'location-empty-address', address: {} });
  f.state.inventory.push({ productId: '123', variantId: 'outside-first-100', sku: 'external-sku', tracked: false, levels: [] }, { productId: '123', variantId: 'missing-levels' }, { productId: '123', variantId: 'null-levels', tracked: null, levels: null }, { productId: '123', variantId: 'unmatched-location', levels: [{ locationId: 'not-in-locations', available: 0 }] });
  const result = await f.request(`${f.accountId}/123/inventory`); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.accountId, f.accountId); assert.equal(result.data.product.id, '123'); assert.equal(result.data.store.accountId, f.accountId);
  assert.deepEqual(result.data.inventory[0], { productId: '123', variantId: 'variant-1', sku: null, tracked: true, levels: [{ locationId: 'location-1', available: 0, onHand: -2, committed: 3, incoming: null }] });
  assert.deepEqual(result.data.inventory[1], { productId: '123', variantId: 'outside-first-100', sku: 'external-sku', tracked: false, levels: [] });
  for (const index of [2, 3]) assert.deepEqual(result.data.inventory[index], { productId: '123', variantId: index === 2 ? 'missing-levels' : 'null-levels', sku: null, tracked: null, levels: null });
  assert.deepEqual(result.data.inventory[4], { productId: '123', variantId: 'unmatched-location', sku: null, tracked: null, levels: [{ locationId: 'not-in-locations', available: 0, onHand: null, committed: null, incoming: null }] });
  assert.deepEqual(result.data.locations[1], { id: 'location-unknown', name: null, isActive: null, fulfillsOnlineOrders: null, address: null }); assert.deepEqual(result.data.locations[2].address, { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null, phone: null });
  assert.equal(result.data.locations[0].isActive, false); assert.equal(result.data.locations[0].fulfillsOnlineOrders, false); assert.equal(result.data.locations[0].address.line1, '<img src=x onerror=alert(1)>'); assert.equal(result.data.locations[0].address.phone, null);
  assert.deepEqual(result.data.coverage, { imagesLimit: 20, variantsLimit: 100, inventoryComplete: null, locationsComplete: null, localLocationsLimit: 1000, localInventoryItemsLimit: 10000, localInventoryLevelsLimit: 10000 });
  assert.deepEqual(f.calls.filter(call => ['/commerce/locations', '/commerce/inventory'].includes(call.path)).map(({ path, query }) => ({ path, query })), [{ path: '/commerce/locations', query: { accountId: f.accountId } }, { path: '/commerce/inventory', query: { accountId: f.accountId, productId: '123' } }]);
  assert.equal(f.calls.every(call => call.method === 'GET' && call.body === undefined && call.key === undefined), true); assert.equal(JSON.stringify(result).includes('never-expose'), false); assert.equal(Object.hasOwn(result.data, 'operation'), false); assert.equal(Object.hasOwn(result.data, 'version'), false);
  f.state.locations = []; f.state.inventory = []; const empty = await f.request(`${f.accountId}/123/inventory`); assert.equal(empty.status, 200); assert.deepEqual(empty.data.locations, []); assert.deepEqual(empty.data.inventory, []); assert.equal(empty.data.coverage.inventoryComplete, null);
});

test('stock read requires current product and inventory grants and rejects filters, request bodies and write methods', async () => {
  for (const scenario of ['missing-inventory', 'ungranted-inventory', 'missing-products', 'inactive', 'reconnect', 'foreign-account']) {
    const f = stockFixture();
    if (scenario === 'missing-inventory' || scenario === 'ungranted-inventory') f.state.store.capabilities = ['products.read'];
    if (scenario === 'ungranted-inventory') f.state.store.missingCapabilities = ['inventory.read'];
    if (scenario === 'missing-products') f.state.store.capabilities = ['inventory.read'];
    if (scenario === 'inactive') f.account.isActive = false;
    if (scenario === 'reconnect') f.account.needsReconnection = true;
    const result = await f.request(`${scenario === 'foreign-account' ? 'foreign' : f.accountId}/123/inventory`); assert.ok([403, 409].includes(result.status), scenario); if (scenario.endsWith('inventory')) assert.equal(result.data.error.code, 'INVENTORY_READ_PERMISSION_REQUIRED'); assert.equal(f.calls.some(call => ['/commerce/locations', '/commerce/inventory'].includes(call.path)), false);
  }
  const f = stockFixture(), route = `${f.accountId}/123/inventory`;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await f.request(route, { method })).status, 405);
  for (const filter of ['cursor=a', 'limit=1', 'productId=other', 'locationId=location-1', 'variantId=variant-1', 'accountId=foreign']) assert.equal((await f.request(route + '?' + filter)).status, 400);
  for (const [body, headers] of [[null, {}], [[], {}], ['bad', {}], [{ quantity: 1 }, {}], [{}, { 'content-length': '1' }], [{}, { 'transfer-encoding': 'chunked' }]]) {
    await assert.rejects(handleZernioProducts({ req: { method: 'GET', headers }, url: new URL('https://campaign.example.test/' + route), role: 'viewer', body }, () => assert.fail('Invalid reads must not contact the provider'), 'profile-a', route), error => error instanceof IntegrationError && error.status === 400 && error.code === 'INVALID_INVENTORY_QUERY');
  }
  assert.equal(f.calls.length, 0);
});

test('stock read fails closed on malformed identities, arrays, duplicate rows, unsafe counts and local bounds', async () => {
  const cases = [
    f => { f.state.locations = undefined; }, f => { f.state.locations = null; }, f => { f.state.locations = {}; }, f => { f.state.inventory = undefined; }, f => { f.state.inventory = null; }, f => { f.state.inventory = {}; },
    f => { f.state.locations[0].id = ''; }, f => { f.state.locations[0].id = 'bad/id'; }, f => { f.state.locations[0].name = {}; }, f => { f.state.locations[0].isActive = 'false'; }, f => { f.state.locations[0].fulfillsOnlineOrders = 0; }, f => { f.state.locations[0].address = []; }, f => { f.state.locations[0].address.phone = 123; },
    f => { f.state.inventory[0].productId = 'other'; }, f => { delete f.state.inventory[0].productId; }, f => { f.state.inventory[0].variantId = 'bad\nid'; }, f => { delete f.state.inventory[0].variantId; }, f => { f.state.inventory[0].sku = {}; }, f => { f.state.inventory[0].tracked = 'true'; }, f => { f.state.inventory[0].levels = {}; },
    f => { f.state.inventory[0].levels[0].locationId = ''; }, f => { f.state.inventory[0].levels[0].available = '0'; }, f => { f.state.inventory[0].levels[0].onHand = 1.5; }, f => { f.state.inventory[0].levels[0].committed = Number.MAX_SAFE_INTEGER + 1; }, f => { f.state.inventory[0].levels[0].incoming = NaN; },
    f => { f.state.locations.push(f.state.locations[0]); }, f => { f.state.inventory.push(f.state.inventory[0]); }, f => { f.state.inventory[0].levels.push(f.state.inventory[0].levels[0]); },
    f => { f.state.locations = Array(1001).fill({}); }, f => { f.state.inventory = Array(10001).fill({}); }, f => { f.state.inventory[0].levels = Array(10001).fill({}); },
    f => { f.state.inventory = [0, 1].map(index => ({ productId: '123', variantId: 'many-levels-' + index, levels: Array.from({ length: 5001 }, (_, id) => ({ locationId: 'location-' + id })) })); },
  ];
  for (const change of cases) { const f = stockFixture(); change(f); const result = await f.request(`${f.accountId}/123/inventory`); assert.equal(result.status, 502, change.toString()); assert.equal(Object.hasOwn(result.data, 'inventory'), false); assert.equal(f.calls.every(call => call.method === 'GET'), true); }
  for (const stage of ['/commerce/locations', '/commerce/inventory']) for (const foreign of [{ accountId: 'foreign' }, { profileId: 'foreign-profile' }, { platform: 'woocommerce' }]) {
    const f = stockFixture(); f.state.stockHook = call => call.path === stage ? { ...foreign, ...(stage.endsWith('locations') ? { locations: f.state.locations } : { inventory: f.state.inventory }) } : undefined;
    assert.equal((await f.request(`${f.accountId}/123/inventory`)).status, 502);
  }
  for (const target of ['location', 'address', 'inventory', 'level']) {
    const f = stockFixture(), row = target === 'location' ? f.state.locations[0] : target === 'address' ? f.state.locations[0].address : target === 'inventory' ? f.state.inventory[0] : f.state.inventory[0].levels[0]; row.accountId = 'foreign';
    assert.equal((await f.request(`${f.accountId}/123/inventory`)).status, 502, target);
  }
});

test('stock read rechecks account, access, store identity and both grants across each inventory await', async () => {
  for (const stage of ['/commerce/locations', '/commerce/inventory']) for (const scenario of ['access', 'mapping', 'credentials', 'profile', 'native-store', 'alias', 'inactive', 'reconnect', 'inventory-grant', 'product-grant', 'currency', 'domain']) {
    const f = stockFixture(); f.state.stockHook = call => {
      if (call.path !== stage) return;
      if (scenario === 'access') f.state.accessLost = true;
      if (scenario === 'mapping') f.state.mappingChanged = true;
      if (scenario === 'credentials') f.state.settingsChanged = true;
      if (scenario === 'profile') f.account.profileId = 'foreign-profile';
      if (scenario === 'native-store') f.account.platformUserId = 'changed-store';
      if (scenario === 'alias') f.account.username = 'different.myshopify.com';
      if (scenario === 'inactive') f.account.isActive = false;
      if (scenario === 'reconnect') f.account.needsReconnection = true;
      if (scenario === 'inventory-grant') { f.state.store.capabilities = ['products.read']; f.state.store.missingCapabilities = ['inventory.read']; }
      if (scenario === 'product-grant') f.state.store.capabilities = ['inventory.read'];
      if (scenario === 'currency') f.state.store.currency = 'USD';
      if (scenario === 'domain') f.state.store.domain = 'different.myshopify.com';
    };
    const result = await f.request(`${f.accountId}/123/inventory`); assert.ok([403, 409].includes(result.status), stage + ':' + scenario + JSON.stringify(result)); assert.equal(Object.hasOwn(result.data, 'inventory'), false); assert.equal(f.calls.every(call => call.method === 'GET'), true);
    if (stage.endsWith('locations')) assert.equal(f.calls.some(call => call.path === '/commerce/inventory'), false, scenario);
  }
});

test('stock native permission and rate-limit failures stay sanitized through the app router', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  for (const stage of ['/commerce/locations', '/commerce/inventory']) for (const status of [403, 429]) {
    const f = stockFixture(), calls = [];
    globalThis.fetch = async (target, options = {}) => {
      const url = new URL(target), path = url.pathname.replace('/api/v1', ''); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.method || 'GET', 'GET'); assert.equal(options.body, undefined); calls.push(path);
      if (path === stage) return Response.json({ error: 'Private stock provider detail must not leak' }, { status });
      if (path === '/accounts') return Response.json({ accounts: f.state.accounts });
      if (path === '/commerce/store') return Response.json({ store: f.state.store });
      if (path === '/commerce/products/123') return Response.json({ product: f.state.product });
      if (path === '/commerce/locations') return Response.json({ locations: f.state.locations });
      assert.fail('Unexpected provider request: ' + path);
    };
    let response; await handleIntegration({ req: { method: 'GET' }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/products/${f.accountId}/123/inventory`), project: { id: 'project-a', zernioProfileId: 'profile-a' }, role: 'viewer', config: { env: { ZERNIO_API_KEY: 'synthetic-stock-key' } }, send(code, data) { response = { status: code, data }; } });
    assert.equal(response.status, status); assert.equal(response.data.error.code, status === 403 ? 'INVENTORY_READ_PERMISSION_REQUIRED' : 'PROVIDER_RATE_LIMIT'); assert.equal(JSON.stringify(response).includes('Private stock provider detail'), false); assert.ok(calls.includes(stage)); if (stage.endsWith('locations')) assert.equal(calls.includes('/commerce/inventory'), false);
  }
});


test('HTTP every product and collection mutation permits exact receipt-only checks without a first dispatch', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-product-check-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const app = await testApp(t, { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'receipt-check-local-key' } }); let base, cookie, projectId, providerCalls = 0;
  globalThis.fetch = async (target, options) => { if (new URL(target).hostname === '127.0.0.1') return originalFetch(target, options); providerCalls++; assert.fail('A receipt check must not contact the provider'); };
  async function request(path, body, key) { const response = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), 'Idempotency-Key': key }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await request('/api/auth/setup', { name: 'Receipt QA', email: 'receipt-check@example.test', password: 'a long local receipt check password' }, 'receipt-check-setup'); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'receipt-check-profile', projectId);
    const version = 'a'.repeat(64), rows = [
      ['shop/create', { version, confirmCreate: true, title: 'Draft', price: '1' }], ['shop/123/update', { version, confirmUpdate: true, title: 'New title' }], ['shop/123/price', { version, confirmPrice: true, variantId: 'variant-1', price: '1' }],
      ...['deactivate', 'archive', 'activate', 'delete'].map(action => ['shop/123/' + action, { version, ['confirm' + action[0].toUpperCase() + action.slice(1)]: true }]), ['shop/collections/123/rename', { version, title: 'New title' }],
    ];
    for (const [suffix, body] of rows) {
      const path = `/api/projects/${projectId}/integrations/products/${suffix}`, key = 'receipt-check-' + suffix.replaceAll('/', '-');
      assert.equal((await request(path + '?check=1', body, key)).data.error.code, 'OPERATION_OUTCOME_UNAVAILABLE', suffix); assert.equal(providerCalls, 0);
      const seeded = await operation({ db: app.db, project: { id: projectId }, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(origin + path), body }, async () => ({ retained: suffix }));
      const response = await request(path + '?check=1', body, key); assert.equal(response.status, 200, suffix + JSON.stringify(response)); assert.deepEqual(response.data, seeded.data);
      for (const status of ['uncertain', 'reviewed-not-applied']) { await app.sql.run('UPDATE integration_operations SET status=? WHERE project_id=? AND request_key=?', status, projectId, key); assert.equal((await request(path + '?check=1', body, key)).data.error.code, status === 'uncertain' ? 'OPERATION_UNCERTAIN' : 'OPERATION_REVIEWED', suffix); }
      assert.equal((await request(path + '?check=1', { ...body, version: 'b'.repeat(64) }, key)).data.error.code, 'IDEMPOTENCY_CONFLICT', suffix);
      for (const query of ['?check=0', '?check=1&check=1', '?check=1&query=x']) assert.equal((await request(path + query, body, key)).status, 400, suffix + query);
      assert.equal(providerCalls, 0);
    }
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});
