import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('HTTP invitation links safely onboard new accounts, require the existing identity, preserve workspace scope and cannot reset passwords', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-collaboration-http-')), origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, env: {}, appUrl: origin });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`, ownerPassword = 'fixture owner personal password'; let ownerCookie;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, originHeader = origin } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' && originHeader ? { Origin: originHeader } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') };
  }
  const token = result => new URL(result.data.url).hash.slice('#invite='.length);
  try {
    const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Workspace owner', email: 'collaboration-owner@example.test', password: ownerPassword } }); setup.data.projectId = await firstProject(app, setup);
    assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const ownerState = (await request('/api/state')).data, workspaceId = ownerState.workspaces[0].id, projectId = ownerState.projectId, team = `/api/workspaces/${workspaceId}`;
    assert.equal((await request(team + '/invitations', { cookie: null })).status, 401);
    assert.equal((await request(team + '/invitations', { method: 'POST', body: { email: 'new-colleague@example.test', role: 'editor' }, originHeader: null })).status, 403);
    const created = await request(team + '/invitations', { method: 'POST', body: { email: 'NEW-COLLEAGUE@example.test', role: 'editor' } });
    assert.equal(created.status, 201); assert.equal(new URL(created.data.url).origin, origin);
    const inviteToken = token(created), invitation = '/api/invitations/' + inviteToken;
    assert.match(inviteToken, /^[A-Za-z0-9_-]{43}$/);
    const stored = await app.sql.get('SELECT * FROM workspace_invitations WHERE id=?', created.data.invitation.id);
    assert.equal(stored.token_hash, createHash('sha256').update(inviteToken).digest('hex')); assert.equal(JSON.stringify(stored).includes(inviteToken), false);
    const publicRead = await request(invitation, { cookie: null, originHeader: null });
    assert.equal(publicRead.status, 200); assert.equal(publicRead.data.accountExists, false); assert.equal(publicRead.data.requiresSignIn, false); assert.equal(publicRead.data.invitation.email, 'new-colleague@example.test');
    assert.deepEqual(Object.keys(publicRead.data.invitation).sort(), ['email', 'expiresAt', 'role', 'workspaceName']);
    assert.equal((await request('/api/invitations/not-a-token', { cookie: null })).status, 404);
    const newPassword = 'new colleague chooses this password', signup = { name: 'New colleague', password: newPassword };
    assert.equal((await request(invitation, { method: 'POST', body: signup, cookie: null, originHeader: null })).status, 403);
    assert.equal((await request(invitation, { method: 'POST', body: signup, cookie: null, originHeader: 'https://other.example.test' })).status, 403);
    assert.equal((await request(invitation, { method: 'POST', body: signup })).status, 403, 'A different signed-in account cannot claim a new-account invitation.');
    assert.equal((await request(invitation, { method: 'POST', body: { ...signup, isOperator: true }, cookie: null })).status, 400);
    assert.equal((await request(invitation, { method: 'POST', body: { ...signup, password: 'short' }, cookie: null })).status, 400);
    const accepted = await request(invitation, { method: 'POST', body: signup, cookie: null });
    assert.equal(accepted.status, 200); assert.equal(accepted.data.created, true); assert.equal(accepted.data.role, 'editor'); assert.equal(accepted.data.workspaceId, workspaceId); assert.equal(accepted.data.user.isOperator, false);
    assert.ok(accepted.cookie); assert.match(accepted.cookieHeader, /HttpOnly/); assert.match(accepted.cookieHeader, /SameSite=Lax/);
    const colleagueCookie = accepted.cookie, colleagueId = accepted.data.user.id, colleague = await app.sql.get('SELECT * FROM users WHERE id=?', colleagueId);
    assert.match(colleague.password, /^scrypt\$/); assert.equal(colleague.password.includes(newPassword), false);
    assert.equal(await app.sql.get('SELECT * FROM instance_operators WHERE user_id=?', colleagueId), undefined);
    const colleagueState = (await request('/api/state', { cookie: colleagueCookie })).data;
    assert.equal(colleagueState.user.id, colleagueId); assert.deepEqual(colleagueState.workspaces.map(workspace => [workspace.id, workspace.role]), [[workspaceId, 'editor']]);
    assert.equal((await request(`/api/projects/${projectId}/campaigns`, { method: 'POST', body: { name: 'Editor campaign' }, cookie: colleagueCookie })).status, 201);
    assert.equal((await request(team + '/members', { cookie: colleagueCookie })).status, 403);
    assert.equal((await request(team + '/invitations', { method: 'POST', body: { email: 'unapproved@example.test' }, cookie: colleagueCookie })).status, 403);
    assert.equal((await request('/api/settings/integrations', { cookie: colleagueCookie })).status, 403);
    assert.equal((await request(invitation, { cookie: null })).status, 410);
    assert.equal((await request(invitation, { method: 'POST', body: signup, cookie: null })).status, 410);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { name: 'Uninvited', email: 'uninvited@example.test', password: newPassword }, cookie: null })).status, 409, 'Open signup remains closed after instance setup.');
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: colleague.email, password: ownerPassword }, cookie: null })).status, 401);
    const ownLogin = await request('/api/auth/login', { method: 'POST', body: { email: colleague.email, password: newPassword }, cookie: null }); assert.equal(ownLogin.status, 200); assert.equal(ownLogin.data.user.id, colleagueId);
    assert.equal((await app.sql.get('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?', workspaceId, ownerState.user.id)).role, 'owner');
    assert.equal((await request(team + '/members')).status, 200);

    const existingId = randomUUID(), ownerHash = (await app.sql.get('SELECT password FROM users WHERE id=?', ownerState.user.id)).password;
    await app.sql.run('INSERT INTO users VALUES(?,?,?,?)', existingId, 'Existing account', 'existing-colleague@example.test', ownerHash);
    const existingCookie = (await request('/api/auth/login', { method: 'POST', body: { email: 'existing-colleague@example.test', password: ownerPassword }, cookie: null })).cookie;
    const separate = await request('/api/workspaces', { method: 'POST', body: { name: 'Existing private workspace' }, cookie: existingCookie }); assert.equal(separate.status, 201);
    assert.equal((await request(`/api/state?projectId=${separate.data.projectId}`)).status, 404);
    assert.equal((await request(`/api/state?projectId=${separate.data.projectId}`, { cookie: colleagueCookie })).status, 404);
    const existingInvitation = await request(team + '/invitations', { method: 'POST', body: { email: 'existing-colleague@example.test', role: 'viewer' } });
    assert.equal(existingInvitation.status, 201); assert.notEqual(token(existingInvitation), inviteToken);
    const existingPath = '/api/invitations/' + token(existingInvitation), existingRead = await request(existingPath, { cookie: null });
    assert.equal(existingRead.status, 200); assert.equal(existingRead.data.accountExists, true); assert.equal(existingRead.data.requiresSignIn, true);
    assert.equal((await request(existingPath, { method: 'POST', body: { name: 'Reset attempt', password: newPassword }, cookie: null })).status, 401);
    assert.equal((await request(existingPath, { method: 'POST', body: {} })).status, 403);
    assert.equal((await request(existingPath, { method: 'POST', body: { password: newPassword }, cookie: existingCookie })).status, 400);
    assert.equal((await request(existingPath, { cookie: existingCookie })).data.requiresSignIn, false);
    const joinedExisting = await request(existingPath, { method: 'POST', body: {}, cookie: existingCookie });
    assert.equal(joinedExisting.status, 200); assert.equal(joinedExisting.data.created, false); assert.equal(joinedExisting.data.user.id, existingId); assert.equal(joinedExisting.data.role, 'viewer'); assert.equal(joinedExisting.cookie, undefined, 'Accepting with an existing identity does not mint a replacement session.');
    assert.equal((await app.sql.get('SELECT password FROM users WHERE id=?', existingId)).password, ownerHash);
    assert.equal((await app.sql.get('SELECT name FROM users WHERE id=?', existingId)).name, 'Existing account');
    assert.equal((await app.sql.get('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?', separate.data.workspace.id, existingId)).role, 'owner');
    const existingState = (await request(`/api/state?projectId=${projectId}`, { cookie: existingCookie })).data;
    assert.equal(existingState.workspaces.find(workspace => workspace.id === workspaceId).role, 'viewer');
    assert.equal((await request(`/api/projects/${projectId}/campaigns`, { method: 'POST', body: { name: 'Blocked viewer campaign' }, cookie: existingCookie })).status, 403);
    assert.equal((await request(existingPath, { method: 'POST', body: {}, cookie: existingCookie })).status, 410);
    const list = await request(team + '/invitations'); assert.equal(list.status, 200); assert.equal(list.data.invitations.filter(item => item.status === 'accepted').length, 2);
    assert.equal(JSON.stringify(list.data).includes(inviteToken), false); assert.equal(JSON.stringify(list.data).includes(token(existingInvitation)), false); assert.equal(JSON.stringify(list.data).includes('token_hash'), false);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'existing-colleague@example.test', password: newPassword }, cookie: null })).status, 401);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'existing-colleague@example.test', password: ownerPassword }, cookie: null })).status, 200);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP invitation links use #invite=, and inspect, accept and invitation sign-in start take the token in a POST body', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-invite-transport-')), origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, env: {}, appUrl: origin });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`; let ownerCookie;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, originHeader = origin } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(method !== 'GET' && originHeader ? { Origin: originHeader } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Workspace owner', email: 'transport-owner@example.test', password: 'fixture owner personal password' } }); setup.data.projectId = await firstProject(app, setup);
    assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const workspaceId = (await request('/api/state')).data.workspaces[0].id;
    const created = await request(`/api/workspaces/${workspaceId}/invitations`, { method: 'POST', body: { email: 'transport@example.test', role: 'editor' } }), link = new URL(created.data.url);
    assert.equal(created.status, 201); assert.equal(link.origin + link.pathname + link.search, origin + '/'); assert.match(link.hash, /^#invite=[A-Za-z0-9_-]{43}$/);
    const token = link.hash.slice('#invite='.length);
    assert.equal((await request('/api/invitations/inspect', { method: 'POST', body: { token }, cookie: null, originHeader: null })).status, 403, 'The body routes need the app origin like other POSTs.');
    const inspected = await request('/api/invitations/inspect', { method: 'POST', body: { token }, cookie: null });
    assert.equal(inspected.status, 200); assert.equal(inspected.data.invitation.email, 'transport@example.test');
    assert.equal((await request('/api/invitations/inspect', { cookie: null })).status, 404, 'Inspection by GET needs the token in the path.');
    // Invitation sign-in start answers with JSON (here: identity sign-in is not configured) instead of a redirect.
    const started = await request('/api/auth/oidc/start', { method: 'POST', body: { token }, cookie: null });
    assert.equal(started.status, 400); assert.equal(started.data.error, 'Identity sign-in is unavailable.');
    assert.equal((await request('/api/auth/oidc/start', { method: 'POST', body: { token, returnTo: 'https://other.example.test' }, cookie: null })).status, 400);
    assert.equal((await request('/api/auth/oidc/start', { method: 'POST', body: { token }, cookie: null, originHeader: 'https://other.example.test' })).status, 403);
    const accepted = await request('/api/invitations/accept', { method: 'POST', body: { token, name: 'Transport colleague', password: 'transport colleague password' }, cookie: null });
    assert.equal(accepted.status, 200); assert.equal(accepted.data.created, true); assert.equal(accepted.data.workspaceId, workspaceId); assert.ok(accepted.cookie);
    assert.equal((await request('/api/invitations/inspect', { method: 'POST', body: { token }, cookie: null })).status, 410);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
