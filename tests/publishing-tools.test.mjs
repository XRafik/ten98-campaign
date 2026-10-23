import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'publishing-tools-')), originalFetch = globalThis.fetch, calls = [], origin = 'https://tools.example.test';
  const app = await testApp(t, { dataDir, env: { ZERNIO_API_KEY: 'synthetic-tools-key' }, appUrl: origin, directScheduler: false });
  const accounts = [{ _id: 'gmb', profileId: 'tools-profile', platform: 'googlebusiness', platformUserId: 'google-source', isActive: true }, { _id: 'instagram', profileId: 'tools-profile', platform: 'instagram', platformUserId: '17800001', isActive: true, metadata: { loginMethod: 'facebook_login' } }, { _id: 'outside', profileId: 'another-profile', platform: 'googlebusiness', isActive: true }];
  const audio = { audioId: '123', title: 'Sample music', audioType: 'music', durationInMs: 12000, displayArtist: 'Artist', downloadUrl: 'https://cdn.example.test/preview.mp3', isAdsEligible: false, onPlatformAudioPreviewLink: 'https://www.instagram.com/reels/audio/123/', accessToken: 'must-not-escape' };
  let hook;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.method, 'GET', 'Every provider request is read only.'); calls.push({ url, options });
    if (hook) { const value = await hook(url); if (value !== undefined) return Response.json(value); }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts });
    if (url.pathname.endsWith('/gmb-locations')) return Response.json({ locations: [{ id: '123', name: 'First shop', accountId: 'accounts/999', accountName: 'Business owner', address: 'Main Street', category: null, storeCode: 'A', accessToken: 'must-not-escape' }, { id: 'locations/456', name: 'Second shop' }], selectedLocationId: '123', hasMore: true, cached: false });
    if (url.pathname.endsWith('/publishing-limit')) return Response.json({ quotaUsage: 3, quotaTotal: 50, quotaDurationSeconds: 86400, secret: 'must-not-escape' });
    if (url.pathname.endsWith('/audio/123')) return Response.json({ audio });
    if (url.pathname.endsWith('/audio')) return Response.json({ audio: [audio] });
    assert.fail('Unexpected provider endpoint: ' + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`; let cookie;
  async function request(path, method = 'GET', body) {
    const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'Tools owner', email: 'tools@example.test', password: 'synthetic tools passphrase long enough' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const projectId = setup.data.projectId;
  assert.equal((await request('/api/projects/' + projectId, 'PATCH', { zernioProfileId: 'tools-profile' })).status, 200);
  return { app, accounts, calls, audio, request, projectId, read: (route, method = 'GET') => request(`/api/projects/${projectId}/integrations/publishing/accounts/${route}`, method), setHook(value) { hook = value; }, async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('composer accounts expose only the Instagram login capability needed by audio tools', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    f.accounts[1].metadata.privateCredential = 'must-not-escape';
    let result = await f.request(`/api/projects/${f.projectId}/integrations/accounts`);
    assert.equal(result.status, 200); assert.deepEqual(result.data.accounts.find(row => row._id === 'instagram').metadata, { loginMethod: 'facebook_login' });
    assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
    delete f.accounts[1].metadata;
    result = await f.request(`/api/projects/${f.projectId}/integrations/accounts`);
    assert.deepEqual(result.data.accounts.find(row => row._id === 'instagram').metadata, { loginMethod: 'instagram_login' });
    assert.equal(result.data.accounts.find(row => row._id === 'gmb').metadata, undefined);
  } finally { await f.close(); }
});

test('publishing tools bind scoped accounts, keep native location IDs and expose only usable read metadata', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const locations = await f.read('gmb/gmb-locations?search=Shop'); assert.equal(locations.status, 200, JSON.stringify(locations.data));
    assert.equal(locations.data.accountId, 'gmb'); assert.equal(locations.data.platform, 'googlebusiness'); assert.equal(locations.data.locations[0].accountId, 'accounts/999');
    assert.deepEqual(locations.data.locations.map(row => row.id), ['123', 'locations/456']); assert.equal(locations.data.hasMore, true); assert.equal(locations.data.cached, false); assert.equal(locations.data.locations[1].storeCode, null);
    const call = f.calls.find(call => call.url.pathname.endsWith('/gmb-locations')); assert.deepEqual([...call.url.searchParams], [['limit', '100'], ['search', 'Shop']]);
    const quota = await f.read('instagram/instagram-publishing-limit'); assert.deepEqual(quota.data, { accountId: 'instagram', platform: 'instagram', loginMethod: 'facebook_login', quotaUsage: 3, quotaTotal: 50, quotaDurationSeconds: 86400 });
    const music = await f.read('instagram/instagram-audio?audioType=music&q=Sample'); assert.equal(music.status, 200); assert.equal(music.data.loginMethod, 'facebook_login'); assert.equal(music.data.audio[0].igUsername, null); assert.equal(music.data.audio[0].isAdsEligible, false);
    const lookup = await f.read('instagram/instagram-audio-lookup?audioId=123'); assert.equal(lookup.status, 200); assert.deepEqual(lookup.data.audio, music.data.audio[0]);
    assert.equal(JSON.stringify([locations, quota, music, lookup]).includes('must-not-escape'), false);
    assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM integration_operations')).total, 0);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/accounts')).length, 8, 'Each read verifies the connected account again after fetching provider data.');
  } finally { await f.close(); }
});

test('publishing tools reject writes, duplicate scalars, extra filters and fabricated pagination without provider calls', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const route of ['gmb/gmb-locations', 'instagram/instagram-publishing-limit', 'instagram/instagram-audio?audioType=music', 'instagram/instagram-audio-lookup?audioId=123']) assert.equal((await f.read(route, 'POST')).status, 405);
    for (const route of ['gmb/gmb-locations?filter=title%3DShop', 'gmb/gmb-locations?limit=500', 'gmb/gmb-locations?page=2', 'gmb/gmb-locations?cursor=next', 'gmb/gmb-locations?search=a&search=b', 'gmb/gmb-locations?search=', 'gmb/gmb-locations?search=' + 'a'.repeat(201), 'instagram/instagram-publishing-limit?profileId=another', 'instagram/instagram-audio', 'instagram/instagram-audio?audioType=invalid', 'instagram/instagram-audio?audioType=music&audioType=music', 'instagram/instagram-audio?audioType=music&q=', 'instagram/instagram-audio?audioType=music&q=' + 'a'.repeat(201), 'instagram/instagram-audio?audioType=music&page=2', 'instagram/instagram-audio-lookup?audioId=123&audioId=456', 'instagram/instagram-audio-lookup?audioId=abc', 'instagram/instagram-audio-lookup?audioId=' + '1'.repeat(31)]) assert.equal((await f.read(route)).status, 400, route);
    assert.equal(f.calls.length, 0);
    for (const route of ['gmb/gmb-locations/default', 'gmb/gmb-locations/assign']) assert.equal((await f.read(route, 'POST')).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('publishing tools gate foreign, wrong-platform, inactive, reconnection and Instagram Login accounts', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.read('outside/gmb-locations')).status, 403); assert.equal((await f.read('instagram/gmb-locations')).status, 422);
    f.accounts[0].isActive = false; assert.equal((await f.read('gmb/gmb-locations')).status, 422); f.accounts[0].isActive = true;
    f.accounts[1].needsReconnection = true; assert.equal((await f.read('instagram/instagram-publishing-limit')).status, 409); f.accounts[1].needsReconnection = false;
    delete f.accounts[1].metadata; const quota = await f.read('instagram/instagram-publishing-limit'); assert.equal(quota.status, 200); assert.equal(quota.data.loginMethod, 'instagram_login');
    for (const route of ['instagram/instagram-audio?audioType=music', 'instagram/instagram-audio-lookup?audioId=123']) { const before = f.calls.length; assert.equal((await f.read(route)).status, 422); assert.equal(f.calls.length, before + 1); }
    f.accounts[1].metadata = { loginMethod: 'unknown' }; assert.equal((await f.read('instagram/instagram-publishing-limit')).status, 502);
  } finally { await f.close(); }
});

test('publishing tools preserve partial and unknown location lists and reject malformed, duplicate or mismatched provider data', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    f.setHook(url => url.pathname.endsWith('/gmb-locations') ? { locations: [] } : undefined);
    const unknown = await f.read('gmb/gmb-locations'); assert.equal(unknown.status, 200); assert.deepEqual(unknown.data, { accountId: 'gmb', platform: 'googlebusiness', locations: [], selectedLocationId: null, hasMore: null, cached: null });
    for (const bad of [{ locations: [{ id: 'one', name: 'Shop' }, { id: 'one', name: 'Duplicate' }] }, { locations: [], hasMore: 'yes' }, { locations: [], cached: 1 }, { locations: [], selectedLocationId: {} }, { locations: [{ id: 'one', name: {}, accountId: 'accounts/123' }] }, { locations: [], accountId: 'another' }, { locations: [], profileId: 'another' }, { locations: [], platform: 'instagram' }, { locations: Array.from({ length: 101 }, (_, id) => ({ id: String(id), name: 'Shop' })) }]) { f.setHook(url => url.pathname.endsWith('/gmb-locations') ? bad : undefined); assert.equal((await f.read('gmb/gmb-locations')).status, 502); }
    for (const patch of [{ quotaUsage: -1 }, { quotaTotal: 1.5 }, { quotaDurationSeconds: 0 }, { quotaUsage: '3' }]) { f.setHook(url => url.pathname.endsWith('/publishing-limit') ? { quotaUsage: 3, quotaTotal: 50, quotaDurationSeconds: 86400, ...patch } : undefined); assert.equal((await f.read('instagram/instagram-publishing-limit')).status, 502); }
    for (const audio of [[{ audioId: '1' }, { audioId: '1' }], [{ audioId: 'not-numeric' }], [{ audioId: '1', durationInMs: -1 }], [{ audioId: '1', isAdsEligible: 'no' }], [{ audioId: '1', audioType: 'original_sound' }], [{ audioId: '1', downloadUrl: 'javascript:alert(1)' }], [{ audioId: '1', onPlatformAudioPreviewLink: 'https://127.0.0.1/' }]]) { f.setHook(url => url.pathname.endsWith('/audio') ? { audio } : undefined); assert.equal((await f.read('instagram/instagram-audio?audioType=music')).status, 502); }
    f.setHook(url => url.pathname.endsWith('/audio/123') ? { audio: { audioId: '456' } } : undefined); assert.equal((await f.read('instagram/instagram-audio-lookup?audioId=123')).status, 502);
    f.setHook(url => url.pathname.endsWith('/audio') ? { audio: [{ audioId: '1', title: null, audioType: null, durationInMs: 0, isAdsEligible: null }] } : undefined);
    const nullable = await f.read('instagram/instagram-audio?audioType=original_sound'); assert.equal(nullable.status, 200); assert.equal(nullable.data.audio[0].durationInMs, 0); assert.equal(nullable.data.audio[0].downloadUrl, null);
  } finally { await f.close(); }
});

test('publishing tools withhold stale reads after connected identity, login or grant scope changes', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const change of [row => { row.platformUserId = 'changed'; }, row => { row.username = 'changed'; }, row => { row.metadata.loginMethod = 'instagram_login'; }, row => { row.needsReconnection = true; }, row => { row.profileId = 'another'; }]) {
      f.accounts[1] = { _id: 'instagram', profileId: 'tools-profile', platform: 'instagram', platformUserId: '17800001', isActive: true, metadata: { loginMethod: 'facebook_login' } };
      f.setHook(url => { if (url.pathname.endsWith('/audio')) { change(f.accounts[1]); return { audio: [f.audio] }; } });
      const result = await f.read('instagram/instagram-audio?audioType=music'); assert.ok([403, 409].includes(result.status), JSON.stringify(result)); assert.equal(result.data.audio, undefined);
    }
  } finally { await f.close(); }
});

test('in-flight publishing reads stop after session, membership, mapping or credential revocation', { skip: postgresSkip }, async t => {
  for (const change of ['session', 'membership', 'role', 'mapping', 'credentials']) {
    const f = await fixture(t);
    try {
      f.setHook(async url => {
        if (!url.pathname.endsWith('/publishing-limit')) return;
        if (change === 'session') await f.app.sql.run('DELETE FROM sessions');
        if (change === 'membership') await f.app.sql.run('DELETE FROM memberships');
        if (change === 'role') await f.app.sql.run("UPDATE memberships SET role='viewer'");
        if (change === 'mapping') await f.app.sql.run("UPDATE projects SET zernio_profile_id='another'");
        if (change === 'credentials') assert.equal((await f.request('/api/settings/integrations/zernio', 'PUT', { fields: { apiKey: 'changed-synthetic-key' } })).status, 200);
        return { quotaUsage: 3, quotaTotal: 50, quotaDurationSeconds: 86400 };
      });
      const result = await f.read('instagram/instagram-publishing-limit'); assert.ok([403, 404, 409].includes(result.status), change + ': ' + JSON.stringify(result)); assert.equal(result.data.quotaUsage, undefined);
    } finally { await f.close(); }
  }
});
