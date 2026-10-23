import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createApp } from '../server/index.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('native ad connection tests persist rotated tokens, survive restart and reject credentials changed in flight', { skip: postgresSkip }, async t => {
  const database = await testDatabase(t), { sql } = database;
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-native-settings-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  let env = {}, app = await createApp({ dataDir, env, appUrl: origin, database }), base, cookie, pause;
  const start = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; };
  const request = async (path, method = 'GET', body) => {
    const response = await originalFetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    if (url.pathname.endsWith('/token')) {
      const form = new URLSearchParams(options.body), refresh = form.get('refresh_token');
      assert.ok(refresh?.startsWith('private-'));
      if (pause) { const pending = pause; pause = null; pending.started(); await pending.wait; }
      return Response.json({ access_token: 'private-access-token', token_type: 'Bearer', scope: 'https://ads.microsoft.com/msads.manage', refresh_token: refresh + '-rotated' });
    }
    assert.equal(options.headers.Authorization, 'Bearer private-access-token');
    if (url.href === 'https://googleads.googleapis.com/v25/customers:listAccessibleCustomers') return Response.json({ resourceNames: ['customers/1234567890'] });
    if (url.href === 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/User/Query') return Response.json({ User: { Id: '123' } });
    throw new Error('Unexpected native settings provider request');
  };
  try {
    await start();
    const setup = await request('/api/auth/setup', 'POST', { name: 'Native operator', email: 'native-settings@example.test', password: 'native connection fixture password' }); setup.data.projectId = await firstProject(app, setup);
    assert.equal(setup.status, 201); cookie = setup.cookie;
    const projectId = (await request('/api/state')).data.projectId;
    for (const [provider, prefix] of [['googleAdsNative', 'GOOGLE_ADS'], ['microsoftAds', 'MICROSOFT_ADS']]) {
      const path = '/api/settings/integrations/' + provider;
      const fields = { clientId: 'fixture-client', clientSecret: 'private-client-secret', developerToken: 'private-developer-token', refreshToken: 'private-' + provider };
      assert.equal((await request(path, 'PUT', { fields })).status, 200);
      for (let i = 1; i <= 2; i++) {
        const checked = await request(path + '/test', 'POST', { projectId });
        assert.equal(checked.status, 200, JSON.stringify(checked.data)); assert.equal(checked.data.ok, true);
        assert.equal(env[prefix + '_REFRESH_TOKEN'], fields.refreshToken + '-rotated'.repeat(i));
        assert.equal(JSON.stringify(checked.data).includes('private-'), false);
      }
      let started, release;
      const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
      pause = { started, wait };
      const checking = request(path + '/test', 'POST', { projectId });
      try {
        await Promise.race([entered, new Promise((_, reject) => { setTimeout(() => reject(new Error('Expected native token refresh')), 3000).unref(); })]);
        assert.equal((await request(path, 'PUT', { fields: { refreshToken: 'private-reconnected-' + provider } })).status, 200);
      } finally { release(); }
      assert.equal((await checking).status, 409);
      assert.equal(env[prefix + '_REFRESH_TOKEN'], 'private-reconnected-' + provider, 'A stale refresh cannot overwrite a new authorization.');
    }
    const described = JSON.stringify((await request('/api/settings/integrations')).data);
    assert.equal(described.includes('private-'), false);
    for (const row of await sql.all('SELECT ciphertext FROM integration_settings')) assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from('private-')), false);
    await app.close(); env = {}; app = await createApp({ dataDir, env, appUrl: origin, database }); await start();
    for (const [provider, prefix] of [['googleAdsNative', 'GOOGLE_ADS'], ['microsoftAds', 'MICROSOFT_ADS']]) {
      assert.equal(env[prefix + '_REFRESH_TOKEN'], 'private-reconnected-' + provider);
      assert.equal((await request('/api/settings/integrations/' + provider + '/test', 'POST', { projectId })).status, 200);
    }
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('integration settings HTTP routes enforce operators, retain encrypted secrets, use approved project mappings and make only explicit connection tests', { skip: postgresSkip }, async t => {
  const database = await testDatabase(t), { sql } = database;
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-settings-http-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Campaign</title><script src="/app.js"></script>');
  const env = { ZERNIO_API_KEY: 'environment-zernio-fixture-key' }, origin = 'http://127.0.0.1:3000', app = await createApp({ dataDir, distDir, env, appUrl: origin, database });
  const originalFetch = globalThis.fetch, providerCalls = [];
  let ownerCookie, pausedRead;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    providerCalls.push({ url: url.href, method: options.method || 'GET', authorization: options.headers?.Authorization });
    if (pausedRead?.pathname === url.pathname) { const pause = pausedRead; pausedRead = null; pause.started(); await pause.wait; }
    let data;
    if (url.href === 'https://zernio.com/api/v1/profiles') data = { profiles: [{ _id: 'mapped-brand-profile' }] };
    else if (url.href === 'https://openrouter.ai/api/v1/key') data = { data: { label: 'Fixture key' } };
    else if (url.href === 'https://oauth2.googleapis.com/token') data = { access_token: 'google-connection-fixture-token' };
    else if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/files/approved-project-folder') data = { id: 'approved-project-folder', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } };
    else if (url.hostname === 'www.googleapis.com' && url.pathname === '/calendar/v3/calendars/approved-calendar%40example.test/events') data = { kind: 'calendar#events', items: [] };
    else throw new Error('Unexpected provider URL in integration settings HTTP test.');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`, route = '/api/settings/integrations';
  async function request(path, { method = 'GET', body, cookie = ownerCookie, originHeader = origin } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' && originHeader ? { Origin: originHeader } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const save = (provider, fields, extra = {}) => request(`${route}/${provider}`, { method: 'PUT', body: { fields }, ...extra });
  const find = (data, provider) => data.providers.find(item => item.id === provider);
  try {
    assert.equal((await request(route, { cookie: null })).status, 401);
    assert.equal((await save('zernio', { apiKey: 'anonymous-fixture-key' }, { cookie: null })).status, 401);
    const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Settings operator', email: 'settings-operator@example.test', password: 'fixture settings password 2026' } }); setup.data.projectId = await firstProject(app, setup);
    assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data, projectId = state.projectId, project = `/api/projects/${projectId}`, workspaceId = state.workspaces[0].id;
    const settings = await request(route); assert.equal(settings.status, 200); assert.equal(settings.data.providers.length, 11);
    assert.equal(find(settings.data, 'zernio').source, 'environment');
    assert.equal(JSON.stringify(settings.data).includes(env.ZERNIO_API_KEY), false);

    const passwordHash = (await sql.get('SELECT password FROM users WHERE id=?', state.user.id)).password, otherUserId = randomUUID();
    await sql.run('INSERT INTO users VALUES(?,?,?,?)', otherUserId, 'Workspace owner', 'settings-owner@example.test', passwordHash);
    const otherCookie = (await request('/api/auth/login', { method: 'POST', body: { email: 'settings-owner@example.test', password: 'fixture settings password 2026' } })).cookie;
    const otherWorkspace = await request('/api/workspaces', { method: 'POST', body: { name: 'Separate workspace' }, cookie: otherCookie });
    assert.equal(otherWorkspace.status, 201);
    await sql.run("INSERT INTO memberships VALUES(?,?,'owner')", workspaceId, otherUserId);
    for (const action of [request(route, { cookie: otherCookie }), save('zernio', { apiKey: 'unauthorized-fixture-key' }, { cookie: otherCookie }), request(`${route}/zernio`, { method: 'DELETE', cookie: otherCookie }), request(`${route}/zernio/test`, { method: 'POST', body: { projectId }, cookie: otherCookie })]) assert.equal((await action).status, 403, 'Workspace ownership does not grant installation credentials access.');
    assert.equal((await save('zernio', { apiKey: 'csrf-fixture-key' }, { originHeader: null })).status, 403);
    assert.equal((await save('zernio', { apiKey: 'csrf-fixture-key' }, { originHeader: 'https://other.example.test' })).status, 403);
    assert.equal((await request(`${route}/zernio`, { method: 'DELETE', originHeader: null })).status, 403);
    assert.equal((await request(`${route}/zernio/test`, { method: 'POST', body: { projectId }, originHeader: null })).status, 403);
    assert.equal((await save('zernio', { arbitraryHost: 'https://other.example.test' })).status, 400);
    assert.equal((await request(`${route}/zernio`, { method: 'PUT', body: { fields: { apiKey: 'fixture-valid-key' }, url: 'https://other.example.test' } })).status, 400);
    assert.equal((await save('unknownProvider', { apiKey: 'fixture-valid-key' })).status, 404);
    assert.equal((await save('openrouter', { maxSteps: 100 })).status, 400);
    assert.equal((await save('googleDrive', { privateKey: 'not-a-google-private-key' })).status, 400);

    const zernioSecret = 'saved-zernio-fixture-key', routerSecret = 'saved-openrouter-fixture-key', mapsKey = 'public-google-maps-fixture-key';
    let saved = await save('zernio', { apiKey: zernioSecret, webhookSecret: 'saved-webhook-fixture-secret' }); assert.equal(saved.status, 200);
    assert.equal(env.ZERNIO_API_KEY, zernioSecret); assert.equal(find(saved.data, 'zernio').secretFields.apiKey.configured, true);
    assert.equal((await request('/api/state')).data.connections.zernio, true);
    saved = await save('zernio', { apiKey: '' }); assert.equal(saved.status, 200); assert.equal(env.ZERNIO_API_KEY, zernioSecret, 'Blank secret fields retain the saved key.');
    assert.equal((await save('openrouter', { apiKey: routerSecret, model: 'fixture/tool-calling-model', maxTokens: '1024', maxSteps: '3' })).status, 200);
    assert.deepEqual((await request(project + '/agent/status')).data, { configured: true, model: 'fixture/tool-calling-model', maxSteps: 3 }); assert.equal(env.OPENROUTER_MAX_TOKENS, '1024');
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    saved = await save('googleDrive', { serviceAccountEmail: 'fixture@campaign.iam.gserviceaccount.com', privateKey }); assert.equal(saved.status, 200);
    assert.equal(find(saved.data, 'googleDrive').configured, true); assert.equal(find(saved.data, 'googleCalendar').configured, true, 'Drive and Calendar share the configured service account.');
    assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: 'mapped-brand-profile', driveFolderId: 'approved-project-folder' } })).status, 200);
    assert.equal((await request(project + '/calendar/status')).status, 200);
    assert.equal((await request(project + '/calendar/connection', { method: 'POST', body: { calendarId: 'approved-calendar@example.test' } })).status, 200);
    assert.equal((await save('googleMaps', { browserApiKey: mapsKey, mapId: 'fixture-map-id' })).status, 200);
    const maps = await request(project + '/maps/config'); assert.deepEqual(maps.data, { configured: true, browserKey: mapsKey, mapId: 'fixture-map-id' });
    const home = await fetch(base + '/'); assert.match(home.headers.get('content-security-policy'), /'unsafe-eval'/); await home.text();
    assert.equal(providerCalls.length, 0, 'Saving credentials, mappings, app state, and status never tests a provider implicitly.');
    const described = await request(route), serialized = JSON.stringify(described.data);
    for (const secret of [zernioSecret, routerSecret, mapsKey, privateKey, 'saved-webhook-fixture-secret']) assert.equal(serialized.includes(secret), false, 'Global settings metadata never returns raw credentials.');
    const encrypted = await sql.all('SELECT nonce,ciphertext,tag FROM integration_settings'); assert.equal(encrypted.length, 4);
    for (const row of encrypted) { assert.equal(row.nonce.length, 12); assert.equal(row.tag.length, 16); for (const secret of [zernioSecret, routerSecret, mapsKey, privateKey]) assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from(secret)), false); }
    // Scan every persisted row of every table, then every file the app keeps in its data directory.
    for (const { name: table } of await sql.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")) { const { dump } = await sql.get(`SELECT coalesce(string_agg(row_to_json(t)::text, ''), '') AS dump FROM "${table}" t`); for (const secret of [zernioSecret, routerSecret, mapsKey, privateKey]) assert.equal(dump.includes(JSON.stringify(secret).slice(1, -1)), false, `Persisted ${table} rows do not contain plaintext provider credentials.`); }
    for (const file of await readdir(dataDir, { recursive: true })) { const bytes = await readFile(join(dataDir, file)).catch(error => { if (error.code === 'EISDIR') return Buffer.alloc(0); throw error; }); for (const secret of [zernioSecret, routerSecret, mapsKey, privateKey]) assert.equal(bytes.includes(Buffer.from(secret)), false, 'Persisted data directory bytes do not contain plaintext provider credentials.'); }

    assert.equal((await request(`${route}/googleDrive/test`, { method: 'POST', body: { projectId, driveFolderId: 'arbitrary-client-folder' } })).status, 400);
    assert.equal((await request(`${route}/googleCalendar/test`, { method: 'POST', body: { projectId, calendarId: 'arbitrary-calendar@example.test' } })).status, 400);
    assert.equal((await request(`${route}/googleDrive/test`, { method: 'POST', body: { projectId: otherWorkspace.data.projectId } })).status, 404, 'Operators still need project membership to test a project mapping.');
    assert.equal(providerCalls.length, 0);
    const zernioTest = await request(`${route}/zernio/test`, { method: 'POST', body: { projectId } }); assert.equal(zernioTest.status, 200); assert.equal(zernioTest.data.status, 'connected');
    assert.equal(providerCalls.at(-1).authorization, `Bearer ${zernioSecret}`);
    const routerTest = await request(`${route}/openrouter/test`, { method: 'POST', body: { projectId } }); assert.equal(routerTest.status, 200); assert.match(routerTest.data.message, /No model request/);
    const driveTest = await request(`${route}/googleDrive/test`, { method: 'POST', body: { projectId } }); assert.equal(driveTest.status, 200); assert.equal(driveTest.data.status, 'connected');
    const calendarTest = await request(`${route}/googleCalendar/test`, { method: 'POST', body: { projectId } }); assert.equal(calendarTest.status, 200); assert.equal(calendarTest.data.status, 'connected');
    assert.ok(providerCalls.some(call => call.url.includes('/drive/v3/files/approved-project-folder?')));
    assert.ok(providerCalls.some(call => call.url.includes('/calendars/approved-calendar%40example.test/events?')));
    assert.equal(providerCalls.some(call => call.url.includes('arbitrary-client-folder') || call.url.includes('arbitrary-calendar')), false);
    assert.ok(providerCalls.every(call => call.method === 'GET' || call.url === 'https://oauth2.googleapis.com/token'), 'Tests read provider metadata or request an authentication token; no external resources are written.');
    for (const [provider, pathname, change, restore] of [
      ['googleDrive', '/drive/v3/files/approved-project-folder', () => request(project, { method: 'PATCH', body: { driveFolderId: 'changed-project-folder' } }), () => request(project, { method: 'PATCH', body: { driveFolderId: 'approved-project-folder' } })],
      ['googleCalendar', '/calendar/v3/calendars/approved-calendar%40example.test/events', () => request(project + '/calendar/connection', { method: 'POST', body: { calendarId: 'changed-calendar@example.test' } }), () => request(project + '/calendar/connection', { method: 'POST', body: { calendarId: 'approved-calendar@example.test' } })],
    ]) {
      let started, release; const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
      pausedRead = { pathname, started, wait };
      const checking = request(`${route}/${provider}/test`, { method: 'POST', body: { projectId } });
      try {
        await Promise.race([entered, new Promise((_, reject) => { setTimeout(() => reject(new Error('The expected provider read was not reached.')), 3000).unref(); })]);
        assert.equal((await change()).status, 200);
      } finally { release(); }
      assert.equal((await checking).status, 409, 'Changing a project mapping during its connection test invalidates the verification.');
      assert.equal((await restore()).status, 200);
    }
    const beforeMaps = providerCalls.length, mapsTest = await request(`${route}/googleMaps/test`, { method: 'POST', body: { projectId } });
    assert.equal(mapsTest.status, 200); assert.equal(mapsTest.data.ok, false); assert.equal(mapsTest.data.status, 'browser_verification_required'); assert.equal(providerCalls.length, beforeMaps);
    assert.equal((await save('zernio', { apiKey: null })).status, 200); assert.equal(env.ZERNIO_API_KEY, ''); assert.equal((await request('/api/state')).data.connections.zernio, false, 'Explicit clearing disables environment fallback.');
    const reset = await request(`${route}/zernio`, { method: 'DELETE' }); assert.equal(reset.status, 200); assert.equal(env.ZERNIO_API_KEY, 'environment-zernio-fixture-key'); assert.equal(find(reset.data, 'zernio').source, 'environment');
    assert.equal((await save('googleCalendar', { privateKey: null })).status, 200);
    const shared = (await request(route)).data; assert.equal(find(shared, 'googleDrive').configured, false); assert.equal(find(shared, 'googleCalendar').configured, false);
    assert.equal((await save('googleMaps', { browserApiKey: null })).status, 200);
    const disabledMaps = await fetch(base + '/'); assert.equal(disabledMaps.headers.get('content-security-policy').includes("'unsafe-eval'"), false); await disabledMaps.text();
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
