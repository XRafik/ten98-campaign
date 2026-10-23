import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setInstanceOperator } from '../server/instance-operators.ts';
import { blockWrites, postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const pg = { skip: postgresSkip };
const cli = fileURLToPath(new URL('../server/cli.ts', import.meta.url));
function runCli(url, command, input) {
  // Honor explicit source-control preloads in the CLI child as well as the test process.
  const preloads = process.execArgv.flatMap((value, index, values) => value === '--import' ? [value, values[index + 1]] : []);
  return spawnSync(process.execPath, [...preloads, cli, command], { input: JSON.stringify(input), env: { DATABASE_URL: url }, encoding: 'utf8', timeout: 120000 });
}
const seed = pool => pool.query("INSERT INTO users VALUES ('owner','Owner','owner@example.test','preserved-owner-hash'),('member','Member','member@example.test','preserved-member-hash'); INSERT INTO instance_operators VALUES ('owner'); INSERT INTO workspaces (id, name) VALUES ('workspace','Workspace'); INSERT INTO memberships VALUES ('workspace','owner','owner'),('workspace','member','editor')");
const history = async pool => (await pool.query('SELECT * FROM instance_operator_audit ORDER BY created_at, id')).rows;
async function failInserts(pool, table) {
  await pool.query(`CREATE FUNCTION fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_${table}()`);
  return () => pool.query(`DROP TRIGGER fail_${table} ON ${table}; DROP FUNCTION fail_${table}()`);
}

test('native host CLI persists command audits including idempotent repeats while preserving upgrade identities without invented history', pg, async t => {
  const { pool, url } = await testDatabase(t);
  await seed(pool);
  assert.equal((await pool.query('SELECT user_id FROM instance_operators')).rows[0].user_id, 'owner');
  let result = runCli(url, 'grant-operator', { email: 'member@example.test' }); assert.equal(result.status, 0, result.stderr);
  assert.equal((await pool.query("SELECT user_id FROM instance_operators WHERE user_id = 'member'")).rows[0]?.user_id, 'member', 'The native host grant must actually persist operator authority.');
  let rows = await history(pool); assert.equal(rows.length, 1, 'Pre-upgrade grants must not acquire invented audit events.');
  assert.equal(rows[0].user_id, 'member'); assert.equal(rows[0].action, 'grant'); assert.equal(rows[0].source, 'host'); assert(Number.isSafeInteger(rows[0].created_at));
  const first = rows[0];
  for (const email of ['member@example.test', 'owner@example.test']) assert.equal(runCli(url, 'grant-operator', { email }).status, 0);
  assert.equal((await history(pool)).length, 3, 'Every successful host invocation records its command, including an already granted role.');
  assert.equal(runCli(url, 'revoke-operator', { email: 'member@example.test' }).status, 0);
  assert.equal(runCli(url, 'revoke-operator', { email: 'member@example.test' }).status, 0);
  assert.deepEqual((await history(pool)).map(row => row.action), ['grant', 'grant', 'grant', 'revoke', 'revoke']); assert.deepEqual((await history(pool))[0], first);
  assert.equal(runCli(url, 'revoke-operator', { email: 'owner@example.test' }).status, 0, 'Host recovery permits revoking the final operator.');
  assert.equal((await pool.query('SELECT count(*) AS count FROM instance_operators')).rows[0].count, 0);
  assert.equal(runCli(url, 'grant-operator', { email: 'owner@example.test' }).status, 0);
  rows = await history(pool);
  assert.deepEqual(rows.map(row => row.action), ['grant', 'grant', 'grant', 'revoke', 'revoke', 'revoke', 'grant']); assert.deepEqual(rows[0], first);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.deepEqual((await pool.query('SELECT id, password FROM users ORDER BY id')).rows, [{ id: 'member', password: 'preserved-member-hash' }, { id: 'owner', password: 'preserved-owner-hash' }]);
  assert.deepEqual((await pool.query('SELECT user_id, role FROM memberships ORDER BY user_id')).rows, [{ user_id: 'member', role: 'editor' }, { user_id: 'owner', role: 'owner' }]);
});

test('native CLI audit insertion failure rolls back grants and revocations and fails no-op commands atomically', pg, async t => {
  const { pool, url } = await testDatabase(t);
  await seed(pool); const restore = await failInserts(pool, 'instance_operator_audit');
  assert.equal(runCli(url, 'grant-operator', { email: 'member@example.test' }).status, 1);
  assert.equal((await pool.query("SELECT user_id FROM instance_operators WHERE user_id = 'member'")).rowCount, 0);
  assert.equal(runCli(url, 'revoke-operator', { email: 'owner@example.test' }).status, 1);
  assert.equal((await pool.query("SELECT user_id FROM instance_operators WHERE user_id = 'owner'")).rows[0].user_id, 'owner');
  assert.equal(runCli(url, 'grant-operator', { email: 'owner@example.test' }).status, 1);
  assert.equal(runCli(url, 'revoke-operator', { email: 'member@example.test' }).status, 1);
  assert.equal((await history(pool)).length, 0);
  await restore();
  assert.equal(runCli(url, 'grant-operator', { email: 'member@example.test' }).status, 0); assert.equal((await history(pool)).length, 1);
});

test('parallel host grants change authority once and audit every command; a grant and revoke race leaves audit and state agreeing', pg, async t => {
  const { pool, db } = await testDatabase(t);
  await seed(pool);
  const grant = enabled => db.transaction(tx => setInstanceOperator(tx, 'member', enabled, 'host'));
  // Idempotency comes from ON CONFLICT DO NOTHING; the user row lock serialises the commands behind the blocked first one.
  let gate = await blockWrites(pool, 'instance_operators');
  const grants = Array.from({ length: 5 }, () => grant(true));
  await gate.waiting(5); await gate.release();
  assert.deepEqual((await Promise.all(grants)).filter(Boolean).length, 1);
  assert.equal((await pool.query("SELECT count(*) AS count FROM instance_operators WHERE user_id = 'member'")).rows[0].count, 1);
  assert.equal((await history(pool)).length, 5);
  await pool.query("DELETE FROM instance_operators WHERE user_id = 'member'; DELETE FROM instance_operator_audit");
  // Without the user row lock the revoke cannot see the uncommitted grant, deletes nothing, and still audits a revoke last.
  // The grant inserts first and blocks on its audit row; the revoke then starts and audits after it.
  gate = await blockWrites(pool, 'instance_operator_audit');
  const granting = grant(true); await gate.waiting(1); await new Promise(resolve => setTimeout(resolve, 5));
  const revoking = grant(false); await gate.waiting(2); await gate.release(); await Promise.all([granting, revoking]);
  const rows = await history(pool), operator = (await pool.query("SELECT 1 FROM instance_operators WHERE user_id = 'member'")).rowCount === 1;
  assert.equal(rows.length, 2); assert.equal(rows.at(-1).action === 'grant', operator, 'The last audited command must match the final authority.');
  await assert.rejects(db.transaction(tx => setInstanceOperator(tx, 'missing-user', true, 'host')), /does not exist/);
});

test('native HTTP sessions observe host revocation immediately, retain workspace boundaries and preserve stdin account recovery', pg, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-operator-http-')), origin = 'http://127.0.0.1:3018';
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, appUrl: origin, env: {}, directScheduler: false }), { pool, url } = app.database;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  async function request(path, { body, cookie } = {}) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  const password = 'owner fixture original password', nextPassword = 'owner fixture replacement password';
  const setup = await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password } }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201);
  const cookie = setup.cookie, state = (await request('/state', { cookie })).data;
  assert.equal(runCli(url, 'revoke-operator', { email: 'owner@example.test' }).status, 0);
  assert.equal((await request('/session', { cookie })).data.user.isOperator, false); assert.equal((await request('/settings/integrations', { cookie })).status, 403);
  assert.equal((await pool.query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [state.workspaces[0].id, setup.data.user.id])).rows[0].role, 'owner');
  assert.equal(runCli(url, 'grant-operator', { email: 'owner@example.test' }).status, 0);
  assert.equal((await request('/session', { cookie })).data.user.isOperator, true); assert.equal((await request('/settings/integrations', { cookie })).status, 200);
  const memberPassword = 'member stdin fixture password';
  const created = runCli(url, 'create-user', { name: 'Member', email: 'member@example.test', password: memberPassword }); assert.equal(created.status, 0, created.stderr); assert.equal((created.stdout + created.stderr).includes(memberPassword), false);
  assert.equal(runCli(url, 'grant-operator', { email: 'member@example.test' }).status, 0);
  const member = await request('/auth/login', { body: { email: 'member@example.test', password: memberPassword } }); assert.equal(member.status, 200);
  assert.equal((await request('/state?projectId=' + state.projectId, { cookie: member.cookie })).status, 404, 'Operator authority must not grant workspace membership.');
  const count = (await history(pool)).length, reset = runCli(url, 'reset-password', { email: 'owner@example.test', password: nextPassword }); assert.equal(reset.status, 0, reset.stderr); assert.equal((reset.stdout + reset.stderr).includes(nextPassword), false);
  assert.equal((await request('/session', { cookie })).data.user, null);
  assert.equal((await request('/auth/login', { body: { email: 'owner@example.test', password } })).status, 401);
  assert.equal((await request('/auth/login', { body: { email: 'owner@example.test', password: nextPassword } })).status, 200);
  assert.equal((await history(pool)).length, count, 'Password recovery must not invent an operator change.');
});
