import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { transformWithOxc } from 'vite';
import { postgresSkip, testApp } from './postgres.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as designSystem from '@ten98/ui';
import { firstProject } from './first-project.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-google-conversions-')), origin = 'https://conversions.example.test', originalFetch = globalThis.fetch, calls = [];
  const app = await testApp(t, { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'synthetic-conversions-key' }, directScheduler: false }), accountId = 'google-connection', adAccountId = '1234567890', profileId = 'conversion-profile';
  const state = { hook: null, stale: false, cachedAt: '2026-10-18T10:00:00Z', sequence: 200, actions: [{ id: '101', name: 'Website inquiry', type: 'WEBPAGE', status: 'ENABLED', category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', primaryForGoal: true, countingType: 'ONE_PER_CLICK', defaultValue: 0, defaultCurrency: 'AED', alwaysUseDefaultValue: false, clickThroughLookbackWindowDays: 30, viewThroughLookbackWindowDays: 1, tagSnippets: [{ type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: '<script>syntheticGlobalTag()</script>', eventSnippet: '<script>syntheticConversion()</script>' }], privateToken: 'never-return' }, { id: '102', name: 'Purchase', type: 'UPLOAD_CLICKS', status: 'ENABLED', category: 'PURCHASE', origin: 'WEBSITE', primaryForGoal: false, tagSnippets: [] }], goals: [{ category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true }, { category: 'PURCHASE', origin: 'WEBSITE', biddable: false }], custom: [{ id: '301', name: 'Qualified inquiries', status: 'ENABLED', conversionActionIds: ['101'] }], campaign: { campaignId: '401', goalConfigLevel: 'CUSTOMER', customConversionGoalId: null, goals: [{ category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true }, { category: 'PURCHASE', origin: 'WEBSITE', biddable: false }] } };
  const snapshot = value => ({ customerId: adAccountId, cachedAt: state.cachedAt, stale: state.stale, ...value }), customerGoals = () => state.goals.map(row => ({ ...row, conversionActions: state.actions.filter(item => item.status !== 'REMOVED' && item.category === row.category && item.origin === row.origin).map(({ id, name, status, primaryForGoal }) => ({ id, name, status, primaryForGoal })) }));
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer synthetic-conversions-key');
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body, key: options.headers['Idempotency-Key'] });
    if (state.hook) { const result = await state.hook(url, options, body); if (result !== undefined) return result; }
    if (url.pathname.endsWith('/accounts') && !url.pathname.endsWith('/ads/accounts')) return Response.json({ accounts: [{ _id: accountId, platform: 'googleads', profileId, isActive: true }, { _id: accountId + '-2', platform: 'googleads', profileId, isActive: true }, { _id: accountId + '-3', platform: 'googleads', profileId: 'conversion-profile-2', isActive: true }, { _id: 'foreign', platform: 'googleads', profileId: 'other-profile', isActive: true }] });
    if (url.pathname.endsWith('/ads/accounts')) { assert.equal(url.searchParams.get('inScopeOnly'), 'true'); return Response.json({ accounts: [{ id: adAccountId, currency: 'AED', selectable: true }, { id: '9999999999', currency: 'AED', selectable: false }] }); }
    if (url.pathname.endsWith('/ads/tree')) return Response.json({ campaigns: [{ platformCampaignId: '401', platform: 'google', profileId, accountId, platformAdAccountId: adAccountId, campaignName: 'Inquiry campaign', status: 'paused' }, { platformCampaignId: '402', platform: 'google', profileId, accountId: 'foreign-connection', platformAdAccountId: '8888888888', campaignName: 'Other customer campaign' }], pagination: { pages: 1 } });
    const actionsPath = '/api/v1/ads/conversions/actions', customPath = '/api/v1/ads/conversions/custom-goals';
    if (url.pathname === actionsPath && method === 'GET') { assert.equal(url.searchParams.get('accountId')?.startsWith(accountId), true); assert.equal(url.searchParams.get('adAccountId'), adAccountId); assert.equal(url.searchParams.has('type'), false); return Response.json(snapshot({ actions: state.actions })); }
    if (url.pathname === actionsPath && method === 'POST') { const { accountId: connection, adAccountId: customer, ...settings } = body; assert.equal(connection, accountId); assert.equal(customer, adAccountId); assert.equal(settings.type, 'WEBPAGE'); const action = { id: String(++state.sequence), status: 'ENABLED', category: 'DEFAULT', origin: 'WEBSITE', tagSnippets: [], ...settings }; state.actions.push(action); return Response.json({ action }, { status: 201 }); }
    if (url.pathname.startsWith(actionsPath + '/') && method === 'PATCH') { const actionId = url.pathname.split('/').at(-1), found = state.actions.find(row => row.id === actionId); assert.ok(found); const { accountId: connection, adAccountId: customer, ...settings } = body; assert.equal(customer, adAccountId); if (settings.status === 'REMOVED') assert.deepEqual(Object.keys(settings), ['status']); Object.assign(found, settings); return Response.json({ customerId: customer, action: { id: actionId, ...settings } }); }
    if (url.pathname.endsWith('/ads/conversions/goals')) { if (method === 'PATCH') { assert.equal(body.adAccountId, adAccountId); for (const row of body.goals) Object.assign(state.goals.find(item => item.category === row.category && item.origin === row.origin), row); } return Response.json(method === 'GET' ? snapshot({ goals: customerGoals() }) : { customerId: adAccountId, goals: customerGoals() }); }
    if (url.pathname === customPath) {
      if (method === 'POST') { const id = String(++state.sequence); state.custom.push({ id, name: body.name, status: 'ENABLED', conversionActionIds: body.conversionActionIds }); return Response.json({ customerId: adAccountId, id, resourceName: `customers/${adAccountId}/customConversionGoals/${id}` }, { status: 201 }); }
      return Response.json(snapshot({ goals: state.custom }));
    }
    if (url.pathname.startsWith(customPath + '/')) { const id = url.pathname.split('/').at(-1), found = state.custom.find(row => row.id === id); assert.ok(found); if (method === 'DELETE') { assert.equal(body, undefined); assert.equal(url.searchParams.get('accountId'), accountId); assert.equal(url.searchParams.get('adAccountId'), adAccountId); if (state.campaign.customConversionGoalId === id) return Response.json({}, { status: 400 }); state.custom = state.custom.filter(row => row.id !== id); return Response.json({ customerId: adAccountId, goalId: id, removed: true }); } const { accountId: connection, adAccountId: customer, ...settings } = body; Object.assign(found, settings); return Response.json({ customerId: customer, goal: found }); }
    if (url.pathname.endsWith('/ads/campaigns/401/conversion-goals')) { assert.equal(url.search, '', 'Campaign goal routes accept no account/customer scope query.'); if (method === 'PATCH') { assert.equal(body.accountId, undefined); assert.equal(body.adAccountId, undefined); const { goals, ...settings } = body; Object.assign(state.campaign, settings); if (goals) for (const row of goals) Object.assign(state.campaign.goals.find(item => item.category === row.category && item.origin === row.origin), row); } return Response.json(method === 'GET' ? snapshot(state.campaign) : { customerId: adAccountId, ...state.campaign }); }
    assert.fail('Unexpected synthetic conversion endpoint: ' + method + ' ' + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}/api`; let cookie;
  async function request(path, body, key = randomUUID(), authenticated = true) { const result = await originalFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie && authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: result.status, data: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/auth/setup', { name: 'Conversion owner', email: 'conversions@example.test', password: 'Synthetic conversions fixture passphrase!' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const project = '/projects/' + setup.data.projectId;
  await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, setup.data.projectId);
  const route = project + '/integrations/google-conversions/' + accountId, query = '?adAccountId=' + adAccountId;
  const get = name => request(route + '/' + name + query), save = async (name, snapshotName, settings, extra = {}, key) => { const data = (await get(snapshotName)).data; return request(route + '/' + name, { adAccountId, expectedVersion: data.version, confirmChange: true, settings, ...extra }, key); };
  return { app, state, calls, accountId, adAccountId, project, route, query, request, get, save, writes: () => calls.filter(row => row.method !== 'GET'), async close() { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); } };
}

test('authenticated Google conversion reads verify project/customer/campaign scope and project only typed settings and inert snippets', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.request(f.route + '/actions' + f.query, undefined, undefined, false)).status, 401);
    for (const resource of ['actions', 'goals', 'custom-goals', 'campaigns/401']) { const result = await f.get(resource); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.customerId, f.adAccountId); assert.equal(result.data.stale, false); assert.match(result.data.version, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(result.data).includes('privateToken'), false); }
    assert.equal((await f.get('actions')).data.actions[0].tagSnippets[0].globalSiteTag, '<script>syntheticGlobalTag()</script>');
    assert.equal((await f.request(f.route.replace(f.accountId, 'foreign') + '/actions' + f.query)).status, 403);
    assert.equal((await f.request(f.route + '/actions?adAccountId=8888888888')).status, 403);
    const before = f.calls.length; assert.equal((await f.get('campaigns/402')).status, 403); assert.ok(f.calls.slice(before).every(row => !row.url.pathname.endsWith('/campaigns/402/conversion-goals')));
    assert.equal((await f.get('actions?type=WEBPAGE&')).status, 400); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('website action create/update/remove/restore and account-goal changes use every typed setting and exact request receipts', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const settings = { type: 'WEBPAGE', name: 'Created website action', category: 'PURCHASE', countingType: 'MANY_PER_CLICK', defaultValue: 12.5, defaultCurrency: 'AED', alwaysUseDefaultValue: false, clickThroughLookbackWindowDays: 45, viewThroughLookbackWindowDays: 7, primaryForGoal: true }, before = (await f.get('actions')).data, body = { adAccountId: f.adAccountId, expectedVersion: before.version, confirmChange: true, settings }, key = randomUUID();
    const created = await f.request(f.route + '/actions/create', body, key); assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(created.data.operation.status, 'complete'); for (const [name, value] of Object.entries(settings)) assert.equal(created.data.action[name], value);
    await f.request(f.route + '/actions/create', body, key); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].body.confirmChange, undefined);
    const id = created.data.action.id, updated = await f.save(`actions/${id}/update`, 'actions', { name: 'Renamed action', defaultValue: 0, primaryForGoal: false }); assert.equal(updated.status, 200); assert.equal(updated.data.action.primaryForGoal, false);
    assert.equal((await f.save(`actions/${id}/update`, 'actions', { status: 'REMOVED' })).status, 200); assert.equal((await f.save(`actions/${id}/update`, 'actions', { status: 'ENABLED' })).status, 200);
    const goals = (await f.get('goals')).data.goals.map(row => ({ category: row.category, origin: row.origin, biddable: !row.biddable })); assert.equal((await f.save('goals/update', 'goals', { goals })).status, 200); assert.deepEqual(f.state.goals.map(row => row.biddable), [false, true]);
    for (const bad of [{ type: 'UPLOAD_CLICKS', name: 'Wrong type' }, { ...settings, category: 'CUSTOM' }, { ...settings, defaultValue: -1 }, { ...settings, defaultCurrency: 'aed' }, { ...settings, clickThroughLookbackWindowDays: 91 }, { ...settings, raw: {} }]) assert.equal((await f.save('actions/create', 'actions', bad)).status, 400);
    const count = f.writes().length; assert.equal((await f.save(`actions/${id}/update`, 'actions', { status: 'REMOVED', name: 'Forbidden combination' })).status, 400); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('custom goals and campaign overrides verify referenced actions and goals, preserve native path contracts and confirm removal readback', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    let actions = (await f.get('actions')).data;
    const created = await f.save('custom-goals/create', 'custom-goals', { name: 'Custom inquiry and purchase', conversionActionIds: ['102', '101'] }, { expectedActionsVersion: actions.version }); assert.equal(created.status, 200, JSON.stringify(created.data)); const id = created.data.goal.id;
    assert.deepEqual(created.data.goal.conversionActionIds, ['101', '102']);
    const updated = await f.save(`custom-goals/${id}/update`, 'custom-goals', { name: 'Renamed custom', conversionActionIds: ['102'] }, { expectedActionsVersion: actions.version }); assert.equal(updated.status, 200); assert.equal(updated.data.goal.name, 'Renamed custom');
    let custom = (await f.get('custom-goals')).data;
    const campaign = await f.save('campaigns/401/update', 'campaigns/401', { goalConfigLevel: 'CAMPAIGN', customConversionGoalId: id }, { expectedCustomVersion: custom.version }); assert.equal(campaign.status, 200, JSON.stringify(campaign.data)); assert.equal(campaign.data.customConversionGoalId, id);
    assert.equal((await f.save(`custom-goals/${id}/remove`, 'custom-goals', {})).status, 400, 'A custom goal in use must be rejected rather than reported removed.');
    assert.equal((await f.save('campaigns/401/update', 'campaigns/401', { goalConfigLevel: 'CUSTOMER', customConversionGoalId: null })).status, 200);
    const removed = await f.save(`custom-goals/${id}/remove`, 'custom-goals', {}); assert.equal(removed.status, 200); assert.equal(removed.data.removed, id); assert.ok(removed.data.goals.every(row => row.id !== id));
    const goals = f.state.campaign.goals.map(row => ({ ...row, biddable: row.category === 'PURCHASE' })); assert.equal((await f.save('campaigns/401/update', 'campaigns/401', { goalConfigLevel: 'CAMPAIGN', customConversionGoalId: null, goals })).status, 200);
    const count = f.writes().length;
    assert.equal((await f.save('custom-goals/create', 'custom-goals', { name: 'Foreign action', conversionActionIds: ['999'] }, { expectedActionsVersion: actions.version })).status, 400);
    custom = (await f.get('custom-goals')).data; assert.equal((await f.save('campaigns/401/update', 'campaigns/401', { customConversionGoalId: '999' }, { expectedCustomVersion: custom.version })).status, 403);
    assert.equal((await f.save('campaigns/401/update', 'campaigns/401', { customConversionGoalId: null, goalConfigLevel: 'CAMPAIGN', goals: goals.map(row => ({ ...row, biddable: false })) })).status, 400); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('stale/changed snapshots, malformed scope/freshness/receipts and viewer or changed-role writes fail closed', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const initial = (await f.get('actions')).data, body = { adAccountId: f.adAccountId, expectedVersion: initial.version, confirmChange: true, settings: { name: 'Reviewed change' } };
    f.state.actions[0].name = 'Changed outside this review'; assert.equal((await f.request(f.route + '/actions/101/update', body)).status, 409); f.state.actions[0].name = initial.actions.find(row => row.id === '101').name;
    f.state.stale = true; assert.equal((await f.request(f.route + '/actions/101/update', body)).status, 409); assert.equal((await f.get('actions')).data.stale, true); f.state.stale = false;
    for (const invalid of [{ customerId: '8888888888' }, { stale: 'false' }, { cachedAt: '2026-02-30T00:00:00Z' }, { actions: [{ ...f.state.actions[0], tagSnippets: 'raw' }] }]) {
      f.state.hook = (url, options) => url.pathname.endsWith('/ads/conversions/actions') && options.method === 'GET' ? Response.json({ customerId: f.adAccountId, stale: false, cachedAt: null, actions: f.state.actions, ...invalid }) : undefined;
      assert.equal((await f.get('actions')).status, 502); assert.equal((await f.request(f.route + '/actions/101/update', body)).status, 502);
    }
    f.state.hook = null; await f.app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await f.request(f.route + '/actions/101/update', body)).status, 403); assert.equal((await f.get('actions')).status, 200);
    await f.app.sql.run("UPDATE memberships SET role='editor'"); let changed = false; f.state.hook = async (url, options) => { if (!changed && url.pathname.endsWith('/ads/conversions/actions') && options.method === 'GET') { changed = true; await f.app.sql.run("UPDATE memberships SET role='viewer'"); } }; assert.equal((await f.request(f.route + '/actions/101/update', body)).status, 403); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('unknown writes retain one global customer fence across changed bodies, sibling connections and projects until explicit outcome review', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const before = (await f.get('actions')).data, body = { adAccountId: f.adAccountId, expectedVersion: before.version, confirmChange: true, settings: { type: 'WEBPAGE', name: 'Unknown creation' } }, key = randomUUID();
    f.state.hook = (url, options) => url.pathname.endsWith('/ads/conversions/actions') && options.method === 'POST' ? Response.json({ action: { id: null } }, { status: 201 }) : undefined;
    const unknown = await f.request(f.route + '/actions/create', body, key); assert.equal(unknown.status, 409); assert.equal(unknown.data.operation.status, 'uncertain');
    const again = await f.request(f.route + '/actions/create', body, key); assert.equal(again.status, 409); assert.equal(f.writes().length, 1);
    for (const route of [f.route, f.route + '-2']) { const blocked = await f.request(route + '/actions/create', { ...body, settings: { ...body.settings, name: 'Changed body' } }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, unknown.data.operation.id); assert.equal(f.writes().length, 1); }
    const other = await f.request('/workspaces', { name: 'Separate Google customer project' }); assert.equal(other.status, 201); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'conversion-profile-2', other.data.projectId);
    const otherRoute = `/projects/${other.data.projectId}/integrations/google-conversions/${f.accountId}-3`, otherRead = await f.request(otherRoute + '/actions' + f.query); assert.equal(otherRead.status, 200);
    const crossProject = await f.request(otherRoute + '/actions/create', { ...body, expectedVersion: otherRead.data.version }, key); assert.equal(crossProject.status, 409); assert.equal(crossProject.data.error.code, 'GOOGLE_CONVERSION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(crossProject.data.operation.status, 'failed'); assert.equal(JSON.stringify(crossProject.data).includes(f.project.slice('/projects/'.length)), false);
    assert.equal(f.writes().length, 1);
    const response = await f.request(f.project + '/operations/' + unknown.data.operation.id + '/review', { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic provider fixture confirmed no conversion resource persisted.', reference: 'synthetic-no-write' }); assert.equal(response.status, 200, JSON.stringify(response.data)); f.state.hook = null;
    const fresh = await f.request(f.route + '/actions/create', body); assert.equal(fresh.status, 200, JSON.stringify(fresh.data)); assert.equal((await f.app.sql.get('SELECT count(*) AS n FROM zernio_google_conversion_mutations')).n, 0);
  } finally { await f.close(); }
});

test('every mutation family rechecks provider connection ownership and customer availability after its reviewed preflight read', { skip: postgresSkip }, async t => {
  for (const resource of ['actions', 'goals', 'custom-goals', 'campaigns/401']) for (const change of ['profile', 'selectable']) {
    const f = await fixture(t);
    try {
      const before = (await f.get(resource)).data; let moved = false;
      f.state.hook = (url, options) => {
        if (options.method === 'GET' && url.pathname.endsWith(resource === 'campaigns/401' ? '/campaigns/401/conversion-goals' : '/conversions/' + resource)) moved = true;
        if (moved && change === 'profile' && url.pathname.endsWith('/accounts') && !url.pathname.endsWith('/ads/accounts')) return Response.json({ accounts: [{ _id: f.accountId, platform: 'googleads', profileId: 'moved-outside-project', isActive: true }] });
        if (moved && change === 'selectable' && url.pathname.endsWith('/ads/accounts')) return Response.json({ accounts: [{ id: f.adAccountId, selectable: false }] });
      };
      const route = resource === 'actions' ? 'actions/101/update' : resource === 'goals' ? 'goals/update' : resource === 'custom-goals' ? 'custom-goals/301/update' : 'campaigns/401/update';
      const settings = resource === 'actions' ? { name: 'Renamed action' } : resource === 'goals' ? { goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }] } : resource === 'custom-goals' ? { name: 'Renamed goal' } : { goalConfigLevel: 'CAMPAIGN' };
      const result = await f.request(f.route + '/' + route, { adAccountId: f.adAccountId, expectedVersion: before.version, confirmChange: true, settings }); assert.equal(result.status, change === 'profile' ? 403 : 409, resource + ':' + change + ':' + JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'failed'); assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  }
});

test('write receipts and custom-goal readbacks cannot certify an existing resource, foreign customer or unconfirmed settings', { skip: postgresSkip }, async t => {
  for (const scenario of ['existing-action', 'foreign-created-action', 'action-ack', 'goal-ack', 'existing-custom', 'remove-readback', 'campaign-ack']) {
    const f = await fixture(t);
    try {
      const actions = (await f.get('actions')).data;
      f.state.hook = (url, options, body) => {
        if (options.method === 'GET') return;
        if (scenario === 'existing-action' && url.pathname.endsWith('/conversions/actions')) return Response.json({ action: f.state.actions[0] }, { status: 201 });
        if (scenario === 'foreign-created-action' && url.pathname.endsWith('/conversions/actions')) return Response.json({ customerId: '8888888888', action: { ...f.state.actions[0], id: '987', name: body.name, category: body.category } }, { status: 201 });
        if (scenario === 'action-ack' && url.pathname.endsWith('/actions/101')) return Response.json({ customerId: f.adAccountId, action: { id: '101', name: 'Unrequested name' } });
        if (scenario === 'goal-ack' && url.pathname.endsWith('/conversions/goals')) return Response.json({ customerId: f.adAccountId, goals: f.state.goals.map(row => ({ ...row, conversionActions: [] })) });
        if (scenario === 'existing-custom' && url.pathname.endsWith('/conversions/custom-goals')) return Response.json({ customerId: f.adAccountId, id: '301', resourceName: `customers/${f.adAccountId}/customConversionGoals/301` }, { status: 201 });
        if (scenario === 'remove-readback' && options.method === 'DELETE') return Response.json({ customerId: f.adAccountId, goalId: '301', removed: true });
        if (scenario === 'campaign-ack' && url.pathname.endsWith('/campaigns/401/conversion-goals')) return Response.json({ customerId: f.adAccountId, campaignId: '401', customConversionGoalId: null, goals: f.state.campaign.goals });
      };
      const result = scenario === 'existing-action' ? await f.save('actions/create', 'actions', { type: 'WEBPAGE', name: 'Website inquiry', category: 'SUBMIT_LEAD_FORM' }) : scenario === 'foreign-created-action' ? await f.save('actions/create', 'actions', { type: 'WEBPAGE', name: 'New action' }) : scenario === 'action-ack' ? await f.save('actions/101/update', 'actions', { name: 'Requested name' }) : scenario === 'goal-ack' ? await f.save('goals/update', 'goals', { goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }] }) : scenario === 'existing-custom' ? await f.save('custom-goals/create', 'custom-goals', { name: 'Qualified inquiries', conversionActionIds: ['101'] }, { expectedActionsVersion: actions.version }) : scenario === 'remove-readback' ? await f.save('custom-goals/301/remove', 'custom-goals', {}) : await f.save('campaigns/401/update', 'campaigns/401', { goalConfigLevel: 'CAMPAIGN', customConversionGoalId: null });
      assert.equal(result.status, 409, scenario + ': ' + JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(f.writes().length, 1);
    } finally { await f.close(); }
  }
});

const source = await readFile(new URL('../src/GoogleConversions.tsx', import.meta.url), 'utf8');
const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const fresh = data => !!data && data.stale === false;

test('conversion review captures an immutable request, cannot bless a newer intent or snapshot, and blocks stale or departed views', async () => {
  const prepareSource = section('function prepare(', '  async function save('), saveSource = section('async function save(', '  function actionForm('), calls = [];
  const data = { actions: { version: 'old-reviewed', stale: false } }; let intent, reviewed;
  const prepare = compile(prepareSource, { canWrite: true, busy: false, unresolved: false, current: () => true, data, fresh, adAccountId: '1234567890', setIntent: value => { intent = value; }, setReviewed: value => { reviewed = value; }, setError() {}, setNotice() {} });
  prepare('actions/101/update', { name: 'Exact reviewed name' }, ['Rename an action'], { actions: 'old-reviewed' }); const first = intent; reviewed = first;
  const makeSave = extra => compile(saveSource, { intent, reviewed, canWrite: true, current: () => true, unresolved: false, data, fresh, path: 'google-conversions/account', act: action => action(), requester: { current: async (...args) => { calls.push(args); return { operation: { status: 'complete' } }; } }, setIntent() {}, setReviewed() {}, setActions() {}, setGoals() {}, setCustom() {}, setCampaignGoals() {}, setUnresolved() {}, setRetrySame() {}, setNotice() {}, ...extra });
  prepare('actions/101/update', { name: 'Changed name' }, ['Another request'], { actions: 'old-reviewed' }); await makeSave({ reviewed: first })(); assert.equal(calls.length, 0);
  reviewed = intent; data.actions.version = 'unseen-new-snapshot'; await makeSave({})(); assert.equal(calls.length, 0);
  data.actions.version = 'old-reviewed'; data.actions.stale = true; await makeSave({})(); assert.equal(calls.length, 0);
  data.actions.stale = false; await makeSave({ current: () => false })(); assert.equal(calls.length, 0);
  await makeSave({})(); assert.equal(calls.length, 1); assert.equal(calls[0][1].settings.name, 'Changed name'); assert.equal(calls[0][1].expectedVersion, 'old-reviewed');
});

test('conversion reads ignore stale responses and preserve the campaign’s actual default selector while uncertain retries keep the same reviewed body', async () => {
  const loadSource = section('async function load(', '  function prepare('), saveSource = section('async function save(', '  function actionForm(');
  for (const stale of ['scope', 'newer', 'current', 'unknown', 'unspecified']) {
    const resolvers = [], accepted = [], read = { current: 0 }; let live = true, mode;
    const context = { current: () => live, read, campaignId: '401', path: 'google-conversions/account', query: '?adAccountId=1234567890', adAccountId: '1234567890', requester: { current: () => new Promise(resolve => resolvers.push(resolve)) }, setActions: value => accepted.push(value), setGoals: value => accepted.push(value), setCustom: value => accepted.push(value), setCampaignGoals: value => accepted.push(value), setCampaignMode: value => { mode = value; }, setIntent() {}, setReviewed() {}, setUnresolved() {}, setRetrySame() {}, setError() {} };
    const pending = compile(loadSource, context)(); if (stale === 'scope') live = false; if (stale === 'newer') read.current++;
    resolvers.forEach((resolve, index) => resolve({ customerId: '1234567890', version: 'snapshot', stale: false, ...(index === 0 ? { actions: [] } : { goals: [] }), ...(index === 3 ? { goalConfigLevel: stale === 'unknown' ? 'UNKNOWN' : stale === 'unspecified' ? 'UNSPECIFIED' : 'CAMPAIGN', customConversionGoalId: '301' } : {}) })); await pending;
    assert.equal(accepted.length, ['scope', 'newer'].includes(stale) ? 0 : 4); assert.equal(mode, stale === 'current' ? 'CUSTOM' : ['unknown', 'unspecified'].includes(stale) ? '' : undefined);
  }
  const modeErrors = [], goalForm = compile(section('function goalForm(', '  function customForm('), { campaignGoals: { version: 'unknown', goals: [], goalConfigLevel: 'UNKNOWN' }, goals: null, campaignMode: '', setError: value => modeErrors.push(value) });
  goalForm({ preventDefault() {} }, true); assert.deepEqual(modeErrors, ['Choose the campaign’s new bidding-goal source explicitly.']);
  const cleared = [], loadContext = { current: () => true, read: { current: 0 }, campaignId: null, path: 'google-conversions/account', query: '?adAccountId=1234567890', adAccountId: '1234567890', requester: { current: async path => { if (path.includes('/actions?')) throw new Error('Reload failed.'); return { customerId: '1234567890', version: 'fresh', stale: false, goals: [] }; } }, setActions: value => cleared.push(value), setGoals() {}, setCustom() {}, setCampaignGoals() {}, setCampaignMode() {}, setIntent() {}, setReviewed() {}, setUnresolved() {}, setRetrySame() {}, setError() {} };
  await compile(loadSource, loadContext)(); assert.deepEqual(cleared, [null], 'A failed section must discard its previous fresh-marked snapshot.');
  const intent = { route: 'actions/create', body: { adAccountId: '1234567890', expectedVersion: 'reviewed', confirmChange: true, settings: { name: 'Website action', type: 'WEBPAGE' } }, versions: { actions: 'reviewed' } }, requests = []; let unresolved = false, retrySame = false;
  const context = { intent, reviewed: intent, canWrite: true, current: () => true, unresolved: false, data: { actions: { version: 'reviewed', stale: false } }, fresh, path: 'google-conversions/account', act: action => action(), requester: { current: async (...args) => { requests.push(args); throw Object.assign(new Error('Unknown outcome'), { status: 409, code: 'OPERATION_UNCERTAIN' }); } }, setUnresolved: value => { unresolved = value; }, setRetrySame: value => { retrySame = value; } };
  await assert.rejects(compile(saveSource, context)(), /Unknown outcome/); assert.equal(unresolved, true); assert.equal(retrySame, true);
  await assert.rejects(compile(saveSource, { ...context, unresolved: true, data: {} })(), /Unknown outcome/); assert.deepEqual(requests[0], requests[1]);
});

test('rendered conversion controls keep snippets inert, stale forms read-only and review confirmation tied to the displayed intent', async () => {
  const description = compile(source.match(/const actionDescription = (.+);/)[1], { title: value => value.replaceAll('_', ' ').toLowerCase() });
  assert.equal(description('name', 'Keep MY Name'), 'Keep MY Name'); assert.equal(description('defaultCurrency', 'AED'), 'AED'); assert.equal(description('primaryForGoal', false), 'Secondary'); assert.equal(description('alwaysUseDefaultValue', false), 'Use the event value when provided'); assert.equal(description('countingType', 'MANY_PER_CLICK'), 'Every conversion per click');
  const start = source.indexOf('  return <Disclosure summary="Google conversions and bidding goals">'), end = source.lastIndexOf('\n}'), { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'GoogleConversions.tsx', { jsx: { runtime: 'classic' } });
  const intent = { route: 'actions/create', summary: ['Create the reviewed website action.'] }, snippet = '<script>mustNeverExecute()</script>', action = { id: '101', name: 'Inquiry', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', tagSnippets: [{ type: 'WEBPAGE', globalSiteTag: snippet }] }; let reviewed;
  const ui = Object.fromEntries(Object.entries(designSystem).filter(([name]) => /^[A-Z]/.test(name))), context = { ...ui, React, adAccountId: '1234567890', campaignId: null, campaign: null, busy: false, act() {}, load() {}, error: '', notice: '', unresolved: false, actions: { version: 'a', stale: true, actions: [action] }, actionId: '101', setActionId() {}, setIntent() {}, setReviewed: value => { reviewed = value; }, selectedAction: action, Freshness: () => null, title: value => value, actionForm() {}, blocked: false, fresh, options: () => null, prepare() {}, goals: null, custom: null, campaignGoals: null, intent, reviewed: null, retrySame: false, canWrite: true, save() {} };
  const render = extra => new Function(...Object.keys({ ...context, ...extra }), code + '; return render;')(...Object.values({ ...context, ...extra }))();
  const html = renderToStaticMarkup(render({})); assert.match(html, /&lt;script&gt;mustNeverExecute/); assert.doesNotMatch(html, /<script>/); assert.match(html, /<fieldset[^>]*disabled=""/);
  const unknown = renderToStaticMarkup(render({ campaignId: '401', campaignGoals: { version: 'unknown', stale: false, goalConfigLevel: 'UNKNOWN', customConversionGoalId: '301', goals: [] }, campaignMode: '', setCampaignMode() {}, goalForm() {} })); assert.match(unknown, /Current mode: Unknown provider configuration/); assert.match(unknown, /Choose a new goal source/); assert.match(unknown, /<button[^>]*disabled=""[^>]*>Review campaign-goal change/);
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }) }, all = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(all)] : [], nodes = all(render({ React: fakeReact }));
  const checkbox = nodes.find(node => node.type === designSystem.Checkbox && node.props.onChange); checkbox.props.onChange({ target: { checked: true } }); assert.equal(reviewed, intent); assert.doesNotMatch(source, /window\.confirm|dangerouslySetInnerHTML/);
});


test('lost conversion responses release only terminal unsent reviews and keep authored settings for fresh load', async () => {
  const intent = { route: 'actions/create', body: { settings: { name: 'Keep this authored name' } }, versions: { actions: 'version' } }; let writes = 0, unresolved = false, retrySame = false, liveIntent = intent, reviewed = intent, snapshot = { version: 'version', stale: false }, notice;
  const context = { intent, reviewed, canWrite: true, current: () => true, unresolved: false, data: { actions: snapshot }, fresh, path: 'google-conversions/account', act: action => action(), requester: { current: async () => { if (++writes === 1) throw new TypeError('Response lost'); throw Object.assign(new Error('Not sent'), { status: 409, code: 'OPERATION_NOT_SENT', operation: { status: 'failed' } }); } }, setUnresolved: value => { unresolved = value; }, setRetrySame: value => { retrySame = value; }, setIntent: value => { liveIntent = value; }, setReviewed: value => { reviewed = value; }, setActions: update => { snapshot = update(snapshot); }, setGoals() {}, setCustom() {}, setCampaignGoals() {}, setNotice: value => { notice = value; } };
  const saveSource = section('async function save(', '  function actionForm('); await assert.rejects(compile(saveSource, context)(), /lost/); assert.equal(unresolved, true); assert.equal(retrySame, true);
  const check = compile(saveSource, { ...context, unresolved: true }); await assert.rejects(check(), /Not sent/); assert.equal(unresolved, false); assert.equal(retrySame, false); assert.equal(liveIntent, null); assert.equal(reviewed, null); assert.equal(snapshot.stale, true); assert.equal(intent.body.settings.name, 'Keep this authored name'); assert.match(notice, /not sent.*Reload conversion settings/); await check(); assert.equal(writes, 2);
});
