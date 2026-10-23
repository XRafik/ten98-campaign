import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { postgresSkip, singleConnection, testApp } from './postgres.mjs';
import { testNativeGoogleAds } from '../server/native-google-ads.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { firstProject } from './first-project.ts';

const env = { GOOGLE_ADS_CLIENT_ID: 'fixture-client.apps.googleusercontent.com', GOOGLE_ADS_CLIENT_SECRET: 'fixture-client-secret', GOOGLE_ADS_REFRESH_TOKEN: 'fixture-refresh-token', GOOGLE_ADS_DEVELOPER_TOKEN: 'fixture-developer-token', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '9999999999' };

test('native Google Shopping uses an atomic paused resource graph, customer mapping, validation, report cursors and durable unconfirmed outcomes over HTTP', { skip: postgresSkip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-native-google-')), origin = 'http://127.0.0.1:3000';
  // One pool connection: the mapping transaction must re-check access on its own connection.
  const app = await testApp(t, { dataDir: directory, appUrl: origin, env: { ...env }, directScheduler: false }, singleConnection), originalFetch = globalThis.fetch, calls = [], creates = [], updates = [], customerId = '1234567890';
  let cookie, projectId, badReceipt = false, readbackFailure = false, badReadbackStatus = false, mappingChange = false, foreignReport = false, sharedBudget = false, malformedReport = {};
  let lastCampaign = null, counter = 0, budgetPeriod = 'DAILY', biddingStrategy = 'MANUAL_CPC', badListing = {}, listingRows = 1, foreignListing = false, failCpcReadback = false;
  let updateHook, releaseUpdate, heldUpdate, timer, accountReadFailure;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    if (url.origin === 'https://oauth2.googleapis.com') { const form = new URLSearchParams(options.body); assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('client_secret'), env.GOOGLE_ADS_CLIENT_SECRET); assert.equal(form.get('refresh_token'), env.GOOGLE_ADS_REFRESH_TOKEN); return new Response(JSON.stringify({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600 })); }
    assert.equal(url.origin, 'https://googleads.googleapis.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-access-token'); assert.equal(options.headers['developer-token'], env.GOOGLE_ADS_DEVELOPER_TOKEN); assert.equal(options.headers['login-customer-id'], env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
    const payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, payload }); let result;
    if (url.pathname === '/v25/customers:listAccessibleCustomers') result = { resourceNames: [`customers/${customerId}`] };
    else if (url.pathname === `/v25/customers/${customerId}/googleAds:search`) {
      assert.equal(options.method, 'POST'); assert.equal(payload.pageSize, undefined, 'v25 rejects the deprecated pageSize field');
      if (payload.query.includes('FROM customer LIMIT 1')) { if (accountReadFailure === 'network') throw new Error('Read-only account lookup disconnected.'); if (accountReadFailure === 'http') return Response.json({}, { status: 503 }); if (accountReadFailure === 'invalid') return new Response('unreadable account result'); result = { results: [{ customer: { id: customerId, descriptiveName: 'Native Google fixture', currencyCode: 'USD', timeZone: 'Asia/Dubai', manager: false, testAccount: true } }] }; }
      else if (payload.query.includes('FROM geo_target_constant')) { assert.match(payload.query, /country_code IN \('AE','SA'\)/); result = { results: [{ geoTargetConstant: { id: '2784', countryCode: 'AE', targetType: 'Country', status: 'ENABLED' } }, { geoTargetConstant: { id: '2682', countryCode: 'SA', targetType: 'Country', status: 'ENABLED' } }] }; }
      else if (payload.query.includes('FROM ad_group_ad WHERE')) result = { results: [{ customer: { id: customerId }, campaign: { id: lastCampaign.id }, adGroupAd: { resourceName: `customers/${customerId}/adGroupAds/${lastCampaign.groupId}~4001`, status: lastCampaign.adStatus } }] };
      else if (payload.query.includes('FROM ad_group WHERE')) result = { results: [{ customer: { id: customerId }, campaign: { id: lastCampaign.id }, adGroup: { resourceName: `customers/${customerId}/adGroups/${lastCampaign.groupId}`, status: lastCampaign.groupStatus, cpcBidMicros: lastCampaign.groupCpc } }] };
      else if (payload.query.includes('FROM ad_group_criterion WHERE')) result = { results: Array.from({ length: listingRows }, () => ({ customer: { id: foreignListing ? '2222222222' : customerId }, campaign: { id: lastCampaign.id }, adGroup: { resourceName: `customers/${customerId}/adGroups/${lastCampaign.groupId}` }, adGroupCriterion: { resourceName: `customers/${customerId}/adGroupCriteria/${lastCampaign.groupId}~5001`, status: 'ENABLED', negative: false, cpcBidMicros: failCpcReadback ? '1' : lastCampaign.listingCpc, listingGroup: { type: 'UNIT' }, ...badListing } })) };
      else if (payload.query.includes('campaign.campaign_budget =')) result = { results: [{ campaign: { id: lastCampaign.id } }, ...(sharedBudget ? [{ campaign: { id: '99999' } }] : [])] };
      else if (payload.query.includes('WHERE campaign.resource_name =')) { if (readbackFailure) throw new Error('Accepted write readback unavailable'); result = { results: [{ customer: { id: customerId }, campaign: { id: lastCampaign.id, name: lastCampaign.name, status: badReadbackStatus ? 'ENABLED' : lastCampaign.status, advertisingChannelType: 'SHOPPING', biddingStrategyType: biddingStrategy }, campaignBudget: { amountMicros: lastCampaign.budget, resourceName: `customers/${customerId}/campaignBudgets/3001`, explicitlyShared: sharedBudget, period: budgetPeriod } }] }; }
      else { assert.match(payload.query, /advertising_channel_type IN \('SHOPPING', 'VIDEO'\)/); assert.match(payload.query, /BETWEEN '2026-09-01' AND '2026-09-30'/); result = { results: [{ customer: { id: foreignReport ? '2222222222' : customerId }, campaign: { id: '801', name: 'Existing video', status: 'PAUSED', advertisingChannelType: 'VIDEO', ...malformedReport.campaign }, campaignBudget: { amountMicros: '20000000', period: 'DAILY', ...malformedReport.budget }, metrics: { impressions: '200', clicks: '5', costMicros: '1750000', conversions: 1.5, ...malformedReport.metrics } }], ...(payload.pageToken ? {} : { nextPageToken: 'native-next-page' }) }; }
    } else if (url.pathname === `/v25/customers/${customerId}/googleAds:mutate`) {
      assert.equal(payload.partialFailure, false); assert.equal(payload.responseContentType, 'RESOURCE_NAME_ONLY');
      if (!payload.mutateOperations[0].campaignBudgetOperation?.create) {
        const responses = payload.mutateOperations.map(row => { const [kind, operation] = Object.entries(row)[0]; assert.ok(operation.update); const change = operation.update;
          if (kind === 'campaignOperation') { assert.equal(change.resourceName, `customers/${customerId}/campaigns/${lastCampaign.id}`); assert.equal(operation.updateMask, 'status'); lastCampaign.status = change.status; }
          if (kind === 'adGroupOperation') { assert.equal(change.resourceName, `customers/${customerId}/adGroups/${lastCampaign.groupId}`); if (change.cpcBidMicros !== undefined) { assert.equal(operation.updateMask, 'cpc_bid_micros'); lastCampaign.groupCpc = change.cpcBidMicros; } else { assert.equal(operation.updateMask, 'status'); lastCampaign.groupStatus = change.status; } }
          if (kind === 'adGroupCriterionOperation') { assert.equal(change.resourceName, `customers/${customerId}/adGroupCriteria/${lastCampaign.groupId}~5001`); assert.equal(operation.updateMask, 'cpc_bid_micros'); lastCampaign.listingCpc = change.cpcBidMicros; }
          if (kind === 'adGroupAdOperation') { assert.equal(change.resourceName, `customers/${customerId}/adGroupAds/${lastCampaign.groupId}~4001`); assert.equal(operation.updateMask, 'status'); lastCampaign.adStatus = change.status; }
          if (kind === 'campaignBudgetOperation') { assert.equal(change.resourceName, `customers/${customerId}/campaignBudgets/3001`); assert.equal(operation.updateMask, 'amount_micros'); lastCampaign.budget = change.amountMicros; }
          return { [kind.replace('Operation', 'Result')]: { resourceName: change.resourceName } };
        }); updates.push(payload); if (updateHook) await updateHook(); return Response.json({ mutateOperationResponses: responses });
      }
      const operations = payload.mutateOperations; assert.deepEqual(operations.map(row => Object.keys(row)[0]), ['campaignBudgetOperation', 'campaignOperation', 'adGroupOperation', 'adGroupAdOperation', 'adGroupCriterionOperation', 'campaignCriterionOperation', 'campaignCriterionOperation']);
      const budget = operations[0].campaignBudgetOperation.create, campaign = operations[1].campaignOperation.create, group = operations[2].adGroupOperation.create, ad = operations[3].adGroupAdOperation.create, listing = operations[4].adGroupCriterionOperation.create;
      assert.equal(budget.resourceName, `customers/${customerId}/campaignBudgets/-1`); assert.equal(budget.amountMicros, '25000000'); assert.equal(budget.explicitlyShared, false);
      assert.equal(campaign.resourceName, `customers/${customerId}/campaigns/-2`); assert.equal(campaign.advertisingChannelType, 'SHOPPING'); assert.equal(campaign.status, 'PAUSED'); assert.equal(campaign.campaignBudget, budget.resourceName); assert.equal(campaign.containsEuPoliticalAdvertising, 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'); assert.deepEqual(campaign.shoppingSetting, { merchantId: '987654', campaignPriority: 1, feedLabel: 'AE_PRODUCTS' }); assert.equal(campaign.geoTargetTypeSetting.positiveGeoTargetType, 'PRESENCE');
      assert.equal(group.resourceName, `customers/${customerId}/adGroups/-3`); assert.equal(group.campaign, campaign.resourceName); assert.equal(group.type, 'SHOPPING_PRODUCT_ADS'); assert.equal(group.status, 'PAUSED'); assert.equal(group.cpcBidMicros, '1500000');
      assert.equal(ad.adGroup, group.resourceName); assert.equal(ad.status, 'PAUSED'); assert.deepEqual(ad.ad.shoppingProductAd, {}); assert.equal(listing.adGroup, group.resourceName); assert.equal(listing.listingGroup.type, 'UNIT'); assert.equal(listing.cpcBidMicros, '1500000'); assert.equal(listing.negative, undefined);
      assert.deepEqual(operations.slice(5).map(row => row.campaignCriterionOperation.create.location.geoTargetConstant), ['geoTargetConstants/2784', 'geoTargetConstants/2682']);
      if (payload.validateOnly) { result = {}; }
      else {
        creates.push(payload); const campaignId = String(1000 + ++counter), groupId = String(2000 + counter); lastCampaign = { id: campaignId, name: campaign.name, budget: budget.amountMicros, status: 'PAUSED', groupId, groupStatus: 'PAUSED', adStatus: 'PAUSED', groupCpc: group.cpcBidMicros, listingCpc: listing.cpcBidMicros };
        result = { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: `customers/${customerId}/campaignBudgets/3001` } }, { campaignResult: { resourceName: `customers/${badReceipt ? '2222222222' : customerId}/campaigns/${campaignId}` } }, { adGroupResult: { resourceName: `customers/${customerId}/adGroups/${groupId}` } }, { adGroupAdResult: { resourceName: `customers/${customerId}/adGroupAds/${groupId}~4001` } }, { adGroupCriterionResult: { resourceName: `customers/${customerId}/adGroupCriteria/${groupId}~5001` } }, { campaignCriterionResult: { resourceName: `customers/${customerId}/campaignCriteria/${campaignId}~6001` } }, { campaignCriterionResult: { resourceName: `customers/${customerId}/campaignCriteria/${campaignId}~6002` } }] };
        if (mappingChange) await app.sql.run('UPDATE native_google_connections SET customer_id=? WHERE project_id=?', '2222222222', projectId);
      }
    } else throw new Error('Unexpected native Google request ' + url.href);
    return new Response(JSON.stringify(result));
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, key = 'native-google-' + calls.length) { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    const setup = await request('/api/auth/setup', { name: 'Native Google QA', email: 'native-google@example.test', password: 'Native Google fixture password!' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; assert.equal(setup.status, 201);
    const state = (await request('/api/state')).data; projectId = state.projectId; const route = `/api/projects/${projectId}/native-google-ads/`;
    assert.equal((await request(route + 'status')).data.configured, true); assert.equal((await request(route + 'account')).status, 409);
    assert.equal((await request(route + 'connection', { customerId: '123-456-7890' })).status, 400);
    let result = await request(route + 'connection', { customerId }); assert.equal(result.status, 200); assert.equal(result.data.account.currencyCode, 'USD'); assert.equal(result.data.account.testAccount, true);
    const ownerId = state.user.id, workspaceId = state.workspaces[0].id;
    await app.sql.run('DELETE FROM instance_operators WHERE user_id=?', ownerId); assert.equal((await request(route + 'connection', { customerId })).status, 403); await app.sql.run('INSERT INTO instance_operators VALUES(?)', ownerId);
    await app.sql.run('UPDATE memberships SET role=? WHERE user_id=? AND workspace_id=?', 'viewer', ownerId, workspaceId); assert.equal((await request(route + 'shopping/create', {})).status, 403); await app.sql.run('UPDATE memberships SET role=? WHERE user_id=? AND workspace_id=?', 'owner', ownerId, workspaceId);
    const body = { name: 'Shopping launch', merchantId: '987654', feedLabel: 'AE_PRODUCTS', priority: 1, dailyBudget: 25, maxCpc: 1.5, countries: ['AE', 'SA'], euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', confirmCreate: true };
    result = await request(route + 'shopping/create', { ...body, validateOnly: true }); assert.equal(result.status, 200); assert.equal(result.data.validated, true); assert.equal(creates.length, 0); assert.equal((await app.store.list(projectId, 'campaigns')).length, 0);
    for (const changes of [{ confirmCreate: false }, { status: 'ENABLED' }, { campaignType: 'VIDEO' }, { countries: ["AE'); DELETE FROM campaigns;"] }, { euPoliticalAdvertising: undefined }, { feedLabel: 'lowercase' }, { dailyBudget: 0.001 }, { maxCpc: -1 }]) { result = await request(route + 'shopping/create', { ...body, ...changes }); assert.equal(result.status, 400, JSON.stringify(changes)); }
    assert.equal(creates.length, 0);
    result = await request(route + 'shopping/create', body, 'create-one-native'); assert.equal(result.status, 200); assert.equal(result.data.campaign.status, 'paused'); assert.equal(result.data.campaign.nativeProvider, 'googleAdsNative'); assert.equal(result.data.campaign.nativeCustomerId, customerId); assert.equal(creates.length, 1); assert.equal((await app.store.list(projectId, 'campaigns')).length, 1);
    result = await request(route + 'shopping/create', body, 'create-one-native'); assert.equal(result.status, 200); assert.equal(creates.length, 1); assert.equal((await app.store.list(projectId, 'campaigns')).length, 1);
    const campaignId = result.data.campaign.platformCampaignId;
    const safeRetry = { campaignId, status: 'PAUSED', confirmChange: true }, beforeAccountRead = updates.length;
    for (const failure of ['network', 'http', 'invalid']) { accountReadFailure = failure; result = await request(route + 'campaign/update', safeRetry, 'account-read-' + failure); assert.equal(result.status, 502); assert.equal(result.data.operation.status, 'failed', 'A failed read before any mutation must remain safely retryable.'); assert.equal(updates.length, beforeAccountRead); }
    accountReadFailure = undefined; result = await request(route + 'campaign/update', safeRetry, 'after-account-read-failure'); assert.equal(result.status, 200); assert.equal(updates.length, beforeAccountRead + 1, 'A fresh key can retry once the read-only preflight recovers.');
    const enable = { campaignId, status: 'ENABLED', enableCreatedChildren: true, confirmChange: true };
    lastCampaign.groupStatus = 'UNKNOWN'; const unknownChildWrites = updates.length; result = await request(route + 'campaign/update', enable); assert.equal(result.status, 403); assert.equal(updates.length, unknownChildWrites); lastCampaign.groupStatus = 'PAUSED';
    result = await request(route + 'campaign/update', enable, 'enable-native-created-graph'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.enabledCreatedChildren, true); assert.equal(lastCampaign.status, 'ENABLED'); assert.equal(lastCampaign.groupStatus, 'ENABLED'); assert.equal(lastCampaign.adStatus, 'ENABLED'); assert.equal(updates.at(-1).mutateOperations.length, 3); assert.equal((await app.store.list(projectId, 'campaigns'))[0].status, 'active');
    const enabledCount = updates.length; result = await request(route + 'campaign/update', enable, 'enable-native-created-graph'); assert.equal(result.status, 200); assert.equal(updates.length, enabledCount);
    result = await request(route + 'campaign/update', { campaignId, status: 'PAUSED', confirmChange: true }, 'pause-native-parent'); assert.equal(result.status, 200); assert.equal(lastCampaign.status, 'PAUSED'); assert.equal(lastCampaign.adStatus, 'ENABLED'); assert.equal(updates.at(-1).mutateOperations.length, 1);
    sharedBudget = true; const beforeShared = updates.length; result = await request(route + 'campaign/update', { campaignId, dailyBudget: 40, confirmChange: true }, 'reject-shared-native-budget'); assert.equal(result.status, 409); assert.equal(updates.length, beforeShared); sharedBudget = false;
    result = await request(route + 'campaign/update', { campaignId, dailyBudget: 40, confirmChange: true }, 'update-native-budget'); assert.equal(result.status, 200); assert.equal(lastCampaign.budget, '40000000'); assert.equal((await app.store.list(projectId, 'campaigns'))[0].budget, 40);
    for (const period of ['CUSTOM_PERIOD', 'UNKNOWN', undefined]) { budgetPeriod = period; const count = updates.length; result = await request(route + 'campaign/update', { campaignId, dailyBudget: 45, confirmChange: true }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'GOOGLE_DAILY_BUDGET_REQUIRED'); assert.equal(updates.length, count, 'A total or unconfirmed budget must never be replaced with a daily amount.'); } budgetPeriod = 'DAILY';
    result = await request(route + 'campaign/cpc?' + new URLSearchParams({ campaignId })); assert.equal(result.status, 200); assert.equal(result.data.maxCpcMicros, '1500000'); assert.equal(result.data.currencyCode, 'USD');
    assert.equal((await request(route + 'campaign/cpc?campaignId=99999')).status, 409);
    const cpcBody = { campaignId, maxCpc: 2.75, confirmChange: true }, beforeCpc = updates.length;
    for (const changes of [{ confirmChange: false }, { maxCpc: 0 }, { maxCpc: '2.75' }, { maxCpc: 0.0000001 }, { adGroupId: 'foreign' }]) assert.equal((await request(route + 'campaign/cpc', { ...cpcBody, ...changes })).status, 400);
    await app.sql.run('UPDATE memberships SET role=? WHERE user_id=? AND workspace_id=?', 'viewer', ownerId, workspaceId); assert.equal((await request(route + 'campaign/cpc', cpcBody)).status, 403); await app.sql.run('UPDATE memberships SET role=? WHERE user_id=? AND workspace_id=?', 'owner', ownerId, workspaceId);
    biddingStrategy = 'TARGET_ROAS'; assert.equal((await request(route + 'campaign/cpc', cpcBody)).status, 409); biddingStrategy = 'MANUAL_CPC';
    for (const listing of [{ negative: true }, { negative: 'false' }, { listingGroup: { type: 'SUBDIVISION' } }, { listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'parent' } }, { resourceName: `customers/${customerId}/adGroupCriteria/888~999` }]) { badListing = listing; assert.equal((await request(route + 'campaign/cpc', cpcBody)).status, 409); } badListing = {};
    listingRows = 2; assert.equal((await request(route + 'campaign/cpc', cpcBody)).status, 409); listingRows = 1;
    foreignListing = true; assert.equal((await request(route + 'campaign/cpc', cpcBody)).status, 409); foreignListing = false; assert.equal(updates.length, beforeCpc);
    result = await request(route + 'campaign/cpc', cpcBody, 'change-shopping-cpc'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.maxCpcMicros, '2750000'); assert.equal(result.data.groupMaxCpcMicros, '2750000'); assert.equal(updates.at(-1).mutateOperations.length, 2); assert.equal((await app.store.list(projectId, 'campaigns'))[0].maxCpc, 2.75);
    const cpcCount = updates.length; result = await request(route + 'campaign/cpc', cpcBody, 'change-shopping-cpc'); assert.equal(result.status, 200); assert.equal(updates.length, cpcCount);
    let reached; const started = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { releaseUpdate = resolve; });
    updateHook = async () => { updateHook = null; reached(); await held; };
    const heldBody = { campaignId, status: 'ENABLED', confirmChange: true }; heldUpdate = request(route + 'campaign/update', heldBody, 'held-native-enable');
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Google held update was not reached.')), 5000); })]); clearTimeout(timer);
    const heldCount = updates.length, blockedRequests = [];
    for (const [action, body] of [['campaign/update', { campaignId, status: 'PAUSED', confirmChange: true }], ['campaign/update', { campaignId, dailyBudget: 50, confirmChange: true }], ['campaign/cpc', { ...cpcBody, maxCpc: 2.9 }]]) {
      const key = 'held-native-blocked-' + blockedRequests.length, blocked = await request(route + action, body, key); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); blockedRequests.push({ action, body, key, receipt: blocked.data });
    }
    assert.equal(updates.length, heldCount, 'Shopping status, budget and CPC changes share one resource guard.'); releaseUpdate(); assert.equal((await heldUpdate).status, 200);
    for (const blocked of blockedRequests) assert.deepEqual((await request(route + blocked.action, blocked.body, blocked.key)).data, blocked.receipt);
    assert.equal(updates.length, heldCount, 'Previously blocked keys remain unsent after the held action completes.');
    assert.equal((await request(route + 'campaign/update', { campaignId, status: 'PAUSED', confirmChange: true }, 'after-held-native-pause')).status, 200);
    assert.equal((await request(route + 'campaign/update', heldBody, 'held-native-enable')).status, 200); assert.equal(lastCampaign.status, 'PAUSED'); assert.equal((await app.store.list(projectId, 'campaigns'))[0].status, 'paused');
    failCpcReadback = true; const unknownCpc = { ...cpcBody, maxCpc: 3 }; result = await request(route + 'campaign/cpc', unknownCpc, 'unknown-shopping-cpc'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const unknownCount = updates.length; result = await request(route + 'campaign/cpc', unknownCpc, 'new-key-shopping-cpc'); assert.equal(result.status, 409); assert.equal(updates.length, unknownCount); failCpcReadback = false;
    assert.equal((await request(route + 'campaign/update', { campaignId: '555', status: 'ENABLED', confirmChange: true })).status, 403);
    assert.equal((await request(route + 'campaign/update', { campaignId, status: 'ENABLED', dailyBudget: 40, confirmChange: true })).status, 400);
    const dates = { fromDate: '2026-09-01', toDate: '2026-09-30' }; result = await request(route + 'campaigns?' + new URLSearchParams(dates)); assert.equal(result.status, 200); assert.equal(result.data.campaigns[0].channel, 'VIDEO'); assert.equal(result.data.campaigns[0].metrics.costMicros, '1750000'); assert.equal(result.data.campaigns[0].budgetPeriod, 'DAILY'); assert.equal(result.data.campaigns[0].dailyBudgetMicros, '20000000');
    malformedReport = { budget: { period: 'CUSTOM_PERIOD', totalAmountMicros: '1000000000' } }; result = await request(route + 'campaigns?' + new URLSearchParams(dates)); assert.equal(result.status, 200); assert.equal(result.data.campaigns[0].totalBudgetMicros, '1000000000'); assert.equal(result.data.campaigns[0].dailyBudgetMicros, undefined); malformedReport = {};
    result = await request(route + 'campaigns?' + new URLSearchParams({ ...dates, pageToken: result.data.nextPageToken })); assert.equal(result.status, 200); assert.equal(result.data.nextPageToken, ''); foreignReport = true; assert.equal((await request(route + 'campaigns?' + new URLSearchParams(dates))).status, 502); foreignReport = false;
    for (const malformed of [{ campaign: { name: {} } }, { campaign: { status: {} } }, { metrics: { clicks: -1 } }, { metrics: { costMicros: 'NaN' } }, { metrics: { impressions: {} } }, { metrics: { conversions: -1 } }, { budget: { amountMicros: 'not-numeric' } }, { budget: { period: {} } }, { budget: { totalAmountMicros: '-1' } }]) { malformedReport = malformed; assert.equal((await request(route + 'campaigns?' + new URLSearchParams(dates))).status, 502); } malformedReport = {};
    assert.equal((await request(route + 'campaigns?toDate=2026-02-30')).status, 400);
    badReceipt = true; const uncertainBody = { ...body, name: 'Unconfirmed foreign receipt' }; result = await request(route + 'shopping/create', uncertainBody, 'foreign-native-receipt'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const count = creates.length;
    result = await request(route + 'shopping/create', uncertainBody, 'fresh-native-duplicate'); assert.equal(result.status, 409); assert.equal(creates.length, count); badReceipt = false;
    readbackFailure = true; result = await request(route + 'shopping/create', { ...body, name: 'Readback unavailable' }, 'native-readback-failure'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); readbackFailure = false;
    badReadbackStatus = true; result = await request(route + 'shopping/create', { ...body, name: 'Unexpected active readback' }, 'native-active-readback'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); badReadbackStatus = false;
    mappingChange = true; result = await request(route + 'shopping/create', { ...body, name: 'Mapping changed during creation' }, 'native-remapped-write'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal((await app.store.list(projectId, 'campaigns')).length, 1);
  } finally { clearTimeout(timer); releaseUpdate?.(); await heldUpdate?.catch(() => {}); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('native Google read-only connection tests save rotated OAuth tokens and never return secrets', async () => {
  const originalFetch = globalThis.fetch, copy = { ...env }, saved = []; let requests = 0, checks = 0;
  globalThis.fetch = async (target, options = {}) => { const url = new URL(target); requests++; if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'valid-access-token', refresh_token: 'new-google-refresh-token' })); assert.equal(url.pathname, '/v25/customers:listAccessibleCustomers'); assert.equal(options.method, undefined); return new Response(JSON.stringify({ resourceNames: ['customers/1234567890'] })); };
  try {
    const result = await testNativeGoogleAds(copy, () => checks++, (expected, next) => saved.push({ expected, next })); assert.match(result.message, /1 directly accessible account/); assert.deepEqual(saved, [{ expected: env.GOOGLE_ADS_REFRESH_TOKEN, next: 'new-google-refresh-token' }]); assert.equal(copy.GOOGLE_ADS_REFRESH_TOKEN, 'new-google-refresh-token'); assert.equal(requests, 2); assert.ok(checks >= 4); assert.equal(JSON.stringify(result).includes('token'), false);
    await assert.rejects(testNativeGoogleAds({ ...env }, () => {}, undefined), error => error.code === 'GOOGLE_AUTHORIZATION_CHANGED');
  } finally { globalThis.fetch = originalFetch; }
});

test('native Google UI preserves action keys on unknown outcomes and rejects completions after the customer view closes', async () => {
  const source = await readFile(new URL('../src/NativeGoogleAds.tsx', import.meta.url), 'utf8'), writeSource = source.slice(source.indexOf('async function write('), source.indexOf('  async function create('));
  const compile = context => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(writeSource)});`)(...Object.values(context));
  const active = { current: true }, keys = { current: new Map() }, calls = []; let finish, reject;
  const write = compile({ active, keys, path: '/projects/a/native-google-ads', crypto: { randomUUID: () => 'stable-creation-key' }, request: (...args) => { calls.push(args); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); } });
  let pending = write({ name: 'Shop' }); reject(new Error('Provider outcome uncertain')); await assert.rejects(pending); assert.equal(keys.current.size, 1);
  pending = write({ name: 'Shop' }); assert.equal(calls[0][3], calls[1][3]); active.current = false; finish({ campaign: {} }); await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(keys.current.size, 1);
  await assert.rejects(write({ name: 'Shop' }), error => error.name === 'AbortError'); assert.equal(calls.length, 2);
  active.current = true; pending = write({ name: 'Shop' }); reject(Object.assign(new Error('Provider rejected before writing'), { status: 400, code: 'PROVIDER_REJECTED' })); await assert.rejects(pending); assert.equal(keys.current.size, 0, 'Definite failures must release the action key for a corrected retry.');
});

test('Shopping report budgets and spend retain the mapped currency precision', async () => {
  const source = await readFile(new URL('../src/NativeGoogleAds.tsx', import.meta.url), 'utf8');
  const number = new Function(`return (${stripTypeScriptTypes(source.match(/const number = (.+);/)[1])});`)();
  const start = source.indexOf('const reportColumns = '), end = source.indexOf('\n];', start) + '\n];'.length;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(source.slice(start, end), 'ShoppingReport.tsx', { jsx: { runtime: 'classic' } });
  const columns = new Function('React', ...Object.keys(ui), 'number', code + '; return reportColumns;')(React, ...Object.values(ui), number);
  const render = (report, currency, digits) => React.createElement(ui.DataTable, { searchable: false, sortable: false, pagination: false, ariaLabel: 'Campaigns', rows: report.campaigns, rowKey: row => row.id, columns: columns(currency, digits) });
  for (const [currency, micros, expected] of [['KWD', '1000', '0.001 KWD'], ['USD', '1230000', '1.23 USD'], ['JPY', '1000000', '1 JPY']]) {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    for (const budgetPeriod of ['DAILY', 'CUSTOM_PERIOD']) {
      const row = { id: '123', name: 'Precision fixture', channel: 'SHOPPING', status: 'PAUSED', budgetPeriod, dailyBudgetMicros: micros, totalBudgetMicros: micros, metrics: { costMicros: micros } };
      const text = renderToStaticMarkup(render({ campaigns: [row] }, currency, digits)).replace(/<[^>]*>/g, '');
      assert.equal(text.split(expected).length - 1, 2, 'Both the budget and spend must retain ' + expected);
    }
  }
});
