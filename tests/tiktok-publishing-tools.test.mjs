import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tiktok-tools-')), originalFetch = globalThis.fetch, calls = [], origin = 'https://tiktok-tools.example.test';
  const app = await testApp(t, { dataDir, env: { ZERNIO_API_KEY: 'synthetic-tiktok-key' }, appUrl: origin, directScheduler: false });
  const account = { _id: 'tiktok', profileId: 'tools-profile', platform: 'tiktok', platformUserId: 'native-one', isActive: true, metadata: { tiktokAccountType: 'business' } };
  const rows = [account, { _id: 'wrong', profileId: 'tools-profile', platform: 'instagram', isActive: true }, { _id: 'outside', profileId: 'other', platform: 'tiktok', isActive: true }];
  const track = { id: 'full-track', commercialMusicId: 'reference-only', name: 'Music', artist: 'Artist', durationSec: 120, genres: ['Pop'], previewUrl: 'https://never.example/full', thumbnailUrl: 'https://never.example/image', rank: 1, clip: { id: 'clip-one', durationSec: 30, previewUrl: 'https://never.example/clip', secret: 'must-not-escape' }, secret: 'must-not-escape' };
  let hook;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.method, 'GET'); calls.push({ url, options });
    if (hook) { const value = await hook(url); if (value !== undefined) return value instanceof Response ? value : Response.json(value); }
    if (url.pathname.endsWith('/accounts')) { assert.equal(url.searchParams.get('profileId'), 'tools-profile'); return Response.json({ accounts: rows }); }
    if (url.pathname.endsWith('/tiktok/commercial-music')) return Response.json({ tracks: [track, { id: 'fallback-track' }] });
    if (url.pathname.endsWith('/tiktok/locations')) return Response.json({ locations: [{ id: 'place-one', name: 'Exact venue', address: 'Main Street', secret: 'must-not-escape' }] });
    assert.fail('Unexpected synthetic endpoint: ' + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`; let cookie;
  async function request(path, method = 'GET', body) { const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/api/auth/setup', 'POST', { name: 'TikTok owner', email: 'tiktok@example.test', password: 'synthetic tiktok passphrase long enough' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const projectId = setup.data.projectId;
  assert.equal((await request('/api/projects/' + projectId, 'PATCH', { zernioProfileId: 'tools-profile' })).status, 200);
  return { app, account, track, calls, request, read: (route, method = 'GET') => request(`/api/projects/${projectId}/integrations/publishing/accounts/${route}`, method), setHook(value) { hook = value; }, async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('TikTok reads use exact endpoints, global or country charts, bounded nullable metadata and no provider writes', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const music = await f.read('tiktok/tiktok-commercial-music'); assert.equal(music.status, 200, JSON.stringify(music)); assert.equal(music.data.accountId, 'tiktok'); assert.equal(music.data.platform, 'tiktok'); assert.equal(music.data.tracks[0].clip.id, 'clip-one'); assert.equal(music.data.tracks[0].commercialMusicId, 'reference-only');
    assert.deepEqual(music.data.tracks[1], { id: 'fallback-track', commercialMusicId: null, name: null, artist: null, previewUrl: null, thumbnailUrl: null, durationSec: null, rank: null, genres: null, clip: null });
    assert.equal(f.calls.find(call => call.url.pathname.endsWith('/commercial-music')).url.search, '');
    assert.equal((await f.read('tiktok/tiktok-commercial-music?countryCode=ae')).status, 200); assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/commercial-music')).at(-1).url.search, '?countryCode=AE');
    const location = await f.read('tiktok/tiktok-locations?query=Venue%20%26%20city'); assert.deepEqual(location.data, { accountId: 'tiktok', platform: 'tiktok', locations: [{ id: 'place-one', name: 'Exact venue', address: 'Main Street' }] });
    assert.equal(f.calls.find(call => call.url.pathname.endsWith('/tiktok/locations')).url.searchParams.get('query'), 'Venue & city'); assert.equal(JSON.stringify([music, location]).includes('must-not-escape'), false);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/accounts')).length, 6); assert.ok(f.calls.every(call => call.options.method === 'GET')); assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM integration_operations')).total, 0);
  } finally { await f.close(); }
});

test('TikTok discovery rejects writes, invalid scalars, pagination and unverified accounts without calling its endpoints', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const route of ['tiktok/tiktok-commercial-music', 'tiktok/tiktok-locations?query=Venue']) assert.equal((await f.read(route, 'POST')).status, 405);
    for (const route of ['tiktok/tiktok-commercial-music?countryCode=', 'tiktok/tiktok-commercial-music?countryCode=USA', 'tiktok/tiktok-commercial-music?countryCode=1A', 'tiktok/tiktok-commercial-music?countryCode=AE&countryCode=GB', 'tiktok/tiktok-commercial-music?page=2', 'tiktok/tiktok-commercial-music?cursor=next', 'tiktok/tiktok-locations', 'tiktok/tiktok-locations?query=', 'tiktok/tiktok-locations?query=one&query=two', 'tiktok/tiktok-locations?query=' + 'a'.repeat(101), 'tiktok/tiktok-locations?query=Venue&limit=20', 'tiktok/tiktok-locations?query=Venue&page=2']) assert.equal((await f.read(route)).status, 400, route);
    assert.equal(f.calls.length, 0); assert.equal((await f.read('outside/tiktok-commercial-music')).status, 403); assert.equal((await f.read('wrong/tiktok-commercial-music')).status, 422);
    f.account.isActive = false; assert.equal((await f.read('tiktok/tiktok-commercial-music')).status, 422); f.account.isActive = true;
    f.account.needsReconnection = true; assert.equal((await f.read('tiktok/tiktok-locations?query=Venue')).status, 409); assert.ok(f.calls.every(call => call.url.pathname.endsWith('/accounts')));
    f.account.needsReconnection = false; f.account.metadata = { tiktokAccountType: 'creator' }; assert.equal((await f.read('tiktok/tiktok-commercial-music')).status, 200, 'Account category does not prove or disprove the OAuth app grant.');
    f.setHook(url => url.pathname.endsWith('/commercial-music') ? Response.json({ error: { code: 'business_app_required', message: 'Business app required' } }, { status: 400 }) : undefined); const unsupported = await f.read('tiktok/tiktok-commercial-music'); assert.equal(unsupported.status, 400); assert.equal(unsupported.data.tracks, undefined);
  } finally { await f.close(); }
});

test('TikTok projections reject duplicate IDs, malformed clips, counts and scope echoes while retaining nullable metadata', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const bad of [{ tracks: [{ id: 'same' }, { id: 'same' }] }, { tracks: [{ id: 'one', clip: {} }] }, { tracks: [{ id: 'one', clip: { id: 'clip', durationSec: -1 } }] }, { tracks: [{ id: 'one', rank: 0 }] }, { tracks: [{ id: 'one', genres: [{}] }] }, { tracks: [{ id: 'one', durationSec: 0.5 }] }, { tracks: Array.from({ length: 101 }, (_, id) => ({ id: String(id) })) }, { tracks: [], accountId: 'other' }, { tracks: [], profileId: 'other' }, { tracks: [], platform: 'instagram' }]) { f.setHook(url => url.pathname.endsWith('/commercial-music') ? bad : undefined); assert.equal((await f.read('tiktok/tiktok-commercial-music')).status, 502, JSON.stringify(bad)); }
    for (const locations of [[{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }], [{ id: 'place', name: '' }], [{ id: 'place', name: 'Venue', address: {} }], Array.from({ length: 21 }, (_, id) => ({ id: String(id), name: 'Venue' }))]) { f.setHook(url => url.pathname.endsWith('/tiktok/locations') ? { locations } : undefined); assert.equal((await f.read('tiktok/tiktok-locations?query=Venue')).status, 502); }
    f.setHook(url => url.pathname.endsWith('/commercial-music') ? { tracks: [{ id: 'zero', durationSec: 0, clip: { id: 'excerpt', durationSec: 0 } }] } : undefined); const zero = await f.read('tiktok/tiktok-commercial-music'); assert.equal(zero.status, 200); assert.equal(zero.data.tracks[0].clip.previewUrl, null);
    f.setHook(url => url.pathname.endsWith('/tiktok/locations') ? { locations: [] } : undefined); assert.deepEqual((await f.read('tiktok/tiktok-locations?query=Missing')).data.locations, []);
  } finally { await f.close(); }
});

test('TikTok reads withhold stale results after identity and actual access changes', { skip: postgresSkip }, async t => {
  for (const change of ['identity', 'session', 'mapping', 'credentials']) {
    const f = await fixture(t);
    try {
      f.setHook(async url => {
        if (!url.pathname.endsWith('/commercial-music')) return;
        if (change === 'identity') f.account.platformUserId = 'another-native-account';
        if (change === 'session') await f.app.sql.run('DELETE FROM sessions');
        if (change === 'mapping') await f.app.sql.run("UPDATE projects SET zernio_profile_id='other'");
        if (change === 'credentials') assert.equal((await f.request('/api/settings/integrations/zernio', 'PUT', { fields: { apiKey: 'changed-synthetic-key' } })).status, 200);
        return { tracks: [f.track] };
      });
      const result = await f.read('tiktok/tiktok-commercial-music'); assert.ok([403, 409].includes(result.status), change + JSON.stringify(result)); assert.equal(result.data.tracks, undefined);
    } finally { await f.close(); }
  }
});
