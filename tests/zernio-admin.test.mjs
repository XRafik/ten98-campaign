import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import * as ui from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioAdmin } from '../server/zernio-admin.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const pg = { skip: postgresSkip };
const profileId = 'profile-a';
async function setup(t) {
  const { db } = await testDatabase(t), calls = [], state = {
    accounts: [{ _id: 'account-a', platform: 'instagram', profileId, displayName: 'Campaign account', isActive: true }, { _id: 'account-b', platform: 'facebook', profileId }, { _id: 'outside', platform: 'instagram', profileId: 'other-profile' }],
    profile: { _id: profileId, name: 'Campaign profile', description: null, color: '#112233', timezone: null, secret: 'never-return' },
    groups: [{ _id: 'group-a', name: 'Campaign group', accountIds: ['account-a'] }, { _id: 'mixed', name: 'Private mixed group', accountIds: ['account-a', 'outside'] }, { _id: 'empty', name: 'Private empty group', accountIds: [] }, { _id: 'foreign', name: 'Private foreign group', accountIds: ['outside'] }],
    malformed: false, readFail: false, retainDeleted: false, hold: null, written: false,
  };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (method === 'GET') {
      if (state.readFail && state.written) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Readback unavailable');
      if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: structuredClone(state.accounts) }; }
      if (path === '/account-groups') { assert.deepEqual(query, {}); return { groups: structuredClone(state.groups) }; }
      assert.equal(path, '/profiles/profile-a'); return { profile: structuredClone(state.profile) };
    }
    state.written = true; state.onWrite?.(); if (state.hold) await state.hold;
    if (path === '/profiles/profile-a') { assert.equal(method, 'PUT'); Object.assign(state.profile, body); return state.malformed ? {} : { profile: structuredClone(state.profile) }; }
    if (path === '/account-groups') { assert.equal(method, 'POST'); const row = { _id: 'created-' + state.groups.length, ...body }; state.groups.push(row); return state.malformed ? {} : { group: structuredClone(row) }; }
    const row = state.groups.find(row => path === `/account-groups/${row._id}`); assert.ok(row);
    if (method === 'PUT') { Object.assign(row, body); return state.malformed ? {} : { group: structuredClone(row) }; }
    assert.equal(method, 'DELETE'); if (!state.retainDeleted) state.groups.splice(state.groups.indexOf(row), 1); else row.accountIds = ['outside'];
    return state.malformed ? {} : { message: 'Group deleted' };
  };
  let count = 0;
  async function request(action, { body, role = 'owner', key = `admin-key-${++count}` } = {}) {
    let response;
    const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/project-a/integrations/admin/${action}`), body: body || {}, send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioAdmin(context, api, profileId, action); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { db, state, calls, request };
}
const snapshot = group => ({ name: group.name, accountIds: [...group.accountIds] });

const teamMember = (id = 'provider-caller') => ({ _id: id, name: '<img src="https://never.example/member">', email: 'member@example.test', role: 'provider-only-role', isRoot: false, profileAccess: ['profile-a'], createdAt: '2026-01-01T00:00:00Z', lastLoginAt: '2026-01-02T00:00:00Z' });

test('provider team reads allowlist bounded native member fields and require one distinct caller', pg, async t => {
  const { db, pool } = await testDatabase(t); await pool.query("INSERT INTO users (id, name, email, password) VALUES ('local-operator', 'Operator', 'local-operator@example.test', NULL); INSERT INTO instance_operators (user_id) VALUES ('local-operator')");
  let payload, result, checks = 0; const calls = [];
  const context = { db, user: { id: 'local-operator', isOperator: true }, role: 'owner', req: { method: 'GET' }, assertProjectMapping(id) { assert.equal(id, profileId); checks++; }, send(status, data) { result = { status, data }; } };
  const api = async (...args) => { calls.push(args); return payload; };
  payload = { currentUserId: 'provider-caller', token: 'never-return', users: [{ ...teamMember(), credentials: { secret: 'never-return' } }, { _id: 'other-provider-member', name: 'Other', email: 'other@example.test', role: 'future-role' }] };
  await handleZernioAdmin(context, api, profileId, 'team');
  assert.equal(result.status, 200); assert.equal(checks, 2); assert.deepEqual(calls, [['/users']]); assert.equal(JSON.stringify(result).includes('never-return'), false);
  assert.deepEqual(result.data.users[1], { _id: 'other-provider-member', name: 'Other', email: 'other@example.test', role: 'future-role', isRoot: null, profileAccess: null, createdAt: null, lastLoginAt: null });
  for (const mutate of [
    value => { value.currentUserId = 'absent'; }, value => { value.users.push(value.users[0]); }, value => { value.users = []; }, value => { value.users = Array.from({ length: 10001 }, () => teamMember()); },
    value => { value.users[0] = null; }, value => { value.users[0]._id = 'bad id'; }, value => { value.users[0].name = 'x'.repeat(201); }, value => { value.users[0].email = 'bad\u0000email'; }, value => { value.users[0].role = {}; },
    value => { value.users[0].isRoot = 'true'; }, value => { value.users[0].profileAccess = ['all', profileId]; }, value => { value.users[0].profileAccess = [profileId, profileId]; }, value => { value.users[0].profileAccess = Array.from({ length: 1001 }, (_, index) => String(index)); },
    value => { value.users[0].createdAt = 'invalid'; }, value => { value.users[0].lastLoginAt = 0; },
  ]) {
    payload = { currentUserId: 'provider-caller', users: [teamMember()] }; mutate(payload);
    await assert.rejects(handleZernioAdmin(context, api, profileId, 'team'), error => error.status === 502 && error.code === 'INVALID_PROVIDER_TEAM');
  }
  for (const profileAccess of [[], ['all'], null]) { payload = { currentUserId: 'provider-caller', users: [{ ...teamMember(), profileAccess, isRoot: null, createdAt: null, lastLoginAt: null }] }; await handleZernioAdmin(context, api, profileId, 'team'); assert.deepEqual(result.data.users[0].profileAccess, profileAccess); }
});

test('provider team HTTP reads require live operator and administration and withdraw data across every access boundary', pg, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-provider-team-')), origin = 'http://127.0.0.1:3029', originalFetch = globalThis.fetch;
  const env = { ZERNIO_API_KEY: 'team-fixture-key' }, app = await testApp(t, { dataDir, appUrl: origin, env, directScheduler: false }), calls = [];
  let base, cookie, pause, rejection = 0, payload = { currentUserId: 'provider-caller', users: [teamMember()] };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.href, 'https://zernio.com/api/v1/users'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); calls.push(options.headers.Authorization);
    if (pause) { const waiting = pause; pause = null; waiting.started(); await waiting.wait; }
    return Response.json(rejection ? { error: 'private-provider-error', token: 'never-return' } : payload, { status: rejection || 200 });
  };
  async function request(path, { method = 'GET', body, selected = cookie } = {}) {
    const response = await originalFetch(base + '/api' + path, { method, headers: { Origin: origin, ...(selected ? { Cookie: selected } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  let state, route;
  async function changedDuring(change, restore, expected) {
    let started, release; const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
    pause = { started, wait }; const pending = request(route);
    try {
      await Promise.race([entered, new Promise((_, reject) => { setTimeout(() => reject(new Error('Expected team read boundary.')), 3000).unref(); })]);
      await change(); release(); const denied = await pending;
      assert.equal(denied.status, expected, JSON.stringify(denied.data)); assert.equal(denied.data.users, undefined); assert.equal(JSON.stringify(denied.data).includes('member@example.test'), false);
    } finally { release(); await restore(); }
  }
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
    const password = 'provider team fixture password 2026', email = 'team-operator@example.test';
    const setup = await request('/auth/setup', { method: 'POST', body: { name: 'Team operator', email, password } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
    state = (await request('/state')).data; route = `/projects/${state.projectId}/integrations/admin/team`; const project = `/projects/${state.projectId}`, workspaceId = state.workspaces[0].id, userId = state.user.id;
    assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    let result = await request(route); assert.equal(result.status, 200); assert.equal(result.data.currentUserId, 'provider-caller'); assert.equal(result.data.users[0].role, 'provider-only-role');
    const beforeDenied = calls.length; assert.equal((await request(route, { selected: null })).status, 401);
    for (const role of ['editor', 'viewer']) { await app.sql.run('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?', role, workspaceId, userId); assert.equal((await request(route)).status, 403); }
    await app.sql.run("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?", workspaceId, userId);
    await app.sql.run('DELETE FROM instance_operators WHERE user_id=?', userId); assert.equal((await request(route)).status, 403); await app.sql.run('INSERT INTO instance_operators (user_id) VALUES (?)', userId);
    assert.equal((await request(route, { method: 'POST', body: {} })).status, 405);
    const outsider = randomUUID(), hash = (await app.sql.get('SELECT password FROM users WHERE id=?', userId)).password;
    await app.sql.run('INSERT INTO users (id, name, email, password) VALUES (?,?,?,?)', outsider, 'Outside', 'team-outsider@example.test', hash);
    const outsideCookie = (await request('/auth/login', { method: 'POST', body: { email: 'team-outsider@example.test', password } })).cookie;
    assert.equal((await request(route, { selected: outsideCookie })).status, 404); assert.equal(calls.length, beforeDenied);
    await app.sql.run("UPDATE memberships SET role='admin' WHERE workspace_id=? AND user_id=?", workspaceId, userId); assert.equal((await request(route)).status, 200); await app.sql.run("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?", workspaceId, userId);
    for (const status of [401, 403, 429, 500]) { rejection = status; const before = calls.length; result = await request(route); assert.equal(result.status, status === 403 ? 403 : status === 401 ? 400 : status === 500 ? 502 : status); assert.equal(calls.length, before + 1); assert.equal(result.data.users, undefined); assert.equal(JSON.stringify(result).includes('private-provider-error'), false); }
    rejection = 0;
    await changedDuring(() => app.sql.run('DELETE FROM instance_operators WHERE user_id=?', userId), () => app.sql.run('INSERT INTO instance_operators (user_id) VALUES (?)', userId), 403);
    await changedDuring(() => app.sql.run("UPDATE memberships SET role='viewer' WHERE workspace_id=? AND user_id=?", workspaceId, userId), () => app.sql.run("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?", workspaceId, userId), 403);
    await changedDuring(() => app.sql.run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?', workspaceId, userId), () => app.sql.run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?,?,'owner')", workspaceId, userId), 403);
    await changedDuring(() => app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id=?", state.projectId), () => app.sql.run('UPDATE projects SET zernio_profile_id=? WHERE id=?', profileId, state.projectId), 409);
    await changedDuring(async () => { assert.equal((await request('/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'changed-team-fixture-key' } } })).status, 200); }, async () => { assert.equal((await request('/settings/integrations/zernio', { method: 'PUT', body: { fields: { apiKey: 'team-fixture-key' } } })).status, 200); }, 409);
    const revoker = (await request('/auth/login', { method: 'POST', body: { email, password } })).cookie;
    await changedDuring(async () => { assert.equal((await request('/account/sessions/revoke', { method: 'POST', body: {}, selected: revoker })).status, 200); }, () => { cookie = revoker; }, 403);
    const beforeUnmapped = calls.length; await app.sql.run("UPDATE projects SET zernio_profile_id='' WHERE id=?", state.projectId); assert.equal((await request(route)).status, 409); assert.equal(calls.length, beforeUnmapped);
    assert.equal((await app.sql.get('SELECT COUNT(*) AS count FROM integration_operations')).count, 0, 'Team reads create no write receipts.');
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});

test('administration reads only the mapped profile and complete project-owned groups, with no foreign names or secrets', pg, async t => {
  const { state, calls, request } = await setup(t);
  const result = await request('overview', { role: 'viewer' }); assert.equal(result.status, 200); assert.equal(result.data.profile._id, profileId); assert.deepEqual(result.data.groups.map(row => row._id), ['group-a']); assert.equal(result.data.accounts.length, 2);
  assert.equal(JSON.stringify(result).includes('Private'), false); assert.equal(JSON.stringify(result).includes('never-return'), false); assert.equal(calls.some(row => row.path === '/profiles'), false);
  state.profile._id = 'foreign-profile'; assert.equal((await request('overview')).status, 502); state.profile._id = profileId;
  state.groups[0].accountIds = ['account-a', 'account-a']; assert.equal((await request('overview')).status, 502);
});

test('group creation, rename, membership update and deletion are scoped, confirmed and idempotent', pg, async t => {
  const { state, calls, request } = await setup(t);
  const body = { name: ' Launch group ', accountIds: ['account-a', 'account-b'] }, key = 'create-launch-group';
  let result = await request('groups/create', { body, key }); assert.equal(result.status, 200); const created = result.data.group; assert.equal(created.name, 'Launch group'); assert.deepEqual(created.accountIds, body.accountIds);
  assert.deepEqual((await request('groups/create', { body, key })).data, result.data); assert.equal(calls.filter(row => row.method === 'POST').length, 1); assert.equal(calls.find(row => row.method === 'POST').body.profileId, undefined);
  result = await request(`groups/${created._id}/update`, { body: { name: 'Edited group', accountIds: ['account-b'], expectedGroup: snapshot(created) } }); assert.equal(result.status, 200); assert.equal(result.data.group.name, 'Edited group');
  result = await request(`groups/${created._id}/delete`, { body: { confirmGroupId: created._id, expectedGroup: snapshot(result.data.group) } }); assert.equal(result.status, 200); assert.equal(result.data.deleted, true); assert.equal(state.groups.some(row => row._id === created._id), false); assert.equal(state.accounts.length, 3);
});

test('roles, foreign or empty memberships, missing confirmations and stale group snapshots fail before a write', pg, async t => {
  const { state, calls, request } = await setup(t);
  for (const role of ['viewer', 'editor']) {
    assert.equal((await request('groups/create', { body: { name: 'Group', accountIds: ['account-a'] }, role })).status, 403);
    assert.equal((await request('profile/update', { body: { name: 'Changed', expectedProfile: state.profile }, role })).status, 403);
  }
  assert.equal(calls.length, 0);
  for (const accountIds of [[], ['outside'], ['account-a', 'outside'], ['account-a', 'account-a']]) assert.ok([400, 403].includes((await request('groups/create', { body: { name: 'Bad group', accountIds } })).status));
  for (const id of ['mixed', 'empty', 'foreign', 'missing']) assert.equal((await request(`groups/${id}/update`, { body: { name: 'Wrong', accountIds: ['account-a'], expectedGroup: { name: 'Private', accountIds: ['account-a'] } } })).status, 403);
  assert.equal((await request('groups/group-a/delete', { body: { expectedGroup: snapshot(state.groups[0]) } })).status, 400);
  assert.equal((await request('groups/group-a/update', { body: { name: 'New name', accountIds: ['account-b'], expectedGroup: { name: 'Stale', accountIds: ['account-a'] } } })).status, 409);
  assert.equal((await request('groups/%invalid/delete', { body: { confirmGroupId: '%invalid', expectedGroup: {} } })).status, 400);
  assert.equal(calls.some(row => row.method !== 'GET'), false);
});

test('mapped profile settings validate timezone, protect global fields and verify receipt plus readback', pg, async t => {
  const { state, calls, request } = await setup(t);
  const current = (await request('overview')).data.profile;
  const patch = { name: 'Brand profile', description: 'New description', color: '#aabbcc', timezone: 'Asia/Dubai', expectedProfile: current };
  let result = await request('profile/update', { body: patch }); assert.equal(result.status, 200); assert.equal(result.data.profile.timezone, 'Asia/Dubai'); assert.equal(result.data.profile.name, 'Brand profile');
  result = await request('profile/update', { body: { name: 'Overwritten', expectedProfile: current } }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROFILE_CHANGED');
  for (const fields of [{ isDefault: true }, { externalId: 'other-tenant' }, { profileId: 'foreign' }, { timezone: 'Invalid/Timezone' }, { color: {} }, { name: ' ' }]) assert.equal((await request('profile/update', { body: { ...fields, expectedProfile: result.data.profile } })).status, 400);
  const latest = (await request('overview')).data.profile; result = await request('profile/update', { body: { description: null, timezone: null, expectedProfile: latest } }); assert.equal(result.status, 200); assert.equal(result.data.profile.description, null); assert.equal(result.data.profile.timezone, null);
  assert.equal(calls.filter(row => row.method === 'PUT').length, 2); assert.equal(JSON.stringify(result).includes('never-return'), false);
});

test('malformed or unconfirmed group writes remain uncertain and cannot be resent using a different key', pg, async t => {
  for (const failure of ['malformed', 'readFail', 'retainDeleted']) {
    const { state, calls, request } = await setup(t);
    state[failure] = true;
    const action = failure === 'retainDeleted' ? 'groups/group-a/delete' : 'groups/create', body = failure === 'retainDeleted' ? { confirmGroupId: 'group-a', expectedGroup: snapshot(state.groups[0]) } : { name: 'Uncertain group', accountIds: ['account-a'] };
    let result = await request(action, { body, key: 'unknown-write-outcome' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    const writes = calls.filter(row => row.method !== 'GET').length; result = await request(action, { body, key: 'another-outcome-key' }); assert.equal(result.status, 409); assert.equal(calls.filter(row => row.method !== 'GET').length, writes);
  }
  const { state, request } = await setup(t);
  const expectedProfile = (await request('overview')).data.profile; state.malformed = true; const result = await request('profile/update', { body: { name: 'Unknown profile', expectedProfile } }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
});

test('group mutations share a resource lock while a provider write is pending', pg, async t => {
  const { state, calls, request } = await setup(t); let release, entered, pending;
  try {
    state.hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; }); state.onWrite = entered;
    pending = request('groups/create', { body: { name: 'Held group', accountIds: ['account-a'] } }); await started;
    const body = { confirmGroupId: 'group-a', expectedGroup: snapshot(state.groups[0]) }, key = 'blocked-admin-delete';
    const result = await request('groups/group-a/delete', { body, key }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(result.data.operation.status, 'failed'); assert.equal(calls.some(row => row.method === 'DELETE'), false);
    release(); state.hold = null; assert.equal((await pending).status, 200);
    assert.deepEqual((await request('groups/group-a/delete', { body, key })).data, result.data); assert.equal(calls.some(row => row.method === 'DELETE'), false);
  } finally { release?.(); await pending?.catch(() => {}); }
});

test('administration UI retains uncertain keys and ignores stale project or out-of-order reads', async () => {
  const source = await readFile(new URL('../src/ZernioAdmin.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  let active = true, finish, reject; const keys = { current: new Map() }, calls = [];
  const write = compile('async function write(', '  async function saveProfile(', { current: () => active, path: '/projects/a/integrations/admin', keys, crypto: { randomUUID: () => 'stable-admin-key' }, requester: { current: (...args) => { calls.push(args); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); } } });
  let pending = write('groups/create', { name: 'Group' }); reject(new Error('Unreadable response')); await assert.rejects(pending); assert.equal(keys.current.size, 1);
  pending = write('groups/create', { name: 'Group' }); reject(Object.assign(new Error('Uncertain'), { status: 409, code: 'OPERATION_UNCERTAIN' })); await assert.rejects(pending); assert.equal(calls[0][3], calls[1][3]);
  pending = write('groups/create', { name: 'Group' }); finish({ operation: { status: 'complete' }, group: {} }); await assert.rejects(pending, /receipt could not be read/); assert.equal(keys.current.size, 1);
  pending = write('groups/create', { name: 'Group' }); active = false; finish({ operation: { status: 'complete' }, group: { _id: 'created', name: 'Group', accountIds: ['a'] } }); await assert.rejects(pending, { name: 'AbortError' }); await assert.rejects(write('groups/create', {}), { name: 'AbortError' }); assert.equal(calls.length, 4);
  const reads = { current: 0 }, resolvers = [], accepted = [], profile = { _id: profileId, name: 'Profile', description: null, color: '#112233', timezone: null };
  const load = compile('async function load()', '  function choose(', { reads, requester: { current: () => new Promise(resolve => resolvers.push(resolve)) }, path: '/projects/a/integrations/admin', current: () => active, setProfile() {}, setAccounts() {}, setGroups: rows => accepted.push(rows), setLoaded() {}, setSelectedId() {}, setGroupDraft() {}, setProfileDraft() {} });
  active = true; const first = load(), second = load(); resolvers[1]({ profile, accounts: [], groups: [{ _id: 'new' }] }); await second; resolvers[0]({ profile, accounts: [], groups: [{ _id: 'old' }] }); await first; assert.deepEqual(accepted, [[{ _id: 'new' }]]);
  const third = load(); active = false; resolvers[2]({ profile, accounts: [], groups: [{ _id: 'departed' }] }); await third; assert.equal(accepted.length, 1);
  const identitySource = stripTypeScriptTypes(source.slice(source.indexOf('  const path ='), source.indexOf('  useEffect(')));
  const identity = new Function('projectId', 'canManage', 'scope', 'requester', 'request', 'active', 'groups', 'selectedId', `${identitySource}; return current;`), scope = { current: { path: '', canManage: true } }, mounted = { current: true };
  const firstA = identity('a', true, scope, {}, () => {}, mounted, [], ''); assert.equal(firstA(), true);
  const currentB = identity('b', true, scope, {}, () => {}, mounted, [], ''); assert.equal(firstA(), false); assert.equal(currentB(), true);
  const secondA = identity('a', true, scope, {}, () => {}, mounted, [], ''); assert.equal(firstA(), false); assert.equal(secondA(), true);
  const readerA = identity('a', false, scope, {}, () => {}, mounted, [], ''); assert.equal(secondA(), false); assert.equal(readerA(), true);
});

test('rendered administration UI offers normal forms and hides write controls from readers', async () => {
  const source = await readFile(new URL('../src/ZernioAdmin.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <Stack'), end = source.lastIndexOf('\n}');
  const { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'AdminView.tsx', { jsx: { runtime: 'classic' } });
  const render = canManage => {
    const context = { React, ...ui, confirming: undefined, setConfirming() {}, deleteGroup() {}, loaded: true, profile: { name: 'Campaign profile', description: 'Campaign details', timezone: null }, profileDraft: { name: 'Campaign profile', description: '', color: '#112233', timezone: '' }, groupDraft: { name: '', accountIds: [] }, selectedId: '', selected: undefined, accounts: [{ _id: 'account-a', platform: 'instagram', displayName: 'Campaign account' }], groups: [{ _id: 'group-a', name: 'Campaign group', accountIds: ['account-a'] }], error: '', notice: '', busy: false, canManage, accountName: row => row.displayName, action() {}, load() {}, saveProfile() {}, saveGroup() {}, choose() {}, removeGroup() {}, setProfileDraft() {}, setGroupDraft() {} };
    return renderToStaticMarkup(new Function(...Object.keys(context), `${code}; return render();`)(...Object.values(context)));
  };
  const reader = render(false), admin = render(true); assert.match(reader, /Campaign group/); assert.doesNotMatch(reader, /Save profile settings|Create account group|Edit Campaign group/); assert.match(admin, /Save profile settings/); assert.match(admin, /Create account group/); assert.match(admin, /type="checkbox"/); assert.doesNotMatch(admin, /JSON|API payload/); assert.doesNotMatch(source, /window.confirm/);
});

test('administration write keys survive server failures and pending receipts until a definite client failure', async () => {
  const source = await readFile(new URL('../src/ZernioAdmin.tsx', import.meta.url), 'utf8'), handler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function saveProfile(')));
  const keys = { current: new Map() }, calls = []; let failure, sequence = 0;
  const context = { current: () => true, path: '/projects/a/integrations/admin', keys, crypto: { randomUUID: () => `admin-key-${++sequence}` }, requester: { current: async (...args) => { calls.push(args); if (failure) throw Object.assign(new Error('Request failed'), failure); return { operation: { status: 'complete' }, group: { _id: 'group-a', name: 'Group', accountIds: ['account-a'] } }; } } };
  const write = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
  for (const receipt of [{ status: 502 }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, operation: { status: 'pending' } }, { status: 400, operation: { status: 'uncertain' } }]) {
    failure = receipt; await assert.rejects(write('groups/create', { name: 'Group' })); assert.equal(keys.current.size, 1, JSON.stringify(receipt)); const retained = calls.at(-1)[3];
    failure = null; await write('groups/create', { name: 'Group' }); assert.equal(calls.at(-1)[3], retained); assert.equal(keys.current.size, 0);
  }
  failure = { status: 400, code: 'INVALID_GROUP_UPDATE', operation: { status: 'failed' } }; await assert.rejects(write('groups/create', { name: 'Group' })); assert.equal(keys.current.size, 0); const rejected = calls.at(-1)[3];
  failure = null; await write('groups/create', { name: 'Group' }); assert.notEqual(calls.at(-1)[3], rejected);
});
