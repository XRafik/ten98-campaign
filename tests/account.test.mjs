import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { postgresSkip, testApp } from './postgres.mjs';

test('account updates, password changes, session revocation and host recovery preserve account boundaries', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-account-')), origin = 'http://127.0.0.1:3018';
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, initial = 'initial password for account checks', changed = 'changed password for account checks', recovered = 'recovered password for account checks';
  let cookie;
  async function api(path, method = 'GET', body, selected = cookie) {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, ...(selected ? { Cookie: selected } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    assert.equal((await api('/account')).status, 401);
    cookie = (await api('/auth/setup', 'POST', { name: 'Owner', email: 'account@example.test', password: initial })).cookie;
    const second = (await api('/auth/login', 'POST', { email: 'account@example.test', password: initial })).cookie;
    assert.equal((await api('/account')).data.activeSessions, 2);
    assert.equal((await api('/account', 'PATCH', { name: 'Updated owner' })).data.user.name, 'Updated owner');
    assert.equal((await api('/account', 'PATCH', { email: 'other@example.test' })).status, 400);
    assert.equal((await api('/account', 'PATCH', { name: '' })).status, 400);
    assert.equal((await api('/account/sessions/revoke', 'POST', {})).data.revoked, 1);
    assert.equal((await api('/account', 'GET', undefined, second)).status, 401);
    const third = (await api('/auth/login', 'POST', { email: 'account@example.test', password: initial })).cookie;
    assert.equal((await api('/account/password', 'POST', { currentPassword: 'wrong current password', newPassword: changed })).status, 400);
    assert.equal((await api('/account/password', 'POST', { currentPassword: initial, newPassword: 'short' })).status, 400);
    const updated = await api('/account/password', 'POST', { currentPassword: initial, newPassword: changed });
    assert.equal(updated.status, 200); assert.ok(updated.cookie);
    assert.equal((await api('/account')).status, 401); assert.equal((await api('/account', 'GET', undefined, third)).status, 401);
    cookie = updated.cookie; assert.equal((await api('/account')).data.localPassword, true);
    assert.equal((await api('/auth/login', 'POST', { email: 'account@example.test', password: initial })).status, 401);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['server/cli.ts', 'reset-password'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_URL: app.database.url }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, output }));
      child.stdin.end(JSON.stringify({ email: 'account@example.test', password: recovered }));
    });
    assert.equal(result.code, 0); assert.equal(result.output.includes(recovered), false);
    assert.equal((await api('/account')).status, 401);
    assert.equal((await api('/auth/login', 'POST', { email: 'account@example.test', password: recovered })).status, 200);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
