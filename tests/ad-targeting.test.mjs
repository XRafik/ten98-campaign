import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('Meta interest HTTP reads project safe results only while account access stays current', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-ad-targeting-')), origin = 'http://127.0.0.1:3018';
  const apiKey = 'synthetic-targeting-key', profileId = 'targeting-profile', accountId = 'meta-connection', adAccountId = 'native-account';
  const app = await testApp(t, { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: apiKey }, directScheduler: false });
  const originalFetch = globalThis.fetch, calls = [], password = 'a long targeting fixture password';
  const connected = () => ({ _id: accountId, profileId, platform: 'metaads', username: 'fixture-brand', isActive: true });
  const advertiser = () => ({ id: adAccountId, selectable: true });
  const interest = () => ({ id: '6001', name: 'Design', type: 'interest' });
  let accounts = [connected()], advertisers = [advertiser()], stale = false, reply = { results: [interest()] }, pause, cookie, base, project, state;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    const method = options.method || 'GET'; calls.push({ url, method }); assert.equal(method, 'GET', 'Interest lookup must never write to a provider.');
    if (pause?.pathname === url.pathname && --pause.remaining === 0) { const waiting = pause; pause = undefined; waiting.entered(); await waiting.wait; }
    if (url.pathname === '/api/v1/accounts') { assert.deepEqual(Object.fromEntries(url.searchParams), { profileId }); return Response.json({ accounts }); }
    if (url.pathname === '/api/v1/ads/accounts') { assert.deepEqual(Object.fromEntries(url.searchParams), { accountId, inScopeOnly: 'true' }); return Response.json({ accounts: advertisers, stale }); }
    if (url.pathname === '/api/v1/ads/targeting/search') return typeof reply === 'string' ? new Response(reply) : Response.json(reply);
    assert.fail(`Unexpected provider request: ${url.pathname}`);
  };
  async function http(path, { method = 'GET', body, selected = cookie } = {}) {
    const response = await originalFetch(base + '/api' + path, { method, headers: { Origin: origin, ...(selected ? { Cookie: selected } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const query = () => `${project}/integrations/ads/targeting?${new URLSearchParams({ accountId, adAccountId, dimension: 'interest', q: ' Design & art ' })}`;
  const search = () => http(query());
  const searchCalls = () => calls.filter(call => call.url.pathname === '/api/v1/ads/targeting/search');
  const reset = () => { accounts = [connected()]; advertisers = [advertiser()]; stale = false; reply = { results: [interest()] }; };
  async function during(pathname, change, occurrence = 1) {
    let entered, release; const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    pause = { pathname, remaining: occurrence, entered, wait }; const pending = search();
    try {
      await Promise.race([started, new Promise((_, reject) => { setTimeout(() => reject(new Error('Expected provider boundary was not reached.')), 3000).unref(); })]);
      await change();
    } finally { release(); pause = undefined; }
    const result = await pending; assert.equal(result.data.results, undefined, 'A changed scope must not return stale interest rows.'); return result;
  }
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await http('/auth/setup', { method: 'POST', body: { name: 'Targeting fixture', email: 'targeting@example.test', password } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
    state = (await http('/state')).data; project = `/projects/${state.projectId}`;
    assert.equal((await http(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);

    await t.test('exact GET query, literal labels, zero and unknown sizes, strict projection and valid empty results', async () => {
      const name = '<img src=x onerror=alert(1)> & "Design"', path = ['Interests', '<script>literal text</script>'];
      reply = { results: [{ id: '6001', name, type: 'interest', path, audienceSize: 0, accessToken: 'NEVER_RETURN', metadata: { secret: 'NEVER_RETURN' } }, { id: '6002', name: 'Unknown', type: 'interest', audienceSize: null }, { id: '6003', name: 'Omitted', type: 'interest' }], apiKey: 'NEVER_RETURN', request: { authorization: 'NEVER_RETURN' } };
      let result = await search(); assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.deepEqual(result.data, { results: [{ id: '6001', name, type: 'interest', path, audienceSize: 0 }, { id: '6002', name: 'Unknown', type: 'interest', audienceSize: null }, { id: '6003', name: 'Omitted', type: 'interest' }] });
      assert.deepEqual(Object.fromEntries(searchCalls().at(-1).url.searchParams), { accountId, adAccountId, dimension: 'interest', q: 'Design & art', limit: '25' });
      assert.deepEqual(calls.slice(-6).map(call => call.url.pathname), ['/api/v1/accounts', '/api/v1/ads/accounts', '/api/v1/ads/targeting/search', '/api/v1/accounts', '/api/v1/ads/accounts', '/api/v1/accounts']);
      reply = { results: [] }; result = await search(); assert.equal(result.status, 200); assert.deepEqual(result.data, { results: [] }); reset();
      const unauthenticated = await http(query(), { selected: null }); assert.equal(unauthenticated.status, 401);
    });

    await t.test('interest query accepts only the four agreed unique parameters and bounded nonempty text', async () => {
      for (const suffix of ['&limit=1', '&countryCode=AE', '&geoType=city', '&platform=facebook', '&q=second', '&dimension=interest', '&accountId=other', '&adAccountId=other']) {
        const before = searchCalls().length, result = await http(query() + suffix); assert.equal(result.status, 400, suffix); assert.equal(searchCalls().length, before);
      }
      for (const q of ['', '   ', 'x'.repeat(201), '\u0000bad']) {
        const before = searchCalls().length, params = new URLSearchParams({ accountId, adAccountId, dimension: 'interest', q });
        assert.equal((await http(`${project}/integrations/ads/targeting?${params}`)).status, 400); assert.equal(searchCalls().length, before);
      }
      for (const q of ['x', 'x'.repeat(200)]) assert.equal((await http(`${project}/integrations/ads/targeting?${new URLSearchParams({ accountId, adAccountId, dimension: 'interest', q })}`)).status, 200);
    });

    await t.test('malformed result arrays, duplicate IDs, wrong dimensions and invalid optional values fail closed', async () => {
      const badRows = [null, {}, { ...interest(), id: 6001 }, { ...interest(), id: 'bad id' }, { ...interest(), name: '' }, { ...interest(), name: 'x'.repeat(201) }, { ...interest(), type: 'interests' }, { ...interest(), type: 'behavior' }, { ...interest(), path: {} }, { ...interest(), path: [''] }, { ...interest(), path: Array(11).fill('Interests') }, ...[-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1].map(audienceSize => ({ ...interest(), audienceSize }))];
      for (const bad of [{}, { results: null }, { results: {} }, ...badRows.map(row => ({ results: [row] })), { results: [interest(), interest()] }, { results: Array.from({ length: 26 }, (_, index) => ({ ...interest(), id: String(index) })) }, 'not json']) {
        reply = bad; const result = await search(); assert.equal(result.status, 502, JSON.stringify(bad)); assert.equal(result.data.results, undefined);
      }
      reset();
    });

    await t.test('scope echoes cannot cross profiles, connections, advertisers or dimensions', async () => {
      for (const scope of [{ profileId: 'foreign-profile' }, { profileId: [profileId] }, { accountId: 'foreign-connection' }, { adAccountId: 'foreign-advertiser' }, { platformAdAccountId: 'foreign-advertiser' }, { platform: 'google' }, { dimension: 'behavior' }]) {
        for (const nested of [false, true]) {
          reply = nested ? { results: [{ ...interest(), ...scope }] } : { results: [interest()], ...scope };
          const result = await search(); assert.equal(result.status, 502, JSON.stringify(scope)); assert.equal(result.data.results, undefined);
        }
      }
      reset();
    });

    await t.test('current Meta connection and exact fresh advertiser membership are required before and after lookup', async () => {
      for (const change of [() => { accounts = []; }, () => { accounts[0].isActive = false; }, () => { advertisers = []; }, () => { advertisers[0].selectable = false; }, () => { stale = true; }, () => { advertisers.push(advertiser()); }, () => { advertisers = [null]; }]) {
        reset(); change(); const before = searchCalls().length, result = await search(); assert.ok(result.status >= 400); assert.equal(searchCalls().length, before); assert.equal(result.data.results, undefined);
      }
      for (const change of [() => { accounts = []; }, () => { accounts[0].username = 'different-brand'; }, () => { accounts[0].platform = 'googleads'; }, () => { accounts[0].isActive = false; }, () => { advertisers = []; }, () => { advertisers[0].selectable = false; }, () => { advertisers.push(advertiser()); }, () => { stale = true; }]) {
        reset(); const result = await during('/api/v1/ads/targeting/search', change); assert.ok(result.status >= 400);
      }
      for (const change of [() => { accounts = []; }, () => { accounts[0].username = 'replaced-during-advertiser-check'; }, () => { accounts[0].isActive = false; }]) {
        reset(); const result = await during('/api/v1/ads/accounts', change, 2); assert.ok(result.status >= 400, 'A connection change during final advertiser verification cannot expose stale rows.');
      }
      reset();
    });

    await t.test('session, membership, role, mapping and credential changes are checked across awaited reads', async () => {
      const role = next => app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', next, state.workspaces[0].id, state.user.id);
      for (const [pathname, occurrence] of [['/api/v1/accounts', 1], ['/api/v1/ads/accounts', 1], ['/api/v1/ads/targeting/search', 1], ['/api/v1/accounts', 2], ['/api/v1/ads/accounts', 2], ['/api/v1/accounts', 3]]) {
        try { const result = await during(pathname, () => role('viewer'), occurrence); assert.equal(result.status, 403); } finally { await role('owner'); }
      }
      try { const result = await during('/api/v1/ads/targeting/search', () => app.sql.run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?', state.workspaces[0].id, state.user.id)); assert.ok([403, 404].includes(result.status)); }
      finally { await app.sql.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?,?,'owner') ON CONFLICT (workspace_id, user_id) DO UPDATE SET role=excluded.role", state.workspaces[0].id, state.user.id); }
      try { const result = await during('/api/v1/ads/targeting/search', () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'foreign-profile', state.projectId)); assert.equal(result.status, 409); }
      finally { await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, state.projectId); }
      try { const result = await during('/api/v1/ads/targeting/search', async () => { assert.equal((await http('/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-synthetic-key' } } })).status, 200); }); assert.equal(result.status, 409); }
      finally { assert.equal((await http('/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey } } })).status, 200); }
      const revoker = (await http('/auth/login', { method: 'POST', body: { email: 'targeting@example.test', password } })).cookie;
      try { const result = await during('/api/v1/ads/targeting/search', async () => { assert.equal((await http('/account/sessions/revoke', { method: 'POST', body: {}, selected: revoker })).status, 200); }); assert.equal(result.status, 403); }
      finally { cookie = revoker; }
      assert.equal((await search()).status, 200);
    });

    await t.test('existing Meta geo queries retain their fields and response contract', async () => {
      reply = { results: [{ id: 'city-1', name: 'Dubai', type: 'city', countryCode: 'AE' }], existingMetadata: true };
      const result = await http(`${project}/integrations/ads/targeting?${new URLSearchParams({ accountId, adAccountId, dimension: 'geo', q: 'Dubai', countryCode: 'AE', geoType: 'city' })}`);
      assert.equal(result.status, 200); assert.deepEqual(result.data, reply); assert.equal(searchCalls().at(-1).url.searchParams.get('geoType'), 'city');
    });
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.method === 'GET'), 'No provider POST, PUT, PATCH or DELETE is allowed.');
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});
