import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { transformWithOxc } from 'vite';
import React from 'react';
import * as design from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/index.ts';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-destinations-')), origin = 'https://destinations.example.test', originalFetch = globalThis.fetch, calls = [];
  const config = { dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'synthetic-destinations-key' }, directScheduler: false }, first = await testApp(t, config); let app = first;
  const accounts = ['pinterest', 'youtube', 'reddit'].map(platform => ({ _id: 'account-' + platform, platform, profileId: 'destination-profile', isActive: true, displayName: platform + ' publishing', platformUserId: 'native-' + platform }));
  const state = { hook: null, sequence: 1, boards: [{ id: 'board-1', name: 'Existing board', description: 'Reviewed description', privacy: 'PUBLIC' }], playlists: [{ id: 'PL-1', title: 'Existing playlist', description: 'Reviewed description', privacy: 'unlisted', itemCount: 3, thumbnailUrl: '' }], defaultPlaylistId: 'PL-1', subreddits: [{ id: 'reddit-1', name: 'marketing', title: 'Marketing', url: '/r/marketing/', over18: false }, { id: 'reddit-2', name: 'socialmedia', title: 'Social media', url: '/r/socialmedia/', over18: true }], defaultSubreddit: 'marketing' };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.headers.Authorization, 'Bearer synthetic-destinations-key'); const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body, key: options.headers['Idempotency-Key'] });
    if (state.hook) { const response = await state.hook(url, options, body); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [...accounts, { _id: 'account-foreign', platform: 'youtube', profileId: 'other-profile', isActive: true, platformUserId: 'native-youtube' }] });
    const youtube = url.pathname.endsWith('/youtube-playlists'), pinterest = url.pathname.endsWith('/pinterest-boards'), reddit = url.pathname.endsWith('/reddit-subreddits'); assert.ok(youtube || pinterest || reddit, url.pathname);
    const field = youtube ? 'playlists' : reddit ? 'subreddits' : 'boards';
    if (method === 'GET') return Response.json({ accountId: url.pathname.split('/').at(-2), [field]: state[field], ...(youtube ? { defaultPlaylistId: state.defaultPlaylistId } : reddit ? { defaultSubreddit: state.defaultSubreddit } : {}) });
    assert.ok(options.headers['Idempotency-Key']);
    if (reddit) { assert.equal(method, 'PUT'); assert.deepEqual(Object.keys(body), ['defaultSubreddit']); assert.ok(state.subreddits.some(row => row.name === body.defaultSubreddit)); state.defaultSubreddit = body.defaultSubreddit; return Response.json({ success: true }); }
    if (method === 'POST') { const row = { id: youtube ? 'PL-' + (++state.sequence) : 'board-' + (++state.sequence), ...body, ...(youtube ? { itemCount: 0, thumbnailUrl: '' } : {}) }; state[field].push(row); return Response.json({ [youtube ? 'playlist' : 'board']: row }, { status: 201 }); }
    assert.equal(method, 'PUT'); if (youtube) { assert.deepEqual(Object.keys(body).sort(), ['defaultPlaylistId', 'defaultPlaylistName']); const row = state.playlists.find(row => row.id === body.defaultPlaylistId); assert.equal(body.defaultPlaylistName, row.title); state.defaultPlaylistId = row.id; return Response.json({ success: true }); }
    assert.deepEqual(Object.keys(body).sort(), ['defaultBoardId', 'defaultBoardName']); const row = state.boards.find(row => row.id === body.defaultBoardId); assert.equal(body.defaultBoardName, row.name); return Response.json({ message: 'Default Pinterest board updated successfully', account: { ...accounts[0], accessToken: 'never-return' } });
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); let base = `http://127.0.0.1:${app.server.address().port}/api`, cookie;
  async function request(path, body, key = randomUUID(), authenticated = true) { const response = await originalFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie && authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/auth/setup', { name: 'Destination owner', email: 'destinations@example.test', password: 'Synthetic destination fixture passphrase!' }); setup.data.projectId = await firstProject(app, setup); cookie = setup.cookie; const project = '/projects/' + setup.data.projectId;
  await app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'destination-profile', setup.data.projectId);
  const route = platform => `${project}/integrations/publishing/accounts/account-${platform}/${platform === 'youtube' ? 'youtube-playlists' : platform === 'reddit' ? 'reddit-subreddits' : 'pinterest-boards'}`, get = platform => request(route(platform) + '/manage'), write = async (platform, task, settings, extra = {}, key) => request(route(platform) + '/' + task, { expectedVersion: (await get(platform)).data.version, confirmed: true, ...(task === 'create' ? { settings } : { destinationId: settings }), ...extra }, key);
  return { get app() { return app; }, accounts, state, calls, project, route, request, get, write, writes: () => calls.filter(row => row.method !== 'GET'), // Reopening is a second app over the same database; testApp closes the first one and drops the database.
    async reopen() { await app.close(); app = Object.assign(await createApp({ ...config, database: { pool: first.database.pool, db: first.database.db } }), { sql: first.sql }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}/api`; }, async close() { if (app !== first) await app.close(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); } };
}

test('all four destination mutations use authenticated native contracts, fresh census/readback and unchanged lookup projections', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.request(f.route('youtube') + '/manage', undefined, undefined, false)).status, 401);
    const original = await f.request(f.route('youtube')); assert.equal(original.data.playlists[0].description, undefined); assert.equal(original.data.version, undefined);
    const snapshot = await f.get('youtube'); assert.equal(snapshot.data.playlists[0].description, 'Reviewed description'); assert.equal(snapshot.data.defaultReported, true); assert.match(snapshot.data.version, /^[a-f0-9]{64}$/);
    const pin = await f.write('pinterest', 'create', { name: 'New board', description: 'New board description', privacy: 'SECRET' }); assert.equal(pin.status, 200, JSON.stringify(pin.data)); assert.equal(pin.data.destination.privacy, 'SECRET'); assert.equal(pin.data.created, true);
    const pinDefault = await f.write('pinterest', 'default', pin.data.destination.id); assert.equal(pinDefault.status, 200); assert.equal(pinDefault.data.accepted, true); assert.equal(pinDefault.data.readback, false); assert.equal(pinDefault.data.snapshot.defaultReported, false); assert.equal(JSON.stringify(pinDefault.data).includes('accessToken'), false);
    const before = (await f.get('youtube')).data, settings = { title: 'New empty playlist', description: 'Explicit description', privacy: 'private' }, body = { expectedVersion: before.version, confirmed: true, settings }, key = randomUUID();
    const yt = await f.request(f.route('youtube') + '/create', body, key); assert.equal(yt.status, 200, JSON.stringify(yt.data)); assert.equal(yt.data.destination.itemCount, 0); assert.equal(yt.data.destination.privacy, 'private'); assert.equal(yt.data.snapshot.defaultPlaylistId, 'PL-1');
    await f.request(f.route('youtube') + '/create', body, key); assert.equal(f.writes().length, 3, 'Exact retries replay even after the census changed because creation succeeded.');
    const ytDefault = await f.write('youtube', 'default', yt.data.destination.id); assert.equal(ytDefault.status, 200, JSON.stringify(ytDefault.data)); assert.equal(ytDefault.data.readback, true); assert.equal(ytDefault.data.snapshot.defaultPlaylistId, yt.data.destination.id);
    assert.deepEqual(f.writes().map(row => row.method), ['POST', 'PUT', 'POST', 'PUT']); assert.ok(f.writes().every(row => row.body.expectedVersion === undefined && row.body.confirmed === undefined));
  } finally { await f.close(); }
});

test('destination management rejects foreign, stale, malformed, unsupported clear and nonadministrator changes without dispatch', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const snapshot = (await f.get('youtube')).data, body = { expectedVersion: snapshot.version, confirmed: true, settings: { title: 'Reviewed playlist', description: '', privacy: 'private' } };
    assert.equal((await f.request(f.route('youtube').replace('account-youtube', 'account-foreign') + '/manage')).status, 403);
    assert.equal((await f.request(f.route('youtube') + '/manage?fields=raw')).status, 400);
    for (const invalid of [{ ...body, confirmed: false }, { ...body, settings: { ...body.settings, privacy: undefined } }, { ...body, settings: { ...body.settings, raw: {} } }]) assert.equal((await f.request(f.route('youtube') + '/create', invalid)).status, 400);
    assert.equal((await f.write('youtube', 'default', '')).status, 400); assert.equal((await f.write('youtube', 'default', 'PL-foreign')).status, 403);
    f.state.playlists[0].title = 'Changed after review'; assert.equal((await f.request(f.route('youtube') + '/create', body)).status, 409);
    await f.app.sql.run("UPDATE memberships SET role='editor'"); assert.equal((await f.write('youtube', 'create', body.settings)).status, 403); assert.equal((await f.get('youtube')).status, 200);
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('destination writes refresh connection scope after the census and retain unknown creation/default receipts until reviewed recovery', { skip: postgresSkip }, async t => {
  for (const scenario of ['moved-profile', 'changed-native', 'existing-id', 'privacy-drift', 'foreign-ack', 'default-not-saved', 'default-changed-on-create', 'default-reporting-lost']) {
    const f = await fixture(t);
    try {
      if (scenario === 'default-reporting-lost') f.state.defaultPlaylistId = null;
      const before = (await f.get('youtube')).data, body = { expectedVersion: before.version, confirmed: true, settings: { title: 'Reviewed playlist', description: '', privacy: 'private' } }; let reads = 0;
      f.state.hook = (url, options, payload) => {
        if (url.pathname.endsWith('/youtube-playlists') && options.method === 'GET' && ++reads === 2) { if (scenario === 'moved-profile') f.accounts[1].profileId = 'other-profile'; if (scenario === 'changed-native') f.accounts[1].platformUserId = 'different-native-channel'; }
        if (url.pathname.endsWith('/youtube-playlists') && options.method === 'POST') {
          if (scenario === 'existing-id') return Response.json({ playlist: { ...f.state.playlists[0], ...payload } }, { status: 201 });
          if (scenario === 'privacy-drift') { const playlist = { id: 'PL-unreviewed', ...payload, privacy: 'public', itemCount: 0, thumbnailUrl: '' }; f.state.playlists.push(playlist); return Response.json({ playlist }, { status: 201 }); }
          if (scenario === 'foreign-ack') return Response.json({ accountId: 'foreign-account', playlist: { id: 'PL-foreign', ...payload, itemCount: 0, thumbnailUrl: '' } }, { status: 201 });
          if (['default-changed-on-create', 'default-reporting-lost'].includes(scenario)) { const playlist = { id: 'PL-created', ...payload, itemCount: 0, thumbnailUrl: '' }; f.state.playlists.push(playlist); if (scenario === 'default-changed-on-create') f.state.defaultPlaylistId = playlist.id; return Response.json({ playlist }, { status: 201 }); }
        }
        if (scenario === 'default-reporting-lost' && options.method === 'GET' && url.pathname.endsWith('/youtube-playlists') && f.state.playlists.some(row => row.id === 'PL-created')) return Response.json({ playlists: f.state.playlists });
        if (scenario === 'default-not-saved' && options.method === 'PUT') return Response.json({ success: true });
      };
      if (scenario === 'default-not-saved') f.state.playlists.push({ ...f.state.playlists[0], id: 'PL-new' });
      const result = scenario === 'default-not-saved' ? await f.write('youtube', 'default', 'PL-new') : await f.request(f.route('youtube') + '/create', body);
      assert.equal(result.status, scenario === 'moved-profile' ? 403 : 409, scenario + ':' + JSON.stringify(result.data)); assert.equal(f.writes().length, ['moved-profile', 'changed-native'].includes(scenario) ? 0 : 1);
      if (!['moved-profile', 'changed-native'].includes(scenario)) { assert.equal(result.data.operation.status, 'uncertain'); f.state.hook = null; const blocked = await f.write('youtube', 'create', { title: 'Different new request', description: '', privacy: 'private' }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(f.writes().length, 1); }
      if (scenario === 'existing-id') {
        const other = await f.request('/workspaces', { name: 'Other publishing project' }); assert.equal(other.status, 201); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'destination-profile-2', other.data.projectId); f.accounts.push({ _id: 'account-youtube-shared', platform: 'youtube', profileId: 'destination-profile-2', isActive: true, platformUserId: 'native-youtube' });
        const otherRoute = `/projects/${other.data.projectId}/integrations/publishing/accounts/account-youtube-shared/youtube-playlists`, snapshot = (await f.request(otherRoute + '/manage')).data;
        const sharedBlocked = await f.request(otherRoute + '/create', { expectedVersion: snapshot.version, confirmed: true, settings: body.settings }); assert.equal(sharedBlocked.status, 409); assert.equal(sharedBlocked.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(f.writes().length, 1);
        const reviewed = await f.request(`${f.project}/operations/${result.data.operation.id}/review`, { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic existing-ID acknowledgement created no new playlist.', reference: 'synthetic-existing-playlist-only' }); assert.equal(reviewed.status, 200);
        assert.equal((await f.write('youtube', 'create', { title: 'After reviewed recovery', description: '', privacy: 'private' })).status, 200); assert.equal((await f.app.sql.get('SELECT count(*) AS n FROM zernio_destination_mutations')).n, 0);
      }
    } finally { await f.close(); }
  }
});

test('provider-wide destination fencing blocks missing-native-ID aliases in the same and other projects until reviewed recovery', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    delete f.accounts[1].platformUserId;
    f.accounts.push({ _id: 'account-youtube-alias', platform: 'youtube', profileId: 'destination-profile', isActive: true });
    const settings = { title: 'Unknown playlist creation', description: '', privacy: 'private' }, before = (await f.get('youtube')).data, key = randomUUID();
    assert.equal(before.nativeAccountId, null);
    f.state.hook = (url, options) => { if (url.pathname.endsWith('/youtube-playlists') && options.method === 'POST') throw new Error('Synthetic transport loss before the fixture persisted a playlist.'); };
    const unknown = await f.request(f.route('youtube') + '/create', { expectedVersion: before.version, confirmed: true, settings }, key); assert.equal(unknown.status, 409); assert.equal(unknown.data.operation.status, 'uncertain');
    const sameProject = f.route('youtube').replace('account-youtube/', 'account-youtube-alias/'), alias = (await f.request(sameProject + '/manage')).data;
    const blockedAlias = await f.request(sameProject + '/create', { expectedVersion: alias.version, confirmed: true, settings }); assert.equal(blockedAlias.status, 409); assert.equal(blockedAlias.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blockedAlias.data.operation.status, 'failed'); assert.notEqual(blockedAlias.data.operation.id, unknown.data.operation.id);
    const other = await f.request('/workspaces', { name: 'Unknown native identity project' }); assert.equal(other.status, 201); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'missing-native-profile', other.data.projectId); f.accounts.push({ _id: 'account-youtube-other-alias', platform: 'youtube', profileId: 'missing-native-profile', isActive: true });
    const otherRoute = `/projects/${other.data.projectId}/integrations/publishing/accounts/account-youtube-other-alias/youtube-playlists`, otherSnapshot = (await f.request(otherRoute + '/manage')).data;
    const blockedOther = await f.request(otherRoute + '/create', { expectedVersion: otherSnapshot.version, confirmed: true, settings }, key); assert.equal(blockedOther.status, 409); assert.equal(blockedOther.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(blockedOther.data.operation.status, 'failed'); assert.equal(f.writes().length, 1);
    assert.equal((await f.app.sql.get('SELECT resource FROM zernio_destination_mutations')).resource, 'youtube');
    assert.equal((await f.write('pinterest', 'create', { name: 'Independent provider board', description: '', privacy: 'PUBLIC' })).status, 200, 'YouTube reconciliation does not block Pinterest writes.');
    const reviewed = await f.request(`${f.project}/operations/${unknown.data.operation.id}/review`, { resolution: 'not_applied', confirmChecked: true, note: 'The synthetic fixture failed before persisting any playlist.', reference: 'synthetic-no-playlist' }); assert.equal(reviewed.status, 200);
    f.state.hook = null; assert.equal((await f.request(otherRoute + '/create', { expectedVersion: otherSnapshot.version, confirmed: true, settings })).status, 200); assert.equal((await f.app.sql.get('SELECT count(*) AS n FROM zernio_destination_mutations')).n, 0);
  } finally { await f.close(); }
});

test('Reddit defaults use exact fresh names, explicit readback and versions while composer lookups stay unchanged', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const lookup = (await f.request(f.route('reddit'))).data; assert.deepEqual(lookup.subreddits[0], { id: 'reddit-1', name: 'marketing', title: 'Marketing', over18: false }); assert.equal(lookup.defaultSubreddit, 'marketing');
    const before = (await f.get('reddit')).data; assert.equal(before.subreddits[0].url, '/r/marketing/'); assert.equal(before.defaultReported, true);
    const body = { expectedVersion: before.version, confirmed: true, destinationId: 'reddit-2' }, key = randomUUID(), saved = await f.request(f.route('reddit') + '/default', body, key);
    assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.readback, true); assert.equal(saved.data.defaultId, 'reddit-2'); assert.equal(saved.data.snapshot.defaultSubreddit, 'socialmedia'); assert.notEqual(saved.data.snapshot.version, before.version); assert.deepEqual(f.writes()[0].body, { defaultSubreddit: 'socialmedia' });
    assert.equal((await f.request(f.route('reddit') + '/default', body, key)).status, 200); assert.equal(f.writes().length, 1);
    const old = saved.data.snapshot.version; f.state.defaultSubreddit = 'marketing'; assert.notEqual((await f.get('reddit')).data.version, old);
    f.state.defaultSubreddit = null; const empty = (await f.get('reddit')).data; assert.equal(empty.defaultReported, false); assert.equal(empty.defaultSubreddit, '');
    f.state.hook = (url, options) => url.pathname.endsWith('/reddit-subreddits') && options.method === 'GET' ? Response.json({ subreddits: f.state.subreddits }) : undefined;
    const omitted = (await f.get('reddit')).data; assert.equal(omitted.defaultReported, false); assert.equal(omitted.defaultSubreddit, ''); assert.notEqual(empty.version, omitted.version);
  } finally { await f.close(); }
});

test('Reddit defaults reject unsupported creation, clearing, stale names, foreign IDs, extra fields, ads and nonadministrators before dispatch', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  try {
    const before = (await f.get('reddit')).data, body = { expectedVersion: before.version, confirmed: true, destinationId: 'reddit-2' };
    for (const patch of [{ destinationId: '' }, { destinationId: null }, { confirmed: false }, { defaultSubreddit: 'socialmedia' }, { settings: {} }]) assert.equal((await f.request(f.route('reddit') + '/default', { ...body, ...patch })).status, 400);
    assert.equal((await f.request(f.route('reddit') + '/create', { expectedVersion: before.version, confirmed: true, settings: { name: 'new' } })).status, 422);
    assert.equal((await f.request(f.route('reddit') + '/default', { ...body, destinationId: 'foreign' })).status, 403);
    f.state.subreddits[1].name = 'renamed'; assert.equal((await f.request(f.route('reddit') + '/default', body)).status, 409);
    f.accounts[2].platform = 'redditads'; assert.equal((await f.get('reddit')).status, 422); f.accounts[2].platform = 'reddit';
    await f.app.sql.run("UPDATE memberships SET role='editor'"); assert.equal((await f.write('reddit', 'default', 'reddit-2')).status, 403); assert.equal((await f.get('reddit')).status, 200); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('managed destination writes recheck reviewed connection identity after the final account await', { skip: postgresSkip }, async t => {
  for (const platform of ['pinterest', 'youtube', 'reddit']) for (const task of platform === 'reddit' ? ['default'] : ['create', 'default']) for (const scenario of ['username', 'native', 'reconnect', 'unrelated']) {
    const f = await fixture(t);
    try {
      const before = (await f.get(platform)).data, account = f.accounts.find(row => row.platform === platform), resource = platform === 'pinterest' ? 'pinterest-boards' : platform === 'youtube' ? 'youtube-playlists' : 'reddit-subreddits';
      let lists = 0, final = 0, changed = false;
      f.state.hook = (url, options) => {
        if (url.pathname.endsWith('/' + resource) && options.method === 'GET' && ++lists === 2) final = 2;
        else if (url.pathname.endsWith('/accounts') && final && --final === 0) {
          changed = true;
          if (scenario === 'username') account.username = 'different-reviewed-sender';
          if (scenario === 'native') account.platformUserId = 'different-native-sender';
          if (scenario === 'reconnect') account.needsReconnection = true;
          if (scenario === 'unrelated') { account.metrics = { followers: 99 }; account.updatedAt = '2026-10-20T00:00:00Z'; account.metadata = { unrelatedDisplayHint: 'Changed' }; }
        }
      };
      const body = { expectedVersion: before.version, confirmed: true, ...(task === 'create' ? { settings: { [platform === 'youtube' ? 'title' : 'name']: 'Reviewed new destination', description: '', privacy: platform === 'youtube' ? 'private' : 'PUBLIC' } } : { destinationId: platform === 'pinterest' ? 'board-1' : platform === 'youtube' ? 'PL-1' : 'reddit-2' }) };
      const result = await f.request(f.route(platform) + '/' + task, body), label = `${platform}/${task}/${scenario}`;
      assert.equal(changed, true, label + ' reaches the account read after both unchanged destination censuses.');
      assert.equal(f.writes().length, scenario === 'unrelated' ? 1 : 0, label + ': only unchanged publication identity may dispatch.');
      assert.equal(result.data.operation.status, scenario === 'unrelated' ? 'complete' : 'failed', label + ': predispatch scope changes are known failures.');
      assert.equal(result.status, scenario === 'unrelated' ? 200 : 409, label + ':' + JSON.stringify(result.data));
    } finally { await f.close(); }
  }
});

test('Reddit rejects changed account/access after GET and after the final account await before PUT', { skip: postgresSkip }, async t => {
  for (const scenario of ['native-after-list', 'username-after-list', 'inactive-after-list', 'reconnect-after-list', 'profile-after-list', 'role-after-list', 'session-after-list', 'mapping-after-list', 'native-final-account', 'role-final-account']) {
    const f = await fixture(t);
    try {
      const before = (await f.get('reddit')).data; let lists = 0, final = 0;
      const change = async () => { if (scenario.startsWith('native')) f.accounts[2].platformUserId = 'different-native'; if (scenario.startsWith('username')) f.accounts[2].username = 'changed'; if (scenario.startsWith('inactive')) f.accounts[2].isActive = false; if (scenario.startsWith('reconnect')) f.accounts[2].needsReconnection = true; if (scenario.startsWith('profile')) f.accounts[2].profileId = 'foreign'; if (scenario.startsWith('role')) await f.app.sql.run("UPDATE memberships SET role='editor'"); if (scenario.startsWith('session')) await f.app.sql.run('DELETE FROM sessions'); if (scenario.startsWith('mapping')) await f.app.sql.run('UPDATE projects SET zernio_profile_id=?', 'foreign'); };
      f.state.hook = async (url, options) => {
        if (url.pathname.endsWith('/reddit-subreddits') && options.method === 'GET' && ++lists === 2) { if (scenario.endsWith('final-account')) final = 2; else await change(); }
        else if (url.pathname.endsWith('/accounts') && final && --final === 0) await change();
      };
      const saved = await f.request(f.route('reddit') + '/default', { expectedVersion: before.version, confirmed: true, destinationId: 'reddit-2' }); assert.ok([403, 409, 422].includes(saved.status), scenario + ':' + JSON.stringify(saved.data)); assert.equal(f.writes().length, 0, scenario);
    } finally { await f.close(); }
  }
});

test('Reddit uncertain acknowledgements and readbacks retain the durable provider fence through aliases, projects and reopen', { skip: postgresSkip }, async t => {
  for (const scenario of ['lost-ack', 'false-success', 'missing-success', 'foreign-ack', 'not-saved', 'missing-default', 'null-default', 'changed-id', 'changed-identity-after-readback']) {
    const f = await fixture(t);
    try {
      const before = (await f.get('reddit')).data, body = { expectedVersion: before.version, confirmed: true, destinationId: 'reddit-2' }, key = randomUUID(); let sent = false, readback = false;
      f.state.hook = (url, options) => {
        if (url.pathname.endsWith('/reddit-subreddits') && options.method === 'PUT') { sent = true; if (scenario !== 'not-saved') f.state.defaultSubreddit = 'socialmedia'; if (scenario === 'lost-ack') throw new Error('Synthetic lost acknowledgement'); if (scenario === 'false-success') return Response.json({ success: false }); if (scenario === 'missing-success') return Response.json({}); if (scenario === 'foreign-ack') return Response.json({ accountId: 'foreign', success: true }); return Response.json({ success: true }); }
        if (sent && url.pathname.endsWith('/reddit-subreddits') && options.method === 'GET') { readback = true; if (scenario === 'missing-default') return Response.json({ subreddits: f.state.subreddits }); if (scenario === 'null-default') return Response.json({ subreddits: f.state.subreddits, defaultSubreddit: null }); if (scenario === 'changed-id') return Response.json({ subreddits: f.state.subreddits.map(row => row.id === 'reddit-2' ? { ...row, id: 'replacement' } : row), defaultSubreddit: 'socialmedia' }); }
        if (readback && scenario === 'changed-identity-after-readback' && url.pathname.endsWith('/accounts')) f.accounts[2].platformUserId = 'replaced-after-readback';
      };
      const result = await f.request(f.route('reddit') + '/default', body, key); assert.equal(result.status, 409, scenario + ':' + JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(f.writes().length, 1);
      f.state.hook = null; const replay = await f.request(f.route('reddit') + '/default', body, key); assert.equal(replay.status, 409); assert.equal(replay.data.error.code, 'OPERATION_UNCERTAIN');
      f.accounts.push({ ...f.accounts[2], _id: 'reddit-alias', platformUserId: undefined }); const aliasRoute = f.route('reddit').replace('account-reddit/', 'reddit-alias/'), alias = (await f.request(aliasRoute + '/manage')).data;
      const blocked = await f.request(aliasRoute + '/default', { expectedVersion: alias.version, confirmed: true, destinationId: 'reddit-1' }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(f.writes().length, 1);
      if (scenario === 'lost-ack') {
        await f.reopen(); const other = await f.request('/workspaces', { name: 'Reddit alias project' }); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'reddit-other-profile', other.data.projectId); f.accounts.push({ ...f.accounts[2], _id: 'reddit-other-alias', platformUserId: undefined, profileId: 'reddit-other-profile' });
        const route = `/projects/${other.data.projectId}/integrations/publishing/accounts/reddit-other-alias/reddit-subreddits`, snapshot = (await f.request(route + '/manage')).data;
        const across = await f.request(route + '/default', { expectedVersion: snapshot.version, confirmed: true, destinationId: 'reddit-1' }); assert.equal(across.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED');
        assert.equal((await f.request(`${f.project}/operations/${result.data.operation.id}/review`, { resolution: 'applied', confirmChecked: true, note: 'The synthetic Reddit readback confirms the shared default was applied.', reference: 'synthetic-reddit-readback' })).status, 200);
        const recovered = await f.write('reddit', 'default', 'reddit-1'); assert.equal(recovered.status, 200, JSON.stringify(recovered.data)); assert.equal((await f.app.sql.get('SELECT count(*) AS n FROM zernio_destination_mutations')).n, 0);
      } else assert.equal(f.writes().length, 1);
    } finally { await f.close(); }
  }
});

test('Reddit provider fence remains held through the final readback account await', { skip: postgresSkip }, async t => {
  const f = await fixture(t); let release;
  try {
    const other = await f.request('/workspaces', { name: 'Concurrent Reddit destination project' }); await f.app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', 'concurrent-profile', other.data.projectId); f.accounts.push({ ...f.accounts[2], _id: 'concurrent-alias', profileId: 'concurrent-profile' });
    const route = `/projects/${other.data.projectId}/integrations/publishing/accounts/concurrent-alias/reddit-subreddits`, otherSnapshot = (await f.request(route + '/manage')).data, before = (await f.get('reddit')).data;
    let ready, sent = false, readback = false, held = false; const blocked = new Promise(resolve => { ready = resolve; });
    f.state.hook = (url, options) => {
      if (url.pathname.endsWith('/reddit-subreddits') && options.method === 'PUT') sent = true;
      if (sent && url.pathname.endsWith('/reddit-subreddits') && options.method === 'GET') readback = true;
      if (readback && !held && url.pathname.endsWith('/accounts')) { held = true; ready(); return new Promise(resolve => { release = () => resolve(Response.json({ accounts: f.accounts })); }); }
    };
    const pending = f.request(f.route('reddit') + '/default', { expectedVersion: before.version, confirmed: true, destinationId: 'reddit-2' }); await blocked;
    const racing = await f.request(route + '/default', { expectedVersion: otherSnapshot.version, confirmed: true, destinationId: 'reddit-1' }); assert.equal(racing.status, 409); assert.equal(racing.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(f.writes().length, 1);
    release(); assert.equal((await pending).status, 200); assert.equal((await f.app.sql.get('SELECT count(*) AS n FROM zernio_destination_mutations')).n, 0);
  } finally { release?.(); await f.close(); }
});

test('parallel duplicate destination creates and defaults reach the provider once', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  // The first write is held at the provider so the duplicate arrives while its receipt is still pending.
  const hold = (method, suffix) => { let entered, release; const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); let held = false; f.state.hook = async (url, options) => { if (!held && options.method === method && url.pathname.endsWith(suffix)) { held = true; entered(); await gate; } }; return { reached, release }; };
  const outcome = result => result.data.error?.code ?? result.data.operation.status;
  try {
    const before = (await f.get('youtube')).data, body = { expectedVersion: before.version, confirmed: true, settings: { title: 'Parallel playlist', description: '', privacy: 'private' } }, key = randomUUID(), created = hold('POST', '/youtube-playlists');
    const sameKey = await Promise.all([f.request(f.route('youtube') + '/create', body, key), created.reached.then(async () => { const duplicate = await f.request(f.route('youtube') + '/create', body, key); created.release(); return duplicate; })]);
    assert.deepEqual(sameKey.map(outcome), ['complete', 'OPERATION_UNCERTAIN']); assert.equal(sameKey[0].status, 200);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith('/youtube-playlists')).length, 1);
    const defaulted = hold('PUT', '/pinterest-boards');
    const differentKeys = await Promise.all([f.write('pinterest', 'default', 'board-1'), defaulted.reached.then(async () => { const duplicate = await f.write('pinterest', 'default', 'board-1'); defaulted.release(); return duplicate; })]);
    assert.deepEqual(differentKeys.map(outcome), ['complete', 'OPERATION_NOT_SENT']); assert.equal(differentKeys[1].data.operation.status, 'failed');
    assert.equal(f.calls.filter(call => call.method === 'PUT' && call.url.pathname.endsWith('/pinterest-boards')).length, 1);
  } finally { await f.close(); }
});

const source = await readFile(new URL('../src/ZernioDestinations.tsx', import.meta.url), 'utf8');
const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('destination UI freezes reviewed settings, rejects stale scope/version and preserves exact uncertain retry keys', async () => {
  const prepareSource = section('function prepare(', '  async function write('), saveSource = section('async function save(', '  return <Card'), writeSource = section('async function write(', '  async function save('), calls = [], view = {};
  let intent, reviewed; const snapshot = { version: 'old-reviewed' };
  const revision = { current: 0 }, prepare = compile(prepareSource, { canManage: true, snapshot, busy: false, uncertain: false, current: () => true, youtube: true, reddit: false, revision, name: 'Reviewed title', description: '', privacy: 'private', rows: [], defaultId: '', setIntent: value => { intent = value; }, setReviewed: value => { reviewed = value; }, setError() {}, setNotice() {} });
  prepare({ preventDefault() {} }, 'create'); const first = intent; reviewed = first;
  const makeSave = extra => compile(saveSource, { canManage: true, intent, reviewed, snapshot, committed: { current: { intent, reviewed, snapshot } }, revision, current: () => true, action: run => run(), write: async value => { calls.push(value); return { snapshot: {}, destination: { id: 'PL' } }; }, setUncertain() {}, setSnapshot() {}, setIntent() {}, setReviewed() {}, setDefaultId() {}, setNotice() {}, youtube: true, reddit: false, ...extra });
  prepare({ preventDefault() {} }, 'create'); await makeSave({ reviewed: first })(); assert.equal(calls.length, 0);
  reviewed = intent; await makeSave({ snapshot: { version: 'changed-unseen' } })(); await makeSave({ current: () => false })(); assert.equal(calls.length, 0); await makeSave({})(); assert.equal(calls.length, 1); assert.equal(calls[0].body.settings.title, 'Reviewed title');
  const keys = { current: new Map() }, requests = []; let unknown = true;
  const write = compile(writeSource, { target: '/publishing/accounts/yt/youtube-playlists', keys, crypto, reddit: false, requester: { current: async (...args) => { requests.push(args); if (unknown) throw Object.assign(new Error('Unknown receipt'), { status: 409, code: 'OPERATION_UNCERTAIN' }); return { operation: { status: 'complete' }, created: true, destination: { id: 'PL' }, snapshot: { accountId: 'yt', version: 'new' } }; } }, accountId: 'yt' });
  await assert.rejects(write(intent), /Unknown/); assert.equal(keys.current.size, 1); unknown = false; await write(intent); assert.deepEqual(requests[0], requests[1]); assert.equal(keys.current.size, 0);
});

test('destination reads ignore late responses and rendered controls expose explicit privacy, quota and unsupported-clear behavior without native dialogs', async () => {
  const loadSource = section('async function load(', '  function clearReview('); let finish, live = true; const accepted = [], reads = { current: 0 };
  const context = { current: () => live, accountId: 'yt', account: { platform: 'youtube' }, field: 'playlists', reads, setSnapshot: value => { if (value) accepted.push(value); }, setIntent() {}, setReviewed() {}, setUncertain() {}, setDefaultId() {}, requester: { current: () => new Promise(resolve => { finish = resolve; }) }, target: '/publishing/yt', youtube: true };
  const pending = compile(loadSource, context)(); live = false; finish({ accountId: 'yt', platform: 'youtube', version: 'late', playlists: [] }); await pending; assert.deepEqual(accepted, []);
  const start = source.indexOf('  return <Card'), end = source.lastIndexOf('\n}'), { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'Destinations.tsx', { jsx: { runtime: 'classic' } });
  const intent = { summary: ['Create empty playlist with private visibility.'] }, renderContext = { React, ...design, accountId: 'yt', busy: false, action() {}, load() {}, error: '', notice: '', accounts: [{ _id: 'yt', platform: 'youtube' }], setAccountId() {}, snapshot: { accountName: 'Synthetic YouTube', defaultReported: true, defaultPlaylistId: 'PL' }, youtube: true, reddit: false, rows: [{ id: 'PL', title: 'Reviewed list', privacy: 'private', description: '', itemCount: 0 }], canManage: true, uncertain: false, prepare() {}, clearReview() {}, defaultId: '', setDefaultId() {}, name: 'New playlist', setName() {}, description: '', setDescription() {}, privacy: 'private', setPrivacy() {}, intent, reviewed: null, setReviewed() {}, save() {} };
  const html = renderToStaticMarkup(new Function(...Object.keys(renderContext), code + '; return render;')(...Object.values(renderContext))()); assert.match(html, /50 YouTube quota units/); assert.match(html, /not idempotent/); assert.match(html, /clearing the saved default is unavailable/); assert.match(html, /<option value="private" selected="">private/); assert.doesNotMatch(source, /window\.confirm/);
});

const { code: destinationCode } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function '), 'DestinationsInteraction.tsx', { jsx: { runtime: 'classic' } });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray([node.props?.actions, node.props?.children]).flatMap(nodes)];
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const redditSnapshot = { accountId: 'reddit-a', platform: 'reddit', accountName: 'Our Reddit', version: 'reviewed-version', defaultReported: true, defaultSubreddit: 'marketing', subreddits: [{ id: 'id-marketing', name: 'marketing', title: '<Marketing>', over18: false }, { id: 'id-social', name: 'socialmedia', title: 'Social media', over18: true }] };
const redditReceipt = () => ({ operation: { id: 'saved-action', status: 'complete' }, accepted: true, readback: true, defaultId: 'id-social', snapshot: { ...redditSnapshot, version: 'saved-version', defaultSubreddit: 'socialmedia' } });
async function destinationBrowser(respond = async (_path, method) => method ? redditReceipt() : { ...redditSnapshot }, canManage = true) {
  const hooks = [], queued = [], calls = []; let cursor = 0, dirty = true, tree, props = { projectId: 'project-a', canManage };
  const useState = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useMemo = (compute, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) hooks[index] = { dependencies, value: compute() }; return hooks[index].value; };
  const useEffect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); return args[0].endsWith('/accounts') ? { accounts: [{ _id: 'reddit-a', platform: 'reddit', isActive: true, displayName: 'Our Reddit' }, { _id: 'reddit-ad', platform: 'redditads', isActive: true }] } : respond(...args); };
  const Component = new Function('React', 'useState', 'useRef', 'useMemo', 'useEffect', 'useLayoutEffect', ...Object.keys(design), destinationCode + ';return ZernioDestinations;')(React, useState, useRef, useMemo, useEffect, useEffect, ...Object.values(design));
  function paint(force = false) { dirty ||= force; for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component({ request, ...props }); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const button = text => { const found = nodes(tree).find(node => node.type === design.Button && React.Children.toArray(node.props.children).join('') === text); assert.ok(found, text); return found; };
  const change = (label, value) => { const field = nodes(tree).find(node => node.type === design.Field && node.props.label === label); assert.ok(field, label); nodes(field).find(child => child.type === design.Select).props.onChange({ target: { value } }); paint(); };
  const review = () => { const form = nodes(tree).find(node => node.props?.as === 'form' && nodes(node).some(child => child.type === design.Button && child.props.children === 'Review default change')); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); paint(); };
  const check = () => { nodes(tree).find(node => node.type === design.Checkbox).props.onChange({ target: { checked: true } }); paint(); };
  const click = text => { const found = button(text); assert.equal(!!found.props.disabled, false, text); const pending = found.props.onClick(); paint(); return pending; };
  const discard = value => { const committed = [...hooks], pending = queued.length; cursor = 0; try { Component({ request, ...props, ...value }); } finally { hooks.splice(0, hooks.length, ...committed); queued.length = pending; } };
  paint(); await tick(); change('Connected account', 'reddit-a'); await tick();
  return { calls, tick, change, review, check, click, button, discard, html: () => renderToStaticMarkup(tree), scope: value => { props = { ...props, ...value }; paint(true); } };
}

test('mounted Reddit destinations expose exact existing choices, administrator review and same-key receipt recovery without automatic writes', async () => {
  let malformed = true; const ui = await destinationBrowser(async (_path, method) => method ? malformed ? { ...redditReceipt(), snapshot: { ...redditReceipt().snapshot, defaultSubreddit: 'wrong' } } : redditReceipt() : { ...redditSnapshot });
  assert.match(ui.html(), /Saved Reddit default: r\/marketing/); assert.match(ui.html(), /clearing the saved default is unavailable/); assert.match(ui.html(), /Subreddit creation is unavailable/); assert.match(ui.html(), /&lt;Marketing&gt;/); assert.doesNotMatch(ui.html(), /reddit-ad|Review creation|>Create (YouTube playlist|Pinterest board)</); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  ui.change('New saved account default', 'id-social'); ui.review(); assert.match(ui.html(), /r\/socialmedia.*ID: id-social/); assert.equal(ui.button('Apply reviewed change').props.disabled, true); ui.check(); await ui.click('Apply reviewed change'); await ui.tick(); assert.match(ui.html(), /same action key has been retained/); assert.doesNotMatch(ui.html(), /Saved Reddit default verified/); assert.equal(ui.button('Refresh destinations').props.disabled, true);
  malformed = false; await ui.click('Check the same action again'); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.deepEqual(writes[0][2], { expectedVersion: 'reviewed-version', confirmed: true, destinationId: 'id-social' }); assert.match(ui.html(), /Saved Reddit default verified: r\/socialmedia/);
  const viewer = await destinationBrowser(undefined, false); assert.match(viewer.html(), /Saved Reddit default: r\/marketing/); assert.doesNotMatch(viewer.html(), /Review default change|New saved account default|Apply reviewed change/); assert.equal(viewer.calls.filter(call => call[1]).length, 0);
});

test('mounted destination responses and retained saves respect newer edits, committed scope and discarded renders', async () => {
  for (const departed of ['edit', 'role', 'project-return']) {
    const receipt = deferred(), ui = await destinationBrowser(async (_path, method) => method ? receipt.promise : { ...redditSnapshot }); ui.change('New saved account default', 'id-social'); ui.review(); ui.check(); const pending = ui.click('Apply reviewed change');
    if (departed === 'edit') ui.change('New saved account default', 'id-marketing'); if (departed === 'role') ui.scope({ canManage: false }); if (departed === 'project-return') { ui.scope({ projectId: 'project-b' }); ui.scope({ projectId: 'project-a' }); }
    receipt.resolve(redditReceipt()); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /Saved Reddit default verified/); if (departed === 'edit') assert.match(ui.html(), /value="id-marketing" selected/);
  }
  for (const abandoned of [{ canManage: false }, { projectId: 'discarded-project' }, { request: () => assert.fail('Discarded requester used') }]) {
    const ui = await destinationBrowser(); ui.change('New saved account default', 'id-social'); ui.review(); ui.check(); const before = ui.html(); ui.discard(abandoned); assert.equal(ui.html(), before); const pending = ui.click('Apply reviewed change'); ui.discard(abandoned); await pending; await ui.tick(); assert.match(ui.html(), /Saved Reddit default verified/); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
  const ui = await destinationBrowser(); ui.change('New saved account default', 'id-social'); ui.review(); ui.check(); const retained = ui.button('Apply reviewed change').props.onClick; ui.change('New saved account default', 'id-marketing'); await retained(); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
});

test('all managed destination snapshots reject identity changes during the destination read', { skip: postgresSkip }, async t => {
  for (const platform of ['pinterest', 'youtube']) {
    const f = await fixture(t);
    try {
      const account = f.accounts.find(row => row.platform === platform);
      f.state.hook = (url, options) => { if ((options.method || 'GET') === 'GET' && url.pathname.endsWith(platform === 'pinterest' ? '/pinterest-boards' : '/youtube-playlists')) account.platformUserId = 'changed-native-account'; };
      const result = await f.get(platform); assert.equal(result.status, 409, platform); assert.equal(result.data.error.code, 'DESTINATION_ACCOUNT_CHANGED'); assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  }
});


test('lost destination response recovers an unsent terminal key only through refresh and fresh review', async () => {
  let writes = 0; const ui = await destinationBrowser(async (_path, method) => { if (!method) return { ...redditSnapshot }; if (++writes === 1) throw new TypeError('Response lost'); if (writes === 2) throw Object.assign(new Error('Not sent'), { status: 409, code: 'OPERATION_NOT_SENT', operation: { status: 'failed' } }); return redditReceipt(); });
  ui.change('New saved account default', 'id-social'); ui.review(); ui.check(); await ui.click('Apply reviewed change'); await ui.tick(); const retained = ui.button('Check the same action again').props.onClick;
  await ui.click('Check the same action again'); await ui.tick(); assert.match(ui.html(), /request was not sent/); assert.equal(ui.button('Refresh destinations').props.disabled, false); await retained(); await ui.tick(); assert.equal(writes, 2); assert.deepEqual(ui.calls.filter(call => call[1])[0], ui.calls.filter(call => call[1])[1]);
  await ui.click('Refresh destinations'); await ui.tick(); ui.change('New saved account default', 'id-social'); ui.review(); assert.equal(ui.button('Apply reviewed change').props.disabled, true); ui.check(); await ui.click('Apply reviewed change'); await ui.tick(); assert.equal(writes, 3); assert.notEqual(ui.calls.filter(call => call[1])[2][3], ui.calls.filter(call => call[1])[0][3]);
});
