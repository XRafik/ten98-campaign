import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('record deletion preserves assignments and administrators can remove sample data without touching real or other-project records', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-record-lifecycle-')), origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, env: {}, appUrl: origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, secret = 'record lifecycle fixture password'; let ownerCookie;
  async function request(path, { method = 'GET', body, cookie = ownerCookie } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Lifecycle owner', email: 'lifecycle-owner@example.test', password: secret } }); setup.data.projectId = await firstProject(app, setup, { sample: true });
    assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const initial = (await request('/api/state')).data, projectId = initial.projectId, project = `/api/projects/${projectId}`, workspaceId = initial.workspaces[0].id;
    const hash = (await app.sql.get('SELECT password FROM users WHERE id=?', initial.user.id)).password;
    const cookies = {};
    for (const role of ['admin', 'editor', 'viewer']) {
      const id = randomUUID(), email = `lifecycle-${role}@example.test`;
      await app.sql.run('INSERT INTO users VALUES(?,?,?,?)', id, role, email, hash);
      await app.sql.run('INSERT INTO memberships VALUES(?,?,?)', workspaceId, id, role);
      cookies[role] = (await request('/api/auth/login', { method: 'POST', body: { email, password: secret }, cookie: null })).cookie;
    }
    async function create(collection, body) { const result = await request(`${project}/${collection}`, { method: 'POST', body }); assert.equal(result.status, 201); return result.data.record; }
    for (const field of ['nativeProvider', 'nativeCustomerId', 'nativeCampaignResource', 'nativeResources', 'nativeAccountId', 'nativeCampaignId', 'nativeAdGroupId', 'nativeAdId']) {
      assert.equal((await request(project + '/campaigns', { method: 'POST', body: { name: 'Forged native receipt', [field]: 'forged' } })).status, 400);
    }
    for (const nativeProvider of ['googleAdsNative', 'microsoft']) {
      const managed = await app.store.create(projectId, 'campaigns', { name: 'Confirmed native campaign', nativeProvider, status: 'paused', budget: 25 });
      assert.equal((await request(`${project}/campaigns/${managed.id}`, { method: 'PATCH', body: { status: 'active', budget: 100 } })).status, 400);
      assert.equal((await request(`${project}/campaigns/${managed.id}`, { method: 'DELETE' })).status, 400);
      assert.equal((await app.store.get(projectId, 'campaigns', managed.id)).status, 'paused');
    }
    const campaign = await create('campaigns', { name: 'Keep my real campaign' }), provider = await create('providers', { name: 'Keep my real provider' }), asset = await create('assets', { name: 'Keep my real asset', url: 'https://cdn.example.com/real.jpg' });
    const post = await create('posts', { content: 'A real linked draft', platforms: ['facebook'], campaignId: campaign.id, assetId: asset.id });
    const placement = await create('placements', { name: 'A real booking', location: 'Dubai', providerId: provider.id });
    for (const [collection, record] of [['campaigns', campaign], ['assets', asset], ['providers', provider]]) {
      const result = await request(`${project}/${collection}/${record.id}`, { method: 'DELETE' });
      assert.equal(result.status, 409); assert.match(result.data.error, /Remove its assignments/); assert.ok(await app.store.get(projectId, collection, record.id));
    }
    assert.equal((await request(`${project}/posts/${post.id}`, { method: 'PATCH', body: { content: 'Still editable after a rejected deletion' } })).status, 200);
    assert.equal((await request(`${project}/posts/${post.id}`, { method: 'PATCH', body: { campaignId: '', assetId: '' } })).status, 200);
    assert.equal((await request(`${project}/placements/${placement.id}`, { method: 'PATCH', body: { providerId: '' } })).status, 200);
    for (const [collection, record] of [['campaigns', campaign], ['assets', asset], ['providers', provider]]) assert.equal((await request(`${project}/${collection}/${record.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await request(`${project}/posts/${post.id}`, { method: 'PATCH', body: { content: 'Editable after parents were unassigned and deleted' } })).status, 200);

    const linkedSample = initial.assets.find(record => record.sample), realWithSample = await create('posts', { content: 'Real draft using a sample creative', platforms: ['facebook'], assetId: linkedSample.id });
    const second = await request('/api/projects', { method: 'POST', body: { workspaceId, name: 'Other project' } });
    const otherSample = await app.store.create(second.data.project.id, 'campaigns', { name: 'Unrelated sample', sample: true });
    const providerPost = await app.store.create(projectId, 'posts', { content: 'Keep actual provider evidence', source: 'zernio', externalId: 'provider-live', status: 'published' });
    assert.equal((await request(project + '/sample-data', { method: 'DELETE', cookie: null })).status, 401);
    assert.equal((await request(project + '/sample-data', { method: 'DELETE', cookie: cookies.editor })).status, 403);
    assert.equal((await request(project + '/sample-data', { method: 'DELETE', cookie: cookies.viewer })).status, 403);
    const before = (await request('/api/state')).data;
    const blocked = await request(project + '/sample-data', { method: 'DELETE' }); assert.equal(blocked.status, 409); assert.match(blocked.data.error, /real record/);
    assert.deepEqual((await request('/api/state')).data, before, 'A blocked cleanup must not partially delete records or their activity.');
    assert.equal((await request(`${project}/posts/${realWithSample.id}`, { method: 'PATCH', body: { assetId: '' } })).status, 200);
    const cleanup = await request(project + '/sample-data', { method: 'DELETE', cookie: cookies.admin });
    assert.equal(cleanup.status, 200); assert.equal(cleanup.data.removed, ['campaigns', 'posts', 'placements', 'assets', 'providers'].reduce((count, collection) => count + initial[collection].filter(row => row.sample).length, 0));
    assert.ok(cleanup.data.activityRemoved > 0);
    const final = (await request('/api/state')).data;
    for (const collection of ['campaigns', 'posts', 'placements', 'assets', 'providers', 'activity']) assert.equal(final[collection].some(row => row.sample), false, collection);
    for (const record of [post, realWithSample, providerPost]) assert.ok(final.posts.find(row => row.id === record.id));
    assert.ok(final.placements.find(row => row.id === placement.id));
    assert.ok(await app.store.get(second.data.project.id, 'campaigns', otherSample.id));
    assert.equal((await request(project + '/sample-data', { method: 'DELETE' })).data.removed, 0, 'Cleanup is safe to repeat.');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
