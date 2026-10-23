import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('HTTP paused campaign copies bind reviewed scope, durable native claims and explicit read-only verification', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-campaign-copy-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const config = { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'campaign-copy-fixture-key' } }, profileId = 'copy-profile', platforms = ['facebook', 'instagram', 'tiktok', 'linkedin'], sourceIds = new Set(), writes = [], reads = [];
  // Reopening reuses this test database; testDatabase cleanup ends the pool after the last app closes.
  const database = await testDatabase(t), open = async () => Object.assign(await createApp({ ...config, database: { pool: database.pool, db: database.db } }), { sql: database.sql });
  let app = await open(), base, ownerCookie, projectId, state, treeHook, writeHook, readHook, nativeError = 0, lostReceipt = false, nativeIdMissing = false, receiptOverride, copyOverride, copyList, budget = 20, accountActive = true, advertiser = 'act_123', copiedStatus = null, copiedReadAt = null;
  const accountFor = platform => ['facebook', 'instagram'].includes(platform) ? 'metaads' : platform + 'ads';
  const campaign = (id, platform, profile) => ({ ...(nativeIdMissing ? { _id: id } : { platformCampaignId: id }), platform, profileId: profile, accountId: accountFor(platform), platformAdAccountId: ['facebook', 'instagram'].includes(platform) ? advertiser : '123', campaignName: 'Reviewed campaign', status: 'paused', currency: 'USD', budgetLevel: 'campaign', campaignBudget: { amount: budget, type: 'daily' }, adCount: 2, adSetCount: 1 });
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer campaign-copy-fixture-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined;
    if (method === 'GET') reads.push(url); else writes.push({ url, method, payload, key: options.headers['Idempotency-Key'] });
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: ['metaads', 'tiktokads', 'linkedinads'].map(platform => ({ _id: platform, platform, profileId: url.searchParams.get('profileId'), isActive: accountActive })) });
    if (url.pathname === '/api/v1/ads/accounts') return Response.json({ accounts: [{ id: '123', selectable: true }] });
    if (url.pathname === '/api/v1/ads/tree') { await treeHook?.(); return Response.json({ campaigns: [...sourceIds].flatMap(id => platforms.map(platform => campaign(id, platform, url.searchParams.get('profileId')))), pagination: { pages: 1 } }); }
    if (url.pathname === '/api/v1/ads/campaigns') {
      assert.equal(method, 'GET'); assert.equal(url.searchParams.get('live'), 'true'); assert.equal(url.searchParams.get('limit'), '20'); assert.equal(url.searchParams.get('source'), 'all');
      const platform = url.searchParams.get('platform'), id = url.searchParams.get('campaignId');
      if (['facebook', 'instagram'].includes(platform)) assert.equal(url.searchParams.get('includeEmpty'), 'true');
      const row = { ...campaign(id, platform, url.searchParams.get('profileId')), platformCampaignStatus: copiedStatus, statusReadAt: copiedReadAt, status: 'active', ...copyOverride };
      await readHook?.(); return Response.json({ campaigns: copyList ?? (copiedStatus === 'missing' ? [] : [row]), pagination: { pages: 1 } });
    }
    assert.match(url.pathname, /^\/api\/v1\/ads\/campaigns\/[^/]+\/duplicate$/); assert.equal(method, 'POST'); assert.ok(options.headers['Idempotency-Key']); assert.deepEqual(payload, { platform: payload.platform, deepCopy: true, statusOption: 'PAUSED', syncAfter: true }); assert.ok(platforms.includes(payload.platform)); assert.equal(url.search, '');
    const id = url.pathname.split('/').at(-2), response = { copiedCampaignId: id + '-copy', discovery: 'triggered', raw: { access_token: 'SYNTHETIC_RAW_PRIVATE' }, ...receiptOverride }; await writeHook?.();
    if (lostReceipt) throw new Error('Synthetic connection lost after native dispatch');
    return Response.json(response, { status: nativeError || 200 });
  };
  async function listen() { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function request(path, { body, key, method = body === undefined ? 'GET' : 'POST', cookie = ownerCookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const route = () => `/api/projects/${projectId}/integrations/ads`, review = async (id, platform = 'facebook') => { sourceIds.add(id); return request(route() + `/copy-review?campaignId=${id}&platform=${platform}`); };
  const body = (id, platform, version) => ({ campaignId: id, platform, version, confirmDuplicate: true });
  const sendCopy = (id, platform, version, key) => request(route() + '/copy', { body: body(id, platform, version), key });
  const check = (id, platform = 'facebook', copiedId = id + '-copy') => request(route() + `/copy-status?campaignId=${id}&platform=${platform}&copiedCampaignId=${copiedId}`);
  const role = value => app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', value, state.workspaces[0].id, state.user.id);
  await listen();
  try {
    const setup = await request('/api/auth/setup', { body: { name: 'Copy QA', email: 'copy@example.test', password: 'a long campaign copy fixture password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    state = (await request('/api/state')).data; projectId = state.projectId;
    assert.equal((await request(`/api/projects/${projectId}`, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    let result = await review('normal'); assert.equal(result.status, 200, JSON.stringify(result.data)); const reviewed = result.data;
    assert.equal(reviewed.canCopy, true); assert.equal(reviewed.previousCopy, null); assert.equal(reviewed.unresolved, false); assert.equal(reviewed.source.campaignBudget.amount, 20); assert.match(reviewed.version, /^[a-f0-9]{64}$/); assert.equal(writes.length, 0);
    nativeIdMissing = true; result = await review('internal-only'); assert.equal(result.status, 409); assert.equal(result.data.source, undefined); result = await sendCopy('internal-only', 'facebook', reviewed.version, 'internal-only-copy-key'); assert.equal(result.status, 409); assert.equal(writes.length, 0, 'An internal-only campaign ID cannot reach the native duplicate endpoint.'); nativeIdMissing = false;
    await role('viewer'); assert.equal((await review('viewer')).status, 200); assert.equal((await sendCopy('normal', 'facebook', reviewed.version, 'viewer-copy-key')).status, 403); await role('owner'); assert.equal(writes.length, 0);
    for (const extra of [{ statusOption: 'ACTIVE' }, { deepCopy: false }, { syncAfter: false }, { confirmDuplicate: false }, { version: 'stale' }, { platform: 'google' }]) { result = await request(route() + '/copy', { body: { ...body('normal', 'facebook', reviewed.version), ...extra }, key: 'invalid-copy-' + Object.keys(extra)[0] }); assert.ok(result.status >= 400); }
    assert.equal(writes.length, 0);
    budget = 21; result = await sendCopy('normal', 'facebook', reviewed.version, 'stale-review-copy'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'failed'); assert.equal(writes.length, 0); budget = 20;
    let n = 0; treeHook = () => { if (++n === 2) advertiser = 'act_999'; }; result = await sendCopy('normal', 'facebook', reviewed.version, 'race-review-copy'); assert.ok(result.status >= 400); assert.equal(writes.length, 0); advertiser = 'act_123'; treeHook = undefined;
    n = 0; treeHook = async () => { if (++n === 2) await role('viewer'); }; result = await sendCopy('normal', 'facebook', reviewed.version, 'role-review-copy'); assert.ok(result.status >= 400); assert.equal(writes.length, 0); await role('owner'); treeHook = undefined;
    result = await sendCopy('normal', 'facebook', reviewed.version, 'normal-copy-key'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'complete'); assert.deepEqual(result.data.campaignCopy, { sourceCampaignId: 'normal', platform: 'facebook', copiedCampaignId: 'normal-copy', discovery: 'triggered', requestedStatus: 'PAUSED', verification: 'pending', statusReadAt: null }); assert.equal(JSON.stringify(result.data).includes('SYNTHETIC_RAW_PRIVATE'), false);
    const successfulWrites = writes.length; assert.equal((await sendCopy('normal', 'facebook', reviewed.version, 'normal-copy-key')).status, 200); assert.equal(writes.length, successfulWrites);
    result = await review('normal'); assert.equal(result.data.canCopy, false); assert.equal(result.data.previousCopy.copiedCampaignId, 'normal-copy'); assert.equal((await sendCopy('normal', 'facebook', reviewed.version, 'normal-copy-new-key')).status, 409); assert.equal(writes.length, successfulWrites);
    result = await review('normal', 'instagram'); assert.equal(result.data.previousCopy.platform, 'facebook'); assert.equal(result.data.canCopy, false); assert.equal((await sendCopy('normal', 'instagram', result.data.version, 'normal-copy-alias-key')).status, 409); assert.equal(writes.length, successfulWrites);
    result = await check('normal'); assert.equal(result.status, 200); assert.equal(result.data.campaignCopy.verification, 'pending'); copiedStatus = 'PAUSED'; copiedReadAt = '2026-10-19T12:00:00Z'; result = await check('normal'); assert.equal(result.data.campaignCopy.verification, 'paused'); assert.equal(result.data.campaignCopy.statusReadAt, copiedReadAt); assert.equal(writes.length, successfulWrites);
    for (const failure of [{ platformCampaignId: 'foreign' }, { platform: 'tiktok' }, { profileId: 'foreign' }, { accountId: 'another-connection' }, { platformAdAccountId: '999' }, { statusReadAt: '2026-02-30T12:00:00Z' }]) { copyOverride = failure; result = await check('normal'); assert.ok(result.status >= 400, JSON.stringify(failure)); assert.equal(result.data.campaignCopy, undefined); } copyOverride = undefined;
    copyList = [null]; result = await check('normal'); assert.equal(result.status, 502); assert.equal(result.data.campaignCopy, undefined); copyList = undefined;
    readHook = () => { budget = 22; }; result = await check('normal'); assert.equal(result.status, 409); assert.equal(result.data.campaignCopy, undefined); readHook = undefined; budget = 20;
    assert.equal((await check('normal', 'facebook', 'unreported-native-id')).status, 404);
    for (const platform of ['instagram', 'tiktok', 'linkedin']) { const id = 'platform-' + platform, r = await review(id, platform); result = await sendCopy(id, platform, r.data.version, id + '-key'); assert.equal(result.status, 200, JSON.stringify(result.data)); copiedStatus = platform === 'tiktok' ? 'DISABLE' : 'PAUSED'; result = await check(id, platform); assert.equal(result.data.campaignCopy.verification, platform === 'linkedin' ? 'pending' : 'paused'); }
    for (const discovery of ['skipped', 'failed']) { receiptOverride = { discovery }; const id = 'discovery-' + discovery, r = await review(id); result = await sendCopy(id, 'facebook', r.data.version, id + '-key'); assert.equal(result.status, 200); assert.equal(result.data.campaignCopy.discovery, discovery); copiedStatus = 'missing'; result = await check(id); assert.equal(result.data.campaignCopy.verification, 'pending'); assert.equal((await review(id)).data.canCopy, false); } receiptOverride = undefined;
    for (const [index, failure] of [{ copiedCampaignId: 'bad/reference' }, { copiedCampaignId: 'malformed-1' }, { discovery: 'unknown' }, { platform: 'google' }, { profileId: 'foreign' }, { accountId: 'foreign' }, { platformAdAccountId: '999' }].entries()) {
      const id = 'malformed-' + index, r = await review(id); receiptOverride = failure; result = await sendCopy(id, 'facebook', r.data.version, id + '-key'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const before = writes.length; assert.equal((await sendCopy(id, 'facebook', r.data.version, id + '-new-key')).status, 409); assert.equal(writes.length, before); assert.equal((await review(id)).data.canCopy, false);
    } receiptOverride = undefined;
    for (const platform of ['tiktok', 'linkedin']) { nativeError = 400; const id = 'partial-' + platform, r = await review(id, platform); result = await sendCopy(id, platform, r.data.version, id + '-key'); assert.equal(result.data.operation.status, 'uncertain', 'Even a native 4xx may follow partially copied child objects.'); } nativeError = 0;
    const revoked = await review('revoked'); writeHook = () => role('viewer'); result = await sendCopy('revoked', 'facebook', revoked.data.version, 'revoked-copy-key'); assert.equal(result.data.operation.status, 'uncertain'); await role('owner'); writeHook = undefined;
    result = await review('revoked'); assert.equal(result.data.previousCopy.copiedCampaignId, 'revoked-copy'); assert.equal(result.data.unresolved, true); copiedStatus = 'PAUSED'; result = await check('revoked'); assert.equal(result.data.campaignCopy.verification, 'pending', 'An uncertain operation cannot become a confirmed owned copy from status alone.');
    const unknown = await review('unknown'); lostReceipt = true; result = await sendCopy('unknown', 'facebook', unknown.data.version, 'unknown-copy-key'); assert.equal(result.data.operation.status, 'uncertain'); lostReceipt = false;
    const originalProject = projectId; await app.sql.run('INSERT INTO projects(id,workspace_id,name,color,zernio_profile_id,drive_folder_id) VALUES(?,?,?,?,?,?)', 'copy-other-project', state.workspaces[0].id, 'Other copy project', '#000000', 'copy-other-profile', ''); projectId = 'copy-other-project';
    result = await review('unknown', 'instagram'); assert.equal(result.status, 200); assert.equal(result.data.unresolved, true); assert.equal(result.data.previousCopy, null); assert.equal(JSON.stringify(result.data).includes('unknown-copy'), false); const beforeOther = writes.length; assert.equal((await sendCopy('unknown', 'instagram', result.data.version, 'other-project-copy-key')).status, 409); assert.equal(writes.length, beforeOther); assert.equal((await check('revoked')).status, 404); projectId = originalProject;
    await app.close(); app = await open(); await listen(); result = await review('unknown'); assert.equal(result.data.unresolved, true); assert.equal(result.data.canCopy, false); assert.equal(result.data.previousCopy.copiedCampaignId, null); const beforeReopen = writes.length; assert.equal((await sendCopy('unknown', 'facebook', unknown.data.version, 'unknown-reopen-key')).status, 409); assert.equal(writes.length, beforeReopen);
    result = await review('revoked'); assert.equal(result.data.previousCopy.copiedCampaignId, 'revoked-copy', 'A reported native ID survives access revocation and reopening.');
    await app.sql.run("UPDATE integration_operations SET status='reviewed-not-applied' WHERE project_id=? AND request_key=?", projectId, 'unknown-copy-key'); result = await review('unknown'); assert.equal(result.data.canCopy, true); assert.equal(result.data.previousCopy, null); assert.equal(result.data.unresolved, false); result = await sendCopy('unknown', 'facebook', result.data.version, 'explicitly-reviewed-new-copy'); assert.equal(result.status, 200, 'An explicit not-applied outcome without a reported ID permits a freshly reviewed action.');
    accountActive = false; const beforeInactive = writes.length; assert.equal((await review('normal')).status, 409); assert.equal(writes.length, beforeInactive); accountActive = true;
    for (const query of ['campaignId=normal&platform=facebook&platform=instagram', 'campaignId=normal&platform=facebook&deepCopy=false']) assert.equal((await request(route() + '/copy-review?' + query)).status, 400);
    assert.equal((await app.store.list(projectId, 'campaigns')).length, 0, 'A reported provider copy never fabricates a locally owned campaign.'); assert.ok(reads.some(url => url.pathname === '/api/v1/ads/campaigns')); assert.ok(writes.every(write => write.method === 'POST' && write.url.pathname.endsWith('/duplicate')));
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP ads formats, native account dates, durable controls, published-copy boosts and scoped analytics work end to end', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-ads-qa-')), distDir = join(directory, 'dist'); await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Ads QA</title>');
  const origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir: directory, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'ads-http-fixture-key' } }), originalFetch = globalThis.fetch;
  const profileId = 'ads-http-profile', accounts = ['metaads', 'googleads', 'tiktokads', 'linkedinads', 'pinterestads', 'xads', 'openaiads', 'redditads', 'facebook', 'tiktok', 'reddit'].map(platform => ({ _id: platform, profileId, platform, isActive: true })), calls = [], writes = [];
  const campaign = { profileId, platform: 'facebook', platformCampaignId: 'managed-campaign', campaignName: 'Managed campaign', currency: 'USD', status: 'paused', budgetLevel: 'adset', adSets: [{ platformAdSetId: 'managed-set', adSetName: 'Managed set', budget: { amount: 20, type: 'daily' } }] };
  let ad = { _id: 'managed-ad', profileId, platform: 'facebook', platformCampaignId: 'managed-campaign', name: 'Managed ad', status: 'paused', configuredStatus: 'PAUSED', creative: {} };
  let ownerCookie, projectId, sequence = 0, adSetAcknowledged = true, renameAcknowledged = true, dashboardFailure = '', listFailure = '', scopeChanged = false, createAckFailure = {};
  let adSetStatusReceipt, adSetStatusDenied = false, treeHook, treeReads = 0;
  const remotePost = { _id: 'partial-post', status: 'partial', platforms: [{ platform: 'facebook', accountId: 'facebook', status: 'published', platformPostId: 'published-copy' }, { platform: 'tiktok', accountId: 'tiktok', status: 'failed' }, { platform: 'reddit', accountId: 'reddit', status: 'published', platformPostId: 't3_abc123' }] };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer ads-http-fixture-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, payload }); let result;
    if (method !== 'GET') writes.push({ url, method, payload });
    if (url.pathname === '/api/v1/accounts') result = { accounts };
    else if (url.pathname === '/api/v1/ads/accounts') { assert.ok(accounts.some(account => account._id === url.searchParams.get('accountId'))); result = { accounts: [{ id: 'native-account', currency: 'USD', selectable: true }] }; }
    else if (url.pathname === '/api/v1/ads/create' || url.pathname === '/api/v1/ads/boost') {
      assert.equal(payload.status, 'PAUSED'); assert.ok(payload.budgetType === 'daily' || payload.accountId === 'redditads' && payload.budgetType === 'lifetime'); assert.ok(options.headers['Idempotency-Key']);
      result = { ad: { _id: `created-ad-${++sequence}`, platformCampaignId: `created-campaign-${sequence}`, platform: payload.accountId === 'metaads' ? 'facebook' : payload.accountId === 'xads' ? 'twitter' : payload.accountId.replace(/ads$/, ''), status: 'paused', ...createAckFailure } };
      if (scopeChanged) await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'other-profile', projectId);
    } else if (url.pathname === '/api/v1/ads/tree') { treeReads++; await treeHook?.(treeReads); result = { campaigns: [campaign], pagination: { pages: 1 } }; }
    else if (url.pathname === '/api/v1/ads') result = { ads: [ad, { ...ad, _id: 'same-profile-other-campaign', platformCampaignId: 'different-campaign' }, { ...ad, _id: 'same-profile-other-network', platform: 'google' }, { ...ad, _id: 'foreign-profile-ad', profileId: 'private-other-profile' }], pagination: { pages: 1 } };
    else if (url.pathname === '/api/v1/ads/managed-ad' && method === 'GET') result = { ad, statusReadAt: '2026-10-18T12:00:00Z' };
    else if (url.pathname === '/api/v1/ads/managed-ad' && method === 'PUT') { ad = { ...ad, ...payload }; result = { ad }; }
    else if (url.pathname === '/api/v1/ads/managed-ad/status') { ad.configuredStatus = payload.status.toUpperCase(); result = { updated: 1, skipped: 0, configuredStatus: ad.configuredStatus, status: 'paused' }; }
    else if (url.pathname === '/api/v1/ads/campaigns/managed-campaign/status') result = { updated: 1, skipped: 0, status: payload.status, platformCampaignStatus: payload.status.toUpperCase(), statusReadAt: '2026-10-18T12:00:00Z' };
    else if (url.pathname === '/api/v1/ads/ad-sets/managed-set/status') {
      assert.equal(method, 'PUT'); assert.deepEqual(Object.keys(payload).sort(), ['platform', 'status']); assert.ok(options.headers['Idempotency-Key']);
      if (adSetStatusDenied) return Response.json({ error: 'Synthetic advertising permission denied.' }, { status: 403 });
      campaign.adSets[0].configuredStatus = payload.status.toUpperCase();
      result = adSetStatusReceipt;
    }
    else if (url.pathname === '/api/v1/ads/ad-sets/managed-set') {
      if (renameAcknowledged && payload.name) campaign.adSets[0].adSetName = payload.name;
      if (adSetAcknowledged && payload.budget) campaign.adSets[0].budget = payload.budget;
      result = { ...(adSetAcknowledged ? { budget: payload.budget } : {}) };
    } else if (url.pathname === '/api/v1/ads/campaigns/managed-campaign') { if (payload.name) campaign.campaignName = payload.name; result = { updated: 1, ...payload }; }
    else if (url.pathname === '/api/v1/posts/partial-post') result = { post: remotePost };
    else if (url.pathname === '/api/v1/ads/targeting/search') result = { results: [{ id: 'interest-1', name: 'Design', type: 'interest' }] };
    else if (url.pathname === '/api/v1/analytics/dashboard') {
      const fromDate = url.searchParams.get('fromDate'), toDate = url.searchParams.get('toDate'); assert.equal(url.searchParams.get('profileId'), profileId);
      result = { dateRange: { fromDate, toDate }, totals: { impressions: 0, reach: null, engagementRate: 0 }, followers: { current: 100, gained: -2, byAccount: [{ accountId: 'facebook', platform: 'facebook', current: 100, gained: -2 }] }, daily: [{ date: fromDate, impressions: 0 }], topPosts: [{ postId: 'report-post', platform: 'facebook', publishedAt: `${fromDate}T12:00:00Z`, metrics: { impressions: null, likes: 0 } }], recentPosts: [], dataAsOf: null };
      if (dashboardFailure === 'scope') result.followers.byAccount[0].accountId = 'foreign-account';
      if (dashboardFailure === 'metrics') result.totals.impressions = 'not-a-number';
      if (dashboardFailure === 'rows') result.topPosts = {};
      if (dashboardFailure === 'window') result.daily[0].date = '1900-01-01';
      if (dashboardFailure === 'duplicate') result.daily.push(result.daily[0]);
    } else if (url.pathname === '/api/v1/analytics') {
      assert.equal(url.searchParams.get('profileId'), profileId);
      result = { posts: [{ _id: 'report-post', profileId, analytics: { impressions: null, likes: 0 }, platforms: [{ accountId: 'facebook', platform: 'facebook' }] }], accounts: [accounts.find(account => account._id === 'facebook')], pagination: { pages: 1, page: 1 }, hasAnalyticsAccess: true };
      if (listFailure === 'profile') result.posts[0].profileId = 'foreign-profile';
      if (listFailure === 'account') result.posts[0].platforms[0].accountId = 'foreign-account';
      if (listFailure === 'shape') result.posts[0].platforms = [null];
    } else if (url.pathname === '/api/v1/analytics/daily-metrics') {
      assert.equal(url.searchParams.get('profileId'), profileId); assert.equal(url.searchParams.get('attribution'), 'received');
      result = { dailyData: [{ date: url.searchParams.get('fromDate'), postCount: 1, metrics: { impressions: 0, reach: null } }], platformBreakdown: [{ platform: 'facebook', impressions: 0 }] };
    } else throw new Error(`Unexpected fixture provider request ${method} ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', cookie = ownerCookie, key } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', { body: { name: 'Ads QA', email: 'ads-qa@example.test', password: 'a long local ads fixture password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data; projectId = state.projectId; const project = `/api/projects/${projectId}`, route = `${project}/integrations`;
    assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    const image = 'https://cdn.example.test/advert.jpg', video = { url: 'https://cdn.example.test/advert.mp4' }, linkUrl = 'https://example.test/launch';
    const basic = { name: 'QA campaign', goal: 'traffic', budgetAmount: 25, countries: ['AE'], headline: 'Launch campaign', body: 'Discover the collection.', linkUrl };
    const connection = platform => ({ ...basic, platform, accountId: platform === 'facebook' || platform === 'instagram' ? 'metaads' : platform === 'twitter' ? 'xads' : `${platform}ads`, adAccountId: 'native-account', ...(platform === 'reddit' ? { promotedObject: { pixelId: 'reddit-pixel' } } : {}) });
    const meta = { ...connection('facebook'), imageUrl: image, callToAction: 'LEARN_MORE' }, cards = [{ imageUrl: image, headline: 'First card' }, { imageUrl: 'https://cdn.example.test/card-two.jpg', headline: 'Second card' }];
    const { imageUrl: unusedImage, ...metaWithoutImage } = meta;
    const group = { finalUrl: linkUrl, businessName: 'QA Campaign', headlines: ['Launch the campaign', 'Explore the collection', 'Designed for every day'], descriptions: ['Discover our collection.', 'Find your favorite item.'], longHeadline: 'Explore the newest collection, designed for everyday life.', images: { landscape: [image], square: [image], logo: [image] } };
    const googleBase = { platform: 'google', accountId: 'googleads', adAccountId: 'native-account', name: 'Google QA', budgetAmount: 25, countries: ['AE'] };
    const demand = { finalUrl: linkUrl, businessName: 'QA Campaign', headlines: ['Discover the launch'], descriptions: ['Explore the collection.'], images: { square: [image], logo: [image] } };
    const formats = [meta, { ...metaWithoutImage, video }, { ...metaWithoutImage, carouselCards: cards }, { ...connection('instagram'), imageUrl: image, callToAction: 'LEARN_MORE' }, { ...connection('google'), campaignType: 'search', additionalHeadlines: ['Browse new arrivals', 'Shop the collection'], additionalDescriptions: ['Explore the newest collection.'], keywords: ['new collection'] }, { ...connection('google'), campaignType: 'display', businessName: 'QA Campaign', images: { landscape: image, square: image } }, { ...googleBase, campaignType: 'pmax', assetGroup: group }, { ...googleBase, campaignType: 'demand_gen', demandGen: demand }, { ...googleBase, campaignType: 'demand_gen', demandGen: { ...demand, images: { logo: [image] }, longHeadlines: ['Explore the latest collection'], youtubeVideoIds: ['dQw4w9WgXcQ'] } }, { ...googleBase, campaignType: 'demand_gen', demandGen: { ...demand, images: { logo: [image] }, carouselCards: cards.map(card => ({ headline: card.headline, images: { square: card.imageUrl } })) } }, { ...connection('tiktok'), imageUrl: video.url }, { ...connection('linkedin'), imageUrl: image }, { ...connection('linkedin'), video, goal: 'video_views', organizationId: 'urn:li:organization:123' }, { ...connection('pinterest'), imageUrl: image }, { ...connection('twitter'), imageUrl: image }, { ...connection('openai'), imageUrl: image }, { ...connection('reddit'), imageUrl: image }, { ...connection('reddit'), video: { ...video, thumbnailUrl: image } }, { ...connection('reddit'), carouselCards: cards }, { ...connection('reddit'), creativeFormat: 'text' }];
    delete formats.at(-1).linkUrl;
    for (const [index, body] of formats.entries()) { const result = await request(route + '/ads/create', { body, key: `format-http-${index}` }); assert.equal(result.status, 200, `${body.platform}/${body.campaignType || 'native'}: ${JSON.stringify(result.data)}`); assert.equal(result.data.campaign.status, 'paused'); }
    for (const goal of ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']) {
      const reddit = { ...connection('reddit'), goal, video: { ...video, thumbnailUrl: image }, promotedObject: { pixelId: 'reddit-pixel', ...(goal === 'conversions' ? { customEventType: 'purchase' } : {}) } };
      let result = await request(route + '/ads/create', { body: reddit, key: `reddit-${goal}-create` }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(writes.at(-1).payload.promotedObject.pixelId, 'reddit-pixel');
      if (goal === 'lead_generation') { assert.equal(writes.at(-1).payload.promotedObject.customEventType, 'LEAD'); assert.equal(writes.at(-1).payload.linkUrl, linkUrl); assert.equal(writes.at(-1).payload.leadGenFormId, undefined); }
      if (goal === 'conversions') assert.equal(writes.at(-1).payload.promotedObject.customEventType, 'PURCHASE');
      const before = writes.length; result = await request(route + '/ads/create', { body: { ...reddit, promotedObject: undefined }, key: `reddit-${goal}-missing-pixel` }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'REDDIT_PIXEL_REQUIRED'); assert.equal(writes.length, before);
      result = await request(route + '/ads/validate', { body: { ...reddit, promotedObject: undefined } }); assert.equal(result.status, 400); assert.equal(writes.length, before);
    }
    const redditImage = { ...connection('reddit'), imageUrl: image, body: '', callToAction: 'INSTALL_MOBILE_APP' };
    assert.equal((await request(route + '/ads/create', { body: redditImage, key: 'reddit-optional-body' })).status, 200); assert.equal(writes.at(-1).payload.body, undefined);
    const lifetime = { ...redditImage, budgetType: 'lifetime', endDate: '2070-01-04T00:00:00Z' };
    const lifetimeResult = await request(route + '/ads/create', { body: lifetime, key: 'reddit-lifetime' }); assert.equal(lifetimeResult.status, 200); assert.equal(lifetimeResult.data.campaign.budgetType, 'lifetime');
    const redditInvalidWrites = writes.length;
    for (const [index, invalid] of [{ ...lifetime, endDate: undefined }, { ...redditImage, goal: 'lead_generation', leadGenFormId: 'retired-form' }, { ...redditImage, goal: 'conversions' }, { ...redditImage, goal: 'conversions', promotedObject: { pixelId: 'reddit-pixel', customEventType: 'UNSUPPORTED' } }, { ...redditImage, imageUrl: undefined, creativeFormat: 'text', goal: 'lead_generation', linkUrl: undefined, callToAction: undefined, body: 'Website lead text' }].entries()) assert.equal((await request(route + '/ads/create', { body: invalid, key: `reddit-invalid-${index}` })).status, 400);
    assert.equal(writes.length, redditInvalidWrites);
    const beforeReplay = writes.length; await request(route + '/ads/create', { body: formats[0], key: 'format-http-0' }); assert.equal(writes.length, beforeReplay);
    let result = await request(route + '/ads/create', { body: { ...formats[4], startDate: '2070-01-02T00:15:00+04:00', endDate: '2070-01-02T00:15:00+04:00' }, key: 'google-one-day-campaign' }); assert.equal(result.status, 200); assert.equal(writes.at(-1).payload.startDate.slice(0, 10), '2070-01-02'); assert.equal(writes.at(-1).payload.endDate.slice(0, 10), '2070-01-02');
    const beforeInvalid = writes.length; result = await request(route + '/ads/create', { body: { ...meta, startDate: '2070-01-02T10:00:00Z', endDate: '2070-01-02T10:00:00Z' }, key: 'reject-zero-length-meta' }); assert.equal(result.status, 400); assert.equal(writes.length, beforeInvalid);
    result = await request(route + '/ads/items?campaignId=managed-campaign&platform=facebook'); assert.equal(result.status, 200); assert.deepEqual(result.data.ads.map(row => row._id), ['managed-ad']);
    assert.equal((await request(route + '/ads/details?adId=managed-ad')).status, 200);
    for (const platform of ['tiktok', 'reddit']) { ad.platform = platform; const before = writes.length; result = await request(route + '/ads/edit', { body: { adId: ad._id, name: 'Unsupported rename' }, key: `reject-${platform}-rename` }); assert.equal(result.status, 422); assert.equal(writes.length, before); } ad.platform = 'facebook';
    ad.platform = 'tiktok'; ad.isSmartPlus = true; const beforeSmartPlus = writes.length; result = await request(route + '/ads/edit', { body: { adId: ad._id, creative: { body: 'Unsupported Smart+ creative edit' } }, key: 'reject-smart-plus-creative' }); assert.equal(result.status, 422); assert.equal(writes.length, beforeSmartPlus); ad.platform = 'facebook'; delete ad.isSmartPlus;
    result = await request(route + '/ads/edit', { body: { adId: ad._id, name: 'Renamed Meta ad', creative: { body: 'Changed campaign copy' } }, key: 'edit-http-meta-copy' }); assert.equal(result.status, 200);
    assert.equal((await request(route + '/ads/ad-status', { body: { adId: ad._id, status: 'active' }, key: 'enable-http-ad' })).status, 200);
    assert.equal((await request(route + '/ads/status', { body: { campaignId: campaign.platformCampaignId, platform: 'facebook', status: 'active' }, key: 'enable-http-campaign' })).status, 200);
    const statusBody = { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', status: 'active' }, statusPath = route + '/ads/adset';
    const acceptedStatus = { status: 'paused', platformAdSetStatus: 'CAMPAIGN_PAUSED', platformCampaignStatus: 'PAUSED', statusReadAt: '2026-10-18T12:00:00Z', updated: 1, skipped: 0, skippedReasons: [] };
    campaign.accountId = 'metaads'; campaign.platformAdAccountId = 'native-account'; campaign.adSets[0].status = 'paused';
    campaign.adSets.push({ platformAdSetId: 'sibling-set', adSetName: 'Untouched sibling', status: 'paused', configuredStatus: 'PAUSED' });
    const localManaged = await app.store.create(projectId, 'campaigns', { name: 'Local managed receipt', channel: 'paid', platform: 'facebook', externalId: ad._id, platformCampaignId: campaign.platformCampaignId, zernioProfileId: profileId, status: 'paused' }), localBeforeStatus = structuredClone(localManaged), siblingBeforeStatus = structuredClone(campaign.adSets[1]), adBeforeStatus = structuredClone(ad);
    adSetStatusReceipt = acceptedStatus;
    result = await request(statusPath, { body: statusBody, key: 'adset-own-switch-active' }); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(writes.at(-1).payload, { platform: 'facebook', status: 'active' }); assert.equal(writes.at(-1).url.pathname, '/api/v1/ads/ad-sets/managed-set/status');
    assert.deepEqual(result.data.statusAcceptance, { campaignId: statusBody.campaignId, platform: 'facebook', adSetId: 'managed-set', requestedStatus: 'active', deliveryStatus: 'paused', platformAdSetStatus: 'CAMPAIGN_PAUSED', platformCampaignStatus: 'PAUSED', statusReadAt: acceptedStatus.statusReadAt, updated: 1, skipped: 0, skippedReasons: [] });
    assert.equal(campaign.status, 'paused'); assert.deepEqual(campaign.adSets[1], siblingBeforeStatus); assert.deepEqual(ad, adBeforeStatus); assert.deepEqual(await app.store.get(projectId, 'campaigns', localManaged.id), localBeforeStatus, 'Accepting an ad-set switch must not relabel its parent, siblings or ads.');
    const beforeStatusReplay = writes.length; result = await request(statusPath, { body: statusBody, key: 'adset-own-switch-active' }); assert.equal(result.status, 200); assert.equal(writes.length, beforeStatusReplay); assert.equal(result.data.statusAcceptance.requestedStatus, 'active');
    for (const platform of ['instagram', 'google', 'tiktok', 'linkedin', 'pinterest', 'twitter', 'openai', 'reddit']) {
      campaign.platform = platform; campaign.accountId = connection(platform).accountId;
      adSetStatusReceipt = platform === 'twitter' ? { status: 'active', platformAdSetStatus: null, platformCampaignStatus: 'PAUSED', statusReadAt: null, updated: 1, skipped: 0 } : { ...acceptedStatus };
      result = await request(statusPath, { body: { ...statusBody, platform }, key: 'adset-switch-' + platform }); assert.equal(result.status, 200, platform + ': ' + JSON.stringify(result.data)); assert.equal(result.data.statusAcceptance.platform, platform);
      if (platform === 'twitter') { assert.equal(result.data.statusAcceptance.statusReadAt, null); assert.equal(result.data.statusAcceptance.platformAdSetStatus, null); assert.equal(result.data.statusAcceptance.platformCampaignStatus, 'PAUSED'); assert.deepEqual(result.data.statusAcceptance.skippedReasons, []); }
    }
    campaign.platform = 'twitter'; campaign.accountId = 'xads';
    for (const [field, value] of [['platformAdSetStatus', 'ACTIVE'], ['statusReadAt', acceptedStatus.statusReadAt]]) {
      adSetStatusReceipt = { ...acceptedStatus, platformAdSetStatus: null, statusReadAt: null, [field]: value };
      result = await request(statusPath, { body: { ...statusBody, platform: 'twitter' }, key: 'adset-x-invalid-' + field }); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(result.data.statusAcceptance, undefined, 'X cannot supply live ad-set switch reads.');
      await app.sql.run("UPDATE integration_operations SET status='reviewed-not-applied' WHERE id=? AND status='uncertain'", result.data.operation.id);
    }
    campaign.platform = 'facebook'; campaign.accountId = 'metaads';
    adSetStatusReceipt = { ...acceptedStatus, updated: 0, skipped: 1, skippedReasons: ['Ad set already switched on\r\nNo new write\tneeded'] };
    result = await request(statusPath, { body: statusBody, key: 'adset-switch-already-on' }); assert.equal(result.status, 200); assert.equal(result.data.statusAcceptance.skipped, 1); assert.equal(result.data.statusAcceptance.deliveryStatus, 'paused');
    const beforeInvalidStatus = writes.length;
    for (const [index, body] of [{ ...statusBody, status: 'deleted' }, { ...statusBody, name: 'Mixed rename' }, { ...statusBody, budget: { amount: 30, type: 'daily' } }, { ...statusBody, adSetId: 'foreign-set' }, { ...statusBody, campaignId: 'foreign-campaign' }].entries()) { result = await request(statusPath, { body, key: 'adset-invalid-status-' + index }); assert.ok(result.status >= 400); assert.equal(writes.length, beforeInvalidStatus); }
    assert.equal((await request(statusPath, { body: statusBody, cookie: null, key: 'adset-switch-no-session' })).status, 401);
    const workspaceId = state.workspaces[0].id, setOwnerRole = role => app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', role, workspaceId, state.user.id);
    await setOwnerRole('viewer'); assert.equal((await request(statusPath, { body: statusBody, key: 'adset-switch-viewer' })).status, 403); await setOwnerRole('owner'); assert.equal(writes.length, beforeInvalidStatus);
    const currentCampaign = structuredClone(campaign);
    for (const [change, mutate] of [
      ['removed-set', () => { campaign.adSets[0].platformAdSetId = 'different-set'; }],
      ['unreadable-sets', () => { campaign.adSets = {}; }],
      ['terminal-campaign', () => { campaign.status = 'archived'; }],
      ['terminal-set', () => { campaign.adSets[0].status = 'deleted'; }],
      ['account', () => { campaign.accountId = 'different-account'; }],
      ['advertiser', () => { campaign.platformAdAccountId = 'different-advertiser'; }],
      ['role', () => setOwnerRole('viewer')],
      ['profile', () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'changed-profile', projectId)],
    ]) {
      treeReads = 0; treeHook = async read => { if (read === 2) await mutate(); };
      result = await request(statusPath, { body: statusBody, key: 'adset-late-' + change }); assert.ok(result.status >= 400, change + ': ' + JSON.stringify(result.data)); assert.equal(writes.length, beforeInvalidStatus, change + ' must be rechecked before the status write.');
      treeHook = undefined; Object.assign(campaign, structuredClone(currentCampaign)); await setOwnerRole('owner'); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId);
    }
    adSetStatusDenied = true; result = await request(statusPath, { body: statusBody, key: 'adset-provider-grant-revoked' }); assert.equal(result.data.operation.status, 'failed'); assert.equal(result.data.statusAcceptance, undefined); adSetStatusDenied = false;
    const malformedStatuses = [{ updated: true }, { updated: 2 }, { skipped: 1 }, { updated: 0, skipped: 0 }, { status: 'unknown' }, { platformAdSetStatus: {} }, { platformCampaignStatus: 123 }, { statusReadAt: 'not-an-instant' }, { skippedReasons: null }, { skippedReasons: [{}] }, { skippedReasons: ['bad\u0000reason'] }, { profileId: 'foreign-profile' }, { platform: 'google' }, { platform: { _id: 'facebook' } }, { adSetId: 'foreign-set' }, { platformAdSetId: 'foreign-set' }, { campaignId: 'foreign-campaign' }, { accountId: 'foreign-account' }, { platformAdAccountId: 'foreign-advertiser' }];
    for (const [index, receipt] of malformedStatuses.entries()) {
      adSetStatusReceipt = { ...acceptedStatus, ...receipt }; const key = 'adset-malformed-receipt-' + index, before = writes.length;
      result = await request(statusPath, { body: statusBody, key }); assert.equal(result.status, 409, JSON.stringify(receipt)); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(result.data.statusAcceptance, undefined); assert.equal(writes.length, before + 1);
      const operationId = result.data.operation.id; result = await request(statusPath, { body: statusBody, key }); assert.equal(result.status, 409); result = await request(statusPath, { body: statusBody, key: key + '-new' }); assert.equal(result.status, 409); assert.equal(writes.length, before + 1, 'An unknown status outcome blocks both replay and a fresh intent key.');
      await app.sql.run("UPDATE integration_operations SET status='reviewed-not-applied' WHERE id=? AND status='uncertain'", operationId);
    }
    adSetStatusReceipt = { ...acceptedStatus, platformAdSetStatus: 'PAUSED', profileId: { _id: profileId }, platform: 'facebook', accountId: { _id: 'metaads' }, platformAdAccountId: 'native-account', campaignId: campaign.platformCampaignId, adSetId: 'managed-set' };
    result = await request(statusPath, { body: { ...statusBody, status: 'paused' }, key: 'adset-own-switch-pause' }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.statusAcceptance.requestedStatus, 'paused'); assert.deepEqual(writes.at(-1).payload, { platform: 'facebook', status: 'paused' }); assert.deepEqual(ad, adBeforeStatus); assert.deepEqual(campaign.adSets[1], siblingBeforeStatus); assert.deepEqual(await app.store.get(projectId, 'campaigns', localManaged.id), localBeforeStatus);
    adSetStatusReceipt = acceptedStatus;
    result = await request(route + '/ads/adset', { body: { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', name: 'Renamed set' }, key: 'edit-http-adset' }); assert.equal(result.status, 200); assert.equal(campaign.adSets[0].adSetName, 'Renamed set');
    const beforeLegacyBudget = writes.length; const badBudget = { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', budget: { amount: 31, type: 'daily' } }; result = await request(route + '/ads/adset', { body: badBudget, key: 'unconfirmed-http-adset-budget' }); assert.equal(result.status, 400); assert.equal(writes.length, beforeLegacyBudget, 'Legacy budget writes must load an explicit review.');
    await app.sql.run("UPDATE integration_operations SET status='reviewed-applied' WHERE status='uncertain'");
    renameAcknowledged = false; result = await request(route + '/ads/adset', { body: { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', name: 'Not actually renamed' }, key: 'unconfirmed-http-adset-name' }); assert.equal(result.data.operation.status, 'uncertain'); renameAcknowledged = true;
    const localPost = await app.store.create(projectId, 'posts', { content: 'Partially published launch', status: 'partial', externalId: 'partial-post', zernioProfileId: profileId, platforms: ['facebook', 'tiktok'] });
    const boost = { platform: 'facebook', accountId: 'facebook', adAccountId: 'native-account', name: 'Boost published Facebook copy', goal: 'engagement', budgetAmount: 25, countries: ['AE'], postId: localPost.id };
    result = await request(route + '/ads/boost', { body: boost, key: 'boost-successful-partial-copy' }); assert.equal(result.status, 200);
    const redditBoost = { ...boost, platform: 'reddit', accountId: 'redditads', goal: 'traffic', promotedObject: { pixelId: 'reddit-pixel' } };
    for (const goal of ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']) {
      const body = { ...redditBoost, goal, linkUrl, promotedObject: { pixelId: 'reddit-pixel', ...(goal === 'conversions' ? { customEventType: 'PURCHASE' } : {}) } };
      result = await request(route + '/ads/boost', { body, key: `reddit-${goal}-boost` }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(writes.at(-1).payload.postId, 'partial-post'); assert.deepEqual(writes.at(-1).payload.targeting.countries, ['AE']); assert.equal(writes.at(-1).payload.promotedObject.pixelId, 'reddit-pixel');
      const before = writes.length; result = await request(route + '/ads/boost', { body: { ...body, promotedObject: undefined }, key: `reddit-${goal}-boost-no-pixel` }); assert.equal(result.status, 400); assert.equal(writes.length, before);
    }
    result = await request(route + '/ads/boost', { body: { ...redditBoost, budgetType: 'lifetime', endDate: '2070-01-04T00:00:00Z' }, key: 'reddit-lifetime-boost' }); assert.equal(result.status, 200); assert.equal(result.data.campaign.budgetType, 'lifetime');
    const redditBoostWrites = writes.length; remotePost.platforms[2].accountId = 'foreign-reddit-account'; result = await request(route + '/ads/boost', { body: redditBoost, key: 'reddit-foreign-organic-copy' }); assert.equal(result.status, 403); assert.equal(writes.length, redditBoostWrites); remotePost.platforms[2].accountId = 'reddit';
    const beforeRedditReplay = writes.length; assert.equal((await request(route + '/ads/boost', { body: { ...redditBoost, goal: 'traffic', linkUrl }, key: 'reddit-traffic-boost' })).status, 200); assert.equal(writes.length, beforeRedditReplay);
    const badAcknowledgements = [{ platform: undefined }, { platform: null }, { platform: 'unknown-network' }, { platform: 'google' }, { profileId: 'foreign-profile' }, { accountId: 'foreign-connection' }, { platformAdAccountId: 'foreign-native-account' }, { _id: '' }, { platformCampaignId: 123 }];
    for (const [index, failure] of badAcknowledgements.entries()) {
      createAckFailure = failure;
      for (const action of ['create', 'boost']) {
        const body = { ...(action === 'create' ? meta : boost), name: `Malformed ${action} acknowledgement ${index}` }, before = (await app.store.list(projectId, 'campaigns')).length;
        result = await request(route + '/ads/' + action, { body, key: `bad-${action}-ack-${index}` }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal((await app.store.list(projectId, 'campaigns')).length, before);
        const afterFirst = writes.length; result = await request(route + '/ads/' + action, { body, key: `bad-${action}-ack-retry-${index}` }); assert.equal(result.status, 409); assert.equal(writes.length, afterFirst, 'A fresh action key cannot duplicate a creation whose acknowledgement is unsafe.');
      }
    }
    createAckFailure = {};
    for (const action of ['create', 'boost']) {
      createAckFailure = { platform: 'instagram', profileId: { _id: profileId }, accountId: { _id: action === 'create' ? 'metaads' : 'facebook' }, platformAdAccountId: 'native-account' };
      result = await request(route + '/ads/' + action, { body: { ...(action === 'create' ? meta : boost), name: `Validated Meta acknowledgement ${action}` }, key: `valid-meta-${action}-scope` }); assert.equal(result.status, 200); assert.equal(result.data.campaign.platform, 'instagram', 'The local campaign uses the provider’s validated Meta network, so its management controls can find it again.');
    }
    createAckFailure = {};
    remotePost.platforms[0].platform = 'instagram'; const beforeWrongBoost = writes.length; result = await request(route + '/ads/boost', { body: boost, key: 'reject-mismatched-boost-copy' }); assert.equal(result.status, 403); assert.equal(writes.length, beforeWrongBoost); remotePost.platforms[0].platform = 'facebook';
    remotePost.platforms[1] = { platform: 'tiktok', accountId: 'tiktok', status: 'published', platformSpecificData: { isDraft: true } }; result = await request(route + '/ads/boost', { body: { ...boost, platform: 'tiktok', accountId: 'tiktok' }, key: 'reject-tiktok-draft-boost' }); assert.equal(result.status, 403); assert.equal(writes.length, beforeWrongBoost);
    const window = '?fromDate=2026-10-01&toDate=2026-10-02'; result = await request(route + '/analytics/dashboard' + window); assert.equal(result.status, 200); assert.equal(result.data.totals.impressions, 0); assert.equal(result.data.totals.reach, null); assert.equal(result.data.followers.gained, -2); assert.equal(result.data.topPosts[0].metrics.impressions, null);
    for (const failure of ['scope', 'metrics', 'rows', 'window', 'duplicate']) { dashboardFailure = failure; result = await request(route + '/analytics/dashboard' + window); assert.equal(result.status, 502, failure); assert.equal(result.data.totals, undefined); } dashboardFailure = '';
    result = await request(route + '/analytics/dashboard?fromDate=2025-01-01&toDate=2026-01-01'); assert.equal(result.status, 200); const beforeLongReport = calls.length; result = await request(route + '/analytics/dashboard?fromDate=2025-01-01&toDate=2026-01-02'); assert.equal(result.status, 400); assert.equal(calls.length, beforeLongReport);
    result = await request(route + '/analytics' + window); assert.equal(result.status, 200); assert.equal(result.data.complete, true); assert.equal(result.data.posts[0].analytics.impressions, null);
    for (const failure of ['profile', 'account', 'shape']) { listFailure = failure; result = await request(route + '/analytics' + window); assert.equal(result.status, 502); assert.equal(result.data.posts, undefined); } listFailure = '';
    result = await request(route + '/analytics/daily' + window); assert.equal(result.status, 200); assert.equal(result.data.dailyData[0].metrics.impressions, 0); assert.equal(result.data.dailyData[0].metrics.reach, null);
    assert.equal((await request(route + '/analytics/dashboard' + window, { cookie: null })).status, 401);
    scopeChanged = true; const beforeRemap = (await app.store.list(projectId, 'campaigns')).length; result = await request(route + '/ads/create', { body: { ...meta, name: 'Connection changed during accepted creation' }, key: 'remapped-http-ad-create' }); assert.equal(result.data.operation.status, 'uncertain'); assert.equal((await app.store.list(projectId, 'campaigns')).length, beforeRemap);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('HTTP live ad reviews remain read-only, scoped and honest about unknown verdicts and native read time', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-ad-review-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const app = await testApp(t, { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'ad-review-fixture-key' } }), profileId = 'ad-review-profile', calls = [], writes = [];
  const originalAd = { _id: 'review-ad', profileId, platform: 'facebook', platformAdId: 'native-review-ad', platformCampaignId: 'review-campaign', platformAdSetId: 'review-set', accountId: 'metaads', platformAdAccountId: 'native-advertiser', status: 'paused', configuredStatus: 'PAUSED', creative: { body: 'Unchanged creative' } };
  const metaReview = { approved: null, reviewStatus: 'PAUSED', readAt: '2026-10-19T12:00:00Z', forbiddenPlacements: ['instagram'], rejections: [{ reasons: ['Policy <script>literal()</script>'], forbiddenPlacements: ['instagram'], content: { type: 'MODE_STRING', text: '<img src="https://example.test/inert">' } }], reviewFeedback: { global: { policy: 'Explanation\r\nSecond line' }, placementSpecific: { instagram: { placement: 'Not eligible for this placement' } } }, issues: [{ error_code: 123, error_message: '<b>Literal issue</b>', details: { requiresReview: true } }] };
  let ad = structuredClone(originalAd), receipt = { adId: ad._id, platform: ad.platform, platformAdId: ad.platformAdId, review: structuredClone(metaReview) }, reviewHook, providerFailure = 0, ownerCookie, projectId;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer ad-review-fixture-key');
    const method = options.method || 'GET'; calls.push(url.pathname); if (method !== 'GET') writes.push({ path: url.pathname, method }); assert.equal(method, 'GET', 'Loading a verdict must never enable, edit or otherwise write an ad.');
    if (url.pathname === '/api/v1/ads') return Response.json({ ads: [ad], pagination: { pages: 1 } });
    assert.equal(url.pathname, '/api/v1/ads/review-ad/review'); assert.equal(url.search, ''); assert.equal(options.body, undefined);
    const result = structuredClone(receipt); await reviewHook?.();
    return providerFailure ? Response.json({ error: 'Synthetic review unavailable' }, { status: providerFailure }) : Response.json(result);
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', cookie = ownerCookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', { body: { name: 'Review QA', email: 'ad-review@example.test', password: 'a long review fixture password' } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data; projectId = state.projectId;
    assert.equal((await request(`/api/projects/${projectId}`, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    const path = `/api/projects/${projectId}/integrations/ads/review?adId=review-ad`, role = value => app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', value, state.workspaces[0].id, state.user.id);
    let result = await request(path); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.adId, originalAd._id); assert.equal(result.data.platformAdId, originalAd.platformAdId); assert.equal(result.data.review.approved, null); assert.equal(result.data.review.reviewStatus, 'PAUSED'); assert.equal(result.data.review.readAt, metaReview.readAt); assert.deepEqual(result.data.review.reviewFeedback, metaReview.reviewFeedback); assert.deepEqual(result.data.review.issues, metaReview.issues); assert.equal(result.data.review.rejections[0].content.text, metaReview.rejections[0].content.text); assert.equal(result.data.review.rejections[0].suggestion, null); assert.deepEqual(calls.slice(-3), ['/api/v1/ads', '/api/v1/ads/review-ad/review', '/api/v1/ads']);
    receipt.review.policyTopics = [{ topic: 'Benign policy', type: 'LIMITED', evidences: [{ textList: { texts: ['Retained evidence'], access_token: 'SYNTHETIC_PRIVATE' }, authorization: 'SYNTHETIC_PRIVATE' }], constraints: [{ countryConstraint: { countries: ['AE'], credentials: { value: 'SYNTHETIC_PRIVATE' } } }] }];
    receipt.review.issues = [{ error_message: 'Retained issue', details: { api_key: 'SYNTHETIC_PRIVATE', private_key: 'SYNTHETIC_PRIVATE', nested: { password: 'SYNTHETIC_PRIVATE', note: 'Retained nested note' } } }];
    result = await request(path); assert.equal(result.status, 200); assert.equal(result.data.review.policyTopics[0].topic, 'Benign policy'); assert.deepEqual(result.data.review.policyTopics[0].evidences, [{ textList: { texts: ['Retained evidence'] } }]); assert.deepEqual(result.data.review.policyTopics[0].constraints, [{ countryConstraint: { countries: ['AE'] } }]); assert.deepEqual(result.data.review.issues, [{ error_message: 'Retained issue', details: { nested: { note: 'Retained nested note' } } }]); assert.equal(JSON.stringify(result.data).includes('SYNTHETIC_PRIVATE'), false);
    await role('viewer'); assert.equal((await request(path)).status, 200, 'Review reads are available without editing permission.'); await role('owner');
    const reviews = {
      instagram: metaReview,
      google: { approved: true, approvalStatus: 'APPROVED_LIMITED', reviewStatus: 'REVIEWED', policyTopics: [{ topic: 'Sensitive content', type: 'LIMITED', evidences: [{ textList: { texts: ['<script>literal evidence</script>'] } }], constraints: [{ countryConstraint: { countries: ['AE'] } }] }] },
      tiktok: { approved: false, reviewStatus: 'UNAVAILABLE', forbiddenAges: ['AGE_13_17'], forbiddenLocations: ['AE'], forbiddenOperatingSystems: ['ANDROID'], rejections: [{ reasons: ['Rejected text'], suggestion: 'Change this wording', content: { type: 'MODE_STRING', text: 'Reviewed text', imageId: null, videoId: null, musicId: null } }] },
    };
    for (const [platform, review] of Object.entries(reviews)) {
      ad.platform = platform; receipt = { adId: ad._id, platform, platformAdId: ad.platformAdId, review };
      result = await request(path); assert.equal(result.status, 200, platform + ': ' + JSON.stringify(result.data)); assert.equal(result.data.review.approved, review.approved); assert.equal(result.data.review.readAt, review.readAt ?? null); assert.equal(result.data.platform, platform);
      if (platform === 'google') assert.deepEqual(result.data.review.policyTopics, review.policyTopics);
      if (platform === 'tiktok') assert.deepEqual(result.data.review.forbiddenOperatingSystems, review.forbiddenOperatingSystems);
    }
    ad = structuredClone(originalAd); receipt = { adId: ad._id, platform: ad.platform, review: {} };
    result = await request(path); assert.equal(result.status, 200); assert.equal(result.data.platformAdId, null); assert.equal(result.data.review.approved, null); assert.equal(result.data.review.readAt, null); assert.equal(result.data.review.reviewStatus, null); assert.deepEqual(result.data.review.rejections, []); assert.deepEqual(result.data.review.policyTopics, []); assert.deepEqual(result.data.review.reviewFeedback, { global: {}, placementSpecific: {} });
    const beforeUnsupported = calls.length;
    for (const platform of ['linkedin', 'pinterest', 'twitter', 'openai', 'reddit']) { ad.platform = platform; result = await request(path); assert.equal(result.status, 422); }
    assert.equal(calls.slice(beforeUnsupported).filter(value => value.endsWith('/review')).length, 0);
    ad = structuredClone(originalAd);
    for (const query of ['adId=foreign-ad', 'adId=review-ad&adId=foreign-ad', 'adId=review-ad&live=false']) { result = await request(path.split('?')[0] + '?' + query); assert.ok(result.status >= 400); assert.equal(result.data.review, undefined); }
    assert.equal((await request(path, { cookie: null })).status, 401);
    const validReceipt = { adId: ad._id, platform: ad.platform, platformAdId: ad.platformAdId, review: structuredClone(metaReview) };
    const nested = {}; let branch = nested; for (let index = 0; index < 10; index++) { branch.next = {}; branch = branch.next; }
    for (const [index, failure] of [
      { adId: 'foreign-ad' }, { platform: 'google' }, { platform: 'meta' }, { platformAdId: 'foreign-native-ad' }, { platformAdId: null }, { profileId: 'foreign-profile' }, { accountId: 'foreign-account' }, { review: null },
      { review: { approved: 'true' } }, { review: { reviewStatus: [] } }, { review: { readAt: null } }, { review: { readAt: '2026-02-30T12:00:00Z' } }, { review: { forbiddenPlacements: null } },
      { review: { rejections: [null] } }, { review: { rejections: [{ reasons: 'not-a-list' }] } }, { review: { rejections: [{ content: [] }] } }, { review: { rejections: [{ content: { text: 123 } }] } },
      { review: { policyTopics: [{ evidences: [null] }] } }, { review: { reviewFeedback: null } }, { review: { reviewFeedback: { global: { policy: false } } } }, { review: { issues: [nested] } },
      { review: { issues: [{ constructor: 'unsafe key' }] } }, { review: { reviewStatus: 'bad\u0000status' } }, { review: { reviewStatus: 'x'.repeat(20001) } }, { review: { forbiddenAges: Array(101).fill('AGE_13_17') } },
    ].entries()) {
      receipt = { ...validReceipt, ...failure }; result = await request(path); assert.equal(result.status, 502, 'malformed review ' + index + ': ' + JSON.stringify(result.data)); assert.equal(result.data.review, undefined);
    }
    receipt = validReceipt;
    for (const [field, value] of [['platformAdId', 'different-native-ad'], ['accountId', 'different-account'], ['platformAdAccountId', 'different-advertiser'], ['platformCampaignId', 'different-campaign'], ['platformAdSetId', 'different-set'], ['platform', 'google'], ['profileId', 'foreign-profile']]) {
      reviewHook = () => { ad[field] = value; }; result = await request(path); assert.ok(result.status >= 400, field + ': ' + JSON.stringify(result.data)); assert.equal(result.data.review, undefined); ad = structuredClone(originalAd);
    }
    reviewHook = () => role('viewer'); result = await request(path); assert.ok(result.status >= 400); assert.equal(result.data.review, undefined); await role('owner');
    reviewHook = () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'changed-profile', projectId); result = await request(path); assert.ok(result.status >= 400); assert.equal(result.data.review, undefined); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId);
    reviewHook = () => { ad.status = 'rejected'; ad.metrics = { spend: 1 }; ad.creative = { body: 'Changed independently' }; }; result = await request(path); assert.equal(result.status, 200, 'Independent delivery/creative/metric changes must not change the ad identity.');
    reviewHook = undefined; providerFailure = 404; result = await request(path); assert.ok(result.status >= 400); assert.equal(result.data.review, undefined); providerFailure = 0;
    assert.deepEqual(writes, []); assert.equal((await app.store.list(projectId, 'campaigns')).length, 0); assert.equal((await app.sql.get('SELECT count(*) AS count FROM integration_operations')).count, 0, 'A review read creates no mutation receipt.');
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});


test('HTTP reviewed Meta daily budgets bind normalized live currency/proposal and fence unknown outcomes without changing delivery switches', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-adset-budget-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch;
  const config = { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'budget-fixture-key' } }, profileId = 'budget-profile', calls = [], writes = [];
  const database = await testDatabase(t), open = async () => Object.assign(await createApp({ ...config, database: { pool: database.pool, db: database.db } }), { sql: database.sql });
  let app = await open();
  let cookie, projectId, workspaceId, userId, liveMode = '', afterWriteMode = '', acknowledgement = {}, treeHook, treeReads = 0, lateMutation, lateReads = 0, active = true, connection = {}, selectable = true, currentAmount = 20, nativeCampaignBudget = false;
  const campaign = { profileId, platform: 'facebook', platformCampaignId: 'budget-campaign', accountId: 'metaads', platformAdAccountId: 'act_123', campaignName: 'Budget campaign', currency: 'AED', status: 'paused', budgetLevel: 'adset', campaignBudget: null, adSets: [{ platformAdSetId: 'budget-set', adSetName: 'Budget set', status: 'paused', configuredStatus: 'PAUSED', adSetBudget: { amount: 20, type: 'daily' } }, { platformAdSetId: 'sibling-set', status: 'active', configuredStatus: 'ACTIVE' }] };
  const reset = async () => { campaign.platform = 'facebook'; campaign.currency = 'AED'; campaign.status = 'paused'; campaign.accountId = 'metaads'; campaign.platformAdAccountId = 'act_123'; campaign.budgetLevel = 'adset'; campaign.campaignBudget = null; campaign.adSets[0] = { platformAdSetId: 'budget-set', adSetName: 'Budget set', status: 'paused', configuredStatus: 'PAUSED', adSetBudget: { amount: 20, type: 'daily' } }; active = selectable = true; connection = {}; currentAmount = 20; nativeCampaignBudget = false; liveMode = afterWriteMode = ''; acknowledgement = {}; treeHook = lateMutation = undefined; lateReads = treeReads = 0; if (workspaceId) await app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', 'owner', workspaceId, userId); if (projectId) await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId); };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); const method = options.method || 'GET', payload = options.body && JSON.parse(options.body); calls.push({ url, method, payload });
    if (method !== 'GET') writes.push({ path: url.pathname, payload }); let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [{ _id: 'metaads', profileId: url.searchParams.get('profileId'), platform: 'metaads', isActive: active, ...connection }] };
    else if (url.pathname === '/api/v1/ads/accounts') result = { accounts: [{ id: 'act_123', currency: campaign.currency, selectable, minimumDailyBudget: 999 }] };
    else if (url.pathname === '/api/v1/ads/tree') { treeReads++; await treeHook?.(treeReads); if (lateReads && --lateReads === 0) await lateMutation?.(); result = { campaigns: [{ ...campaign, profileId: url.searchParams.get('profileId') }], pagination: { pages: 1 } }; }
    else if (url.pathname === '/api/v1/ads/accounts/live') {
      assert.equal(method, 'GET'); assert.equal(url.searchParams.get('accountId'), 'metaads'); assert.equal(url.searchParams.get('adAccountId'), 'act_123'); assert.equal(url.searchParams.get('limit'), '500');
      const parent = { platformCampaignId: 'budget-campaign', budget: nativeCampaignBudget ? { amount: currentAmount, type: 'daily' } : null, dailyBudget: nativeCampaignBudget ? currentAmount : null, lifetimeBudget: null, configuredStatus: 'PAUSED', platformCampaignStatus: 'PAUSED', status: 'paused' }, set = { platformAdSetId: 'budget-set', platformCampaignId: 'budget-campaign', budget: nativeCampaignBudget ? null : { amount: currentAmount, type: 'daily' }, dailyBudget: nativeCampaignBudget ? null : currentAmount, lifetimeBudget: null, configuredStatus: 'PAUSED', platformAdSetStatus: 'CAMPAIGN_PAUSED', status: 'paused' };
      result = { accountId: 'metaads', adAccountId: 'act_123', platform: 'facebook', currency: campaign.currency, readAt: new Date().toISOString(), campaigns: [parent], adSets: [set], paging: {} };
      if (liveMode === 'currency') result.currency = 'USD'; if (liveMode === 'foreign-account') result.accountId = 'foreign'; if (liveMode === 'foreign-parent') set.platformCampaignId = 'foreign'; if (liveMode === 'stale') result.readAt = new Date(Date.now() - 120000).toISOString(); if (liveMode === 'timestamp') result.readAt = '0'; if (liveMode === 'duplicate') result.adSets.push({ ...set }); if (liveMode === 'cbo') { parent.budget = { amount: 50, type: 'daily' }; parent.dailyBudget = 50; } if (liveMode === 'lifetime') { const target = nativeCampaignBudget ? parent : set; target.budget.type = 'lifetime'; target.lifetimeBudget = currentAmount; } if (liveMode === 'missing') result.adSets = []; if (liveMode === 'paging') result.paging.adSets = 'unreadable'; if (liveMode === 'cycle') result.paging.adSets = { after: 'same-cursor' };
      if (liveMode === 'paginated') { if (!url.searchParams.has('after')) { result.adSets = []; result.paging.adSets = { after: 'next/page+=?&token' }; } else { assert.equal(url.searchParams.get('level'), 'adSet'); delete result.campaigns; result.paging.adSets = { after: null }; } }
      if (liveMode === 'abo') { parent.budget = null; parent.dailyBudget = null; } if (liveMode === 'wrong-amount') { parent.budget = { amount: currentAmount + 1, type: 'daily' }; parent.dailyBudget = currentAmount + 1; } if (liveMode === 'duplicate-campaign') result.campaigns.push({ ...parent }); if (liveMode === 'missing-campaign') result.campaigns = [];
      if (lateMutation) lateReads = 2;
    } else if (url.pathname === '/api/v1/ads/ad-sets/budget-set/status') { assert.deepEqual(Object.keys(payload).sort(), ['platform', 'status']); result = { status: 'paused', updated: 1, skipped: 0 }; }
    else if (url.pathname === '/api/v1/ads/ad-sets/budget-set') {
      assert.equal(method, 'PUT'); assert.ok(options.headers['Idempotency-Key']);
      if (payload.budget) { assert.deepEqual(Object.keys(payload).sort(), ['budget', 'platform']); assert.deepEqual(Object.keys(payload.budget).sort(), ['amount', 'type']); assert.equal(payload.budget.type, 'daily'); currentAmount = payload.budget.amount; liveMode = afterWriteMode; result = { budget: { ...payload.budget }, budgetLevel: 'adset', ...acknowledgement }; }
      else { campaign.adSets[0].adSetName = payload.name; result = {}; }
    } else if (url.pathname === '/api/v1/ads/campaigns/budget-campaign') {
      assert.equal(method, 'PUT'); assert.ok(options.headers['Idempotency-Key']);
      if (payload.budget) { assert.deepEqual(Object.keys(payload).sort(), ['budget', 'platform']); currentAmount = payload.budget.amount; liveMode = afterWriteMode; result = { updated: 1, budget: { ...payload.budget }, budgetLevel: 'campaign', ...acknowledgement }; }
      else { campaign.campaignName = payload.name; result = { updated: 1, name: payload.name }; }
    } else throw new Error('Unexpected budget fixture ' + method + ' ' + url.pathname);
    return Response.json(result);
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, key) => { const response = await originalFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; };
  const body = amount => ({ campaignId: 'budget-campaign', platform: campaign.platform, adSetId: 'budget-set', budget: { amount, type: 'daily' }, currency: campaign.currency, confirmBudget: true });
  let route;
  const review = async (amount = 30) => request(`${route}/adset-budget-review?${new URLSearchParams({ campaignId: 'budget-campaign', platform: campaign.platform, adSetId: 'budget-set', currency: campaign.currency, amount: String(amount) })}`);
  const reviewed = async amount => { const response = await review(amount); assert.equal(response.status, 200, JSON.stringify(response.data)); return { ...body(amount ?? 30), version: response.data.budgetReview.version, reviewExpiresAt: response.data.budgetReview.expiresAt }; };
  const reviewCampaign = async (amount = 40) => request(`${route}/campaign-budget-review?${new URLSearchParams({ campaignId: 'budget-campaign', platform: campaign.platform, currency: campaign.currency, amount: String(amount) })}`);
  const reviewedCampaign = async (amount = 40) => { const result = await reviewCampaign(amount); assert.equal(result.status, 200, JSON.stringify(result)); const payload = { ...body(amount), version: result.data.budgetReview.version, reviewExpiresAt: result.data.budgetReview.expiresAt }; delete payload.adSetId; return payload; };
  const settle = async result => { if (result.data.operation?.status === 'uncertain') await app.sql.run("UPDATE integration_operations SET status='reviewed-not-applied' WHERE id=?", result.data.operation.id); };
  try {
    const setup = await request('/api/auth/setup', { name: 'Budget QA', email: 'budget@example.test', password: 'long local budget fixture password' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const state = (await request('/api/state')).data; projectId = state.projectId; workspaceId = state.workspaces[0].id; userId = state.user.id;
    const response = await originalFetch(base + `/api/projects/${projectId}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ zernioProfileId: profileId }) }); assert.equal(response.status, 200); route = `/api/projects/${projectId}/integrations/ads`;
    for (const platform of ['facebook', 'instagram']) for (const currency of ['AED', 'USD']) {
      await reset(); campaign.platform = platform; campaign.currency = currency; liveMode = 'paginated'; const payload = await reviewed(30.25), before = writes.length, sibling = structuredClone(campaign.adSets[1]); const result = await request(route + '/adset', payload, 'budget-' + platform + currency);
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(writes.length, before + 1); assert.deepEqual(result.data.budgetAcceptance, { campaignId: 'budget-campaign', platform, adSetId: 'budget-set', accountId: 'metaads', adAccountId: 'act_123', currency, requestedAmount: 30.25, acknowledgedAmount: 30.25, observedAmount: 30.25, readAt: result.data.budgetAcceptance.readAt }); assert.ok(Number.isFinite(Date.parse(result.data.budgetAcceptance.readAt))); assert.equal(campaign.status, 'paused'); assert.equal(campaign.adSets[0].configuredStatus, 'PAUSED'); assert.deepEqual(campaign.adSets[1], sibling);
      assert.equal((await request(route + '/adset', payload, 'budget-' + platform + currency)).status, 200); assert.equal(writes.length, before + 1);
    }
    await reset(); const payload = await reviewed(); const noWrite = writes.length;
    for (const [index, invalid] of [{ ...body(30) }, { ...payload, name: 'Mixed' }, { ...payload, status: 'active' }, { ...payload, confirmBudget: false }, { ...payload, budget: { amount: 31, type: 'daily' } }, { ...payload, budget: { amount: 30, type: 'lifetime' } }, { ...payload, version: '0'.repeat(64) }, { ...payload, reviewExpiresAt: new Date(0).toISOString() }, { ...payload, reviewExpiresAt: new Date(Date.now() + 999999).toISOString() }, { ...payload, currency: 'USD' }].entries()) { const result = await request(route + '/adset', invalid, 'bad-budget-' + index); assert.ok(result.status >= 400, JSON.stringify(result)); assert.equal(writes.length, noWrite); }
    for (const platform of ['google', 'tiktok', 'linkedin', 'pinterest', 'twitter', 'openai', 'reddit']) { campaign.platform = platform; const result = await request(route + '/adset', { ...payload, platform }, 'unsupported-budget-' + platform); assert.ok(result.status >= 400); assert.equal(writes.length, noWrite); } await reset();
    for (const mode of ['currency', 'foreign-account', 'foreign-parent', 'stale', 'timestamp', 'duplicate', 'cbo', 'lifetime', 'missing', 'paging', 'cycle']) { liveMode = mode; const result = await review(); assert.ok(result.status >= 400, mode + ': ' + JSON.stringify(result)); assert.equal(writes.length, noWrite); } await reset();
    for (const [name, mutate] of [['amount', () => { currentAmount = 21; }], ['currency', () => { campaign.currency = 'USD'; }], ['lifetime', () => { campaign.adSets[0].adSetBudget.type = 'lifetime'; }], ['cbo', () => { campaign.budgetLevel = 'campaign'; }], ['account', () => { active = false; }], ['grant', () => { selectable = false; }]]) { const payload = await reviewed(); mutate(); const result = await request(route + '/adset', payload, 'changed-budget-' + name); assert.ok(result.status >= 400, name); assert.equal(writes.length, noWrite); await reset(); }
    for (const [name, mutate] of [['connection', () => { active = false; }], ['native-user', () => { connection.platformUserId = 'changed-native-user'; }], ['native-id', () => { connection.platformId = 'changed-native-id'; }], ['platform', () => { connection.platform = 'google'; }], ['reconnect', () => { connection.needsReconnection = true; }], ['removed', () => { campaign.adSets[0].platformAdSetId = 'removed'; }], ['duplicate', () => { campaign.adSets.push({ ...campaign.adSets[0] }); }], ['terminal', () => { campaign.status = 'ARCHIVED'; }], ['advertiser', () => { campaign.platformAdAccountId = 'act_999'; }], ['role', () => app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', 'viewer', workspaceId, userId)], ['profile', () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'foreign-profile', projectId)]]) { const payload = await reviewed(); lateMutation = mutate; const result = await request(route + '/adset', payload, 'late-budget-' + name); assert.ok(result.status >= 400, name + JSON.stringify(result)); assert.equal(writes.length, noWrite, name + ' must fail at the final tree await'); campaign.adSets.splice(2); await reset(); }
    for (const scenario of ['review-expiry-at-put', 'live-expiry-after-final-await']) {
      const payload = await reviewed(), before = writes.length, realNow = Date.now; let offset = scenario === 'review-expiry-at-put' ? 285000 : 0;
      Date.now = () => realNow() + offset;
      try { lateMutation = () => { offset += scenario === 'review-expiry-at-put' ? 30000 : 90000; }; const result = await request(route + '/adset', payload, scenario); assert.ok(result.status >= 400, JSON.stringify(result)); assert.equal(writes.length, before, scenario); }
      finally { Date.now = realNow; await reset(); }
    }
    for (const mode of ['foreign-account', 'currency', 'stale', 'missing']) { const payload = await reviewed(); afterWriteMode = mode; const result = await request(route + '/adset', payload, 'unknown-budget-' + mode); assert.equal(result.data.operation.status, 'uncertain', JSON.stringify(result)); assert.equal(result.data.budgetAcceptance, undefined); const count = writes.length; assert.equal((await request(route + '/adset', payload, 'unknown-budget-' + mode)).status, 409); assert.equal((await request(route + '/adset', payload, 'unknown-budget-' + mode + '-new')).status, 409); assert.equal(writes.length, count); await settle(result); await reset(); }
    for (const ack of [{ budget: { amount: 31, type: 'daily' } }, { budgetLevel: 'campaign' }, { budget: null }]) { const payload = await reviewed(); acknowledgement = ack; const result = await request(route + '/adset', payload, 'bad-ack-' + writes.length); assert.equal(result.data.operation.status, 'uncertain'); await settle(result); await reset(); }
    // Name and status use the same final scope guard and retain their existing native body shapes.
    for (const kind of ['name', 'status']) {
      await reset(); const before = writes.length, payload = { campaignId: 'budget-campaign', platform: 'facebook', adSetId: 'budget-set', [kind]: kind === 'name' ? 'Renamed only' : 'paused' };
      let result = await request(route + '/adset', payload, 'sibling-safe-' + kind); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(writes.length, before + 1); assert.deepEqual(Object.keys(writes.at(-1).payload).sort(), [kind, 'platform'].sort());
      treeReads = 0; treeHook = read => { if (read === 4) campaign.adSets[0].status = 'DELETED'; }; result = await request(route + '/adset', payload, 'sibling-stale-' + kind); assert.ok(result.status >= 400); assert.equal(writes.length, before + 1); await reset();
      for (const [name, mutate] of [['connection', () => { active = false; }], ['native-user', () => { connection.platformUserId = 'changed-native-user'; }]]) { treeReads = 0; treeHook = read => { if (read === 4) mutate(); }; result = await request(route + '/adset', payload, 'sibling-late-' + kind + '-' + name); assert.ok(result.status >= 400); assert.equal(writes.length, before + 1, kind + ' must reject a late ' + name + ' change'); await reset(); }
    }
    // The native resource fence spans aliases, independent profile mappings and process reopening.
    await reset(); const originalProject = projectId, originalRoute = route, unknownPayload = await reviewed(30), beforeUnknown = writes.length;
    afterWriteMode = 'foreign-account'; const unknown = await request(route + '/adset', unknownPayload, 'global-budget-unknown'); assert.equal(unknown.data.operation.status, 'uncertain'); assert.equal(writes.length, beforeUnknown + 1);
    liveMode = afterWriteMode = ''; currentAmount = 20; campaign.platform = 'instagram';
    let aliasPayload = await reviewed(31), blocked = await request(route + '/adset', aliasPayload, 'global-budget-instagram'); assert.equal(blocked.status, 409); assert.equal(writes.length, beforeUnknown + 1, 'A Facebook unknown outcome must block its Instagram alias.');
    const created = await request('/api/projects', { workspaceId, name: 'Independent budget project', zernioProfileId: 'budget-second-profile' }); assert.equal(created.status, 201, JSON.stringify(created.data)); projectId = created.data.project.id; route = `/api/projects/${projectId}/integrations/ads`;
    aliasPayload = await reviewed(32); blocked = await request(route + '/adset', aliasPayload, 'global-budget-other-project'); assert.equal(blocked.status, 409); assert.equal(writes.length, beforeUnknown + 1); assert.equal(JSON.stringify(blocked.data).includes(originalProject), false); assert.equal(JSON.stringify(blocked.data).includes(unknown.data.operation.id), false); assert.equal(JSON.stringify(blocked.data).includes('global-budget-unknown'), false);
    await app.close(); app = await open(); await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    aliasPayload = await reviewed(33); blocked = await request(route + '/adset', aliasPayload, 'global-budget-after-reopen'); assert.equal(blocked.status, 409); assert.equal(writes.length, beforeUnknown + 1, 'An app restart must preserve the unresolved native budget fence.');
    const recovery = await request(`/api/projects/${originalProject}/operations/${unknown.data.operation.id}/review`, { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic operator checked the native budget and confirmed it was not applied.' }); assert.equal(recovery.status, 200, JSON.stringify(recovery.data)); assert.equal(recovery.data.operation.status, 'reviewed-not-applied');
    aliasPayload = await reviewed(34); const recovered = await request(route + '/adset', aliasPayload, 'global-budget-deliberate-after-review'); assert.equal(recovered.status, 200, JSON.stringify(recovered.data)); assert.equal(writes.length, beforeUnknown + 2); assert.equal(recovered.data.budgetAcceptance.observedAmount, 34); projectId = originalProject; route = originalRoute;
    // Campaign-owned edits use authoritative live CBO even when the synced tree still says ABO.
    for (const platform of ['facebook', 'instagram']) for (const currency of ['AED', 'USD']) {
      await reset(); nativeCampaignBudget = true; campaign.platform = platform; campaign.currency = currency; liveMode = 'paginated'; acknowledgement = { updated: 0 };
      const children = structuredClone(campaign.adSets), before = writes.length, payload = await reviewedCampaign(40.25), result = await request(route + '/campaign', payload, 'cbo-' + platform + currency);
      assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(writes.length, before + 1); assert.deepEqual(result.data.budgetAcceptance, { campaignId: 'budget-campaign', platform, adSetId: null, accountId: 'metaads', adAccountId: 'act_123', currency, requestedAmount: 40.25, acknowledgedAmount: 40.25, observedAmount: 40.25, readAt: result.data.budgetAcceptance.readAt }); assert.deepEqual(campaign.adSets, children); assert.equal(campaign.status, 'paused'); assert.equal(campaign.budgetLevel, 'adset', 'The stale synced stamp is not proof of native budget ownership.');
      assert.equal((await request(route + '/campaign', payload, 'cbo-' + platform + currency)).status, 200); assert.equal(writes.length, before + 1);
    }
    await reset(); nativeCampaignBudget = true; const cboPayload = await reviewedCampaign(), beforeInvalidCbo = writes.length;
    for (const [index, payload] of [{ campaignId: 'budget-campaign', platform: 'facebook', budget: { amount: 40, type: 'daily' } }, { ...cboPayload, name: 'Mixed rename' }, { ...cboPayload, status: 'active' }, { ...cboPayload, confirmBudget: false }, { ...cboPayload, budget: { amount: 41, type: 'daily' } }, { ...cboPayload, budget: { amount: 40, type: 'lifetime' } }, { ...cboPayload, currency: 'USD' }, { ...cboPayload, version: '0'.repeat(64) }, { ...cboPayload, reviewExpiresAt: new Date(0).toISOString() }].entries()) { const result = await request(route + '/campaign', payload, 'invalid-cbo-' + index); assert.ok(result.status >= 400, JSON.stringify(result)); assert.equal(writes.length, beforeInvalidCbo); }
    for (const mode of ['abo', 'lifetime', 'duplicate-campaign', 'missing-campaign', 'foreign-account', 'currency', 'stale', 'paging', 'cycle']) { liveMode = mode; const result = await reviewCampaign(); assert.ok(result.status >= 400, mode + JSON.stringify(result)); assert.equal(writes.length, beforeInvalidCbo); } await reset(); nativeCampaignBudget = true;
    for (const platform of ['google', 'openai', 'reddit', 'tiktok']) { campaign.platform = platform; assert.ok((await reviewCampaign()).status >= 400, platform); } await reset(); nativeCampaignBudget = true;
    for (const [name, mutate] of [['amount', () => { currentAmount++; }], ['lifetime', () => { liveMode = 'lifetime'; }], ['ownership', () => { liveMode = 'abo'; }], ['currency', () => { campaign.currency = 'USD'; }], ['connection', () => { active = false; }], ['access', () => { selectable = false; }]]) { const payload = await reviewedCampaign(); mutate(); const result = await request(route + '/campaign', payload, 'changed-cbo-' + name); assert.ok(result.status >= 400, name + JSON.stringify(result)); assert.equal(writes.length, beforeInvalidCbo); await reset(); nativeCampaignBudget = true; }
    for (const [name, mutate] of [['connection', () => { active = false; }], ['native-user', () => { connection.platformUserId = 'changed-native-user'; }], ['native-id', () => { connection.platformId = 'changed-native-id'; }], ['platform', () => { connection.platform = 'google'; }], ['reconnect', () => { connection.needsReconnection = true; }], ['terminal', () => { campaign.status = 'ARCHIVED'; }], ['advertiser', () => { campaign.platformAdAccountId = 'act_999'; }], ['role', () => app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', 'viewer', workspaceId, userId)], ['mapping', () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'other-profile', projectId)]]) { const payload = await reviewedCampaign(); lateMutation = mutate; const result = await request(route + '/campaign', payload, 'late-cbo-' + name); assert.ok(result.status >= 400, name + JSON.stringify(result)); assert.equal(writes.length, beforeInvalidCbo); await reset(); nativeCampaignBudget = true; }
    for (const scenario of ['cbo-review-expiry', 'cbo-live-expiry']) { const payload = await reviewedCampaign(), before = writes.length, realNow = Date.now; let offset = scenario === 'cbo-review-expiry' ? 285000 : 0; Date.now = () => realNow() + offset; try { lateMutation = () => { offset += scenario === 'cbo-review-expiry' ? 30000 : 90000; }; const result = await request(route + '/campaign', payload, scenario); assert.ok(result.status >= 400); assert.equal(writes.length, before); } finally { Date.now = realNow; await reset(); nativeCampaignBudget = true; } }
    for (const mode of ['foreign-account', 'stale', 'missing-campaign', 'abo', 'wrong-amount']) { const payload = await reviewedCampaign(); afterWriteMode = mode; const result = await request(route + '/campaign', payload, 'uncertain-cbo-' + mode); assert.equal(result.data.operation.status, 'uncertain', JSON.stringify(result)); assert.equal(result.data.budgetAcceptance, undefined); const before = writes.length; assert.equal((await request(route + '/campaign', payload, 'uncertain-cbo-' + mode)).status, 409); assert.equal((await request(route + '/campaign', payload, 'uncertain-cbo-' + mode + '-new')).status, 409); assert.equal(writes.length, before); await settle(result); await reset(); nativeCampaignBudget = true; }
    for (const ack of [{ updated: true }, { updated: -1 }, { budgetLevel: 'adset' }, { budget: { amount: 41, type: 'daily' } }]) { const payload = await reviewedCampaign(); acknowledgement = ack; const result = await request(route + '/campaign', payload, 'bad-cbo-ack-' + writes.length); assert.equal(result.data.operation.status, 'uncertain'); await settle(result); await reset(); nativeCampaignBudget = true; }
    // Existing name-only Meta and non-Meta budget semantics retain their original routes and bodies.
    let nameResult = await request(route + '/campaign', { campaignId: 'budget-campaign', platform: 'facebook', name: 'Name only preserved' }, 'cbo-name-only'); assert.equal(nameResult.status, 200); assert.equal(campaign.campaignName, 'Name only preserved');
    for (const platform of ['google', 'openai', 'reddit']) { await reset(); campaign.platform = platform; campaign.budgetLevel = 'campaign'; const result = await request(route + '/campaign', { campaignId: 'budget-campaign', platform, budget: { amount: 50, type: 'daily' } }, 'legacy-budget-' + platform); assert.equal(result.status, 200, platform + JSON.stringify(result)); assert.deepEqual(writes.at(-1).payload, { platform, budget: { amount: 50, type: 'daily' } }); }
    await reset(); nativeCampaignBudget = true; const firstCbo = await reviewedCampaign(40), beforeCboUnknown = writes.length; afterWriteMode = 'foreign-account'; const unknownCbo = await request(route + '/campaign', firstCbo, 'global-cbo-unknown'); assert.equal(unknownCbo.data.operation.status, 'uncertain'); assert.equal(writes.length, beforeCboUnknown + 1); afterWriteMode = liveMode = ''; currentAmount = 20; campaign.platform = 'instagram';
    let nextCbo = await reviewedCampaign(41); assert.equal((await request(route + '/campaign', nextCbo, 'global-cbo-alias')).status, 409); assert.equal(writes.length, beforeCboUnknown + 1);
    projectId = created.data.project.id; route = `/api/projects/${projectId}/integrations/ads`; nextCbo = await reviewedCampaign(42); const crossProject = await request(route + '/campaign', nextCbo, 'global-cbo-other-project'); assert.equal(crossProject.status, 409); assert.equal(writes.length, beforeCboUnknown + 1); assert.equal(JSON.stringify(crossProject.data).includes(unknownCbo.data.operation.id), false); assert.equal(JSON.stringify(crossProject.data).includes(originalProject), false);
    await app.close(); app = await open(); await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`; nextCbo = await reviewedCampaign(43); assert.equal((await request(route + '/campaign', nextCbo, 'global-cbo-reopen')).status, 409); assert.equal(writes.length, beforeCboUnknown + 1);
    const recoveredCbo = await request(`/api/projects/${originalProject}/operations/${unknownCbo.data.operation.id}/review`, { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic operator checked the native campaign budget and confirmed no change.' }); assert.equal(recoveredCbo.status, 200, JSON.stringify(recoveredCbo)); nextCbo = await reviewedCampaign(44); const finalCbo = await request(route + '/campaign', nextCbo, 'global-cbo-deliberate-fresh-review'); assert.equal(finalCbo.status, 200, JSON.stringify(finalCbo)); assert.equal(writes.length, beforeCboUnknown + 2); assert.equal(finalCbo.data.budgetAcceptance.observedAmount, 44);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});


test('HTTP Meta campaign discovery includes zero-ad campaigns only within one verified project connection and advertiser', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-meta-discovery-')), origin = 'http://127.0.0.1:3000', originalFetch = globalThis.fetch, profileId = 'discovery-profile';
  const app = await testApp(t, { dataDir: directory, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'discovery-fixture-key' } });
  let base, cookie, projectId, mode = '', active = true, nativeId = 'native-meta', advertiserReads = 0; const reads = [];
  const campaign = id => ({ platformCampaignId: id, platform: 'facebook', campaignName: '<b>Provider campaign</b>', accountId: 'meta-a', profileId, platformAdAccountId: 'act_123', status: 'paused', platformCampaignStatus: 'PAUSED', adCount: 0, budget: { amount: 999999, type: 'daily' }, access_token: 'never-expose-discovery-secret' });
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(options.method || 'GET', 'GET', 'Discovery never writes to the provider.'); reads.push(url); let result;
    if (url.pathname === '/api/v1/accounts') {
      const account = { _id: 'meta-a', profileId: url.searchParams.get('profileId'), platform: 'metaads', isActive: active, platformUserId: nativeId };
      result = { accounts: [account] }; if (mode === 'duplicate-account') result.accounts.push({ ...account }); if (mode === 'foreign-connection') account.profileId = 'foreign'; if (mode === 'google-connection') account.platform = 'googleads';
    } else if (url.pathname === '/api/v1/ads/accounts') {
      advertiserReads++; assert.equal(url.searchParams.get('accountId'), 'meta-a'); assert.equal(url.searchParams.get('inScopeOnly'), 'true'); result = { accounts: [{ id: 'act_123', name: 'Scoped advertiser', selectable: true }] };
      if (mode === 'stale-access') result.stale = true; if (mode === 'foreign-access') result.accountId = 'foreign'; if (mode === 'duplicate-advertiser') result.accounts.push({ id: '123', selectable: true }); if (mode === 'revoked-access' && advertiserReads === 2) result.accounts[0].selectable = false;
    } else {
      assert.equal(url.pathname, '/api/v1/ads/campaigns'); assert.equal(url.searchParams.get('profileId'), profileId); assert.equal(url.searchParams.get('accountId'), 'meta-a'); assert.equal(url.searchParams.get('adAccountId'), 'act_123'); assert.equal(url.searchParams.get('includeEmpty'), 'true'); assert.equal(url.searchParams.get('source'), 'all'); assert.equal(url.searchParams.get('limit'), '100'); assert.equal(url.searchParams.has('live'), false);
      const page = Number(url.searchParams.get('page')), total = mode === 'paginated' ? 101 : mode === 'ceiling' ? 1001 : mode === 'empty' || mode === 'empty-one-page' ? 0 : 2;
      result = { campaigns: Array.from({ length: Math.min(100, Math.max(0, total - (page - 1) * 100)) }, (_, index) => campaign(String((page - 1) * 100 + index + 1))), pagination: { page, limit: 100, total, pages: mode === 'empty-one-page' ? 1 : Math.ceil(total / 100) } };
      if (total === 2) { result.campaigns[1].platform = 'instagram'; result.campaigns[1].adCount = 3; }
      if (mode === 'foreign-profile') result.campaigns[0].profileId = 'foreign'; if (mode === 'foreign-account') result.campaigns[0].accountId = 'foreign'; if (mode === 'foreign-advertiser') result.campaigns[0].platformAdAccountId = 'act_999'; if (mode === 'foreign-platform') result.campaigns[0].platform = 'google';
      if (mode === 'duplicate-campaign') result.campaigns[1].platformCampaignId = result.campaigns[0].platformCampaignId; if (mode === 'bad-count') result.campaigns[0].adCount = -1; if (mode === 'bad-name') result.campaigns[0].campaignName = {}; if (mode === 'bad-status') result.campaigns[0].status = {};
      if (mode === 'null-response') return Response.json(null); if (mode === 'foreign-envelope') result.accountId = 'foreign'; if (mode === 'contradict-more') result.pagination.hasMore = true; if (mode === 'contradict-total-pages') result.pagination.totalPages = 2; if (mode === 'missing-pagination') delete result.pagination; if (mode === 'wrong-page') result.pagination.page++; if (mode === 'bad-pages') result.pagination.pages = 2; if (mode === 'string-total') result.pagination.total = '2'; if (mode === 'short-page') result.campaigns.pop(); if (mode === 'backfill') result.backfillPending = true;
      if (mode === 'late-connection') active = false; if (mode === 'late-native') nativeId = 'changed-native-meta'; if (mode === 'late-mapping') await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'foreign-profile', projectId);
      if (mode === 'unavailable') throw new Error('Synthetic provider unavailable');
    }
    return Response.json(result);
  };
  async function request(path, method = 'GET', body) { const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await request('/api/auth/setup', 'POST', { name: 'Discovery QA', email: 'discovery@example.test', password: 'a long local discovery fixture password' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
    await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId); await app.sql.run("UPDATE memberships SET role='viewer'");
    const route = `/api/projects/${projectId}/integrations/ads/campaign-discovery?accountId=meta-a&adAccountId=act_123`;
    let result = await request(route); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.complete, true); assert.deepEqual(result.data.campaigns.map(row => row.adCount), [0, 3]); assert.equal(result.data.accountId, 'meta-a'); assert.equal(result.data.adAccountId, 'act_123'); assert.equal(JSON.stringify(result).includes('never-expose-discovery-secret'), false); assert.equal(Object.hasOwn(result.data.campaigns[0], 'budget'), false);
    for (mode of ['empty', 'empty-one-page']) { advertiserReads = 0; result = await request(route); assert.equal(result.status, 200); assert.deepEqual(result.data.campaigns, []); }
    mode = 'paginated'; advertiserReads = 0; result = await request(route); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.campaigns.length, 101); assert.equal(result.data.campaigns.at(-1).platformCampaignId, '101');
    for (mode of ['foreign-profile', 'foreign-account', 'foreign-advertiser', 'foreign-platform', 'duplicate-campaign', 'bad-count', 'bad-name', 'bad-status', 'foreign-envelope', 'null-response', 'contradict-more', 'contradict-total-pages', 'missing-pagination', 'wrong-page', 'bad-pages', 'string-total', 'short-page', 'backfill', 'duplicate-account', 'foreign-connection', 'google-connection', 'stale-access', 'foreign-access', 'duplicate-advertiser', 'revoked-access', 'late-connection', 'late-native', 'late-mapping', 'unavailable', 'ceiling']) {
      active = true; nativeId = 'native-meta'; advertiserReads = 0; result = await request(route); assert.ok(result.status >= 400, mode + JSON.stringify(result)); assert.equal(result.data.campaigns, undefined, mode); await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, projectId);
    }
    mode = ''; active = true; const count = reads.length; for (const query of ['&includeEmpty=false', '&accountId=other', '&live=true']) assert.equal((await request(route + query)).status, 400); assert.equal(reads.length, count, 'Invalid filters cannot reach the provider.');
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});
