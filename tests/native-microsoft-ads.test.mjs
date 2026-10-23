import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, singleConnection, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const input = { name: 'Native Microsoft search', dailyBudget: 20, maxCpc: 2, finalUrl: 'https://example.test/offer', headlines: ['Plan Better Campaigns', 'Coordinate Your Launch', 'See Campaign Performance'], descriptions: ['Plan and review campaign work in one place.', 'Bring channels and teams together for your next launch.'], keywords: ['campaign manager', 'campaign planning'], matchType: 'Exact', locationIds: ['190'], confirmed: true };
async function fixture(t, poolOptions) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-microsoft-native-')), origin = 'https://campaign.example.test', env = { MICROSOFT_ADS_CLIENT_ID: 'fixture-client-id', MICROSOFT_ADS_CLIENT_SECRET: 'PRIVATE_CLIENT_SECRET', MICROSOFT_ADS_REFRESH_TOKEN: 'PRIVATE_REFRESH_TOKEN', MICROSOFT_ADS_DEVELOPER_TOKEN: 'PRIVATE_DEVELOPER_TOKEN' };
  const app = await testApp(t, { dataDir, env, appUrl: origin, directScheduler: false }, poolOptions), originalFetch = globalThis.fetch, calls = [], state = { campaigns: [], groups: [], ads: [], keywords: [], locations: [], mode: '', hook: null };
  let cookie, counter = 1000;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    const body = url.hostname === 'login.microsoftonline.com' ? Object.fromEntries(new URLSearchParams(options.body)) : JSON.parse(options.body); calls.push({ url, ...options, body }); assert.equal(options.redirect, 'error');
    if (url.hostname === 'login.microsoftonline.com') { assert.equal(url.pathname, '/common/oauth2/v2.0/token'); assert.equal(body.grant_type, 'refresh_token'); assert.equal(body.scope, 'https://ads.microsoft.com/msads.manage offline_access'); assert.equal(body.client_secret, env.MICROSOFT_ADS_CLIENT_SECRET); return Response.json({ access_token: 'PRIVATE_ACCESS_TOKEN', token_type: Object.hasOwn(state, 'tokenType') ? state.tokenType : 'Bearer', scope: 'https://ads.microsoft.com/msads.manage', ...(state.rotateTokens ? { refresh_token: 'ROTATED_' + randomUUID() } : {}) }); }
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE_ACCESS_TOKEN'); assert.equal(options.headers.DeveloperToken, env.MICROSOFT_ADS_DEVELOPER_TOKEN);
    if (state.hook) await state.hook(url, body);
    if (url.hostname === 'clientcenter.api.bingads.microsoft.com') { assert.equal(url.pathname, '/CustomerManagement/v13/Account/Query'); return Response.json({ Account: { Id: body.AccountId, ParentCustomerId: state.mode === 'foreign-account' ? '999' : '10', Name: 'Synthetic Microsoft account', CurrencyCode: 'USD', TimeZone: 'PacificTimeUSCanadaTijuana' } }); }
    assert.equal(options.headers.CustomerAccountId, '100'); assert.equal(options.headers.CustomerId, '10');
    if (url.hostname === 'reporting.api.bingads.microsoft.com') {
      if (url.pathname.endsWith('/Submit')) { assert.deepEqual(body.ReportRequest.Scope, { AccountIds: ['100'] }); assert.equal(body.ReportRequest.Type, 'CampaignPerformanceReportRequest'); assert.deepEqual(body.ReportRequest.Columns, ['AccountId', 'CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Spend', 'Conversions']); return Response.json({ ReportRequestId: 'private-report-job' }); }
      assert.equal(url.pathname, '/Reporting/v13/GenerateReport/Poll'); assert.equal(body.ReportRequestId, 'private-report-job'); return Response.json({ ReportRequestStatus: { Status: state.mode === 'report-pending' ? 'Pending' : 'Success', ReportDownloadUrl: state.mode === 'report-private' ? 'https://127.0.0.1/report' : 'https://reports.bingads.microsoft.com/campaign.zip?signature=fixture' } });
    }
    assert.equal(url.hostname, 'campaign.api.bingads.microsoft.com');
    const path = url.pathname.slice('/CampaignManagement/v13'.length), nextId = () => String(++counter);
    if (path === '/Campaigns/QueryByAccountId') {
      assert.equal(body.AccountId, '100');
      const failure = state.nextUpdateReadbackFailure; delete state.nextUpdateReadbackFailure;
      if (state.mode === 'preflight-read-failure' || failure === 'http') return Response.json({}, { status: 400 });
      if (failure === 'fault') return Response.json({ OperationErrors: [{ Code: 'SyntheticReadFailure' }] });
      if (failure === 'revoked') await app.sql.run("UPDATE memberships SET role='viewer' WHERE user_id=?", state.revokeUserId);
      return Response.json({ Campaigns: state.campaigns });
    }
    if (path === '/Campaigns' && options.method === 'PUT') { if (state.mode !== 'ignore-status-update') Object.assign(state.campaigns.find(row => row.Id === body.Campaigns[0].Id), body.Campaigns[0]); if (state.updateReadbackFailure) state.nextUpdateReadbackFailure = state.updateReadbackFailure; return Response.json({ PartialErrors: [] }); }
    // Microsoft's REST SDK defaults to MaxClicks, while accepting both that and the legacy SOAP name on reads:
    // https://github.com/BingAds/BingAds-Python-SDK/blob/main/openapi_client/models/campaign/bidding_scheme.py
    if (path === '/Campaigns') { assert.equal(body.Campaigns[0].Status, 'Paused'); assert.equal(body.Campaigns[0].CampaignType, 'Search'); assert.deepEqual(body.Campaigns[0].BiddingScheme, { Type: 'MaxClicks', MaxCpc: { Amount: 2 } }); const row = { Id: nextId(), BudgetId: '0', ...body.Campaigns[0] }; state.campaigns.push(row); return Response.json({ CampaignIds: [row.Id], PartialErrors: [] }); }
    if (path === '/AdGroups') { const row = { Id: nextId(), ...body.AdGroups[0] }; state.groups.push(row); return Response.json({ AdGroupIds: [row.Id], PartialErrors: [] }); }
    if (path === '/Ads') { if (state.mode === 'lost-ad-receipt') throw new Error('PRIVATE_PROVIDER_LOST_ACK'); const row = { Id: nextId(), ...body.Ads[0] }; state.ads.push(row); return Response.json({ AdIds: [row.Id], PartialErrors: [] }); }
    if (path === '/Keywords') { const created = body.Keywords.map(row => ({ Id: nextId(), ...row })); state.keywords.push(...created); return Response.json({ KeywordIds: created.map(row => row.Id), PartialErrors: [] }); }
    if (path === '/CampaignCriterions') { const created = body.CampaignCriterions.map(row => ({ Id: nextId(), ...row })); state.locations.push(...created); return Response.json({ CampaignCriterionIds: created.map(row => row.Id), NestedPartialErrors: [] }); }
    if (path === '/AdGroups/QueryByCampaignId') { assert.equal(body.ReturnAdditionalFields, 'AdGroupType'); return Response.json({ AdGroups: state.groups.map(row => body.ReturnAdditionalFields === 'AdGroupType' ? row : { ...row, AdGroupType: undefined }) }); }
    if (path === '/Ads/QueryByAdGroupId') return Response.json({ Ads: state.mode === 'bad-readback' ? state.ads.map(row => ({ ...row, Headlines: [] })) : state.ads });
    if (path === '/Keywords/QueryByAdGroupId') return Response.json({ Keywords: state.keywords });
    if (path === '/CampaignCriterions/QueryByIds') return Response.json({ CampaignCriterions: state.locations });
    assert.fail('Unexpected native Microsoft route: ' + url.href);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, key, auth = cookie) { const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(auth ? { Cookie: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/api/auth/setup', 'POST', { name: 'Native Microsoft operator', email: 'native-microsoft@example.test', password: 'isolated Microsoft fixture password' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const projectId = setup.data.projectId, prefix = `/api/projects/${projectId}/microsoft-ads`;
  return { app, env, calls, state, request, projectId, prefix, userId: setup.data.user.id, async map() { const result = await request(prefix + '/connection', 'POST', { customerId: '10', accountId: '100', confirmed: true }); assert.equal(result.status, 200, JSON.stringify(result.data)); }, async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('native Microsoft search creates a paused campaign with exact targeting, responsive assets and keywords, then verifies status, budget and scoped reporting', { skip: postgresSkip }, async t => {
  // One pool connection: the mapping transaction must re-check access on its own connection.
  const f = await fixture(t, singleConnection);
  try {
    assert.equal((await f.request(f.prefix + '/status', 'GET', undefined, undefined, '')).status, 401); assert.equal((await f.request(f.prefix + '/status')).data.mapping, null); assert.equal(f.calls.length, 0);
    f.state.mode = 'foreign-account'; assert.equal((await f.request(f.prefix + '/connection', 'POST', { customerId: '10', accountId: '100', confirmed: true })).status, 502); f.state.mode = ''; await f.map();
    const mapped = (await f.request(f.prefix + '/status')).data.mapping; assert.deepEqual(mapped, { customerId: '10', accountId: '100', name: 'Synthetic Microsoft account', currency: 'USD', timeZone: 'PacificTimeUSCanadaTijuana' });
    assert.equal((await f.request(f.prefix + '/connection', 'POST', { customerId: '10', accountId: '101', confirmed: true })).status, 409);
    const another = await f.request('/api/workspaces', 'POST', { name: 'Separate native project' }), otherPrefix = `/api/projects/${another.data.projectId}/microsoft-ads`;
    assert.equal((await f.request(otherPrefix + '/connection', 'POST', { customerId: '10', accountId: '100', confirmed: true })).status, 409);
    const key = randomUUID(), created = await f.request(f.prefix + '/campaigns', 'POST', input, key); assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(created.data.providerCampaign.status, 'Paused'); assert.equal(created.data.campaign.nativeProvider, 'microsoft'); assert.equal(f.state.campaigns.length, 1);
    assert.equal(created.data.providerCampaign.bidding, 'MaxClicksBiddingScheme', 'REST MaxClicks readback must confirm the configured bidding strategy.');
    f.state.campaigns[0].BiddingScheme.Type = 'MaxClicksBiddingScheme';
    assert.equal((await f.request(f.prefix + '/campaigns')).data.campaigns[0].bidding, created.data.providerCampaign.bidding, 'Legacy SOAP names remain readable.');
    assert.deepEqual(f.state.ads[0].Headlines.map(row => row.Asset.Text), input.headlines); assert.deepEqual(f.state.ads[0].Descriptions.map(row => row.Asset.Text), input.descriptions); assert.deepEqual(f.state.keywords.map(row => [row.Text, row.MatchType]), input.keywords.map(value => [value, input.matchType])); assert.equal(f.state.locations[0].Criterion.LocationId, '190');
    assert.equal((await f.request(f.prefix + '/campaigns', 'POST', input, key)).status, 200); assert.equal(f.state.campaigns.length, 1);
    const campaignId = created.data.providerCampaign.id, updated = await f.request(f.prefix + '/campaigns/' + campaignId, 'POST', { status: 'Active', dailyBudget: 25, confirmed: true }, randomUUID());
    assert.equal(updated.status, 200, JSON.stringify(updated.data)); assert.equal(updated.data.campaign.status, 'Active'); assert.equal(updated.data.campaign.dailyBudget, 25);
    const local = (await f.app.store.list(f.projectId, 'campaigns'))[0]; assert.equal(local.status, 'active'); assert.equal(local.budget, 25);
    assert.equal((await f.request(f.prefix + '/campaigns/99999', 'POST', { status: 'Paused', confirmed: true }, randomUUID())).status, 404);
    const report = await f.request(f.prefix + '/reports', 'POST', { fromDate: '2026-10-01', toDate: '2026-10-17' }); assert.equal(report.status, 200, JSON.stringify(report.data)); assert.equal(report.data.report.status, 'Pending'); assert.equal((await f.request(f.prefix + '/status')).data.latestReport.id, report.data.report.id, 'Reopening the page can resume its most recent report.');
    f.state.mode = 'report-pending'; assert.equal((await f.request(f.prefix + '/reports/' + report.data.report.id)).data.report.status, 'Pending'); f.state.mode = '';
    const ready = await f.request(f.prefix + '/reports/' + report.data.report.id); assert.equal(ready.status, 200); assert.equal(ready.data.report.downloadUrl, 'https://reports.bingads.microsoft.com/campaign.zip?signature=fixture');
    await f.request(otherPrefix + '/connection', 'POST', { customerId: '10', accountId: '101', confirmed: true }); assert.equal((await f.request(otherPrefix + '/reports/' + report.data.report.id)).status, 404);
    f.state.mode = 'report-private'; assert.equal((await f.request(f.prefix + '/reports/' + report.data.report.id)).status, 502); f.state.mode = '';
    const state = await f.request('/api/state'); assert.doesNotMatch(JSON.stringify(state.data), /PRIVATE_/);
  } finally { await f.close(); }
});

test('native Microsoft validation, roles, partial creation, readback and lost acknowledgements stop unintended writes or duplicate campaigns', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    for (const tokenType of [42, {}, [], null]) {
      f.state.tokenType = tokenType; const before = f.calls.length;
      const rejected = await f.request(f.prefix + '/connection', 'POST', { customerId: '10', accountId: '100', confirmed: true });
      assert.equal(rejected.status, 502); assert.equal(rejected.data.error.code, 'INVALID_MICROSOFT_TOKEN');
      assert.equal(f.calls.length, before + 1, 'A malformed token must stop before any account or campaign request.');
    }
    delete f.state.tokenType;
    await f.map();
    for (const patch of [{ confirmed: false }, { dailyBudget: -1 }, { dailyBudget: 1.001 }, { finalUrl: 'http://localhost/private' }, { headlines: ['Only one'] }, { descriptions: ['Same', 'Same'] }, { keywords: [] }, { locationIds: [] }, { matchType: 'Unsupported' }, { arbitraryPayload: {} }, { headlines: ['Dynamic {keyword}', 'Second headline', 'Third headline'] }]) {
      const result = await f.request(f.prefix + '/campaigns', 'POST', { ...input, ...patch }, randomUUID()); assert.ok([400, 422].includes(result.status), JSON.stringify(result.data));
    }
    assert.equal(f.state.campaigns.length, 0);
    await f.app.sql.run("UPDATE memberships SET role='viewer' WHERE user_id=?", f.userId); const before = f.calls.length;
    assert.equal((await f.request(f.prefix + '/campaigns', 'POST', input, randomUUID())).status, 403); assert.equal(f.calls.length, before); assert.equal((await f.request(f.prefix + '/campaigns')).status, 200);
    await f.app.sql.run("UPDATE memberships SET role='editor' WHERE user_id=?", f.userId); assert.equal((await f.request(f.prefix + '/connection', 'POST', { customerId: '10', accountId: '100', confirmed: true })).status, 403);
    await f.app.sql.run("UPDATE memberships SET role='owner' WHERE user_id=?", f.userId);
    for (const mode of ['lost-ad-receipt', 'bad-readback']) {
      f.state.mode = mode; const body = { ...input, name: input.name + ' ' + mode }, key = randomUUID(), result = await f.request(f.prefix + '/campaigns', 'POST', body, key);
      assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'uncertain'); assert.match(result.data.error.message, /reconciliation/); assert.ok(f.state.campaigns.every(row => row.Status === 'Paused')); assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_/);
      const count = f.state.campaigns.length; for (const retry of [key, randomUUID()]) assert.equal((await f.request(f.prefix + '/campaigns', 'POST', body, retry)).status, 409); assert.equal(f.state.campaigns.length, count);
    }
    assert.equal((await f.app.store.list(f.projectId, 'campaigns')).length, 0, 'An incomplete native campaign must not be presented as a complete local campaign.');
    f.state.mode = ''; f.state.hook = async url => { if (url.hostname === 'campaign.api.bingads.microsoft.com') await f.app.sql.run('DELETE FROM memberships WHERE user_id=?', f.userId); };
    const revoked = await f.request(f.prefix + '/campaigns'); assert.ok([403, 409].includes(revoked.status)); assert.doesNotMatch(JSON.stringify(revoked.data), /Native Microsoft search/);
  } finally { await f.close(); }
});

test('a concurrent campaign list can rotate its token without interrupting paused campaign creation', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  let release, create, timer;
  try {
    f.state.rotateTokens = true; await f.map();
    let reached;
    const paused = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent Microsoft fixture did not settle.')), 5000); });
    f.state.hook = async (url, body) => {
      if (url.pathname === '/CampaignManagement/v13/Campaigns' && body.Campaigns) { f.state.hook = null; reached(); await held; }
    };
    create = f.request(f.prefix + '/campaigns', 'POST', input, randomUUID());
    await Promise.race([paused, deadline, create.then(() => { throw new Error('Creation finished before its provider pause.'); })]);
    const beforeRead = f.env.MICROSOFT_ADS_REFRESH_TOKEN;
    assert.equal((await Promise.race([f.request(f.prefix + '/campaigns'), deadline])).status, 200);
    assert.notEqual(f.env.MICROSOFT_ADS_REFRESH_TOKEN, beforeRead, 'The concurrent list must persist a different refresh token.');
    release();
    const result = await create;
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'complete');
    assert.equal(f.state.campaigns.length, 1); assert.equal((await f.app.store.list(f.projectId, 'campaigns')).length, 1);
    assert.match(f.env.MICROSOFT_ADS_REFRESH_TOKEN, /^ROTATED_/);
  } finally { clearTimeout(timer); release?.(); await create?.catch(() => {}); await f.close(); }
});

test('native Microsoft serializes campaign status and budget changes through provider readback', { skip: postgresSkip }, async t => {
  const f = await fixture(t); let release, heldRequest, timer;
  try {
    await f.map(); const created = await f.request(f.prefix + '/campaigns', 'POST', input, randomUUID()); assert.equal(created.status, 200);
    const campaignId = created.data.providerCampaign.id, route = f.prefix + '/campaigns/' + campaignId;
    let reached; const started = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
    f.state.hook = async (url, body) => { if (url.pathname === '/CampaignManagement/v13/Campaigns' && body.Campaigns?.[0].Status === 'Active') { f.state.hook = null; reached(); await held; } };
    const key = randomUUID(); heldRequest = f.request(route, 'POST', { status: 'Active', confirmed: true }, key);
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Microsoft held update was not reached.')), 5000); })]); clearTimeout(timer);
    const writes = () => f.calls.filter(row => row.method === 'PUT').length, before = writes(), blockedRequests = [];
    for (const body of [{ status: 'Paused', confirmed: true }, { dailyBudget: 30, confirmed: true }]) {
      const key = randomUUID(), blocked = await f.request(route, 'POST', body, key); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); blockedRequests.push({ body, key, receipt: blocked.data });
    }
    assert.equal(writes(), before, 'Overlapping native changes cannot reach Microsoft.'); release(); assert.equal((await heldRequest).status, 200);
    for (const blocked of blockedRequests) assert.deepEqual((await f.request(route, 'POST', blocked.body, blocked.key)).data, blocked.receipt);
    assert.equal(writes(), before, 'Blocked keys cannot dispatch after the original action completes.');
    assert.equal((await f.request(route, 'POST', { status: 'Paused', confirmed: true }, randomUUID())).status, 200);
    assert.equal((await f.request(route, 'POST', { status: 'Active', confirmed: true }, key)).status, 200, 'A completed receipt can still replay.');
    assert.equal(f.state.campaigns[0].Status, 'Paused'); assert.equal((await f.app.store.get(f.projectId, 'campaigns', created.data.campaign.id)).status, 'paused');
  } finally { clearTimeout(timer); release?.(); await heldRequest?.catch(() => {}); await f.close(); }
});

test('Microsoft status-only controls work with shared and unknown budgets without editing a shared pool or trusting unreadable ownership', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    await f.map(); const created = await f.request(f.prefix + '/campaigns', 'POST', input, randomUUID()); assert.equal(created.status, 200);
    const campaign = f.state.campaigns[0], route = f.prefix + '/campaigns/' + campaign.Id, writes = () => f.calls.filter(row => row.method === 'PUT');
    // BudgetId identifies sharing; DailyBudget on a shared campaign is the pool total, not a campaign allocation.
    // https://learn.microsoft.com/en-us/advertising/campaign-management-service/campaign?view=bingads-13
    campaign.BudgetId = '900'; campaign.DailyBudget = 500;
    const active = await f.request(route, 'POST', { status: 'Active', confirmed: true }, randomUUID()); assert.equal(active.status, 200); assert.equal(active.data.campaign.sharedBudget, true);
    assert.deepEqual(writes().at(-1).body.Campaigns, [{ Id: campaign.Id, Status: 'Active' }]);
    assert.equal((await f.app.store.get(f.projectId, 'campaigns', created.data.campaign.id)).budget, input.dailyBudget, 'Changing a switch cannot copy a shared pool total into a local campaign allocation.');
    let before = writes().length; assert.equal((await f.request(route, 'POST', { dailyBudget: 50, confirmed: true }, randomUUID())).status, 422); assert.equal(writes().length, before);
    campaign.BudgetId = '0'; campaign.BudgetType = 'LifetimeBudgetStandard';
    assert.equal((await f.request(route, 'POST', { status: 'Paused', confirmed: true }, randomUUID())).status, 200);
    before = writes().length; assert.equal((await f.request(route, 'POST', { dailyBudget: 50, confirmed: true }, randomUUID())).status, 422); assert.equal(writes().length, before); campaign.BudgetType = 'DailyBudgetStandard';
    for (const value of ['unreadable', {}, -1, 9007199254740992, '9223372036854775808']) {
      campaign.BudgetId = value;
      const result = await f.request(route, 'POST', { status: 'Active', confirmed: true }, randomUUID()); assert.equal(result.status, 200); assert.equal(result.data.campaign.sharedBudget, null);
      before = writes().length; assert.equal((await f.request(route, 'POST', { dailyBudget: 50, confirmed: true }, randomUUID())).status, 422); assert.equal(writes().length, before);
    }
    f.state.mode = 'ignore-status-update'; const key = randomUUID(), body = { status: 'Paused', confirmed: true };
    const unconfirmed = await f.request(route, 'POST', body, key); assert.equal(unconfirmed.status, 409); assert.equal(unconfirmed.data.operation.status, 'uncertain'); assert.equal((await f.app.store.get(f.projectId, 'campaigns', created.data.campaign.id)).status, 'active');
    before = writes().length;
    assert.equal((await f.request(route, 'POST', body, key)).data.error.code, 'OPERATION_UNCERTAIN');
    const blocked = await f.request(route, 'POST', body, randomUUID()); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, unconfirmed.data.operation.id); assert.equal(writes().length, before);
  } finally { await f.close(); }
});

test('accepted Microsoft changes stay uncertain after rejected or revoked readback, while preflight reads remain retryable', { skip: postgresSkip }, async t => {
  for (const failure of ['http', 'fault', 'revoked']) {
    const f = await fixture(t);
    try {
      await f.map(); const created = await f.request(f.prefix + '/campaigns', 'POST', input, randomUUID()); assert.equal(created.status, 200);
      const route = f.prefix + '/campaigns/' + created.data.providerCampaign.id, writes = () => f.calls.filter(row => row.method === 'PUT').length;
      f.state.mode = 'preflight-read-failure';
      const preflight = await f.request(route, 'POST', { status: 'Paused', confirmed: true }, randomUUID());
      assert.equal(preflight.status, 400); assert.equal(preflight.data.operation, undefined); assert.equal(writes(), 0);
      f.state.mode = ''; assert.equal((await f.request(route, 'POST', { status: 'Paused', confirmed: true }, randomUUID())).status, 200);
      const before = writes(), body = { status: 'Active', confirmed: true }, key = randomUUID();
      f.state.updateReadbackFailure = failure; f.state.revokeUserId = f.userId;
      const result = await f.request(route, 'POST', body, key);
      assert.equal(f.state.campaigns[0].Status, 'Active', 'The provider already applied this update.');
      assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'uncertain');
      assert.equal((await f.app.store.get(f.projectId, 'campaigns', created.data.campaign.id)).status, 'paused', 'Unconfirmed readback cannot advance the local receipt.');
      await f.app.sql.run("UPDATE memberships SET role='owner' WHERE user_id=?", f.userId); f.state.updateReadbackFailure = '';
      assert.equal((await f.request(route, 'POST', body, key)).data.error.code, 'OPERATION_UNCERTAIN');
      const blocked = await f.request(route, 'POST', body, randomUUID()); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id);
      assert.equal(writes(), before + 1, 'Neither retry may repeat the accepted provider update.');
    } finally { await f.close(); }
  }
});
