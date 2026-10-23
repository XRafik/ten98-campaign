import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { postgresSkip, testApp } from './postgres.mjs';

test('AI ad suggestions stay private, reviewable and unsubmitted until the user completes the ad builder', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-ai-ads-')), origin = 'http://127.0.0.1:3018';
  const app = await testApp(t, { dataDir, appUrl: origin, env: { OPENROUTER_API_KEY: 'synthetic-ai-key', OPENROUTER_MODEL: 'test/model' }, directScheduler: false }), localFetch = globalThis.fetch;
  const draft = { name: 'Search launch', platform: 'google', format: 'search', headline: 'A clear next step', body: 'Explore our services today.', linkUrl: 'https://example.test/services', additionalHeadlines: ['Made for your team', 'Start with a conversation'], additionalDescriptions: ['Get the details and choose what works.'], keywords: ['team services'] };
  let calls = 0, cookie;
  globalThis.fetch = async (target, options) => {
    if (new URL(target).hostname === '127.0.0.1') return localFetch(target, options);
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions', 'Generating or opening an ad proposal must never call an advertising provider.');
    calls++; const payload = JSON.parse(options.body);
    assert.ok(payload.tools.find(tool => tool.function.name === 'propose_draft').function.parameters.properties.collection.enum.includes('ads'));
    const tool = (id, fields) => ({ id, type: 'function', function: { name: 'propose_draft', arguments: JSON.stringify({ collection: 'ads', fields }) } });
    return Response.json({ choices: [{ message: calls === 1 ? { role: 'assistant', content: null, tool_calls: [tool('safe-ad', draft), tool('spend-without-review', { ...draft, budgetAmount: 1000 }), tool('private-url', { ...draft, imageUrl: 'http://127.0.0.1/secret' })] } : { role: 'assistant', content: 'Review the creative, account and budget in the ad builder.' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });
  };
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
    async function api(path, method = 'GET', body, key = 'ai-ad-draft-round5') {
      const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; return { status: response.status, data: await response.json() };
    }
    const setup = await api('/auth/setup', 'POST', { name: 'Ad studio', email: 'ai-ads@example.test', password: 'synthetic ai ad fixture password' }), projectId = (await api('/projects', 'POST', { workspaceId: setup.data.workspaceId, name: 'Brand launch' }, 'ai-ad-draft-first-project')).data.project.id, path = `/projects/${projectId}/agent`;
    const generated = await api(path + '/run', 'POST', { message: 'Suggest a Google Search ad for our services.' });
    assert.equal(generated.status, 200, JSON.stringify(generated.data)); assert.equal(calls, 2); assert.equal(generated.data.run.actions.length, 1);
    const action = generated.data.run.actions[0]; assert.equal(action.collection, 'ads'); assert.deepEqual(action.data, draft);
    assert.deepEqual(await app.store.list(projectId, 'campaigns'), []); assert.equal(generated.data.run.usage.cost, 0.002);
    for (let attempt = 0; attempt < 2; attempt++) { const opened = await api(`${path}/actions/${action.id}/apply`, 'POST', {}); assert.equal(opened.status, 200); assert.deepEqual(opened.data.adDraft, draft); }
    assert.deepEqual(await app.store.list(projectId, 'campaigns'), []); assert.equal(calls, 2, 'Opening a saved suggestion cannot bill another model call.');
    const foreign = (await app.sql.get('SELECT id FROM users')).id;
    await app.sql.run("UPDATE memberships SET role='viewer' WHERE user_id=?", foreign);
    assert.equal((await api(`${path}/actions/${action.id}/apply`, 'POST', {})).status, 403);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = localFetch; await rm(dataDir, { recursive: true, force: true }); }
});

test('the actual AI suggestion handler opens ad review without saving a campaign or applying stale results', async () => {
  const source = await readFile(new URL('../src/CampaignAgent.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function applyDraft('), handler = source.slice(start, source.indexOf('  return <', start));
  const opened = [], saved = [], active = { current: true }, context = { path: '/projects/p/agent', active, run: work => work(), request: async () => ({ adDraft: { platform: 'openai', name: 'Suggested card' } }), onOpenAdDraft: value => opened.push(value), history: async () => {}, onSaved: value => saved.push(value) };
  const apply = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
  await apply({ id: 'ad-action', collection: 'ads' }); assert.equal(opened[0].platform, 'openai'); assert.deepEqual(saved, []);
  active.current = false; await apply({ id: 'old-action', collection: 'ads' }); assert.equal(opened.length, 1);
});
