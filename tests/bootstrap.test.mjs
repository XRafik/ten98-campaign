import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { hashPassword } from '../server/auth.ts';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

const origin = 'http://127.0.0.1:3018';
async function start(app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
}
const count = async (pool, table) => (await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count;
const claimed = async pool => (await pool.query('SELECT claimed FROM installation WHERE id = 1')).rows[0].claimed;
async function failInserts(pool, table, message) {
  await pool.query(`CREATE FUNCTION fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$`);
  await pool.query(`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_${table}()`);
  return () => pool.query(`DROP TRIGGER fail_${table} ON ${table}; DROP FUNCTION fail_${table}()`);
}

test('the first sign-up claims the installation as owner of its named workspace, without a setup token or a project', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-bootstrap-')), { pool, db } = await testDatabase(t);
  const app = await createApp({ dataDir, env: { BOOTSTRAP_TOKEN: 'a'.repeat(48) }, appUrl: origin, directScheduler: false, database: { pool, db } });
  try {
    const request = await start(app), body = { name: 'Owner', email: 'owner@example.test', password: 'first sign-up fixture password' };
    assert.equal((await readdir(dataDir)).includes('bootstrap-token'), false, 'No setup token is generated or read.');
    assert.equal((await request('/session')).data.setupRequired, true);
    for (const workspaceName of [7, 'w'.repeat(121), 'line\u0001break']) assert.equal((await request('/auth/setup', { ...body, workspaceName })).status, 400);
    assert.equal((await request('/auth/setup', { ...body, password: 'too short' })).status, 400, 'The owner password policy still applies.');
    assert.equal(await count(pool, 'users'), 0);
    const created = await request('/auth/setup', { ...body, workspaceName: '  Northwind marketing  ' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const workspaces = (await pool.query('SELECT id, name FROM workspaces')).rows, user = (await pool.query('SELECT id FROM users')).rows[0];
    assert.deepEqual(workspaces, [{ id: created.data.workspaceId, name: 'Northwind marketing' }]);
    assert.deepEqual((await pool.query('SELECT workspace_id, user_id, role FROM memberships')).rows, [{ workspace_id: created.data.workspaceId, user_id: user.id, role: 'owner' }]);
    assert.equal(created.data.user.isOperator, true); assert.equal(await count(pool, 'instance_operators'), 1);
    assert.equal(await count(pool, 'projects'), 0, 'The first project is the next onboarding step, not part of setup.');
    assert.equal(created.data.projectId, undefined);
    assert.equal(await count(pool, 'sessions'), 1, 'The new owner is signed in.');
    assert.equal(await claimed(pool), true);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/setup', { ...body, email: 'second@example.test' })).status, 409, 'Sign-up closes once the installation is claimed.');
    assert.equal(await count(pool, 'users'), 1);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('an omitted or blank workspace name falls back to My workspace', { skip: postgresSkip }, async t => {
  for (const workspaceName of [undefined, '   ']) {
    const dataDir = await mkdtemp(join(tmpdir(), 'campaign-bootstrap-name-')), { pool, db } = await testDatabase(t);
    const app = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } });
    try {
      const request = await start(app);
      assert.equal((await request('/auth/setup', { name: 'Owner', email: 'owner@example.test', password: 'first sign-up fixture password', ...(workspaceName === undefined ? {} : { workspaceName }) })).status, 201);
      assert.deepEqual((await pool.query('SELECT name FROM workspaces')).rows, [{ name: 'My workspace' }]);
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
});

test('failed claims roll back, and of two competing first sign-ups exactly one claims the installation', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-bootstrap-race-')), { pool, db } = await testDatabase(t);
  // Two app processes on one database, as in a rolling restart.
  const first = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } }), second = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } });
  try {
    const request = await start(first), competing = await start(second);
    const body = { name: 'Owner', email: 'owner@example.test', password: 'first sign-up fixture password', workspaceName: 'Owner team' };
    const tables = ['users', 'instance_operators', 'instance_operator_audit', 'workspaces', 'memberships', 'sessions'];
    for (const table of ['instance_operator_audit', 'memberships']) {
      const restore = await failInserts(pool, table, 'synthetic setup failure');
      assert.equal((await request('/auth/setup', body)).status, 500);
      for (const name of tables) assert.equal(await count(pool, name), 0, `${name} rolled back after a ${table} failure`);
      assert.equal(await claimed(pool), false);
      await restore();
    }
    // Both sign-ups pass the unlocked pre-check; only the installation row lock stops the second from also claiming.
    const gate = await blockWrites(pool, 'users');
    const results = Promise.all([request('/auth/setup', body), competing('/auth/setup', { ...body, email: 'other@example.test', workspaceName: 'Other team' })]);
    await gate.waiting(2); await gate.release();
    const settled = await results;
    assert.deepEqual(settled.map(result => result.status).sort(), [201, 409]);
    for (const table of ['users', 'instance_operators', 'workspaces', 'memberships', 'sessions']) assert.equal(await count(pool, table), 1);
    const winner = settled.find(result => result.status === 201).data;
    assert.deepEqual((await pool.query('SELECT id, email FROM users')).rows, [{ id: winner.user.id, email: winner.user.email }]);
    const audit = (await pool.query('SELECT user_id, action, source FROM instance_operator_audit')).rows;
    assert.deepEqual(audit, [{ user_id: winner.user.id, action: 'bootstrap', source: 'bootstrap' }]);
    assert.equal(await claimed(pool), true);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await competing('/auth/setup', { ...body, email: 'late@example.test' })).status, 409);
  } finally { await second.close(); await first.close(); await rm(dataDir, { recursive: true, force: true }); }
});

// A claimed installation must keep login working and never reopen setup.
test('claimed installations preserve login, invent no operator history, and never reopen setup after account deletion', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-existing-')), password = 'existing installation password', { pool, db } = await testDatabase(t);
  await pool.query('INSERT INTO users VALUES ($1, $2, $3, $4)', ['existing', 'Existing owner', 'existing@example.test', await hashPassword(password)]);
  await pool.query('UPDATE installation SET claimed = true');
  let app;
  try {
    app = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } });
    let request = await start(app);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/login', { email: 'existing@example.test', password })).status, 200);
    assert.equal(await count(pool, 'instance_operator_audit'), 0, 'Upgrading an installation must not invent operator history.');
    assert.equal((await request('/auth/setup', { name: 'Uninvited', email: 'new@example.test', password })).status, 409);
    await pool.query('DELETE FROM users'); await app.close(); app = undefined;
    app = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } }); request = await start(app);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/setup', { name: 'Uninvited', email: 'new@example.test', password })).status, 409);
  } finally { await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
