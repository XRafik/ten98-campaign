import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';

// After the PostgreSQL upgrade no session is carried over, so every browser arrives with a cookie that matches
// nothing. The session endpoint says so once, clears that cookie, and stays quiet for anyone else.
test('a stale session cookie is reported once as an ended session and cleared', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-session-ended-')), origin = 'http://127.0.0.1:3018';
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin, directScheduler: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, { body, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), setCookies: response.headers.getSetCookie() };
  };
  assert.equal((await request('/session')).data.sessionEnded, undefined, 'A first visit without a cookie is not an ended session.');
  const setup = await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'session ended fixture password' } });
  const cookie = setup.setCookies.map(value => value.split(';')[0]).join('; ');
  assert.equal((await request('/session', { cookie })).data.sessionEnded, undefined, 'A valid session is not reported as ended.');
  await app.sql.run('DELETE FROM sessions');
  const ended = await request('/session', { cookie });
  assert.equal(ended.status, 200); assert.equal(ended.data.user, null); assert.equal(ended.data.sessionEnded, true);
  assert.ok(ended.setCookies.some(value => /^ten98_session_[0-9a-f]{16}=;.*Max-Age=0/.test(value)), 'The stale cookie is cleared so the notice shows once.');
  assert.equal((await request('/session')).data.sessionEnded, undefined, 'Once the browser drops the cleared cookie, the notice does not return.');
  assert.equal((await request('/session', { cookie: 'ten98_session_0000000000000000=not-a-session-token' })).data.sessionEnded, undefined, 'A malformed cookie is not treated as a real ended session.');
});
