import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashPassword } from '../server/auth.ts';
import { postgresSkip, testApp } from './postgres.mjs';

type Result = { status: number; data: any; cookie?: string };
const origin = 'http://127.0.0.1:3027', password = 'first project fixture password';

test('the first project may include the sample once, seeded only by an owner or administrator into that new project', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-first-project-')), app = await testApp(t, { dataDir, env: {}, appUrl: origin, directScheduler: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  async function request(path: string, cookie?: string, body?: unknown): Promise<Result> {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const sampleRecords = async (projectId: string) => (await Promise.all(['campaigns', 'posts', 'assets', 'providers', 'placements'].map(collection => app.store.list(projectId, collection)))).flat();
  async function member(email: string, role: string, workspaceId: string) {
    const id = 'member-' + role;
    await app.sql.run('INSERT INTO users VALUES (?, ?, ?, ?)', id, role, email, await hashPassword(password));
    await app.sql.run('INSERT INTO memberships VALUES (?, ?, ?)', workspaceId, id, role);
    return (await request('/auth/login', undefined, { email, password })).cookie!;
  }
  try {
    const setup = await request('/auth/setup', undefined, { name: 'Owner', email: 'owner@example.test', password, workspaceName: 'Owner team' });
    assert.equal(setup.status, 201); const owner = setup.cookie!, workspaceId = setup.data.workspaceId;
    assert.deepEqual((await request('/state', owner)).data.projects, [], 'Setup leaves the first project to the next step.');

    assert.equal((await request('/projects', owner, { workspaceId, name: 'Launch', sample: 'yes' })).status, 400);
    const seeded = await request('/projects', owner, { workspaceId, name: 'Launch', sample: true });
    assert.equal(seeded.status, 201, JSON.stringify(seeded.data));
    const records = await sampleRecords(seeded.data.project.id);
    assert.ok(records.length > 0); assert.ok(records.every(record => record.sample === true));
    assert.equal((await sampleRecords(seeded.data.project.id)).length, records.length, 'The sample is seeded once.');
    const state = (await request('/state?projectId=' + seeded.data.project.id, owner)).data;
    assert.deepEqual(state.projects.map((project: { name: string }) => project.name), ['Launch']);
    assert.equal(state.campaigns.filter((campaign: { sample?: boolean }) => campaign.sample).length, 3);
    assert.ok(state.activity.some((entry: { message: string; sample: boolean }) => entry.sample && /Sample campaign workspace created/.test(entry.message)));

    const plain = await request('/projects', owner, { workspaceId, name: 'Own work' });
    assert.equal(plain.status, 201); assert.deepEqual(await sampleRecords(plain.data.project.id), [], 'Without the opt-in a project starts empty.');

    const admin = await member('admin@example.test', 'admin', workspaceId), editor = await member('editor@example.test', 'editor', workspaceId), viewer = await member('viewer@example.test', 'viewer', workspaceId);
    const byAdmin = await request('/projects', admin, { workspaceId, name: 'Admin sample', sample: true });
    assert.equal(byAdmin.status, 201); assert.ok((await sampleRecords(byAdmin.data.project.id)).length > 0);
    const projectsBefore = (await app.sql.get('SELECT count(*) AS count FROM projects')).count;
    const byEditor = await request('/projects', editor, { workspaceId, name: 'Editor sample', sample: true });
    assert.equal(byEditor.status, 403); assert.match(byEditor.data.error, /owner or administrator/);
    assert.equal((await request('/projects', viewer, { workspaceId, name: 'Viewer sample', sample: true })).status, 404);
    assert.equal((await app.sql.get('SELECT count(*) AS count FROM projects')).count, projectsBefore, 'A refused sample creates no project.');
    assert.equal((await request('/projects', editor, { workspaceId, name: 'Editor work', sample: false })).status, 201, 'Editors still create empty projects.');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
