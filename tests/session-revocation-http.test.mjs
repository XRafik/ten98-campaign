import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { postgresSkip, testApp } from './postgres.mjs';

test('revoked sessions cannot complete provider reads or imports, while accepted writes retain uncertain receipts', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-session-revocation-')), origin = 'http://127.0.0.1:3018';
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const app = await testApp(t, { dataDir, appUrl: origin, directScheduler: false, env: { ZERNIO_API_KEY: 'session-fixture-zernio-key', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'session-fixture@example.test', GOOGLE_PRIVATE_KEY: privateKey } });
  const originalFetch = globalThis.fetch; let pause, cookie, writes = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    if (url.origin === 'https://www.googleapis.com' && url.pathname === '/upload/drive/v3/files') {
      assert.equal(options.method, 'POST'); assert.match(options.headers['Content-Type'], /^multipart\/related; boundary=ten98-/);
      assert.ok(Buffer.isBuffer(options.body)); assert.ok(options.body.includes(Buffer.from('"parents":["session-folder"]'))); writes++;
    }
    if (pause?.pathname === url.pathname) { const waiting = pause; pause = undefined; waiting.started(); await waiting.wait; }
    if (url.origin === 'https://zernio.com' && url.pathname === '/api/v1/profiles') return Response.json({ profiles: [] });
    if (url.origin === 'https://zernio.com' && url.pathname === '/api/v1/accounts') return Response.json({ accounts: [{ _id: 'private-account', profileId: 'session-profile', platform: 'facebook' }] });
    if (url.origin === 'https://zernio.com' && url.pathname === '/api/v1/connect/facebook') return Response.json({ authUrl: 'https://provider.example.test/private-connect-url' });
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'session-fixture-access-token' });
    if (url.origin === 'https://www.googleapis.com' && url.pathname === '/drive/v3/files/session-folder') return Response.json({ id: 'session-folder', mimeType: 'application/vnd.google-apps.folder', driveId: 'shared-drive' });
    const file = { id: 'session-file', name: 'Private fixture image', mimeType: 'image/jpeg', webViewLink: 'https://drive.google.com/file/d/session-file/view', size: '100' };
    if (url.origin === 'https://www.googleapis.com' && url.pathname === '/drive/v3/files') return Response.json({ files: [file] });
    if (url.origin === 'https://www.googleapis.com' && url.pathname === '/upload/drive/v3/files') return Response.json(file);
    assert.fail(`Unexpected provider request: ${url}`);
  };
  let base; const password = 'session revocation fixture password';
  async function api(path, { method = 'GET', body, key, selected = cookie } = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, ...(selected ? { Cookie: selected } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function revokeDuring(pathname, action) {
    let started, release; const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const revoker = (await api('/auth/login', { method: 'POST', body: { email: 'session-fixture@example.test', password } })).cookie;
    pause = { pathname, started, wait }; const pending = action();
    try {
      await Promise.race([entered, new Promise((_, reject) => { setTimeout(() => reject(new Error('Expected provider boundary was not reached.')), 3000).unref(); })]);
      assert.equal((await api('/account/sessions/revoke', { method: 'POST', body: {}, selected: revoker })).status, 200);
    } finally { release(); cookie = revoker; }
    return pending;
  }
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${app.server.address().port}`;
    const setup = await api('/auth/setup', { method: 'POST', body: { name: 'Session fixture', email: 'session-fixture@example.test', password } }); cookie = setup.cookie; await api('/projects', { method: 'POST', body: { workspaceId: setup.data.workspaceId, name: 'Brand launch' } });
    const state = (await api('/state')).data, project = `/projects/${state.projectId}`;
    assert.equal((await api(project, { method: 'PATCH', body: { zernioProfileId: 'session-profile', driveFolderId: 'session-folder' } })).status, 200);
    assert.equal((await api('/settings/integrations/zernio/test', { method: 'POST', body: { projectId: state.projectId } })).data.ok, true);
    assert.equal((await api(project + '/integrations/accounts')).data.accounts[0]._id, 'private-account');
    for (const change of [
      { pathname: '/api/v1/connect/facebook', action: () => api(project + '/integrations/connect?platform=facebook'), remove: () => app.sql.run("UPDATE memberships SET role='viewer' WHERE workspace_id=? AND user_id=?", state.workspaces[0].id, state.user.id), restore: () => app.sql.run("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?", state.workspaces[0].id, state.user.id), forbidden: 'authUrl' },
      { pathname: '/api/v1/profiles', action: () => api('/settings/integrations/zernio/test', { method: 'POST', body: { projectId: state.projectId } }), remove: () => app.sql.run('DELETE FROM instance_operators WHERE user_id=?', state.user.id), restore: () => app.sql.run('INSERT INTO instance_operators VALUES(?)', state.user.id), forbidden: 'ok' },
    ]) {
      let started, release; const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
      pause = { pathname: change.pathname, started, wait }; const pending = change.action();
      try {
        await Promise.race([entered, new Promise((_, reject) => { setTimeout(() => reject(new Error('Expected permission-change boundary was not reached.')), 3000).unref(); })]);
        await change.remove(); release(); const denied = await pending;
        assert.equal(denied.status, 403); assert.equal(denied.data[change.forbidden], undefined);
      } finally { release(); await change.restore(); }
    }
    let result = await revokeDuring('/api/v1/profiles', () => api('/settings/integrations/zernio/test', { method: 'POST', body: { projectId: state.projectId } }));
    assert.equal(result.status, 403); assert.equal(result.data.ok, undefined);
    result = await revokeDuring('/api/v1/accounts', () => api(project + '/integrations/accounts'));
    assert.equal(result.status, 403); assert.equal(result.data.accounts, undefined);
    result = await revokeDuring('/drive/v3/files', () => api(project + '/integrations/drive/sync', { method: 'POST', body: {} }));
    assert.equal(result.status, 403); assert.equal((await app.store.list(state.projectId, 'assets')).length, 0);
    const upload = { name: 'Private fixture image', mimeType: 'image/jpeg', contentBase64: Buffer.from('synthetic image fixture').toString('base64') };
    result = await revokeDuring('/upload/drive/v3/files', () => api(project + '/integrations/drive/upload', { method: 'POST', body: upload, key: 'revoked-upload-original' }));
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(writes, 1);
    assert.equal((await app.sql.get('SELECT status FROM integration_operations WHERE id=? AND project_id=?', result.data.operation.id, state.projectId)).status, 'uncertain');
    assert.equal((await app.store.list(state.projectId, 'assets')).length, 0, 'A revoked session must not import provider results after the write.');
    const blocked = await api(project + '/integrations/drive/upload', { method: 'POST', body: upload, key: 'revoked-upload-fresh-key' });
    assert.equal(blocked.status, 409); assert.equal(writes, 1, 'A fresh session and action key cannot duplicate an unconfirmed external write.');
    const current = await api(project + '/integrations/drive/sync', { method: 'POST', body: {} });
    assert.equal(current.status, 200); assert.equal(current.data.synced, 1, 'A separate request with the current session can import provider data.');
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});
