import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIntegration } from '../server/integrations.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

// Current contract: https://docs.zernio.com/platforms/openai-ads
async function scenario(t, run) {
  const { db, sql } = await testDatabase(t), original = globalThis.fetch, writes = [], records = [];
  const project = { id: 'openai-project', zernioProfileId: 'openai-profile' }, account = { _id: 'openai-account', profileId: project.zernioProfileId, platform: 'openaiads', isActive: true };
  const campaign = { platformCampaignId: 'openai-campaign', platform: 'openai', profileId: project.zernioProfileId, currency: 'USD', campaignBudget: { amount: 100, type: 'lifetime' } };
  const ad = { _id: 'openai-ad', platformCampaignId: campaign.platformCampaignId, platform: 'openai', profileId: project.zernioProfileId, status: 'paused' };
  const draft = { platform: 'openai', accountId: account._id, adAccountId: 'native-account', name: 'Planner launch', goal: 'traffic', budgetAmount: 25, budgetType: 'lifetime', endDate: '2090-02-28T23:59:00Z', bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: 2, headline: 'Try the new planner', body: 'Coordinate tasks and meetings.', imageUrl: 'https://cdn.example.com/planner.png', linkUrl: 'https://example.com/planner', countries: ['US'], tracking: { urlTags: [{ key: 'utm_source', value: 'chatgpt' }, { key: 'click_id', value: '{oppref}' }] } };
  let sequence = 0, behavior;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), payload = options.body ? JSON.parse(options.body) : undefined;
    assert.equal(url.origin, 'https://zernio.com');
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (url.pathname === '/api/v1/ads/accounts') return Response.json({ accounts: [{ id: 'native-account', currency: 'USD', selectable: true, minimumDailyBudget: 50 }] });
    if (url.pathname === '/api/v1/ads/tree') return Response.json({ campaigns: [campaign], pagination: { pages: 1 } });
    if (url.pathname === '/api/v1/ads') return Response.json({ ads: [ad], pagination: { pages: 1 } });
    writes.push({ url, payload, options });
    if (behavior) return behavior(url, payload);
    if (url.pathname === '/api/v1/connect/openai-ads/credentials') return Response.json({ accountId: account._id, adAccountName: 'QA Ads', apiKey: 'must-not-leak' });
    if (url.pathname === '/api/v1/ads/create' && payload.validateOnly) return Response.json({ validateOnly: true, results: ['campaign', 'adSet', 'ad'].map(node => ({ node, status: 'validated' })), message: 'Validated; nothing created.' });
    if (url.pathname === '/api/v1/ads/create') return Response.json({ ad: { _id: 'created-ad', platformCampaignId: campaign.platformCampaignId, platform: 'openai', status: 'paused' } }, { status: 201 });
    return Response.json({ updated: 1, budget: payload.budget });
  };
  async function invoke(path, body, { role = 'editor', key = 'openai-check-' + ++sequence } = {}) {
    let result;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/' + project.id + '/integrations/' + path), body, project, role, db, config: { env: { ZERNIO_API_KEY: 'zernio-test-key' } }, store: { create(_project, _collection, value) { const record = { id: 'local-campaign', ...value }; records.push(record); return record; }, list() { return records; }, update(_project, _collection, id, value) { const record = records.find(row => row.id === id); Object.assign(record, value); return record; }, activity() {} }, send(status, data) { result = { status, data }; } });
    return result;
  }
  try { await run({ invoke, draft, writes, records, campaign, ad, account, sql, mock(fn) { behavior = fn; } }); }
  finally { globalThis.fetch = original; }
}

test('ChatGPT lifetime ads preserve their spend cap, fixed bid, tracking macros and local budget type', { skip: postgresSkip }, t => scenario(t, async ({ invoke, draft, writes, records }) => {
  const result = await invoke('ads/create', draft);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(writes[0].payload.budgetType, 'lifetime'); assert.equal(writes[0].payload.status, 'PAUSED');
  assert.deepEqual(writes[0].payload.tracking, draft.tracking); assert.equal(records[0].budgetType, 'lifetime');
  const count = writes.length;
  for (const change of [{ endDate: undefined }, { bidStrategy: undefined, bidAmount: undefined }, { promotedObject: { customEventType: 'order_created' } }, { tracking: { urlTags: [{ key: 'bad key', value: 'x' }] } }, { targeting: { ageMin: 25 } }]) {
    assert.equal((await invoke('ads/create', { ...draft, ...change })).status, 400);
  }
  assert.equal(writes.length, count, 'Invalid lifetime, conversion and targeting inputs cannot reach a provider write.');
  const daily = await invoke('ads/create', { ...draft, budgetType: 'daily', budgetAmount: 50, bidStrategy: undefined, bidAmount: undefined }); assert.equal(daily.status, 200);
}));

test('ChatGPT validation performs provider checks without a local campaign or paid operation receipt', { skip: postgresSkip }, t => scenario(t, async ({ invoke, draft, records, writes, sql, mock }) => {
  const result = await invoke('ads/validate', draft);
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.validateOnly, true); assert.equal(writes[0].payload.validateOnly, true); assert.equal(records.length, 0);
  assert.equal((await sql.get('SELECT count(*) AS n FROM integration_operations')).n, 0);
  mock(() => Response.json({ ad: { _id: 'unexpected-write' } }));
  assert.equal((await invoke('ads/validate', draft)).status, 502);
}));

test('ChatGPT credentials require workspace administration, scoped readback, and never persist or return the key', { skip: postgresSkip }, t => scenario(t, async ({ invoke, writes, sql }) => {
  assert.equal((await invoke('connect/openai-ads', { apiKey: 'sk-ads-fixture' })).status, 403); assert.equal(writes.length, 0);
  const options = { role: 'admin', key: 'credentials-one' }, result = await invoke('connect/openai-ads', { apiKey: 'sk-ads-fixture' }, options);
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.accountId, 'openai-account');
  assert.deepEqual(writes[0].payload, { apiKey: 'sk-ads-fixture', profileId: 'openai-profile' });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(await sql.all('SELECT * FROM integration_operations')).includes('sk-ads-fixture'), false);
  assert.deepEqual(await invoke('connect/openai-ads', { apiKey: 'sk-ads-fixture' }, options), result); assert.equal(writes.length, 1);
}));

test('an unconfirmed ChatGPT connection blocks duplicate credential writes and never exposes provider secrets', { skip: postgresSkip }, t => scenario(t, async ({ invoke, writes, sql, mock }) => {
  mock(() => Response.json({ accountId: 'outside-project', apiKey: 'provider-secret' }));
  const body = { apiKey: 'sk-ads-fixture' }, result = await invoke('connect/openai-ads', body, { role: 'owner', key: 'uncertain-connect' });
  assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(JSON.stringify(result).includes('provider-secret'), false);
  assert.equal((await invoke('connect/openai-ads', body, { role: 'owner', key: 'different-connect-key' })).status, 409); assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(await sql.all('SELECT * FROM integration_operations')).includes('sk-ads-fixture'), false);
}));

test('ChatGPT campaign budgets retain lifetime limits or switch to daily, never daily back to lifetime', { skip: postgresSkip }, t => scenario(t, async ({ invoke, campaign, writes }) => {
  const body = { platform: 'openai', campaignId: campaign.platformCampaignId, budget: { amount: 125, type: 'lifetime' } };
  assert.equal((await invoke('ads/campaign', body)).status, 200);
  assert.deepEqual(writes[0].payload.budget, body.budget);
  assert.equal((await invoke('ads/campaign', { ...body, budget: { amount: 50, type: 'daily' } })).status, 200);
  campaign.campaignBudget.type = 'daily';
  assert.equal((await invoke('ads/campaign', body)).status, 400); assert.equal(writes.length, 2);
}));

test('archived and deleted ChatGPT campaigns and ads cannot resume or accept creative edits', { skip: postgresSkip }, t => scenario(t, async ({ invoke, campaign, ad, writes }) => {
  // Archiving is terminal; Zernio marks records no longer found by OpenAI as deleted.
  // https://docs.zernio.com/platforms/openai-ads#read-status
  campaign.adSets = [{ platformAdSetId: 'openai-adset', adSetName: 'Planner ad group' }];
  for (const status of ['archived', 'deleted']) {
    campaign.status = status; ad.status = status;
    assert.equal((await invoke('ads/status', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'active' })).status, 409);
    assert.equal((await invoke('ads/ad-status', { adId: ad._id, status: 'active' })).status, 409);
    assert.equal((await invoke('ads/edit', { adId: ad._id, creative: { headline: 'Reopen card' } })).status, 409);
    assert.equal((await invoke('ads/campaign', { campaignId: campaign.platformCampaignId, platform: 'openai', budget: { amount: 125, type: 'lifetime' } })).status, 409);
    assert.equal((await invoke('ads/adset', { campaignId: campaign.platformCampaignId, platform: 'openai', adSetId: 'openai-adset', name: 'Renamed ad group' })).status, 409);
  }
  assert.equal(writes.length, 0, 'Terminal state checks must stop provider mutations.');
}));

test('ChatGPT ad-set budget changes require the campaign budget editor even when budget-level metadata is omitted', { skip: postgresSkip }, t => scenario(t, async ({ invoke, campaign, writes }) => {
  campaign.adSets = [{ platformAdSetId: 'openai-adset', adSetName: 'Planner ad group' }];
  const result = await invoke('ads/adset', { campaignId: campaign.platformCampaignId, platform: 'openai', adSetId: 'openai-adset', budget: { amount: 50, type: 'daily' } });
  assert.equal(result.status, 422); assert.equal(result.data.error.code, 'CAMPAIGN_BUDGET_REQUIRED');
  assert.equal(writes.length, 0, 'OpenAI has one campaign spend cap; an ad group cannot change it.');
}));

test('ChatGPT HTTP flow connects, validates, creates paused and confirms campaign status without losing project scope', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-openai-http-')), originalFetch = globalThis.fetch, origin = 'https://campaign.example.test';
  const app = await testApp(t, { dataDir, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'PRIVATE_ZERNIO_KEY' } }), profileId = 'openai-http-profile', accountId = 'openai-http-account', writes = [];
  let cookie, campaign, confirmStatus = true, confirmBudget = true, statusHold, statusReached, releaseStatus, heldRequest;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer PRIVATE_ZERNIO_KEY');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: [{ _id: accountId, profileId, platform: 'openaiads', isActive: true }] }); }
    if (url.pathname === '/api/v1/ads/accounts') { assert.equal(url.searchParams.get('accountId'), accountId); return Response.json({ accounts: [{ id: 'openai-native', currency: 'USD', minimumDailyBudget: 1, selectable: true }] }); }
    if (url.pathname === '/api/v1/ads/tree') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ campaigns: campaign ? [campaign] : [], pagination: { pages: 1 } }); }
    const payload = JSON.parse(options.body); writes.push({ path: url.pathname, payload });
    if (url.pathname === '/api/v1/connect/openai-ads/credentials') { assert.deepEqual(payload, { apiKey: 'PRIVATE_ADS_PROVIDER_KEY', profileId }); return Response.json({ accountId, adAccountName: 'HTTP advertising account', apiKey: 'PRIVATE_PROVIDER_ECHO' }); }
    if (url.pathname === '/api/v1/ads/create' && payload.validateOnly) return Response.json({ validateOnly: true, results: ['campaign', 'adSet', 'ad'].map(node => ({ node, status: 'validated' })) });
    if (url.pathname === '/api/v1/ads/create') {
      assert.equal(payload.status, 'PAUSED'); assert.equal(payload.accountId, accountId); assert.equal(payload.adAccountId, 'openai-native');
      campaign = { platformCampaignId: 'openai-native-campaign', platform: 'openai', profileId, currency: 'USD', status: 'paused', platformCampaignStatus: 'paused', campaignBudget: { amount: payload.budgetAmount, type: payload.budgetType } };
      return Response.json({ ad: { _id: 'openai-http-ad', platformCampaignId: campaign.platformCampaignId, platform: 'openai', profileId, accountId, adAccountId: 'openai-native', status: 'paused' } }, { status: 201 });
    }
    if (url.pathname === '/api/v1/ads/campaigns/openai-native-campaign/status') { assert.equal(options.method, 'PUT'); campaign.status = payload.status; campaign.platformCampaignStatus = payload.status; const receipt = { updated: 1, skipped: 0, status: payload.status, platformCampaignStatus: confirmStatus ? payload.status : null, statusReadAt: confirmStatus ? new Date().toISOString() : null }; if (statusHold) { statusReached(); await statusHold; } return Response.json(receipt); }
    if (url.pathname === '/api/v1/ads/campaigns/openai-native-campaign') { assert.equal(options.method, 'PUT'); campaign.campaignBudget = payload.budget; return Response.json({ updated: 1, budget: confirmBudget ? payload.budget : undefined }); }
    assert.fail('Unexpected OpenAI request: ' + url.href);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, key, auth = cookie) { const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(auth ? { Cookie: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'OpenAI HTTP owner', email: 'openai-http@example.test', password: 'isolated OpenAI HTTP password' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie;
    const projectId = setup.data.projectId, route = `/api/projects/${projectId}/integrations/`;
    assert.equal((await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: profileId })).status, 200);
    const connected = await request(route + 'connect/openai-ads', 'POST', { apiKey: 'PRIVATE_ADS_PROVIDER_KEY' }, randomUUID()); assert.equal(connected.status, 200); assert.doesNotMatch(JSON.stringify(connected), /PRIVATE_/);
    const body = { platform: 'openai', accountId, adAccountId: 'openai-native', name: 'HTTP daily campaign', goal: 'traffic', budgetType: 'daily', budgetAmount: 50, headline: 'Plan a better launch', body: 'Bring campaign work together.', imageUrl: 'https://cdn.example.test/card.png', linkUrl: 'https://example.test/offer', countries: ['US'] };
    assert.equal((await request(route + 'ads/validate', 'POST', body)).status, 200); assert.equal((await app.store.list(projectId, 'campaigns')).length, 0);
    const key = randomUUID(), created = await request(route + 'ads/create', 'POST', body, key); assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(created.data.campaign.status, 'paused');
    assert.equal((await request(route + 'ads/create', 'POST', body, key)).status, 200); assert.equal(writes.filter(row => row.path === '/api/v1/ads/create' && !row.payload.validateOnly).length, 1);
    const foreign = [
      await app.store.create(projectId, 'campaigns', { name: 'Previous profile record', status: 'paused', budget: 20, externalId: 'other-profile-ad', platform: 'openai', platformCampaignId: campaign.platformCampaignId, zernioProfileId: 'other-profile' }),
      await app.store.create(projectId, 'campaigns', { name: 'Different network record', status: 'paused', budget: 30, externalId: 'other-network-ad', platform: 'facebook', platformCampaignId: campaign.platformCampaignId, zernioProfileId: profileId })
    ];
    const active = await request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'active' }, randomUUID()); assert.equal(active.status, 200, JSON.stringify(active.data)); assert.equal(active.data.verification, 'confirmed');
    assert.equal((await app.store.get(projectId, 'campaigns', created.data.campaign.id)).status, 'active', 'The local campaign overview must reflect the confirmed provider switch.');
    const changed = await request(route + 'ads/campaign', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', budget: { amount: 75, type: 'daily' } }, randomUUID()); assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal((await app.store.get(projectId, 'campaigns', created.data.campaign.id)).budget, 75, 'Confirmed campaign budget changes must update the local overview.');
    for (const record of foreign) { const saved = await app.store.get(projectId, 'campaigns', record.id); assert.equal(saved.status, 'paused'); assert.equal(saved.budget, record.budget); }
    const reached = new Promise(resolve => { statusReached = resolve; }); statusHold = new Promise(resolve => { releaseStatus = resolve; });
    const heldKey = randomUUID(); heldRequest = request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'active' }, heldKey);
    let deadline; try { await Promise.race([reached, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('The held provider receipt was not reached.')), 5000); })]); } finally { clearTimeout(deadline); }
    const pendingWrites = writes.length, blockedRequests = [];
    for (const [path, payload] of [['ads/status', { status: 'paused' }], ['ads/campaign', { budget: { amount: 80, type: 'daily' } }]]) {
      const body = { campaignId: campaign.platformCampaignId, platform: 'openai', ...payload }, key = randomUUID(), blocked = await request(route + path, 'POST', body, key);
      assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); blockedRequests.push({ path, body, key, receipt: blocked.data });
    }
    assert.equal(writes.length, pendingWrites, 'A second change cannot overtake the first campaign receipt.');
    releaseStatus(); assert.equal((await heldRequest).status, 200); statusHold = null;
    for (const blocked of blockedRequests) assert.deepEqual((await request(route + blocked.path, 'POST', blocked.body, blocked.key)).data, blocked.receipt);
    assert.equal(writes.length, pendingWrites, 'A previously blocked key cannot dispatch after the earlier action completes.');
    assert.equal((await request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'paused' }, randomUUID())).status, 200);
    assert.equal((await app.store.get(projectId, 'campaigns', created.data.campaign.id)).status, 'paused');
    assert.equal((await request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'active' }, heldKey)).status, 200);
    assert.equal((await app.store.get(projectId, 'campaigns', created.data.campaign.id)).status, 'paused', 'Replaying an older completed receipt cannot restore an older snapshot.');
    assert.equal((await request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'active' }, randomUUID())).status, 200);
    confirmStatus = false;
    const unconfirmed = await request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', status: 'paused' }, randomUUID()); assert.equal(unconfirmed.status, 409); assert.equal(unconfirmed.data.operation.status, 'uncertain');
    assert.equal((await app.store.get(projectId, 'campaigns', created.data.campaign.id)).status, 'active', 'An unconfirmed write cannot replace the last confirmed switch.');
    const beforeBlockedBudget = writes.length, blockedBudget = await request(route + 'ads/campaign', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', budget: { amount: 90, type: 'daily' } }, randomUUID());
    assert.equal(blockedBudget.status, 409); assert.equal(blockedBudget.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blockedBudget.data.operation.status, 'failed'); assert.equal(writes.length, beforeBlockedBudget, 'An unresolved switch must block changed campaign requests until reviewed.');
    await app.sql.run("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?", unconfirmed.data.operation.id);
    confirmBudget = false;
    const missingBudget = await request(route + 'ads/campaign', 'POST', { campaignId: campaign.platformCampaignId, platform: 'openai', budget: { amount: 90, type: 'daily' } }, randomUUID());
    assert.equal(missingBudget.status, 409); assert.equal(missingBudget.data.operation.status, 'uncertain', 'After review, the next independent unverified action retains its own uncertainty fence.');
    assert.equal((await app.store.get(projectId, 'campaigns', created.data.campaign.id)).budget, 75, 'An unconfirmed budget cannot become local delivery evidence.');
    campaign.platform = 'pinterest';
    const acknowledged = await app.store.create(projectId, 'campaigns', { name: 'Acknowledged-only switch', status: 'paused', externalId: 'pinterest-ad', platform: 'pinterest', platformCampaignId: campaign.platformCampaignId, zernioProfileId: profileId });
    const accepted = await request(route + 'ads/status', 'POST', { campaignId: campaign.platformCampaignId, platform: 'pinterest', status: 'active' }, randomUUID()); assert.equal(accepted.status, 200); assert.equal(accepted.data.verification, 'unavailable');
    assert.equal((await app.store.get(projectId, 'campaigns', acknowledged.id)).status, 'paused', 'Acknowledgement without live readback cannot become a confirmed local switch.');
    const before = writes.length; await app.sql.run("UPDATE memberships SET role='viewer' WHERE user_id=?", setup.data.user.id);
    assert.equal((await request(route + 'ads/create', 'POST', body, randomUUID())).status, 403); assert.equal(writes.length, before);
    assert.equal((await request(route + 'ads', 'GET', undefined, undefined, '')).status, 401);
    assert.doesNotMatch(JSON.stringify(await app.sql.all('SELECT * FROM integration_operations')), /PRIVATE_/);
  } finally { releaseStatus?.(); await heldRequest?.catch(() => {}); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});
