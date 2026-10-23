import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { validatePostForPlatforms } from '../shared/social-posts.ts';
import { firstProject } from './first-project.ts';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-publishing-lookup-')), originalFetch = globalThis.fetch, calls = [], origin = 'https://publishing.example.test';
  const app = await testApp(t, { dataDir, env: { ZERNIO_API_KEY: 'synthetic-publishing-key' }, appUrl: origin, directScheduler: false });
  const accounts = ['pinterest', 'youtube', 'reddit', 'facebook'].map(platform => ({ _id: 'account-' + platform, profileId: 'publishing-profile', platform, isActive: true })); let hook;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer synthetic-publishing-key'); calls.push({ url, options });
    if (hook) { const response = await hook(url, options); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [...accounts, { _id: 'foreign-account', platform: 'pinterest', profileId: 'foreign-profile' }] });
    if (url.pathname.endsWith('/pinterest-boards')) return Response.json({ boards: [{ id: 'board-one', name: 'Product launches', privacy: 'PUBLIC', description: 'Our new products', accessToken: 'private' }] });
    if (url.pathname.endsWith('/youtube-playlists')) return Response.json({ playlists: [{ id: 'PL-launch', title: 'Launch videos', privacy: 'unlisted', itemCount: 3 }], defaultPlaylistId: 'PL-launch' });
    if (url.pathname.endsWith('/reddit-subreddits')) return Response.json({ subreddits: [{ id: 't5-test', name: 'programming', title: 'Programming', over18: false }], defaultSubreddit: '' });
    if (url.pathname.endsWith('/reddit-subreddits/programming/rules')) return Response.json({ rules: [{ kind: 'all', shortName: 'Stay on topic', description: 'Discuss programming.', priority: 0 }], siteRules: ['Follow Reddit content policy.'] });
    if (url.pathname.endsWith('/reddit-flairs')) { assert.equal(url.searchParams.get('subreddit'), 'programming'); return Response.json({ flairs: [{ id: 'flair-news', text: 'News' }] }); }
    assert.fail('Unexpected synthetic Zernio endpoint: ' + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`; let cookie;
  async function request(path, method = 'GET', body) { const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/api/auth/setup', 'POST', { name: 'Publishing owner', email: 'publishing@example.test', password: 'synthetic publishing passphrase long enough' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const projectId = setup.data.projectId;
  await request('/api/projects/' + projectId, 'PATCH', { zernioProfileId: 'publishing-profile' });
  return { app, accounts, calls, path: `/api/projects/${projectId}/integrations/publishing/accounts/`, request, setHook(value) { hook = value; }, async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('publishing destination discovery round-trips boards, playlists, subreddit rules and flairs without provider writes', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const [route, field] of [['account-pinterest/pinterest-boards', 'boards'], ['account-youtube/youtube-playlists', 'playlists'], ['account-reddit/reddit-subreddits', 'subreddits'], ['account-reddit/reddit-rules?subreddit=programming', 'rules'], ['account-reddit/reddit-flairs?subreddit=programming', 'flairs']]) {
      const response = await f.request(f.path + route); assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data[field].length, 1); assert.equal(response.data[field][0].accessToken, undefined);
    }
    assert.equal((await f.request(f.path + 'account-youtube/youtube-playlists')).data.defaultPlaylistId, 'PL-launch'); assert.equal((await f.request(f.path + 'account-reddit/reddit-subreddits')).data.defaultSubreddit, '');
    assert.ok(f.calls.every(call => call.options.method === 'GET')); assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM integration_operations')).total, 0, 'Read-only lookups record no provider operation.');
    const before = f.calls.length; assert.equal((await f.request(f.path + 'account-pinterest/pinterest-boards', 'POST', {})).status, 405); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('publishing lookups reject cross-profile, wrong-platform, disconnected and malformed resources and retain access-change guards', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.request(f.path + 'foreign-account/pinterest-boards')).status, 403); assert.equal((await f.request(f.path + 'account-facebook/pinterest-boards')).status, 422);
    f.accounts[0].isActive = false; assert.equal((await f.request(f.path + 'account-pinterest/pinterest-boards')).status, 422); f.accounts[0].isActive = true;
    for (const route of ['account-reddit/reddit-rules?subreddit=r/programming', 'account-reddit/reddit-flairs', 'account-youtube/youtube-playlists?profileId=foreign']) assert.equal((await f.request(f.path + route)).status, 400);
    for (const result of [{ boards: [{ id: 'one', name: {} }] }, { boards: [{ id: 'one', name: 'First' }, { id: 'one', name: 'Duplicate' }] }, { accountId: 'other', boards: [] }]) { f.setHook(url => url.pathname.endsWith('/pinterest-boards') ? Response.json(result) : undefined); assert.equal((await f.request(f.path + 'account-pinterest/pinterest-boards')).status, 502); }
    f.setHook(async url => { if (url.pathname.endsWith('/pinterest-boards')) { await f.app.sql.run("UPDATE memberships SET role='viewer'"); return Response.json({ boards: [] }); } });
    assert.equal((await f.request(f.path + 'account-pinterest/pinterest-boards')).status, 403, 'A membership change during the provider read prevents returning its account data.');
  } finally { await f.close(); }
});

test('Instagram carousel and Facebook Reel boundaries follow the current provider guides', () => {
  // Primary contracts: docs.zernio.com/platforms/instagram (10 carousel items), /facebook (3–60s Reels), checked 2026-10-18.
  const image = { type: 'image', url: 'https://cdn.example.test/image.jpg', width: 1080, height: 1080, size: 10000, mimeType: 'image/jpeg' };
  for (const [count, valid] of [[10, true], [11, false]]) assert.equal(validatePostForPlatforms({ content: 'Carousel', mediaItems: Array.from({ length: count }, () => ({ ...image })) }, ['instagram']).valid, valid);
  const reel = duration => ({ content: 'Reel', mediaItems: [{ type: 'video', url: 'https://cdn.example.test/reel.mp4', width: 1080, height: 1920, duration, size: 100000, mimeType: 'video/mp4' }], platformOverrides: { facebook: { options: { contentType: 'reel' } } } });
  for (const [duration, valid] of [[3, true], [60, true], [60.001, false], [90, false]]) assert.equal(validatePostForPlatforms(reel(duration), ['facebook']).valid, valid, String(duration));
});
