import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';

test('platform drafts keep metadata and explicit resets, protect DAM references, and enforce request schemas', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-platform-records-')), origin = 'http://127.0.0.1:3000';
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; let cookie;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/auth/setup', 'POST', { name: 'Platform QA', email: 'variants@example.test', password: 'a long platform fixture password' }); cookie = setup.cookie; await request('/projects', 'POST', { workspaceId: setup.body.workspaceId, name: 'Brand launch' });
    const state = (await request('/state')).body, path = `/projects/${state.projectId}`;
    const asset = (await request(path + '/assets', 'POST', { name: 'Platform artwork', kind: 'image', url: 'https://cdn.example.com/art.jpg' })).body.record;
    const otherProject = (await request('/projects', 'POST', { name: 'Other project', workspaceId: state.workspaces[0].id })).body.project;
    const foreign = (await request(`/projects/${otherProject.id}/assets`, 'POST', { name: 'Private artwork', kind: 'image', url: 'https://cdn.example.com/private.jpg' })).body.record;
    let response = await request(path + '/posts', 'POST', { content: '', platforms: ['facebook', 'twitter'], mediaItems: null, platformOverrides: { facebook: { content: 'A longer caption', assetId: asset.id }, twitter: { content: 'A short caption', mediaItems: [], options: { madeWithAi: false } } } });
    assert.equal(response.status, 201, JSON.stringify(response.body)); const post = response.body.record;
    assert.equal(post.content, ''); assert.equal(post.mediaItems, null); assert.deepEqual(post.platformOverrides.twitter.mediaItems, []);
    assert.equal((await request(path + '/assets/' + asset.id, 'DELETE')).status, 409, 'A platform-only asset reference must prevent deletion.');
    response = await request(path + '/posts/' + post.id, 'PATCH', { platformOverrides: { facebook: { assetId: foreign.id } } });
    assert.equal(response.status, 400, 'Platform assets must belong to this project.');
    response = await request(path + '/posts/' + post.id, 'PATCH', { mediaItems: [{ type: 'video', url: 'https://cdn.example.com/video.mp4', width: 1080, height: 1920, duration: 30, size: 2000000, mimeType: 'video/mp4', thumbnail: 'https://cdn.example.com/cover.jpg' }], platformOverrides: {} });
    assert.equal(response.status, 200); assert.equal(response.body.record.mediaItems[0].width, 1080); assert.equal(response.body.record.mediaItems[0].size, 2000000);
    response = await request(path + '/posts/' + post.id, 'PATCH', { mediaItems: null, assetId: asset.id });
    assert.equal(response.status, 200); assert.equal(response.body.record.mediaItems, null, 'Switching from URLs back to DAM must clear prior media.');
    await request(path + '/posts/' + post.id, 'PATCH', { assetId: '' });
    assert.equal((await request(path + '/assets/' + asset.id, 'DELETE')).status, 200);
    for (const fields of [{ platformOverrides: [] }, { platformOverrides: { invented: {} } }, { platformOverrides: { facebook: { source: 'provider' } } }, { platformOverrides: { twitter: { options: { replySettings: 'invalid-choice' } } } }, { platformOverrides: { instagram: { mediaItems: [{ type: 'image', url: 'https://127.1/secret' }] } } }, { mediaItems: [{ type: 'video', url: 'https://cdn.example.com/v.mp4', width: -1 }] }]) {
      assert.equal((await request(path + '/posts', 'POST', { content: 'Draft', platforms: ['facebook'], ...fields })).status, 400, JSON.stringify(fields));
    }
    response = await request(path + '/posts', 'POST', { content: 'x'.repeat(70000), platforms: ['facebook'] });
    assert.equal(response.status, 201, 'Long or incomplete drafts can be saved; publishing enforces destination restrictions.');
    assert.equal((await request(path + '/posts', 'POST', { content: 'x'.repeat(2 * 1024 * 1024), platforms: ['facebook'] })).status, 413);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
