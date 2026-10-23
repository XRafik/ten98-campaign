import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import React from 'react';
import * as ui from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioContacts } from '../server/zernio-contacts.ts';
import { createContacts } from '../server/contacts.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { postgresSkip, testDatabase, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const pg = { skip: postgresSkip };
const profileId = 'profile-a', id = value => String(value).padStart(24, '0');
// Stubbed Zernio transport; state.writes counts every non-GET call that reached the provider.
function provider() {
  const calls = [], record = (value, profile = profileId, linked = []) => ({ id: id(value), profileId: profile, name: 'Provider customer ' + value, email: `provider${value}@example.test`, company: 'Provider company', avatarUrl: '', tags: ['provider'], notes: 'Project notes', isSubscribed: false, isBlocked: false, customFields: {}, channels: linked });
  const channel = (value, accountId = 'wa-a', phone = '12025550101', platform = 'whatsapp') => ({ id: id(value), accountId, platform, platformIdentifier: phone, displayIdentifier: '+' + phone, isSubscribed: false });
  const state = { accounts: [{ _id: 'wa-a', profileId, platform: 'whatsapp', isActive: true, displayName: 'Project WhatsApp' }, { _id: 'sms-a', profileId, platform: 'sms', isActive: true }, { _id: 'fb-a', profileId, platform: 'facebook', isActive: true }, { _id: 'wa-foreign', profileId: 'foreign-profile', platform: 'whatsapp', isActive: true }], rows: [record(1, profileId, [channel(101)]), record(2, profileId, [channel(102), channel(103, 'wa-foreign', '12025559999')]), record(3, 'foreign-profile', [channel(104)]), record(4, 'foreign-profile', [channel(105, 'wa-foreign')]), record(5)], fields: [{ id: id(801), profileId, name: 'Plan', slug: 'plan', type: 'select', options: ['Basic', 'Pro'] }], counter: 1000, writes: 0, malformed: false, readFail: false, unchanged: false, rejectPhones: new Set(), hold: null };
  state.rows[1].channels[0].platformIdentifier = '12025550111'; state.rows[2].channels[0].platformIdentifier = '12025550112';
  state.rows[1].notes = 'Foreign-private-notes'; state.rows[2].company = 'Foreign-private-company';
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query: structuredClone(query), body: structuredClone(body), key, method });
    if (method === 'GET') {
      await state.onRead?.(path, query);
      if (state.readFail && state.writes && path !== '/accounts') throw new IntegrationError(502, 'READ_FAILED', 'Readback failed');
      if (path === '/accounts') return { accounts: structuredClone(state.accounts) };
      if (path === '/contacts') {
        const rows = state.rows.filter(row => query.accountId ? row.channels.some(channel => channel.accountId === query.accountId) : row.profileId === query.profileId).filter(row => (!query.search || [row.name, row.email, row.company].some(value => value.toLowerCase().includes(query.search.toLowerCase()))) && (!query.tag || row.tags.includes(query.tag)) && (!query.platform || row.channels.some(channel => channel.platform === query.platform)) && (!query.isSubscribed || row.isSubscribed === (query.isSubscribed === 'true'))), skip = Number(query.skip || 0), limit = Number(query.limit || 25);
        return { success: true, contacts: rows.slice(skip, skip + limit).map(row => ({ ...structuredClone(row), ...(query.accountId ? { platformIdentifier: row.channels.find(channel => channel.accountId === query.accountId).platformIdentifier } : {}) })), filters: { tags: ['Foreign-secret-suggestion'] }, pagination: { total: rows.length, limit, skip, hasMore: skip + limit < rows.length } };
      }
      if (path === '/custom-fields') return { success: true, fields: structuredClone(state.fields.filter(row => row.profileId === query.profileId)) };
      const match = /^\/contacts\/([a-f0-9]{24})(\/channels)?$/.exec(path), row = match && state.rows.find(row => row.id === match[1]); if (!row) throw new IntegrationError(404, 'NOT_FOUND', 'Contact not found');
      return match[2] ? { success: true, channels: structuredClone(row.channels) } : { success: true, contact: structuredClone(row), channels: structuredClone(row.channels) };
    }
    state.writes++; await state.onWrite?.(path, body); if (state.hold) await state.hold;
    if (path === '/contacts' && method === 'POST') {
      const row = { id: id(++state.counter), ...structuredClone(body), avatarUrl: '', notes: '', customFields: {}, isBlocked: false, channels: body.accountId ? [{ id: id(++state.counter), accountId: body.accountId, platform: body.platform, platformIdentifier: body.platformIdentifier.replace(/^\+/, ''), displayIdentifier: body.displayIdentifier, isSubscribed: body.isSubscribed }] : [] }; state.rows.push(row);
      return state.malformed ? {} : { success: true, contact: structuredClone(row), ...(row.channels.length ? { channel: structuredClone(row.channels[0]) } : {}) };
    }
    if (path === '/contacts/bulk') {
      let created = 0, skipped = 0; const errors = [];
      for (const input of body.contacts) {
        if (state.rejectPhones.has(input.platformIdentifier)) { errors.push('Provider rejected this synthetic row'); continue; }
        if (state.rows.some(row => row.channels.some(channel => channel.accountId === body.accountId && channel.platformIdentifier === input.platformIdentifier.replace(/^\+/, '')))) { skipped++; continue; }
        const row = { ...record(++state.counter), ...input, profileId: body.profileId, isSubscribed: true, channels: [{ id: id(++state.counter), accountId: body.accountId, platform: body.platform, platformIdentifier: input.platformIdentifier.replace(/^\+/, ''), displayIdentifier: input.platformIdentifier, isSubscribed: true }] }; state.rows.push(row); created++;
      }
      return state.malformed ? {} : { success: true, created, skipped, total: body.contacts.length, errors };
    }
    if (path === '/custom-fields') { const row = { id: id(++state.counter), ...body }; state.fields.push(row); return state.malformed ? {} : { success: true, field: structuredClone(row) }; }
    const definition = state.fields.find(row => path === '/custom-fields/' + row.id);
    if (definition) { if (method === 'DELETE') { if (!state.unchanged) { state.fields.splice(state.fields.indexOf(definition), 1); for (const row of state.rows) delete row.customFields[definition.slug]; } return {}; } if (!state.unchanged) Object.assign(definition, body); return state.malformed ? {} : { success: true, field: structuredClone(definition) }; }
    const match = /^\/contacts\/([a-f0-9]{24})(?:\/fields\/([^/]+))?$/.exec(path), row = state.rows.find(row => row.id === match?.[1]); assert.ok(row, path);
    if (match[2]) { if (!state.unchanged) { if (method === 'DELETE') delete row.customFields[match[2]]; else row.customFields[match[2]] = body.value; } return {}; }
    if (method === 'DELETE') { if (!state.unchanged) state.rows.splice(state.rows.indexOf(row), 1); return {}; }
    if (!state.unchanged) Object.assign(row, structuredClone(body)); return state.malformed ? {} : { success: true, contact: structuredClone(row) };
  };
  return { state, calls, api };
}

async function setup(t) {
  const { db, pool, sql } = await testDatabase(t);
  await pool.query("INSERT INTO workspaces (id, name) VALUES ('w', 'Fixture'); INSERT INTO projects (id, workspace_id, name) VALUES ('project-a', 'w', 'Project A'), ('project-b', 'w', 'Project B'); INSERT INTO users (id, name, email, password) VALUES ('operator-a', 'Operator', 'operator-a@example.test', NULL); INSERT INTO instance_operators (user_id) VALUES ('operator-a')");
  const contacts = createContacts({ db }), local = await contacts.save('project-a', { name: 'Reviewed customer', email: 'customer@example.test', phone: '+12025550101', company: 'Own company', tags: ['vip'], consents: { whatsapp: true, sms: true }, consentSource: 'Explicit synthetic opt-in' }), second = await contacts.save('project-a', { name: 'Second customer', phone: '+12025550102', consents: { whatsapp: true }, consentSource: 'Explicit synthetic opt-in' });
  const { state, calls, api } = provider();
  let count = 0;
  async function request(action, { body, query = '', role = 'owner', operator = false, key = `contact-action-${++count}`, assertAccess, localService = contacts } = {}) {
    let response; const context = { db, contacts: localService, project: { id: 'project-a', zernioProfileId: profileId }, user: { id: 'operator-a', isOperator: operator }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, body: body || {}, url: new URL(`http://localhost/api/projects/project-a/integrations/contacts/${action}${query}`), assertProjectMapping: () => assertAccess?.(), send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioContacts(context, api, profileId, action); return response || { handled }; } catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code } } }; }
  }
  const overview = async () => (await request('overview')).data;
  const read = async (contactId = id(1), accountId = '') => (await request('contacts/' + contactId, { query: '?accountId=' + accountId })).data.contact;
  const change = (contact, extra = {}) => ({ accountId: '', expectedVersion: contact.version, confirmed: true, ...extra });
  return { sql, contacts, local, second, state, calls, api, request, overview, read, change };
}

test('contact browsing proves profile/account origin, sanitizes foreign channels and masks mixed metadata', pg, async t => {
  const { request, read, calls } = await setup(t);
  const result = await request('contacts', { role: 'viewer' }); assert.equal(result.status, 200); assert.equal(result.data.contacts.length, 3); assert.equal(result.data.contacts[0].exclusive, true);
  const shared = await read(id(2)); assert.equal(shared.exclusive, false); assert.equal(shared.metadataMasked, true); assert.equal(shared.channels.length, 1); assert.equal(shared.notes, undefined); assert.equal(JSON.stringify(shared).includes('wa-foreign'), false);
  const external = await read(id(3), 'wa-a'); assert.equal(external.originHere, false); assert.equal(external.metadataMasked, true); assert.equal(JSON.stringify(external).includes('Foreign-private-company'), false);
  const start = calls.length; assert.equal((await request('contacts/' + id(4))).status, 403); assert.ok(calls.slice(start).every(call => call.path !== '/contacts/' + id(4)));
  assert.equal((await request('contacts', { query: '?accountId=wa-foreign' })).status, 403); assert.equal((await request('contacts', { query: '?search=customer%201&limit=1' })).data.contacts.length, 1);
  const first = await request('contacts', { query: '?limit=1' }); assert.equal(first.data.pagination.hasMore, true); assert.equal((await request('contacts', { query: '?limit=1&skip=1' })).data.contacts[0].id, id(2));
  assert.ok(calls.filter(call => call.path === '/contacts').every(call => call.query.profileId === profileId));
});

test('contact filters return only current visible matches and private counts without changing local permission', pg, async t => {
  const { sql, contacts, state, request, calls } = await setup(t);
  const before = await contacts.list('project-a'); state.rows[0].tags = ['vip']; state.rows[0].isSubscribed = true;
  state.rows.push({ ...structuredClone(state.rows[0]), id: id(6), name: 'Provider customer 6' });
  const query = '?accountId=wa-a&search=Provider%20customer&platform=whatsapp&isSubscribed=true&tag=vip&limit=1';
  let result = await request('contacts', { query, role: 'viewer' }); assert.equal(result.status, 200); assert.deepEqual(result.data.contacts.map(row => row.id), [id(1)]); assert.deepEqual(result.data.pagination, { total: 2, limit: 1, skip: 0, hasMore: true });
  assert.equal(JSON.stringify(result.data).includes('Foreign-secret-suggestion'), false);
  result = await request('contacts', { query: query + '&skip=1', role: 'viewer' }); assert.deepEqual(result.data.contacts.map(row => row.id), [id(6)]); assert.equal(result.data.pagination.hasMore, false);
  for (const hiddenTags of [['vip'], ['different']]) {
    state.rows[1].tags = hiddenTags; state.rows[2].tags = hiddenTags; state.rows[1].isSubscribed = true; state.rows[2].isSubscribed = true;
    result = await request('contacts', { query, role: 'viewer' }); assert.equal(result.data.pagination.total, 2); assert.deepEqual(result.data.contacts.map(row => row.id), [id(1)]);
  }
  assert.ok(calls.filter(call => call.path === '/contacts').every(call => call.query.profileId === profileId && !['search', 'tag', 'platform', 'isSubscribed'].some(key => key in call.query)));
  assert.ok(calls.some(call => call.path === '/contacts' && call.query.accountId === 'wa-a' && call.query.limit === 200));
  state.rows[0].isSubscribed = undefined; state.rows[1].channels[1].platform = 'sms';
  result = await request('contacts', { query: '?platform=sms', role: 'viewer' }); assert.equal(result.data.pagination.total, 0);
  result = await request('contacts', { query: '?accountId=wa-a&isSubscribed=false', role: 'viewer' }); assert.equal(result.data.contacts.some(row => row.id === id(1)), false);
  result = await request('contacts', { query: '?accountId=wa-a&tag=missing', role: 'viewer' }); assert.equal(result.data.pagination.total, 0);
  assert.equal(state.writes, 0); assert.deepEqual(await contacts.list('project-a'), before); assert.equal((await sql.get('SELECT count(*) AS total FROM zernio_contact_links')).total, 0);
});

test('contact filter validation rejects ambiguous values and account or mapping changes leave no result', pg, async t => {
  const { state, request, calls } = await setup(t);
  for (const query of ['?platform=imessage', '?isSubscribed=False', '?tag=' + 'x'.repeat(201), '?search=x&search=y', '?platform=whatsapp&platform=sms', '?tags=vip', '?limit=0', '?skip=-1', '?tag=%00']) {
    const start = calls.length, result = await request('contacts', { query }); assert.equal(result.status, 400, query); assert.ok(calls.slice(start).every(call => call.path !== '/contacts'));
  }
  assert.equal((await request('contacts', { query: '?accountId=wa-foreign&tag=vip' })).status, 403);
  let reads = 0; state.onRead = path => { if (path === '/accounts' && ++reads === 2) state.accounts[0].profileId = 'moved-profile'; };
  let result = await request('contacts', { query: '?isSubscribed=false' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'CONTACT_SCOPE_CHANGED'); assert.equal(result.data.contacts, undefined);
  state.accounts[0].profileId = profileId; let changed = false; state.onRead = path => { if (path.startsWith('/contacts/')) changed = true; };
  result = await request('contacts', { query: '?isSubscribed=false', assertAccess: () => { if (changed) throw new IntegrationError(403, 'ROLE_CHANGED', 'Role changed'); } }); assert.equal(result.status, 403); assert.equal(result.data.contacts, undefined);
});

test('contact filtering hydrates the actual 10,000-contact scope once before matching and rejects 10,001 before details', pg, async t => {
  const { state, request, calls } = await setup(t);
  const template = { ...state.rows[0], channels: [], tags: [] };
  state.rows = Array.from({ length: 10000 }, (_, index) => ({ ...template, id: id(index + 10000), name: 'Contact ' + index, tags: index === 0 ? ['vip'] : [] }));
  let result = await request('contacts', { query: '?tag=vip' }); assert.equal(result.status, 200); assert.equal(result.data.pagination.total, 1);
  assert.equal(calls.filter(call => call.path === '/contacts').length, 100); assert.ok(calls.every(call => !call.query.tag)); const details = calls.filter(call => /^\/contacts\//.test(call.path)); assert.equal(details.length, 10000); assert.equal(new Set(details.map(call => call.path)).size, 10000);
  state.rows.push({ ...template, id: id(20000) });
  for (const tag of ['vip', 'absent']) {
    const start = calls.length; result = await request('contacts', { query: '?tag=' + tag }); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'CONTACT_WINDOW_INCOMPLETE'); assert.equal(result.data.contacts, undefined); assert.equal(result.data.pagination, undefined);
    const run = calls.slice(start); assert.equal(run.filter(call => call.path === '/contacts').length, 50); assert.ok(run.every(call => !call.query.tag && !/^\/contacts\//.test(call.path)));
  }
});

test('contact scans recheck origin membership after hydration and reject duplicate base pages', pg, async t => {
  const { state, request } = await setup(t);
  state.onRead = path => { if (path === '/contacts/' + id(1)) { state.rows[0].profileId = 'different-origin'; state.onRead = null; } };
  let result = await request('contacts', { query: '?tag=new' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'CONTACT_SCOPE_CHANGED'); assert.equal(result.data.contacts, undefined);
  const template = state.rows[0]; state.rows = Array.from({ length: 201 }, (_, index) => ({ ...structuredClone(template), profileId, id: id(index + 1000) }));
  state.onRead = (path, query) => { if (path === '/contacts' && query.skip === 200) state.rows[200].id = state.rows[0].id; };
  result = await request('contacts', { query: '?isSubscribed=false' }); assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_CONTACT_RESPONSE'); assert.equal(result.data.pagination, undefined);
});

test('hidden metadata cannot select provider requests or turn shared detail failures into a tag oracle', pg, async t => {
  const { state, request, calls } = await setup(t);
  state.rows[1].tags = ['secret']; state.onRead = path => { if (path === '/contacts/' + id(2)) throw new IntegrationError(502, 'SHARED_DETAIL_UNAVAILABLE', 'Contact details are unavailable.'); };
  let sequence, unavailable;
  for (const query of ['?tag=secret', '?tag=absent', '']) {
    const start = calls.length, result = await request('contacts', { query, role: 'viewer' }), run = calls.slice(start);
    assert.equal(result.status, 502); assert.equal(result.data.contacts, undefined); assert.equal(result.data.pagination, undefined);
    if (sequence) { assert.deepEqual(run, sequence); assert.deepEqual(result, unavailable); } else { sequence = run; unavailable = result; }
  }
  state.onRead = null; sequence = undefined;
  for (const tags of [['secret'], ['absent'], []]) {
    state.rows[1].tags = tags; state.rows[1].name = tags.join(' '); state.rows[1].company = tags.join(' ');
    for (const query of ['?tag=secret', '?tag=absent', '?search=secret', '?platform=whatsapp', '?isSubscribed=false', '']) {
      const start = calls.length, result = await request('contacts', { query, role: 'viewer' }), run = calls.slice(start); assert.equal(result.status, 200);
      if (sequence) assert.deepEqual(run, sequence); else sequence = run;
      if (query.startsWith('?tag=') || query.startsWith('?search=')) assert.equal(result.data.pagination.total, 0);
    }
  }
  assert.equal(state.writes, 0);
});

test('reviewed contact linking is local, phone-exact, versioned and does not infer consent', pg, async t => {
  const { contacts, local, second, request, read, overview, change, state } = await setup(t);
  const provider = await read(), channel = provider.channels[0], localRow = (await overview()).localContacts.find(row => row.id === local.id), body = change(provider, { localContactId: local.id, expectedLocalVersion: localRow.version, channelId: channel.id, expectedChannelVersion: channel.version });
  let result = await request(`contacts/${provider.id}/link`, { body, role: 'editor', key: 'link-exact-phone' }); assert.equal(result.status, 200); assert.equal(result.data.contact.links[0].localContactId, local.id); assert.equal(state.writes, 0); assert.deepEqual((await contacts.get('project-a', local.id)).consents, local.consents);
  assert.deepEqual((await request(`contacts/${provider.id}/link`, { body, role: 'editor', key: 'link-exact-phone' })).data, result.data);
  const wrong = (await overview()).localContacts.find(row => row.id === second.id); assert.equal((await request(`contacts/${provider.id}/link`, { body: { ...body, localContactId: second.id, expectedLocalVersion: wrong.version } })).status, 409);
  result = await request(`contacts/${provider.id}/unlink`, { body: change(provider, { linkId: result.data.contact.links[0].id }), role: 'editor' }); assert.equal(result.status, 200); assert.equal(result.data.contact.links.length, 0); assert.equal((await contacts.list('project-a')).length, 2);
});

test('individual creation binds reviewed local data and channel identity without granting subscription', pg, async t => {
  const { contacts, request, overview, state } = await setup(t);
  const selected = await contacts.save('project-a', { name: 'No opt-in', phone: '+12025550103' }), row = (await overview()).localContacts.find(row => row.id === selected.id), body = { accountId: 'wa-a', localContactId: selected.id, expectedLocalVersion: row.version, confirmed: true };
  let result = await request('contacts/create', { body, key: 'create-no-permission' }); assert.equal(result.status, 200); assert.equal(result.data.contact.isSubscribed, false); assert.equal(result.data.contact.channels[0].isSubscribed, false); assert.equal(result.data.contact.links[0].localContactId, selected.id); assert.equal((await contacts.get('project-a', selected.id)).consents.whatsapp, false);
  assert.equal((await request('contacts/create', { body, key: 'create-no-permission' })).status, 200); assert.equal(state.writes, 1);
  result = await request('contacts/create', { body: { localContactId: selected.id, expectedLocalVersion: row.version, confirmed: true } }); assert.equal(result.status, 200); assert.equal(result.data.contact.channels.length, 0); assert.equal(result.data.contact.links[0].accountId, '');
  assert.equal((await request('contacts/create', { role: 'editor', body })).status, 403); assert.equal((await request('contacts/create', { body: { ...body, confirmed: false } })).status, 400);
});

test('exclusive edits work for project admins while shared changes require fresh explicit operator review', pg, async t => {
  const { sql, state, request, read, change } = await setup(t);
  let current = await read(); let result = await request(`contacts/${current.id}/update`, { body: change(current, { changes: { company: 'Reviewed company', notes: '<script>plain text</script>' } }) }); assert.equal(result.status, 200); assert.equal(result.data.contact.company, 'Reviewed company');
  const shared = await read(id(2)), body = change(shared, { changes: { notes: 'Reviewed global replacement' } });
  assert.equal((await request(`contacts/${shared.id}/update`, { body })).status, 403); assert.equal((await request(`contacts/${shared.id}/update`, { body, operator: true })).status, 403);
  result = await request(`contacts/${shared.id}/update`, { body: { ...body, reviewSharedContactId: shared.id, reviewProfileId: profileId }, operator: true }); assert.equal(result.status, 200); assert.equal(result.data.contact.metadataMasked, true); assert.equal(result.data.contact.notes, undefined);
  await sql.run('DELETE FROM instance_operators'); assert.equal((await request(`contacts/${shared.id}/delete`, { operator: true, body: change(result.data.contact, { reviewSharedContactId: shared.id, reviewProfileId: profileId, confirmContactId: shared.id }) })).status, 403); assert.equal(state.writes, 2);
  current = await read(); state.rows[0].email = 'changed@example.test'; assert.equal((await request(`contacts/${current.id}/update`, { body: change(current, { changes: { company: 'Stale replacement' } }) })).status, 409);
});

test('subscription requires current mapped local permission, while unsubscribe preserves old-destination suppressions', pg, async t => {
  const { contacts, local, request, read, overview, change, state } = await setup(t);
  let current = await read(); assert.equal((await request(`contacts/${current.id}/subscription`, { body: change(current, { subscribed: true }) })).status, 409);
  const localRow = (await overview()).localContacts.find(row => row.id === local.id); await request(`contacts/${current.id}/link`, { body: change(current, { localContactId: local.id, expectedLocalVersion: localRow.version, channelId: current.channels[0].id, expectedChannelVersion: current.channels[0].version }) });
  let result = await request(`contacts/${current.id}/subscription`, { body: change(current, { subscribed: true }) }); assert.equal(result.status, 200); assert.equal(result.data.contact.isSubscribed, true); assert.equal(result.data.contact.channels[0].isSubscribed, false, 'Global contact flags do not invent a channel resubscription contract.');
  current = result.data.contact; await contacts.save('project-a', { phone: '+12025550109' }, local.id);
  result = await request(`contacts/${current.id}/subscription`, { body: change(current, { subscribed: false }) }); assert.equal(result.status, 200); assert.equal((await contacts.get('project-a', local.id)).phone, '+12025550109'); assert.equal((await contacts.get('project-a', local.id)).suppression.whatsapp, undefined, 'A changed local number is not suppressed on behalf of the old channel.');
  const restored = await contacts.save('project-a', { name: 'Old destination re-imported', phone: '+12025550101', consents: { whatsapp: true }, consentSource: 'New evidence does not erase an existing suppression' }); assert.equal(restored.consents.whatsapp, false); assert.ok(restored.suppression.whatsapp);
  current = result.data.contact; assert.equal((await request(`contacts/${current.id}/subscription`, { body: change(current, { subscribed: true }) })).status, 409); assert.equal(state.writes, 2);
});

test('bulk import avoids duplicate metadata writes and reconciles per-contact successes and missing rows', pg, async t => {
  const { contacts, local, second, request, overview, state, calls } = await setup(t);
  const rejected = await contacts.save('project-a', { name: 'Rejected row', phone: '+12025550103', consents: { whatsapp: true }, consentSource: 'Synthetic permission' }); state.rejectPhones.add(rejected.phone);
  const rows = (await overview()).localContacts, selected = [local.id, second.id, rejected.id].map(localContactId => ({ localContactId, expectedLocalVersion: rows.find(row => row.id === localContactId).version }));
  const result = await request('contacts/bulk', { body: { accountId: 'wa-a', contacts: selected, confirmed: true } }); assert.equal(result.status, 200); assert.equal(result.data.partial, true); assert.equal(result.data.results.filter(row => row.status === 'linked').length, 2); assert.equal(result.data.results.find(row => row.localContactId === rejected.id).status, 'not_found'); assert.equal(result.data.providerReceipt.errorCount, 1);
  const payload = calls.find(call => call.path === '/contacts/bulk').body; assert.equal(payload.contacts.length, 2); assert.ok(payload.contacts.every(row => row.tags.length === 0)); assert.equal(state.rows.find(row => row.id === id(1)).tags[0], 'provider'); assert.equal((await contacts.get('project-a', rejected.id)).consents.whatsapp, true);
  const notPermitted = await contacts.save('project-a', { name: 'No permission', phone: '+12025550104' }), row = (await overview()).localContacts.find(row => row.id === notPermitted.id); assert.equal((await request('contacts/bulk', { body: { accountId: 'wa-a', contacts: [{ localContactId: row.id, expectedLocalVersion: row.version }], confirmed: true } })).status, 409);
});

test('typed custom field lifecycle and values validate immutable types, shared scope and exact readbacks', pg, async t => {
  const { state, request, read, change } = await setup(t);
  let result = await request('fields/create', { body: { name: 'Team size', slug: 'team_size', type: 'number', confirmed: true } }); assert.equal(result.status, 200); const definition = result.data.field;
  let current = await read(); result = await request(`contacts/${current.id}/fields/team_size/set`, { body: change(current, { expectedFieldVersion: definition.version, value: 42 }) }); assert.equal(result.status, 200); assert.equal(result.data.contact.customFields.team_size, 42);
  current = result.data.contact; assert.equal((await request(`contacts/${current.id}/fields/team_size/set`, { body: change(current, { expectedFieldVersion: definition.version, value: '42' }) })).status, 400);
  result = await request(`contacts/${current.id}/fields/team_size/clear`, { body: change(current, { expectedFieldVersion: definition.version }) }); assert.equal(result.status, 200); assert.equal(Object.hasOwn(result.data.contact.customFields, 'team_size'), false);
  const body = { name: 'Team members', expectedVersion: definition.version, confirmFieldId: definition.id, reviewProfileId: profileId, confirmed: true }; assert.equal((await request(`fields/${definition.id}/update`, { body })).status, 403);
  result = await request(`fields/${definition.id}/update`, { operator: true, body }); assert.equal(result.status, 200); assert.equal(result.data.field.name, 'Team members');
  result = await request(`fields/${definition.id}/delete`, { operator: true, body: { expectedVersion: result.data.field.version, confirmFieldId: definition.id, reviewProfileId: profileId, confirmed: true } }); assert.equal(result.status, 200); assert.equal(state.fields.some(row => row.id === definition.id), false);
  const foreign = await read(id(3), 'wa-a'); assert.equal((await request(`contacts/${foreign.id}/fields/plan/set`, { operator: true, body: change(foreign, { accountId: 'wa-a', reviewSharedContactId: foreign.id, reviewProfileId: profileId, expectedFieldVersion: 'irrelevant', value: 'Pro' }) })).status, 403);
});

test('unknown receipts fence changed-body retries, and deleted provider contacts keep local contacts intact', pg, async t => {
  const { sql, state, contacts, request, read, change } = await setup(t);
  const current = await read(); state.malformed = true; const body = change(current, { changes: { company: 'Unconfirmed' } }), result = await request(`contacts/${current.id}/update`, { body, key: 'unknown-update-contact' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
  const count = state.writes, blocked = await request(`contacts/${current.id}/update`, { body: change(current, { changes: { company: 'Different request body' } }) }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(state.writes, count);
  await sql.run("UPDATE integration_operations SET status='reviewed-applied' WHERE request_key=?", 'unknown-update-contact'); state.malformed = false;
  const fresh = await read(); const deleted = await request(`contacts/${fresh.id}/delete`, { body: change(fresh, { confirmContactId: fresh.id }) }); assert.equal(deleted.status, 200); assert.equal(deleted.data.localContactsKept, true); assert.equal((await contacts.list('project-a')).length, 2); assert.equal(state.rows.some(row => row.id === fresh.id), false);
});

test('search counts cannot reveal hidden shared metadata and scope changes stop reads and writes', pg, async t => {
  const { state, request, read, change } = await setup(t);
  const hidden = await request('contacts', { query: '?accountId=wa-a&search=Foreign-private-company' }); assert.equal(hidden.status, 200); assert.equal(hidden.data.contacts.length, 0); assert.equal(hidden.data.pagination.total, 0);
  let stale = false; state.onRead = path => { if (path.startsWith('/contacts/')) stale = true; };
  const result = await request('contacts', { assertAccess: () => { if (stale) throw new IntegrationError(409, 'PROJECT_CONNECTION_CHANGED', 'Connection changed'); } }); assert.equal(result.status, 409);
  state.onRead = null; const current = await read(); let accountReads = 0; state.onRead = path => { if (path === '/accounts' && ++accountReads === 2) state.accounts[0].profileId = 'moved-profile'; };
  assert.equal((await request(`contacts/${current.id}/update`, { body: change(current, { accountId: 'wa-a', changes: { name: 'Must not dispatch' } }) })).status, 403); assert.equal(state.writes, 0);
});

test('fresh local permission, field versions and operator membership are checked before dispatch', pg, async t => {
  for (const task of ['create', 'bulk']) {
    const { contacts, local, state, request, overview } = await setup(t);
    const row = (await overview()).localContacts.find(row => row.id === local.id); let accountReads = 0;
    state.onRead = path => { if (path === '/accounts' && ++accountReads === 3) return contacts.suppress('project-a', local.id, 'whatsapp', 'Opted out during review'); };
    const body = task === 'create' ? { accountId: 'wa-a', localContactId: local.id, expectedLocalVersion: row.version, confirmed: true } : { accountId: 'wa-a', contacts: [{ localContactId: local.id, expectedLocalVersion: row.version }], confirmed: true };
    // Bulk with only an existing channel is local reconciliation; include a new destination to exercise dispatch preflight.
    if (task === 'bulk') state.rows[0].channels[0].platformIdentifier = '12025550888';
    const result = await request(`contacts/${task}`, { body }); assert.equal(result.status, 409); assert.equal(state.writes, 0);
  }
  for (const failure of ['operator', 'definition']) {
    const { sql, state, request } = await setup(t);
    const definition = (await request('fields')).data.fields[0]; let reads = 0;
    state.onRead = path => { if (path === '/accounts' && ++reads === 2) { if (failure === 'operator') return sql.run('DELETE FROM instance_operators'); else state.fields[0].name = 'Changed elsewhere'; } };
    const result = await request(`fields/${definition.id}/update`, { operator: true, body: { name: 'Reviewed rename', options: ['Basic', 'Pro'], expectedVersion: definition.version, confirmFieldId: definition.id, reviewProfileId: profileId, confirmed: true } }); assert.equal(result.status, 409); assert.equal(state.writes, 0);
  }
});

test('malformed channel scope and create/bulk acknowledgements fail closed without blind retry', pg, async t => {
  const scope = await setup(t);
  scope.state.rows[0].channels[0].platform = 'facebook'; assert.equal((await scope.request('contacts/' + id(1))).status, 502); assert.equal(scope.state.writes, 0);
  for (const task of ['create', 'bulk']) {
    const { local, state, request, overview } = await setup(t);
    const selected = (await overview()).localContacts.find(row => row.id === local.id), body = task === 'create' ? { accountId: 'wa-a', localContactId: local.id, expectedLocalVersion: selected.version, confirmed: true } : { accountId: 'wa-a', contacts: [{ localContactId: local.id, expectedLocalVersion: selected.version }], confirmed: true };
    state.rows[0].channels[0].platformIdentifier = '12025550888'; state.malformed = true;
    let result = await request(`contacts/${task}`, { body, key: 'unknown-contact-' + task }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(state.writes, 1); const originalOperation = result.data.operation;
    result = await request(`contacts/${task}`, { body, key: 'unknown-contact-' + task }); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(state.writes, 1);
    const changedBody = task === 'create' ? { ...body, expectedLocalVersion: 'different-version' } : { ...body, contacts: [{ ...body.contacts[0], expectedLocalVersion: 'different-version' }] };
    result = await request(`contacts/${task}`, { body: changedBody }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(result.data.operation.status, 'failed'); assert.notEqual(result.data.operation.id, originalOperation.id); assert.equal(state.writes, 1);
  }
  const ambiguous = await setup(t);
  ambiguous.state.rows[1].channels[0].platformIdentifier = '12025550101'; const selected = (await ambiguous.overview()).localContacts.find(row => row.id === ambiguous.local.id);
  const result = await ambiguous.request('contacts/bulk', { body: { accountId: 'wa-a', contacts: [{ localContactId: selected.id, expectedLocalVersion: selected.version }], confirmed: true } }); assert.equal(result.status, 200); assert.equal(result.data.results[0].status, 'ambiguous'); assert.equal(ambiguous.state.writes, 0);
});

test('custom value writes recheck their definition and serialize against profile definition mutations', pg, async t => {
  const { state, request, read, change } = await setup(t); let release;
  try {
    const current = await read(), definition = (await request('fields')).data.fields[0]; let reads = 0;
    state.onRead = path => { if (path === '/accounts' && ++reads === 3) state.fields[0].name = 'Changed during value review'; };
    const body = change(current, { expectedFieldVersion: definition.version, value: 'Pro' }); let result = await request(`contacts/${current.id}/fields/plan/set`, { body }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'CUSTOM_FIELD_CHANGED'); assert.equal(state.writes, 0);
    state.onRead = null; const freshField = (await request('fields')).data.fields[0]; state.hold = new Promise(resolve => { release = resolve; });
    const first = request(`fields/${definition.id}/update`, { operator: true, body: { name: 'Locked definition', options: ['Basic', 'Pro'], expectedVersion: freshField.version, confirmFieldId: definition.id, reviewProfileId: profileId, confirmed: true } });
    while (!state.writes) await new Promise(resolve => setTimeout(resolve, 1));
    result = await request(`contacts/${current.id}/fields/plan/set`, { body: { ...body, expectedFieldVersion: freshField.version } }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'CONTACT_RESOURCE_BUSY'); assert.equal(state.writes, 1);
    release(); state.hold = null; assert.equal((await first).status, 200);
  } finally { release?.(); }
});

test('contact origin and metadata masking are freshly proven before global writes and after readback', pg, async t => {
  for (const timing of ['preflight', 'readback']) {
    const { state, request, read, change } = await setup(t);
    const current = await read(id(1), 'wa-a'); let reads = 0;
    if (timing === 'preflight') state.onRead = path => { if (path === '/accounts' && ++reads === 3) state.rows[0].profileId = 'foreign-profile'; };
    else state.onWrite = () => { state.rows[0].profileId = 'foreign-profile'; };
    const result = await request(`contacts/${current.id}/update`, { body: change(current, { accountId: 'wa-a', changes: { company: 'Reviewed replacement' } }) });
    if (timing === 'preflight') { assert.equal(result.status, 403); assert.equal(result.data.error.code, 'SHARED_CONTACT_REVIEW_REQUIRED'); assert.equal(state.writes, 0); }
    else { assert.equal(result.status, 200); assert.equal(result.data.contact.metadataMasked, true); assert.equal(result.data.contact.company, undefined); assert.equal(result.data.contact.originHere, false); }
  }
});

test('contact UI retains action identities, rejects malformed receipts and never revives departed views', async () => {
  const source = await readFile(new URL('../src/ZernioContacts.tsx', import.meta.url), 'utf8'), helper = stripTypeScriptTypes(source.slice(source.indexOf('  async function write('), source.indexOf('  function accept(')));
  const keys = { current: new Map() }, calls = []; let active = true, sequence = 0, failure, response = { operation: { status: 'complete' }, contact: { id: id(1), version: 'new-version' }, updated: true };
  const context = { current: () => active, path: '/projects/a/integrations/contacts', keys, crypto: { randomUUID: () => `contact-ui-key-${++sequence}` }, requester: { current: async (...args) => { calls.push(args); if (failure) throw Object.assign(new Error('Request failed'), failure); return response; } } };
  const write = new Function(...Object.keys(context), `return (${helper});`)(...Object.values(context)), body = { expectedVersion: 'old-version', changes: { name: 'Reviewed name' }, confirmed: true }, task = `contacts/${id(1)}/update`;
  for (const receipt of [{ status: 502 }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, operation: { status: 'pending' } }, { status: 400, operation: { status: 'uncertain' } }]) {
    failure = receipt; await assert.rejects(write(task, body)); const key = calls.at(-1)[3]; assert.equal(keys.current.size, 1); failure = null; await write(task, body); assert.equal(calls.at(-1)[3], key); assert.equal(keys.current.size, 0);
  }
  response = { operation: { status: 'complete' }, contact: { id: id(999), version: 'wrong-contact' }, updated: true }; await assert.rejects(write(task, body), /receipt/); assert.equal(keys.current.size, 1);
  failure = { status: 400, code: 'INVALID_CONTACT_FIELDS' }; await assert.rejects(write(task, body)); assert.equal(keys.current.size, 0); failure = null; active = false; await assert.rejects(write(task, body), { name: 'AbortError' });
  const identitySource = stripTypeScriptTypes(source.slice(source.indexOf('  const path ='), source.indexOf('  const account ='))).replace('  const scope = useRef({ identity });', '  const scope = state;');
  const identify = (projectId, canManage, state, filters = { platform: '', isSubscribed: '', tag: '' }) => new Function('projectId', 'accountId', 'search', 'filters', 'canManage', 'canWrite', 'isOperator', 'state', 'mounted', `${identitySource}; return current;`)(projectId, 'wa-a', '', filters, canManage, false, true, state, { current: true });
  const state = { current: { identity: '' } }, first = identify('a', true, state), second = identify('b', true, state), third = identify('a', true, state), viewer = identify('a', false, state), owner = identify('a', true, state); assert.equal(first(), false); assert.equal(second(), false); assert.equal(third(), false); assert.equal(viewer(), false); assert.equal(owner(), true);
  for (const filters of [{ platform: 'whatsapp', isSubscribed: '', tag: '' }, { platform: '', isSubscribed: 'false', tag: '' }, { platform: '', isSubscribed: '', tag: 'vip' }]) { const before = identify('a', true, state), filtered = identify('a', true, state, filters), restored = identify('a', true, state); assert.equal(before(), false); assert.equal(filtered(), false); assert.equal(restored(), true); }
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'Contacts.tsx', { jsx: { runtime: 'classic' } });
  const component = new Function('React', 'useEffect', 'useRef', 'useState', ...Object.keys(ui), `${code}; return ZernioContacts;`)(React, React.useEffect, React.useRef, React.useState, ...Object.values(ui)), html = renderToStaticMarkup(React.createElement(component, { projectId: 'a', canManage: true, isOperator: true, request: async () => ({}) }));
  assert.match(html, /Connected contacts/); assert.match(html, /Create from a local contact/); assert.match(html, /Custom field definitions/); assert.doesNotMatch(source, /window\.confirm|JSON\.parse\(|dangerouslySetInnerHTML/);
});

test('refreshing contact and field snapshots invalidates dependent create, link, bulk and value reviews', async () => {
  const source = await readFile(new URL('../src/ZernioContacts.tsx', import.meta.url), 'utf8'), code = stripTypeScriptTypes(source.slice(source.indexOf('  async function load('), source.indexOf('  async function write('))), review = { reviewed: true, bulkReviewed: true, valueReviewed: true, fieldReviewed: true, fieldScopeReviewed: true, sharedReviewed: true, deleteReviewed: true, fieldDeleteReviewed: true, subscriptionReviewed: true };
  const context = { current: () => true, contactPage: () => true, reads: { current: 0 }, path: '/projects/a/integrations/contacts', query: '', requester: { current: async path => path.endsWith('/overview') ? { localContacts: [{ id: 'local', version: 'new-local', name: 'New unreviewed details' }], accounts: [], profileId } : path.endsWith('/fields') ? { fields: [{ id: id(801), version: 'new-field' }] } : { contacts: [], pagination: {} } }, setLocalContacts() {}, setAccounts() {}, setProfileId() {}, setContacts() {}, setPagination() {}, setFields() {}, setError() {}, ...Object.fromEntries(Object.keys(review).map(key => ['set' + key.charAt(0).toUpperCase() + key.slice(1), value => { review[key] = value; }])) };
  await new Function(...Object.keys(context), `return (${code});`)(...Object.values(context))(); assert.ok(Object.values(review).every(value => value === false));
  const createCode = stripTypeScriptTypes(source.slice(source.indexOf('  async function createContact('), source.indexOf('  async function linkContact('))); let dispatched = 0;
  const create = new Function('canManage', 'local', 'reviewed', 'action', `return (${createCode});`)(true, { id: 'local', version: 'new-local' }, review.reviewed, () => { dispatched++; }); await create({ preventDefault() {} }); assert.equal(dispatched, 0);
});

test('contact filter layout keeps its form full width and row actions compact with complete accessible names', async () => {
  const source = await readFile(new URL('../src/ZernioContacts.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    <Field label="Contact scope">'), end = source.indexOf('    <Text tone="muted">Only this project', start), table = source.indexOf('    <DataTable ariaLabel="Connected contacts"'), tableEnd = source.indexOf('    {pagination?.hasMore', table);
  assert.ok(start > 0 && end > start && table > end && tableEnd > table);
  const { code } = await transformWithOxc(`const render = () => (<>${source.slice(start, end)}${source.slice(table, tableEnd)}</>);`, 'ContactFilterLayout.tsx', { jsx: { runtime: 'classic' } });
  const contact = { id: 'contact-one', name: 'Long contact identity for the connected project', channels: [], isSubscribed: false }, draft = { platform: 'whatsapp', isSubscribed: 'false', tag: ' vip ' };
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  for (const busy of [false, true]) {
    let inspected, scope, search, filters;
    const context = { React, ...ui, busy, selected: null, accountId: '', accounts: [{ id: 'wa', name: 'Project number', platform: 'whatsapp', isActive: true }], contacts: [contact], pagination: null, searchDraft: '  Reviewed search  ', filterDraft: draft, label: row => row.name, setAccountId: value => { scope = value; }, setSearch: value => { search = value; }, setFilters: value => { filters = value; }, setSearchDraft() {}, setFilterDraft() {}, inspect: row => { inspected = row; } };
    const tree = new Function(...Object.keys(context), code + '; return render();')(...Object.values(context)), children = React.Children.toArray(tree.props.children).filter(React.isValidElement), form = children[1], formChildren = React.Children.toArray(form.props.children), grid = formChildren[0];
    // The library Form prevents native navigation; the scope picker and the four filters stay full-width labelled fields.
    assert.equal(children[0].type, ui.Field); assert.equal(children[0].props.label, 'Contact scope'); assert.equal(form.type, ui.Form); assert.equal(grid.type, ui.FormGrid);
    assert.equal(React.Children.toArray(grid.props.children).length, 4); assert.ok(React.Children.toArray(grid.props.children).every(node => node.type === ui.Field));
    const apply = nodes(formChildren[1]).find(node => node.type === ui.Button); assert.equal(apply.props.children, 'Apply contact filters'); assert.equal(apply.props.type, 'submit'); assert.equal(apply.props.disabled, busy);
    assert.equal(search, undefined); assert.equal(filters, undefined);
    form.props.onSubmit(new FormData(), { preventDefault() {} }); assert.equal(search, 'Reviewed search'); assert.deepEqual(filters, { ...draft, tag: 'vip' });
    nodes(children[0]).find(node => node.type === ui.Select).props.onChange({ target: { value: 'wa' } }); assert.equal(scope, 'wa');
    const results = children.find(node => node.type === ui.DataTable); assert.equal(results.props.ariaLabel, 'Connected contacts'); assert.equal(results.props.rows[0], contact);
    const inspect = results.props.rowActions(contact);
    assert.equal(inspect.type, ui.Button); assert.equal(inspect.props['aria-label'], 'Inspect ' + contact.name); assert.equal(inspect.props.children, 'Inspect'); assert.equal(inspect.props.disabled, busy);
    if (!busy) { inspect.props.onClick(); assert.equal(inspected, contact); inspected = undefined; results.props.onRowActivate(contact); assert.equal(inspected, contact); }
  }
});

test('contact filter UI keeps failed or late results unknown and validates pagination before showing empty', async () => {
  const source = await readFile(new URL('../src/ZernioContacts.tsx', import.meta.url), 'utf8'), helper = stripTypeScriptTypes(source.slice(source.indexOf('const contactPage ='), source.indexOf('\n\nexport default'))), contactPage = new Function(`${helper}; return contactPage;`)();
  const valid = { contacts: [{ id: id(1), channels: [] }], pagination: { total: 1, limit: 25, skip: 0, hasMore: false } };
  assert.equal(contactPage(valid), true); assert.equal(contactPage({ contacts: [], pagination: {} }), false); assert.equal(contactPage({ contacts: [], pagination: { total: 0, limit: 25, skip: 0, hasMore: true } }), false);
  let active = true, release; const pending = new Promise(resolve => { release = resolve; }), values = { contacts: valid.contacts, pagination: valid.pagination, error: '' };
  const context = { current: () => active, contactPage, reads: { current: 0 }, path: '/projects/a/integrations/contacts', query: '?tag=vip', requester: { current: async path => path.endsWith('/overview') ? { accounts: [], localContacts: [], profileId } : path.endsWith('/fields') ? { fields: [] } : pending }, setContacts(value) { values.contacts = value; }, setPagination(value) { values.pagination = value; }, setError(value) { values.error = value; }, ...Object.fromEntries(['LocalContacts', 'Accounts', 'ProfileId', 'Fields', 'Reviewed', 'BulkReviewed', 'ValueReviewed', 'FieldReviewed', 'FieldScopeReviewed', 'SharedReviewed', 'DeleteReviewed', 'FieldDeleteReviewed', 'SubscriptionReviewed'].map(key => ['set' + key, () => {}])) };
  const loadSource = stripTypeScriptTypes(source.slice(source.indexOf('  async function load('), source.indexOf('  async function write('))), load = new Function(...Object.keys(context), `return (${loadSource});`)(...Object.values(context));
  const loading = load(); assert.deepEqual(values.contacts, []); assert.equal(values.pagination, null); active = false; release(valid); await loading; assert.deepEqual(values.contacts, []); assert.equal(values.pagination, null);
  active = true;
  for (const response of [{ contacts: [], pagination: {} }, new Error('Choose a smaller account scope.')]) {
    values.contacts = valid.contacts; values.pagination = valid.pagination;
    context.requester.current = async path => path.endsWith('/overview') ? { accounts: [], localContacts: [], profileId } : path.endsWith('/fields') ? { fields: [] } : response instanceof Error ? Promise.reject(response) : response;
    await load(); assert.deepEqual(values.contacts, []); assert.equal(values.pagination, null); assert.match(values.error, /scope|verified/);
  }
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'Contacts.tsx', { jsx: { runtime: 'classic' } });
  const render = pagination => { let index = 0; const component = new Function('React', 'useEffect', 'useRef', 'useState', ...Object.keys(ui), `${code}; return ZernioContacts;`)(React, () => {}, value => ({ current: value }), initial => [index++ === 7 ? pagination : initial, () => {}], ...Object.values(ui)); return renderToStaticMarkup(React.createElement(component, { projectId: 'a', canManage: false, isOperator: false, request: async () => ({}) })); };
  let html = render(null); assert.match(html, /Contact results are unavailable/); assert.doesNotMatch(html, /No connected contacts matched|Load more contacts/); assert.match(html, /Exact tag/); assert.match(html, /Provider subscription/);
  html = render({ total: 0, limit: 25, skip: 0, hasMore: false }); assert.match(html, /No connected contacts matched/);
});

test('authenticated contact HTTP workflows use all contacts endpoints, empty receipts and safe retry reconciliation', pg, async t => {
  const upstream = provider(), originalFetch = globalThis.fetch, dataDir = await mkdtemp(join(tmpdir(), 'ten98-contacts-'));
  const app = await testApp(t, { dataDir, env: { ZERNIO_API_KEY: 'synthetic-contacts-key' }, appUrl: 'https://contacts.example.test', directScheduler: false }); let origin, cookie;
  globalThis.fetch = async (target, options = {}) => {
    const targetUrl = new URL(target); if (targetUrl.origin === origin) return originalFetch(target, options);
    assert.equal(targetUrl.origin, 'https://zernio.com'); assert.equal(options.redirect, 'error');
    const body = options.body ? JSON.parse(options.body) : undefined, path = targetUrl.pathname.slice('/api/v1'.length);
    try { const result = await upstream.api(path, Object.fromEntries(targetUrl.searchParams), body, options.headers['Idempotency-Key'], options.method); return options.method === 'DELETE' || options.method === 'PUT' ? new Response('', { status: 200 }) : Response.json(result); }
    catch (error) { return Response.json({ error: error.message }, { status: error.providerStatus || error.status || 500 }); }
  };
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (path, method = 'GET', body, key = 'http-contact-key-' + Math.random(), csrf = true) => {
      const response = await originalFetch(origin + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { Origin: 'https://contacts.example.test' } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; return { status: response.status, data: await response.json() };
    };
    const setupResponse = await request('/api/auth/setup', 'POST', { name: 'Contact QA owner', email: 'contacts-qa@example.test', password: 'Synthetic contacts passphrase 2026!' }); setupResponse.data.projectId = await firstProject(app, setupResponse, { cookie }); assert.equal(setupResponse.status, 201);
    const projectId = setupResponse.data.projectId; assert.equal((await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: profileId })).status, 200); const path = `/api/projects/${projectId}/integrations/contacts`;
    const local = await app.direct.contacts.save(projectId, { name: 'HTTP local contact', phone: '+12025550102', consents: { whatsapp: true }, consentSource: 'Synthetic HTTP opt-in' });
    let overview = (await request(path + '/overview')).data, localRow = overview.localContacts.find(row => row.id === local.id), body = { accountId: 'wa-a', localContactId: local.id, expectedLocalVersion: localRow.version, confirmed: true };
    assert.equal((await request(path + '/contacts/create', 'POST', body, 'csrf-contact-key', false)).status, 403); assert.equal(upstream.state.writes, 0);
    let result = await request(path + '/contacts/create', 'POST', body, 'http-create-contact'); assert.equal(result.status, 200, JSON.stringify(result.data)); let contact = result.data.contact;
    assert.equal((await request(path + '/contacts/create', 'POST', body, 'http-create-contact')).status, 200); assert.equal(upstream.state.writes, 1);
    assert.equal((await request(path + `/contacts/${contact.id}?accountId=wa-a`)).data.contact.id, contact.id); assert.equal((await request(path + '/contacts?accountId=wa-a&search=HTTP')).data.contacts.length, 1);
    result = await request(path + `/contacts/${contact.id}/update`, 'POST', { accountId: 'wa-a', expectedVersion: contact.version, changes: { company: 'HTTP company' }, confirmed: true }); assert.equal(result.status, 200); contact = result.data.contact;
    result = await request(path + '/fields/create', 'POST', { name: 'HTTP date', slug: 'http_date', type: 'date', confirmed: true }); assert.equal(result.status, 200); let definition = result.data.field;
    result = await request(path + `/contacts/${contact.id}/fields/http_date/set`, 'POST', { accountId: 'wa-a', expectedVersion: contact.version, expectedFieldVersion: definition.version, value: '2026-10-18', confirmed: true }); assert.equal(result.status, 200, JSON.stringify(result.data)); contact = result.data.contact;
    result = await request(path + `/contacts/${contact.id}/fields/http_date/clear`, 'POST', { accountId: 'wa-a', expectedVersion: contact.version, expectedFieldVersion: definition.version, confirmed: true }); assert.equal(result.status, 200); contact = result.data.contact;
    result = await request(path + `/fields/${definition.id}/update`, 'POST', { name: 'HTTP reviewed date', expectedVersion: definition.version, confirmFieldId: definition.id, reviewProfileId: profileId, confirmed: true }); assert.equal(result.status, 200); definition = result.data.field;
    assert.equal((await request(path + `/fields/${definition.id}/delete`, 'POST', { expectedVersion: definition.version, confirmFieldId: definition.id, reviewProfileId: profileId, confirmed: true })).status, 200);
    result = await request(path + `/contacts/${contact.id}/subscription`, 'POST', { accountId: 'wa-a', expectedVersion: contact.version, subscribed: false, confirmed: true }); assert.equal(result.status, 200); contact = result.data.contact; assert.ok((await app.direct.contacts.get(projectId, local.id)).suppression.whatsapp);
    assert.equal((await request(path + `/contacts/${contact.id}/subscription`, 'POST', { accountId: 'wa-a', expectedVersion: contact.version, subscribed: true, confirmed: true })).status, 409);
    result = await request(path + `/contacts/${contact.id}/delete`, 'POST', { accountId: 'wa-a', expectedVersion: contact.version, confirmContactId: contact.id, confirmed: true }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal((await app.direct.contacts.get(projectId, local.id)).id, local.id);
    const bulkLocal = await app.direct.contacts.save(projectId, { name: 'HTTP bulk contact', phone: '+12025550104', consents: { whatsapp: true }, consentSource: 'Synthetic HTTP bulk opt-in' }); overview = (await request(path + '/overview')).data; localRow = overview.localContacts.find(row => row.id === bulkLocal.id);
    result = await request(path + '/contacts/bulk', 'POST', { accountId: 'wa-a', contacts: [{ localContactId: bulkLocal.id, expectedLocalVersion: localRow.version }], confirmed: true }); assert.equal(result.status, 200); assert.equal(result.data.results[0].status, 'linked');
    const otherProject = await request('/api/projects', 'POST', { workspaceId: (await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId)).workspace_id, name: 'Other contacts project' }); assert.equal(otherProject.status, 201); assert.equal((await request(`/api/projects/${otherProject.data.project.id}/integrations/contacts/contacts?accountId=wa-a`)).status, 409);
    contact = (await request(path + `/contacts/${id(1)}?accountId=wa-a`)).data.contact; upstream.state.malformed = true; const uncertain = { accountId: 'wa-a', expectedVersion: contact.version, changes: { company: 'Unknown HTTP update' }, confirmed: true }; result = await request(path + `/contacts/${contact.id}/update`, 'POST', uncertain, 'http-unknown-contact'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const writes = upstream.state.writes;
    assert.equal((await request(path + `/contacts/${contact.id}/update`, 'POST', uncertain, 'http-unknown-contact')).data.error.code, 'OPERATION_UNCERTAIN'); const blocked = await request(path + `/contacts/${contact.id}/update`, 'POST', { ...uncertain, changes: { company: 'Changed after unknown' } }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); assert.equal(upstream.state.writes, writes);
    for (const [method, route] of [['GET', '/contacts'], ['POST', '/contacts'], ['GET', '/contacts/' + contact.id], ['GET', '/contacts/' + contact.id + '/channels'], ['PATCH', '/contacts/' + contact.id], ['DELETE', '/contacts/' + result.data.contact?.id], ['POST', '/contacts/bulk']]) { if (method === 'DELETE') assert.ok(upstream.calls.some(call => call.method === 'DELETE' && /^\/contacts\/[a-f0-9]{24}$/.test(call.path))); else assert.ok(upstream.calls.some(call => call.method === method && call.path === route), `${method} ${route}`); }
  } finally {
    globalThis.fetch = originalFetch; assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep)); await rm(dataDir, { recursive: true, force: true });
  }
});
