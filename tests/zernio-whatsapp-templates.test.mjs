import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioWhatsAppTemplates, templateComponents } from '../server/zernio-whatsapp-templates.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const profileId = 'profile-a', wabaId = '1234567890';
const form = () => ({ headerFormat: 'text', headerText: 'Hello {{1}}', headerExamples: ['Ana'], headerMediaUrl: '', bodyText: 'Your order {{1}} is ready.', bodyExamples: ['ORDER-123'], footerText: 'Contact our team for help', buttons: [{ type: 'url', text: 'View order', url: 'https://example.com/orders/{{1}}', phoneNumber: '', example: 'ORDER-123' }] });
const createBody = () => ({ accountId: 'wa-a', expectedWabaId: wabaId, name: 'order_ready', category: 'UTILITY', language: 'en', form: form(), ttlSeconds: 3600, confirmSubmission: true });
const pg = { skip: postgresSkip };
async function setup(t) {
  const { db, sql } = await testDatabase(t);
  await sql.run("INSERT INTO users (id, name, email, password) VALUES ('operator-a', 'Operator', 'operator-a@example.test', NULL)"); await sql.run("INSERT INTO instance_operators (user_id) VALUES ('operator-a')");
  const calls = [], state = {
    accounts: [{ _id: 'wa-a', profileId, platform: 'whatsapp', displayName: 'Campaign support', isActive: true, metadata: { wabaId } }, { _id: 'wa-b', profileId: 'profile-b', platform: 'whatsapp', isActive: true, metadata: { wabaId } }, { _id: 'outside', profileId: 'elsewhere', platform: 'whatsapp', metadata: { wabaId: '99999' } }, { _id: 'social', profileId, platform: 'facebook' }],
    templates: [{ id: '1001', name: 'existing_order', language: 'en', category: 'UTILITY', status: 'APPROVED', components: templateComponents(form()), secret: 'never-return' }, { id: '1002', name: 'existing_order', language: 'es', category: 'UTILITY', status: 'REJECTED', rejected_reason: 'Add a clearer example', components: [{ type: 'body', text: 'Hola' }] }],
    library: { name: 'account_confirmation', language: 'en_US', category: 'UTILITY', body: 'Your account is ready.', body_params: [], availableLanguages: ['en_US', 'es'], buttons: [{ type: 'URL', text: 'View account' }] },
    malformed: false, readFail: false, writeCount: 0, staleRead: false, pendingDeletion: false, hold: null,
  };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query: structuredClone(query), body: structuredClone(body), key, method });
    if (method === 'GET') {
      if (state.readFail && state.writeCount && path !== '/accounts') throw new IntegrationError(502, 'READ_FAILED', 'Readback unavailable');
      if (path === '/accounts') { await state.onAccounts?.(); return { accounts: structuredClone(state.accounts) }; }
      if (path === '/whatsapp/template-library') return { template: structuredClone(state.library) };
      if (path === '/whatsapp/templates') return { success: true, templates: structuredClone(state.templates.filter(row => !query.status || row.status === query.status)) };
      const row = state.templates.find(row => path === `/whatsapp/templates/id/${row.id}`);
      if (!row) throw new IntegrationError(404, 'NOT_FOUND', 'Template not found');
      return { success: true, template: structuredClone(row) };
    }
    state.writeCount++; state.onWrite?.(); if (state.hold) await state.hold;
    if (method === 'POST') {
      assert.equal(path, '/whatsapp/templates');
      let components = structuredClone(body.components);
      if (body.library_template_name) components = [{ type: 'body', text: state.library.body }, { type: 'buttons', buttons: state.library.buttons.map((button, index) => ({ type: button.type.toLowerCase(), text: button.text, ...(button.type === 'URL' ? { url: body.library_template_button_inputs[index].url.base_url } : {}) })) }];
      const row = { id: String(2000 + state.writeCount), name: body.name, language: body.language, category: body.category, status: body.library_template_name ? 'APPROVED' : 'PENDING', components, ...(body.message_send_ttl_seconds !== undefined && body.message_send_ttl_seconds !== -1 ? { message_send_ttl_seconds: body.message_send_ttl_seconds } : {}) };
      if (!state.staleRead) state.templates.push(row); return state.malformed ? {} : { success: true, template: structuredClone(row) };
    }
    const row = state.templates.find(row => path === `/whatsapp/templates/id/${row.id}`); assert.ok(row);
    if (method === 'PATCH') {
      if (!state.staleRead) { if (body.components) { row.components = structuredClone(body.components); row.status = 'PENDING'; } if (body.message_send_ttl_seconds !== undefined) row.message_send_ttl_seconds = body.message_send_ttl_seconds; }
      return state.malformed ? {} : { success: true, template: { id: row.id, name: row.name, language: row.language, status: row.status } };
    }
    assert.equal(method, 'DELETE'); if (!state.staleRead) { if (state.pendingDeletion) row.status = 'PENDING_DELETION'; else state.templates.splice(state.templates.indexOf(row), 1); }
    return state.malformed ? {} : { success: true, scope: 'language', language: row.language };
  };
  let count = 0;
  async function request(action, { body, role = 'owner', operator = false, key = `whatsapp-template-${++count}`, projectId = 'project-a', mappedProfile = profileId, query = '', assertAccess } = {}) {
    let response;
    const context = { db, project: { id: projectId, zernioProfileId: mappedProfile }, user: { id: 'operator-a', isOperator: operator }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${projectId}/integrations/whatsapp-templates/${action}${query}`), body: body || {}, assertProjectMapping: () => assertAccess?.(), send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioWhatsAppTemplates(context, api, mappedProfile, action); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  const read = async (id = '1001', options = {}) => (await request(`templates/${id}`, { ...options, query: '?accountId=wa-a' })).data.template;
  const change = (template, extra = {}) => ({ accountId: 'wa-a', expectedWabaId: wabaId, expectedVersion: template.version, ...extra });
  return { db, sql, calls, state, api, request, read, change };
}

test('WhatsApp templates expose all statuses and exact variants without foreign accounts or unknown provider fields', pg, async t => {
  const { sql, state, request, read } = await setup(t);
  const overview = await request('overview', { role: 'viewer' }); assert.deepEqual(overview.data.accounts.map(row => row.id), ['wa-a']);
  const result = await request('templates', { query: '?accountId=wa-a' }); assert.equal(result.status, 200); assert.equal(result.data.templates.length, 2); assert.equal(result.data.templates[0].managedHere, false); assert.equal(result.data.templates[0].canReviewShared, false); assert.equal(JSON.stringify(result).includes('never-return'), false);
  assert.equal((await request('templates', { query: '?accountId=outside' })).status, 403); assert.equal((await request('templates', { query: '?accountId=social' })).status, 422); assert.equal((await request('templates', { query: '?accountId=wa-a&status=BAD' })).status, 400);
  assert.equal((await request('templates', { query: '?accountId=wa-a&status=REJECTED' })).data.templates[0].language, 'es'); assert.equal((await read('1002')).rejectedReason, 'Add a clearer example');
  state.templates[0].components = [{ type: 'carousel', cards: [{ private: 'content one' }] }]; const first = await read(); assert.equal(first.form, null); assert.equal(JSON.stringify(first).includes('content one'), false);
  state.templates[0].components[0].cards[0].private = 'content two'; assert.notEqual((await read()).version, first.version);
});

test('positional template creation, owned edits, TTL-only edits and exact deletion round trip with durable receipts', pg, async t => {
  const { sql, state, calls, request, read, change } = await setup(t);
  const body = createBody(); let result = await request('templates/create', { body, key: 'create-order-key' }); assert.equal(result.status, 200); const created = result.data.template; assert.equal(created.managedHere, true); assert.equal(created.status, 'PENDING'); assert.equal(created.ttlSeconds, 3600);
  assert.deepEqual((await request('templates/create', { body, key: 'create-order-key' })).data, result.data); assert.equal(state.writeCount, 1);
  state.templates.find(row => row.id === created.id).status = 'APPROVED'; let current = await read(created.id);
  result = await request(`templates/${created.id}/update`, { operator: true, body: change(current, { ttlSeconds: 7200, reviewSharedWabaId: wabaId, confirmTemplateId: created.id }) }); assert.equal(result.status, 200); assert.equal(result.data.template.status, 'APPROVED'); assert.equal(result.data.template.ttlSeconds, 7200);
  const edited = form(); edited.bodyText = 'Your revised order {{1}} is ready.';
  result = await request(`templates/${created.id}/update`, { operator: true, body: change(result.data.template, { form: edited, reviewSharedWabaId: wabaId, confirmTemplateId: created.id }) }); assert.equal(result.status, 200); assert.equal(result.data.template.status, 'PENDING'); assert.equal(result.data.template.form.bodyText, edited.bodyText);
  current = result.data.template; result = await request(`templates/${created.id}/delete`, { operator: true, body: change(current, { confirmTemplateId: created.id, reviewSharedWabaId: wabaId }) }); assert.equal(result.status, 200); assert.equal(result.data.deleted, true); assert.equal(state.templates.some(row => row.id === created.id), false); assert.ok(state.templates.some(row => row.id === '1002')); assert.ok(calls.filter(row => row.method !== 'GET').every(row => row.key));
});

test('external and cross-project templates require current instance operator authority and explicit shared WABA review', pg, async t => {
  const { sql, state, request, read, change } = await setup(t);
  const current = await read(); const body = change(current, { ttlSeconds: 3600 });
  assert.equal((await request('templates/1001/update', { body })).status, 403); assert.equal((await request('templates/1001/update', { body, operator: true })).status, 403);
  const reviewed = { ...body, reviewSharedWabaId: wabaId, confirmTemplateId: '1001' };
  assert.equal((await request('templates/1001/update', { body: reviewed, operator: true, role: 'editor' })).status, 403);
  await sql.run('INSERT INTO zernio_whatsapp_template_ownership (waba_id, template_id, project_id, profile_id) VALUES (?,?,?,?)', wabaId, '1001', 'another-project', 'another-profile');
  assert.equal((await request('templates/1001/update', { body: reviewed })).status, 403); assert.equal(state.writeCount, 0);
  let result = await request('templates/1001/update', { body: reviewed, operator: true }); assert.equal(result.status, 200); assert.equal(result.data.template.managedHere, false);
  await sql.run('DELETE FROM instance_operators'); result = await request('templates/1001/update', { body: change(result.data.template, { ttlSeconds: 4000, reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }), operator: true }); assert.equal(result.status, 403); assert.equal(state.writeCount, 1);
});

test('local creation provenance cannot bypass operator review of a business-account template used across profiles', pg, async t => {
  const { sql, state, calls, request, read, change } = await setup(t);
  assert.ok(state.accounts.some(account => account.profileId !== profileId && account.metadata?.wabaId === wabaId));
  const created = (await request('templates/create', { body: createBody() })).data.template; assert.equal(created.managedHere, true);
  state.templates.find(template => template.id === created.id).status = 'APPROVED';
  let current = await read(created.id), body = change(current, { ttlSeconds: 7200 });
  assert.equal((await request(`templates/${created.id}/update`, { body })).status, 403);
  assert.equal((await request(`templates/${created.id}/update`, { operator: true, body })).status, 403);
  const reviewed = { ...body, reviewSharedWabaId: wabaId, confirmTemplateId: created.id };
  assert.equal((await request(`templates/${created.id}/update`, { body: reviewed })).status, 403);
  assert.equal(state.writeCount, 1);
  const saved = await request(`templates/${created.id}/update`, { operator: true, body: reviewed }); assert.equal(saved.status, 200); assert.equal(saved.data.template.managedHere, true);
  current = saved.data.template; body = change(current, { confirmTemplateId: created.id });
  assert.equal((await request(`templates/${created.id}/delete`, { body })).status, 403);
  assert.equal((await request(`templates/${created.id}/delete`, { operator: true, body })).status, 403);
  assert.equal((await request(`templates/${created.id}/delete`, { operator: true, body: { ...body, reviewSharedWabaId: wabaId } })).status, 200);
  assert.ok(calls.filter(call => call.path === '/accounts').every(call => Object.keys(call.query).length === 1 && typeof call.query.profileId === 'string'), 'No global account census or foreign identity read is needed.');
});

test('snapshots, connection changes, roles, supported content and delivery-window boundaries fail before writes', pg, async t => {
  const { sql, state, request, read, change } = await setup(t);
  const current = await read(); state.templates[0].components[1].text = 'Changed elsewhere';
  assert.equal((await request('templates/1001/update', { body: change(current, { ttlSeconds: 3600, reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }), operator: true })).status, 409);
  for (const body of [{ ...createBody(), expectedWabaId: 'other' }, { ...createBody(), confirmSubmission: false }, { ...createBody(), category: 'AUTHENTICATION' }, { ...createBody(), ttlSeconds: 43201 }, { ...createBody(), form: { ...form(), bodyText: 'Hi {{customer}}' } }, { ...createBody(), form: { ...form(), bodyExamples: [] } }, { ...createBody(), form: { ...form(), headerMediaUrl: 'http://localhost/x', headerFormat: 'image' } }]) assert.ok([400, 409].includes((await request('templates/create', { body })).status));
  for (const role of ['viewer', 'editor']) assert.equal((await request('templates/create', { body: createBody(), role })).status, 403);
  assert.equal((await request('templates/create', { body: { ...createBody(), category: 'MARKETING', ttlSeconds: 43200, form: { ...form(), buttons: [] } } })).status, 200);
  state.accounts[0].isActive = false; assert.equal((await request('templates/create', { body: { ...createBody(), name: 'inactive' } })).status, 409);
  assert.equal(state.writeCount, 1);
});

test('lost or malformed acknowledgements and unreadable readbacks stay uncertain and cannot replay with another key', pg, async t => {
  for (const failure of ['malformed', 'readFail', 'staleRead']) {
    const { sql, state, request } = await setup(t);
    state[failure] = true; const body = createBody(), result = await request('templates/create', { body, key: 'uncertain-create-key' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal((await request('templates/create', { body, key: 'uncertain-create-key' })).status, 409); assert.equal((await request('templates/create', { body, key: 'another-create-key' })).status, 409); const blocked = await request('templates/create', { body: { ...body, name: 'changed_after_unknown' } }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(state.writeCount, 1);
    await sql.run("UPDATE integration_operations SET status='reviewed-not_applied' WHERE request_key=?", 'uncertain-create-key'); state[failure] = false; assert.equal((await request('templates/create', { body: { ...body, name: 'reviewed_new_template' } })).status, 200);
  }
  const { sql, state, request, read, change } = await setup(t);
  const current = await read(); state.staleRead = true; const result = await request('templates/1001/update', { operator: true, body: change(current, { ttlSeconds: 3600, reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }) }); assert.equal(result.data.operation.status, 'uncertain');
});

test('variant deletion accepts the provider grace period and never removes another language', pg, async t => {
  const { sql, state, request, read, change } = await setup(t);
  state.pendingDeletion = true; const current = await read();
  assert.equal((await request('templates/1001/delete', { operator: true, body: change(current, { reviewSharedWabaId: wabaId }) })).status, 403);
  const result = await request('templates/1001/delete', { operator: true, body: change(current, { reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }) }); assert.equal(result.status, 200); assert.equal(state.templates[0].status, 'PENDING_DELETION'); assert.equal(state.templates[1].status, 'REJECTED');
});

test('exact library lookup reviews returned language, input order and current structure before importing', pg, async t => {
  const { sql, state, request } = await setup(t);
  let result = await request('library', { query: '?accountId=wa-a&name=account_confirmation&language=es' }); const source = result.data.library; assert.equal(source.language, 'en_US');
  const body = { accountId: 'wa-a', expectedWabaId: wabaId, name: 'imported_confirmation', language: source.language, libraryName: source.name, expectedLibraryVersion: source.version, buttonInputs: [{ type: 'url', url: 'https://example.com/account' }], confirmSubmission: true };
  assert.equal((await request('templates/import', { body: { ...body, language: 'es' } })).status, 409);
  assert.equal((await request('templates/import', { body: { ...body, buttonInputs: [] } })).status, 400);
  result = await request('templates/import', { body }); assert.equal(result.status, 200); assert.equal(result.data.template.status, 'APPROVED'); assert.equal(result.data.template.managedHere, true); assert.equal(result.data.template.form.buttons[0].url, 'https://example.com/account');
  state.library.buttons[0].type = 'FLOW'; const advanced = (await request('library', { query: '?accountId=wa-a&name=account_confirmation&language=en_US' })).data.library; assert.equal(advanced.importable, false); assert.equal((await request('templates/import', { body: { ...body, name: 'advanced_confirmation', expectedLibraryVersion: advanced.version } })).status, 422);
  state.library = null; assert.equal((await request('library', { query: '?accountId=wa-a&name=not_found&language=en' })).data.library, null); assert.equal(state.writeCount, 1);
});

test('shared WABA locks cover different projects and permission revocation is rechecked before dispatch', pg, async t => {
  const { sql, state, request, read, change } = await setup(t); let release;
  try {
    const current = await read(); state.hold = new Promise(resolve => { release = resolve; });
    const first = request('templates/1001/update', { operator: true, body: change(current, { ttlSeconds: 3600, reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }) });
    // Bounded: if the first request fails before its provider write, fail here instead of waiting forever.
    let settled = false; first.finally(() => { settled = true; });
    for (const deadline = Date.now() + 10000; !state.writeCount && !settled;) { assert.ok(Date.now() < deadline, 'The first template write did not start.'); await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.equal(state.writeCount, 1, JSON.stringify(settled && await first));
    const second = await request('templates/1001/delete', { operator: true, projectId: 'project-b', mappedProfile: 'profile-b', body: { ...change(current, { reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }), accountId: 'wa-b' } }); assert.equal(second.status, 409); assert.equal(second.data.error.code, 'WHATSAPP_BUSINESS_BUSY'); assert.equal(state.writeCount, 1);
    release(); state.hold = null; assert.equal((await first).status, 200);
    let reads = 0; state.onAccounts = () => { if (++reads === 3) return sql.run('DELETE FROM instance_operators'); };
    const fresh = await read(); reads = 0; const result = await request('templates/1001/update', { operator: true, body: change(fresh, { ttlSeconds: 4000, reviewSharedWabaId: wabaId, confirmTemplateId: '1001' }) }); assert.equal(result.status, 403); assert.equal(state.writeCount, 1);
  } finally { release?.(); }
});

test('typed content leaves one canonical provider payload and rejects invalid examples and unsafe button URLs', () => {
  const valid = form(); valid.headerFormat = 'image'; valid.headerMediaUrl = 'https://example.com/header.jpg'; const components = templateComponents(valid); assert.deepEqual(components[0].example.header_handle, ['https://example.com/header.jpg']); assert.equal(components[1].example.body_text[0][0], 'ORDER-123');
  for (const patch of [{ bodyText: 'Missing {{2}}' }, { headerFormat: 'text', headerText: '{{1}} and {{2}}' }, { footerText: '{{1}}' }, { buttons: [{ ...valid.buttons[0], url: 'https://{{1}}.example.com/x' }] }, { buttons: [{ ...valid.buttons[0], type: 'flow' }] }, { buttons: [{ ...valid.buttons[0], type: 'phone_number', phoneNumber: '123' }] }]) assert.throws(() => templateComponents({ ...valid, ...patch }), IntegrationError);
});

test('template write helper retains uncertain keys, validates receipts and ignores departed views', async () => {
  const source = await readFile(new URL('../src/ZernioWhatsAppTemplates.tsx', import.meta.url), 'utf8'), helper = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  const shared =')));
  const keys = { current: new Map() }, calls = []; let active = true, sequence = 0, failure, response = { operation: { status: 'complete' }, template: { id: '2001', name: 'order_ready', language: 'en', version: 'v1', wabaId } };
  const context = { current: () => active, path: '/projects/a/integrations/whatsapp-templates', keys, crypto: { randomUUID: () => `stable-template-key-${++sequence}` }, requester: { current: async (...args) => { calls.push(args); if (failure) throw Object.assign(new Error('Request failed'), failure); return response; } } };
  const write = new Function(...Object.keys(context), `return (${helper});`)(...Object.values(context)), body = createBody();
  for (const receipt of [{ status: 502 }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, operation: { status: 'pending' } }, { status: 400, operation: { status: 'uncertain' } }]) {
    failure = receipt; await assert.rejects(write('templates/create', body)); const key = calls.at(-1)[3]; assert.equal(keys.current.size, 1); failure = null; await write('templates/create', body); assert.equal(calls.at(-1)[3], key); assert.equal(keys.current.size, 0);
  }
  response = { operation: { status: 'complete' }, template: { id: '2001', name: 'wrong', language: 'en', version: 'v1', wabaId } }; await assert.rejects(write('templates/create', body), /receipt/); assert.equal(keys.current.size, 1);
  failure = { status: 400, code: 'INVALID_TEMPLATE' }; await assert.rejects(write('templates/create', body)); assert.equal(keys.current.size, 0); failure = null; active = false; await assert.rejects(write('templates/create', body), { name: 'AbortError' });
  const identitySource = stripTypeScriptTypes(source.slice(source.indexOf('  const path ='), source.indexOf('  useEffect(')));
  const identify = (projectId, accountId, canManage, isOperator, scope) => new Function('projectId', 'accountId', 'canManage', 'isOperator', 'scope', 'requester', 'request', 'active', 'status', 'accounts', 'selected', 'sharedReviewed', `${identitySource}; return current;`)(projectId, accountId, canManage, isOperator, scope, {}, () => {}, { current: true }, '', [], null, false);
  const scope = { current: { identity: '' } }, first = identify('a', 'wa-a', true, true, scope), second = identify('b', 'wa-b', true, true, scope); assert.equal(first(), false); assert.equal(second(), true); const third = identify('a', 'wa-a', true, true, scope); assert.equal(first(), false); assert.equal(third(), true); const viewer = identify('a', 'wa-a', false, true, scope); assert.equal(third(), false); assert.equal(viewer(), true);
});

test('template editor renders ordinary fields, reviewer examples and escaped previews', async () => {
  const source = await readFile(new URL('../src/ZernioWhatsAppTemplates.tsx', import.meta.url), 'utf8'), preview = source.slice(source.indexOf('const positions ='), source.indexOf('\nexport default function'));
  const { code } = await transformWithOxc(preview.replace('export function TemplateContentEditor', 'function TemplateContentEditor'), 'TemplateEditor.tsx', { jsx: { runtime: 'classic' } });
  const ui = await import('@ten98/ui'), editor = new Function('React', 'WhatsAppTemplate', ...Object.keys(ui), `${code}; return TemplateContentEditor;`)(React, ({ template }) => React.createElement('p', {}, template.components.find(row => row.type === 'BODY').text), ...Object.values(ui));
  const value = form(); value.bodyText = '<script>alert(1)</script> {{1}}'; const html = renderToStaticMarkup(React.createElement(editor, { form: value, onChange() {} })); assert.match(html, /Reviewer examples and preview/); assert.match(html, /Header text/); assert.match(html, /Website URL/); assert.match(html, /&lt;script&gt;/); for (const raw of ['<script>', 'JSON', 'API payload']) assert.ok(!html.includes(raw), raw);
});

test('template UI requires inline operator review even when this project created the variant', async () => {
  const source = await readFile(new URL('../src/ZernioWhatsAppTemplates.tsx', import.meta.url), 'utf8');
  const selectionLine = source.split('\n').find(line => line.includes('const account = accounts.find'));
  const eligible = new Function('selected', 'accounts', 'accountId', 'canManage', 'isOperator', 'sharedReviewed', `${stripTypeScriptTypes(selectionLine)}; return canWrite && scopeReviewed;`);
  const selected = { id: '2001', managedHere: true, canReviewShared: true }, accounts = [{ id: 'wa-a', wabaId, isActive: true }];
  assert.equal(eligible(selected, accounts, 'wa-a', true, false, false), false);
  assert.equal(eligible(selected, accounts, 'wa-a', true, true, false), false);
  assert.equal(eligible(selected, accounts, 'wa-a', true, true, true), true);
  assert.equal(eligible(selected, accounts, 'wa-a', false, true, true), false);
  const sharedCode = source.slice(source.indexOf('  const shared ='), source.indexOf('  async function save('));
  const reviewed = new Function('selected', 'sharedReviewed', 'wabaId', `${stripTypeScriptTypes(sharedCode)}; return shared();`)(selected, true, wabaId);
  assert.deepEqual(reviewed, { reviewSharedWabaId: wabaId, confirmTemplateId: '2001' });
  assert.doesNotMatch(source, /canWrite && !selected\.managedHere/); assert.match(source, /including templates created here/);
});

test('authenticated HTTP template workflows enforce project routing, CSRF, ownership and uncertain retry protection', pg, async t => {
  const upstream = await setup(t), originalFetch = globalThis.fetch, dataDir = await mkdtemp(join(tmpdir(), 'ten98-wa-templates-'));
  const app = await testApp(t, { dataDir, env: { ZERNIO_API_KEY: 'synthetic-template-key' }, appUrl: 'https://templates.example.test', directScheduler: false }); let origin, cookie;
  globalThis.fetch = async (target, options = {}) => {
    const targetUrl = new URL(target); if (targetUrl.origin === origin) return originalFetch(target, options);
    assert.equal(targetUrl.origin, 'https://zernio.com'); assert.equal(options.redirect, 'error');
    const body = options.body ? JSON.parse(options.body) : undefined;
    try { return Response.json(await upstream.api(targetUrl.pathname.slice('/api/v1'.length), Object.fromEntries(targetUrl.searchParams), body, options.headers['Idempotency-Key'], options.method)); }
    catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
  };
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (path, method = 'GET', body, key = 'http-template-key-' + Math.random(), csrf = true) => {
      const response = await originalFetch(origin + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { Origin: 'https://templates.example.test' } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; return { status: response.status, data: await response.json() };
    };
    const created = await request('/api/auth/setup', 'POST', { name: 'Template QA owner', email: 'templates-qa@example.test', password: 'Synthetic template passphrase 2026!' }); created.data.projectId = await firstProject(app, created, { cookie }); assert.equal(created.status, 201);
    const projectId = created.data.projectId; assert.equal((await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: profileId })).status, 200); const path = `/api/projects/${projectId}/integrations/whatsapp-templates`;
    assert.equal((await request(path + '/overview')).data.accounts[0].id, 'wa-a');
    assert.equal((await request(path + '/templates/create', 'POST', createBody(), 'csrf-template-key', false)).status, 403); assert.equal(upstream.state.writeCount, 0);
    let result = await request(path + '/templates/create', 'POST', createBody(), 'http-create-template'); assert.equal(result.status, 200); assert.equal(result.data.template.managedHere, true);
    assert.equal((await request(path + '/templates/create', 'POST', createBody(), 'http-create-template')).status, 200); assert.equal(upstream.state.writeCount, 1);
    let template = result.data.template; upstream.state.templates.find(row => row.id === template.id).status = 'APPROVED'; template = (await request(path + `/templates/${template.id}?accountId=wa-a`)).data.template;
    result = await request(path + `/templates/${template.id}/update`, 'POST', upstream.change(template, { ttlSeconds: 5000, reviewSharedWabaId: wabaId, confirmTemplateId: template.id })); assert.equal(result.status, 200); assert.equal(result.data.template.ttlSeconds, 5000);
    template = result.data.template;
    result = await request(path + `/templates/${template.id}/delete`, 'POST', upstream.change(template, { confirmTemplateId: template.id, reviewSharedWabaId: wabaId })); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.deleted, true); assert.equal(upstream.state.templates.some(row => row.id === template.id), false); assert.ok(upstream.state.templates.some(row => row.id === '1002'));
    const otherProject = await request('/api/projects', 'POST', { workspaceId: (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id, name: 'Other template project' }); assert.equal(otherProject.status, 201);
    assert.equal((await request(`/api/projects/${otherProject.data.project.id}/integrations/whatsapp-templates/templates?accountId=wa-a`)).status, 409);
    upstream.state.malformed = true; const changed = { ...createBody(), name: 'uncertain_order' }; result = await request(path + '/templates/create', 'POST', changed, 'http-uncertain-template'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal((await request(path + '/templates/create', 'POST', changed, 'http-uncertain-template-again')).status, 409); const blocked = await request(path + '/templates/create', 'POST', { ...changed, name: 'changed_http_retry' }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(upstream.state.writeCount, 4);
  } finally {
    globalThis.fetch = originalFetch; assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep)); await rm(dataDir, { recursive: true, force: true });
  }
});
