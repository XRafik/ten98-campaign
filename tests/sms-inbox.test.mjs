import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { createContacts } from '../server/contacts.ts';
import { createDirectCampaigns } from '../server/direct-campaigns.ts';
import { createSmsInbox } from '../server/sms-inbox.ts';
import { createIntegrationSettings } from '../server/integration-settings.ts';
import { sendDirect } from '../server/direct-providers.ts';
import { HttpError } from '../server/auth.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const pg = { skip: postgresSkip };
const token = (prefix, value) => prefix + String(value).padStart(32, '0');
// Drizzle wraps driver errors; the PostgreSQL message is on the cause.
const failure = pattern => error => pattern.test(error.cause?.message ?? error.message);
async function fixture(t) {
  const { db, pool } = await testDatabase(t);
  await pool.query("INSERT INTO users (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test'); INSERT INTO workspaces (id, name) VALUES ('wa', 'A'), ('wb', 'B'); INSERT INTO projects (id, workspace_id, name) VALUES ('a', 'wa', 'A'), ('b', 'wb', 'B'); INSERT INTO memberships VALUES ('wa', 'owner', 'owner'), ('wb', 'owner', 'owner')");
  const env = { TWILIO_ACCOUNT_SID: token('AC', 1), TWILIO_AUTH_TOKEN: 'sms-inbox-fixture-secret', TWILIO_FROM_NUMBER: '+12025550100' }, appUrl = 'https://campaign.example.test', contacts = createContacts({ db }), originalFetch = globalThis.fetch, calls = [];
  const store = { activity() {} }, direct = createDirectCampaigns({ db, env, appUrl, secret: 'fixture-session-secret-with-enough-entropy', store }), inbox = createSmsInbox({ db, env, appUrl, contacts }); await direct.attachSmsInbox(inbox);
  let hook, counter = 1, access = true;
  globalThis.fetch = async (url, options) => {
    const target = new URL(url); assert.ok(['api.twilio.com', 'api.cloudflare.com'].includes(target.hostname)); calls.push({ url: target, ...options });
    if (hook) { const result = await hook(target, options); if (result !== undefined) return result; }
    const form = new URLSearchParams(options.body); return Response.json({ sid: token('SM', counter++), account_sid: env.TWILIO_ACCOUNT_SID, from: form.get('From') || '+12025550200', to: form.get('To'), status: 'queued', messaging_service_sid: form.get('MessagingServiceSid') });
  };
  async function request(path, method = 'GET', body, key = randomUUID(), projectId = 'a', role = 'owner') {
    let result; const context = { db, store, contacts, project: { id: projectId, zernioProfileId: '' }, role, user: { id: 'owner' }, config: { env }, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`/api/projects/${projectId}/${path}`, appUrl), body: body || {}, send: (status, data) => { result = { status, data }; }, assertIntegrationSettings() { if (!access) throw new HttpError(403, 'Access revoked'); } };
    await (path.startsWith('direct/') ? direct.handle(context) : inbox.handle(context)); return result;
  }
  function inbound(fields, projectId, extra = {}) {
    const path = `/api/webhooks/twilio/inbound${projectId ? '/' + projectId : ''}`; return callback(path, { From: '+12025550123', To: env.TWILIO_FROM_NUMBER, MessageSid: token('SM', 900), Body: 'Customer reply', NumMedia: '0', ...fields }, extra);
  }
  function callback(path, fields, extra = {}) {
    const form = new URLSearchParams({ AccountSid: env.TWILIO_ACCOUNT_SID, ...fields }), signature = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(appUrl + path + [...form.keys()].sort().map(key => key + form.get(key)).join('')).digest('base64');
    return direct.receiveTwilio({ url: new URL(path, appUrl), rawBody: Buffer.from(form.toString()), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature, ...extra } });
  }
  function outbound(projectId = 'a', options = {}) { return inbox.recordOutbound({ id: randomUUID(), projectId, accountSid: env.TWILIO_ACCOUNT_SID, sender: env.TWILIO_FROM_NUMBER, recipient: '+12025550123', providerId: token('SM', counter++), message: 'Campaign message', status: 'queued', ...options }); }
  const count = async (table, where = '', params = []) => (await pool.query(`SELECT count(*) AS n FROM ${table} ${where}`, params)).rows[0].n;
  return { db, pool, env, contacts, direct, inbox, calls, request, inbound, callback, outbound, count, appUrl, setHook(value) { hook = value; }, revoke() { access = false; }, restore() { access = true; }, async close() { direct.close(); await direct.idle(); globalThis.fetch = originalFetch; } };
}

test('verified campaign replies persist once, preserve raw signature checks and never invent contacts or consent', pg, async t => {
  const f = await fixture(t);
  try {
    const contact = await f.contacts.save('a', { name: 'Alex', phone: '+12025550123', consents: { sms: true }, consentSource: 'Explicit signup record' });
    const draft = await f.request('direct/campaigns', 'POST', { name: 'Service notice', channel: 'sms', text: 'Your appointment is confirmed.' }), id = draft.data.campaign.id;
    const preview = await f.request(`direct/campaigns/${id}/preview`, 'POST', {}); await f.request(`direct/campaigns/${id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken }); await f.direct.processPending();
    const before = await f.request('sms-inbox/conversations'); assert.equal(before.data.conversations.length, 1); assert.equal(before.data.conversations[0].contactId, contact.id);
    assert.equal((await f.inbound()).accepted, true); assert.equal((await f.inbound()).duplicate, true);
    const conversation = (await f.request('sms-inbox/conversations')).data.conversations[0], history = await f.request(`sms-inbox/conversations/${conversation.id}/messages`); assert.equal(history.data.messages.length, 2); assert.equal(history.data.messages[0].message, 'Customer reply'); assert.match(history.data.messages[1].message, /Reply STOP/); assert.equal((await f.contacts.get('a', contact.id)).consents.sms, true);
    await assert.rejects(f.inbound({ Body: 'Different body with same SID' }), error => error.status === 400);
    await assert.rejects(f.inbound({ MessageSid: token('SM', 901) }, undefined, { 'x-twilio-signature': 'invalid' }), error => error.status === 401);
    await assert.rejects(f.inbound({ AccountSid: token('AC', 2), MessageSid: token('SM', 902) }), error => error.status === 400);
    await assert.rejects(f.inbound({ To: '+12025550999', MessageSid: token('SM', 903) }), error => error.status === 400);
    await f.contacts.remove('a', contact.id); await f.inbound({ MessageSid: token('SM', 904) }); assert.equal((await f.contacts.list('a')).length, 0); assert.equal((await f.request('sms-inbox/conversations')).data.conversations[0].contactId, undefined);
    assert.deepEqual((await f.request('sms-inbox/conversations', 'GET', undefined, undefined, 'b')).data.conversations, []);
    await assert.rejects(f.request(`sms-inbox/conversations/${conversation.id}/messages`, 'GET', undefined, undefined, 'b'), error => error.status === 404);
    const unknown = await f.inbound({ MessageSid: token('SM', 905), From: '+12025550199', Body: 'UNATTRIBUTED_PRIVATE_BODY' }); assert.equal(unknown.unattributed, true); assert.equal(await f.count('sms_messages'), 3); assert.equal(JSON.stringify((await f.pool.query('SELECT * FROM sms_inbound_receipts')).rows).includes('UNATTRIBUTED_PRIVATE_BODY'), false);
    const status = await f.request('sms-inbox/status'); assert.equal(status.data.callbackUrl, f.appUrl + '/api/webhooks/twilio/inbound/a');
  } finally { await f.close(); }
});

// ten98-campaign#54 item 5: each conversation finds its contact by phone, not by reading every contact in the project.
test('the SMS conversation list reads each conversation contact by phone, not the whole contact list', pg, async t => {
  const f = await fixture(t);
  try {
    const contact = await f.contacts.save('a', { name: 'Alex', phone: '+12025550123', consents: { sms: true }, consentSource: 'Explicit signup record' });
    await f.contacts.import('a', { csv: ['email', ...Array.from({ length: 300 }, (_, index) => `other-${index}@example.test`)].join('\n'), consents: {}, consentSource: 'Fixture' });
    const draft = await f.request('direct/campaigns', 'POST', { name: 'Service notice', channel: 'sms', text: 'Your appointment is confirmed.', contactIds: [contact.id] }), id = draft.data.campaign.id;
    const preview = await f.request(`direct/campaigns/${id}/preview`, 'POST', {}); await f.request(`direct/campaigns/${id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken }); await f.direct.processPending();
    const driver = (await import('pg')).default, query = driver.Client.prototype.query; let rows = 0;
    // Pool queries use pg's callback form and transactions the promise form; count direct_contacts rows either way.
    driver.Client.prototype.query = function (...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || '', count = value => { if (/FROM direct_contacts\b/.test(text)) rows += value?.rows?.length || 0; }, done = args.at(-1);
      if (typeof done === 'function') args[args.length - 1] = (error, value) => { if (!error) count(value); return done(error, value); };
      const result = query.apply(this, args); if (result?.then) result.then(count, () => {}); return result;
    };
    let listed; try { listed = await f.request('sms-inbox/conversations'); } finally { driver.Client.prototype.query = query; }
    assert.equal(listed.data.conversations[0].contactId, contact.id);
    assert.ok(rows < 10, `Listing one conversation read ${rows} contact rows; the whole list is 301.`);
  } finally { await f.close(); }
});

test('a campaign acknowledgement cannot replace the sender established by its signed delivery callback', pg, async t => {
  const f = await fixture(t);
  try {
    f.env.TWILIO_MESSAGING_SERVICE_SID = token('MG', 1);
    await f.contacts.save('a', { phone: '+12025550123', consents: { sms: true }, consentSource: 'Explicit service request' });
    const draft = await f.request('direct/campaigns', 'POST', { name: 'Service notice', channel: 'sms', text: 'Your appointment is confirmed.' }), id = draft.data.campaign.id;
    const preview = await f.request(`direct/campaigns/${id}/preview`, 'POST', {}); await f.request(`direct/campaigns/${id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken });
    f.setHook(async (url, options) => {
      assert.equal(options.method, 'POST'); const form = new URLSearchParams(options.body), callback = new URL(form.get('StatusCallback'));
      await f.callback(callback.pathname, { MessageSid: token('SM', 500), From: '+12025550200', To: form.get('To'), MessagingServiceSid: token('MG', 1), MessageStatus: 'delivered' });
      return Response.json({ sid: token('SM', 500), account_sid: f.env.TWILIO_ACCOUNT_SID, from: '+12025550999', to: form.get('To'), messaging_service_sid: token('MG', 1), status: 'queued' });
    });
    await f.direct.processPending();
    const result = await f.request(`direct/campaigns/${id}`), conversations = await f.request('sms-inbox/conversations');
    assert.equal(result.data.deliveries[0].smsSender, '+12025550200'); assert.equal(result.data.deliveries[0].status, 'delivered');
    assert.equal(conversations.data.conversations.length, 1); assert.equal(conversations.data.conversations[0].sender, '+12025550200');
    assert.match(result.data.campaign.lastError, /acknowledgement/);
  } finally { await f.close(); }
});

test('shared-phone ambiguity fails closed and project-specific signed callbacks can attribute one copy only', pg, async t => {
  const f = await fixture(t);
  try {
    await f.outbound('a'); await f.outbound('b'); assert.equal((await f.inbound()).unattributed, true); assert.equal(await f.count('sms_messages'), 2);
    assert.equal((await f.inbound({}, 'a')).accepted, true); assert.equal(await f.count('sms_messages'), 3); assert.equal((await f.inbound({}, 'a')).duplicate, true);
    await assert.rejects(f.inbound({}, 'b'), error => error.status === 400);
    const b = (await f.request('sms-inbox/conversations', 'GET', undefined, undefined, 'b')).data.conversations[0]; assert.equal((await f.request(`sms-inbox/conversations/${b.id}/messages`, 'GET', undefined, undefined, 'b')).data.messages.length, 1);
    assert.equal((await f.inbound({ MessageSid: token('SM', 901) }, 'missing-project')).unattributed, true);
    const a = (await f.request('sms-inbox/conversations')).data.conversations[0];
    await f.pool.query("CREATE FUNCTION fail_sms() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data::text LIKE '%ROLLBACK_BODY%' THEN RAISE EXCEPTION 'storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_sms BEFORE INSERT ON sms_messages FOR EACH ROW EXECUTE FUNCTION fail_sms();");
    await assert.rejects(f.inbound({ MessageSid: token('SM', 902), Body: 'ROLLBACK_BODY' }, 'a'), failure(/storage failure/)); assert.equal(await f.count('sms_inbound_receipts', 'WHERE provider_id = $1', [token('SM', 902)]), 0);
    assert.equal((await f.request(`sms-inbox/conversations/${a.id}/messages`)).data.messages.length, 2);
  } finally { await f.close(); }
});

test('SMS replies use one original sender, durable keys, authenticated status callbacks and uncertain duplicate protection', pg, async t => {
  const f = await fixture(t);
  try {
    await f.outbound(); await f.inbound(); const row = (await f.request('sms-inbox/conversations')).data.conversations[0], path = `sms-inbox/conversations/${row.id}/reply`, key = randomUUID();
    f.setHook(async (url, options) => { const form = new URLSearchParams(options.body), providerId = token('SM', 500); await f.callback(new URL(form.get('StatusCallback')).pathname, { MessageSid: providerId, MessageStatus: 'delivered', From: row.sender, To: row.recipient }); return Response.json({ sid: providerId, account_sid: f.env.TWILIO_ACCOUNT_SID, from: row.sender, to: row.recipient, status: 'queued' }); });
    const sent = await f.request(path, 'POST', { message: 'One support reply' }, key); assert.equal(sent.status, 200); assert.equal(sent.data.message.status, 'delivered'); assert.equal(new URLSearchParams(f.calls[0].body).get('From'), row.sender); assert.equal(new URLSearchParams(f.calls[0].body).get('To'), row.recipient);
    assert.equal((await f.request(path, 'POST', { message: 'One support reply' }, key)).status, 200); assert.equal(f.calls.length, 1);
    await assert.rejects(f.request(path, 'POST', { message: 'Changed' }, key), error => error.status === 409);
    await assert.rejects(f.request(path, 'POST', { message: 'Viewer' }, randomUUID(), 'a', 'viewer'), error => error.status === 403);
    for (const body of [{ message: '' }, { message: 'x'.repeat(1601) }, { message: 'Valid', to: '+12025550999' }, { message: ['invalid'] }]) await assert.rejects(f.request(path, 'POST', body), error => error.status === 400);
    f.setHook(() => { throw new Error('Mock lost acknowledgement'); }); const body = { message: 'Unconfirmed reply' }, uncertainKey = randomUUID();
    const uncertain = await f.request(path, 'POST', body, uncertainKey); assert.equal(uncertain.status, 409); assert.equal(uncertain.data.operation.status, 'uncertain'); const calls = f.calls.length;
    await assert.rejects(f.request(path, 'POST', body, uncertainKey), error => error.status === 409); const blocked = await f.request(path, 'POST', body); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(f.calls.length, calls);
    assert.equal((await f.request(`sms-inbox/conversations/${row.id}/messages`)).data.messages[0].status, 'uncertain');
  } finally { await f.close(); }
});

test('STOP survives deletion across projects, blocks replies and never reenables consent; media is account scoped', pg, async t => {
  const f = await fixture(t);
  try {
    await f.outbound(); await f.inbound(); const row = (await f.request('sms-inbox/conversations')).data.conversations[0];
    await f.contacts.save('b', { phone: row.recipient, consents: { sms: true }, consentSource: 'Prior opt-in' });
    await f.inbound({ MessageSid: token('SM', 901), Body: 'STOP' }, 'a'); assert.equal((await f.contacts.list('b'))[0].consents.sms, false); assert.ok((await f.contacts.list('b'))[0].suppression.sms);
    assert.equal((await f.request('sms-inbox/conversations')).data.conversations[0].blocked, true);
    await assert.rejects(f.request(`sms-inbox/conversations/${row.id}/reply`, 'POST', { message: 'Blocked' }), error => error.code === 'SMS_RECIPIENT_SUPPRESSED'); assert.equal(f.calls.length, 0);
    await f.inbound({ MessageSid: token('SM', 902), Body: 'Another question' }, 'a'); assert.equal((await f.contacts.save('a', { phone: row.recipient, consents: { sms: true }, consentSource: 'Cannot clear STOP' })).consents.sms, false);
    const mediaSid = token('MM', 903), mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${f.env.TWILIO_ACCOUNT_SID}/Messages/${mediaSid}/Media/${token('ME', 1)}`;
    await f.inbound({ MessageSid: mediaSid, Body: '', NumMedia: '1', MediaUrl0: mediaUrl, MediaContentType0: 'image/jpeg' }, 'a'); assert.equal((await f.request(`sms-inbox/conversations/${row.id}/messages`)).data.messages[0].attachments[0].url, mediaUrl);
    await assert.rejects(f.inbound({ MessageSid: token('MM', 904), NumMedia: '1', MediaUrl0: 'https://127.0.0.1/private', MediaContentType0: 'image/jpeg' }, 'a'), error => error.status === 400);
  } finally { await f.close(); }
});

test('Messaging Service replies pin the verified sender and live access or suppression changes stop acknowledgement', pg, async t => {
  const f = await fixture(t);
  try {
    f.env.TWILIO_MESSAGING_SERVICE_SID = token('MG', 1); const sender = '+12025550200'; await f.outbound('a', { sender, messagingServiceSid: f.env.TWILIO_MESSAGING_SERVICE_SID }); await f.inbound({ To: sender, MessagingServiceSid: f.env.TWILIO_MESSAGING_SERVICE_SID }, 'a');
    const row = (await f.request('sms-inbox/conversations')).data.conversations[0], path = `sms-inbox/conversations/${row.id}/reply`;
    const result = await f.request(path, 'POST', { message: 'Specific service sender' }); assert.equal(result.status, 200); const form = new URLSearchParams(f.calls[0].body); assert.equal(form.get('From'), sender); assert.equal(form.get('MessagingServiceSid'), f.env.TWILIO_MESSAGING_SERVICE_SID);
    f.setHook(() => { f.revoke(); return Response.json({ sid: token('SM', 501), account_sid: f.env.TWILIO_ACCOUNT_SID, from: sender, to: row.recipient, status: 'queued' }); });
    await assert.rejects(f.request(path, 'POST', { message: 'Access revoked during send' }), error => error.status === 403); f.restore();
    assert.equal((await f.request(`sms-inbox/conversations/${row.id}/messages`)).data.messages[0].status, 'uncertain');
    f.env.TWILIO_MESSAGING_SERVICE_SID = token('MG', 2); await assert.rejects(f.request(path, 'POST', { message: 'Changed connection' }), error => error.code === 'SMS_CONNECTION_CHANGED');
    f.setHook(null); await f.outbound('a', { sender, messagingServiceSid: f.env.TWILIO_MESSAGING_SERVICE_SID }); assert.equal((await f.request(path, 'POST', { message: 'New verified service routing' })).status, 200);
  } finally { await f.close(); }
});

test('signed STOP excludes future-project imports and campaign sends; START lifts only the opt-out and restores no campaign consent', pg, async t => {
  const f = await fixture(t);
  try {
    await f.outbound(); await f.inbound({ MessageSid: token('SM', 901), Body: 'STOP' });
    await f.pool.query("INSERT INTO workspaces (id, name) VALUES ('wf', 'Future'); INSERT INTO projects (id, workspace_id, name) VALUES ('future', 'wf', 'Future'); INSERT INTO memberships VALUES ('wf', 'owner', 'owner')");
    const contact = await f.contacts.save('future', { phone: '+12025550123', consents: { sms: true }, consentSource: 'New project signup cannot clear STOP' }); assert.equal(contact.consents.sms, false);
    await f.contacts.remove('future', contact.id); const imported = await f.contacts.import('future', { csv: 'phone,name\n+12025550123,Imported', consents: { sms: true }, consentSource: 'Imported opt-in cannot clear STOP' }); assert.equal(imported.contacts[0].consents.sms, false);
    await f.inbound({ MessageSid: token('SM', 902), Body: 'START' }); assert.equal((await f.contacts.list('future'))[0].consents.sms, false);
    assert.equal((await f.contacts.list('future'))[0].suppression.sms, undefined, 'The copied opt-out is lifted from the contact too.');
    const draft = await f.request('direct/campaigns', 'POST', { name: 'Blocked future campaign', channel: 'sms', text: 'Must not send' }, undefined, 'future'), id = draft.data.campaign.id;
    const preview = await f.request(`direct/campaigns/${id}/preview`, 'POST', {}, undefined, 'future'); assert.equal(preview.data.audience.eligible, 0);
    await assert.rejects(f.request(`direct/campaigns/${id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken }, undefined, 'future'), error => error.status === 400); await f.direct.processPending(); assert.equal(f.calls.length, 0);
    // Council decision ten98-code-system#35 Q3: START is the recipient's carrier-level re-opt-in, so replies resume, but
    // campaign consent stays off until a new consent source is recorded.
    await f.outbound('future'); const conversation = (await f.request('sms-inbox/conversations', 'GET', undefined, undefined, 'future')).data.conversations[0]; assert.equal(conversation.blocked, false);
    assert.equal((await f.request(`sms-inbox/conversations/${conversation.id}/reply`, 'POST', { message: 'Replies resume after START' }, undefined, 'future')).status, 200); assert.equal(f.calls.length, 1);
    await f.inbound({ MessageSid: token('SM', 903), Body: 'STOP' }); assert.equal((await f.request('sms-inbox/conversations', 'GET', undefined, undefined, 'future')).data.conversations[0].blocked, true, 'A later STOP applies again.');
  } finally { await f.close(); }
});

test('every signed START form lifts only an opt-out, never a manual suppression', pg, async t => {
  const f = await fixture(t);
  try {
    const phone = '+12025550123'; let sid = 910;
    for (const fields of [{ Body: 'START' }, { Body: ' unstop ' }, { Body: 'Yes' }, { Body: 'anything', OptOutType: 'START' }]) {
      await f.inbound({ MessageSid: token('SM', sid++), Body: 'STOP' }); assert.ok(await f.contacts.smsSuppression(phone));
      await f.inbound({ MessageSid: token('SM', sid++), ...fields }); assert.equal(await f.contacts.smsSuppression(phone), undefined, JSON.stringify(fields));
    }
    // A suppression with any other reason (manual, or recorded by an operator) is untouched by START.
    await f.contacts.suppressSmsGlobally(phone, 'Operator block'); await f.inbound({ MessageSid: token('SM', sid++), Body: 'START' });
    assert.equal((await f.contacts.smsSuppression(phone)).reason, 'Operator block');
    // An ordinary message that merely contains the word does not re-subscribe.
    await f.pool.query('DELETE FROM direct_sms_suppressions'); await f.inbound({ MessageSid: token('SM', sid++), Body: 'STOP' });
    await f.inbound({ MessageSid: token('SM', sid++), Body: 'please start again later' }); assert.ok(await f.contacts.smsSuppression(phone));
  } finally { await f.close(); }
});

test('Twilio HTTP 400 code 21610 creates durable global suppression for campaign and reply rejections without storing provider text', pg, async t => {
  for (const kind of ['campaign', 'reply']) {
    const f = await fixture(t);
    try {
      f.setHook(() => Response.json({ code: 21610, message: 'PRIVATE_PROVIDER_TEXT +12025550123', more_info: 'https://provider.invalid/private' }, { status: 400 }));
      if (kind === 'campaign') {
        await f.contacts.save('a', { phone: '+12025550123', consents: { sms: true }, consentSource: 'Prior explicit signup' });
        const draft = await f.request('direct/campaigns', 'POST', { name: 'Provider opt-out', channel: 'sms', text: 'Previously approved' }), id = draft.data.campaign.id, preview = await f.request(`direct/campaigns/${id}/preview`, 'POST', {});
        await f.request(`direct/campaigns/${id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken }); await f.direct.processPending();
      } else {
        await f.outbound(); const row = (await f.request('sms-inbox/conversations')).data.conversations[0], result = await f.request(`sms-inbox/conversations/${row.id}/reply`, 'POST', { message: 'Reply before learning opt-out' }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'PROVIDER_REJECTED'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_TEXT/);
      }
      assert.equal(f.calls.length, 1); assert.ok(await f.contacts.smsSuppression('+12025550123'));
      const ledger = JSON.stringify((await f.pool.query('SELECT * FROM direct_sms_suppressions')).rows); assert.doesNotMatch(ledger, /PRIVATE_PROVIDER_TEXT|12025550123/);
      await f.pool.query("INSERT INTO workspaces (id, name) VALUES ('wf', 'Future'); INSERT INTO projects (id, workspace_id, name) VALUES ('future', 'wf', 'Future'); INSERT INTO memberships VALUES ('wf', 'owner', 'owner')"); assert.equal((await f.contacts.save('future', { phone: '+12025550123', consents: { sms: true }, consentSource: 'New signup' })).consents.sms, false);
      const draft = await f.request('direct/campaigns', 'POST', { name: 'Future blocked', channel: 'sms', text: 'Must not send' }, undefined, 'future'); assert.equal((await f.request(`direct/campaigns/${draft.data.campaign.id}/preview`, 'POST', {}, undefined, 'future')).data.audience.eligible, 0); await f.direct.processPending(); assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  }
});

test('signed 21610 delivery callbacks suppress campaign and inbox destinations for future projects', pg, async t => {
  for (const kind of ['campaign', 'reply']) {
    const f = await fixture(t);
    try {
      let delivery;
      if (kind === 'campaign') {
        await f.contacts.save('a', { phone: '+12025550123', consents: { sms: true }, consentSource: 'Prior signup' });
        const draft = await f.request('direct/campaigns', 'POST', { name: 'Callback opt-out', channel: 'sms', text: 'Approved notice' }), id = draft.data.campaign.id, preview = await f.request(`direct/campaigns/${id}/preview`, 'POST', {});
        await f.request(`direct/campaigns/${id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken }); await f.direct.processPending(); delivery = (await f.request(`direct/campaigns/${id}`)).data.deliveries[0];
      } else delivery = await f.outbound();
      await f.callback(`/api/webhooks/twilio/status/${delivery.id}`, { MessageSid: delivery.providerId, MessageStatus: 'undelivered', To: '+12025550123', From: f.env.TWILIO_FROM_NUMBER, ErrorCode: '21610' });
      await f.pool.query("INSERT INTO workspaces (id, name) VALUES ('wf', 'Future'); INSERT INTO projects (id, workspace_id, name) VALUES ('future', 'wf', 'Future')"); assert.equal((await f.contacts.save('future', { phone: '+12025550123', consents: { sms: true }, consentSource: 'Cannot override provider opt-out' })).consents.sms, false);
    } finally { await f.close(); }
  }
});

test('SMS history pagination is bounded, complete and conversation scoped', pg, async t => {
  const f = await fixture(t);
  try {
    await f.outbound(); await f.inbound(); for (let index = 0; index < 105; index++) await f.outbound('a', { message: 'Follow-up ' + index });
    const row = (await f.request('sms-inbox/conversations')).data.conversations[0], first = await f.request(`sms-inbox/conversations/${row.id}/messages`); assert.equal(first.data.messages.length, 100); assert.equal(first.data.pagination.hasMore, true);
    const second = await f.request(`sms-inbox/conversations/${row.id}/messages?cursor=${first.data.pagination.nextCursor}`); assert.equal(second.data.messages.length, 7); assert.equal(second.data.pagination.hasMore, false); assert.equal(new Set([...first.data.messages, ...second.data.messages].map(item => item.id)).size, 107);
    await assert.rejects(f.request(`sms-inbox/conversations/${row.id}/messages?cursor=-1`), error => error.status === 400);
  } finally { await f.close(); }
});

test('Cloudflare Reply-To is optional, validated, saved and sent using the official reply_to field', pg, async t => {
  const f = await fixture(t);
  try {
    const settings = await createIntegrationSettings({ db: f.db, env: f.env, secret: 'settings-fixture-secret-with-enough-entropy' }); await settings.save('cloudflareEmail', { replyToAddress: 'group@example.com' });
    assert.equal((await settings.describe()).providers.find(row => row.id === 'cloudflareEmail').fields.replyToAddress, 'group@example.com'); await assert.rejects(async () => settings.save('cloudflareEmail', { replyToAddress: 'bad\naddress@example.com' }), error => error.status === 400);
    Object.assign(f.env, { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'mock-token', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'service@example.com' });
    f.setHook((url, options) => { const body = JSON.parse(options.body); assert.equal(body.reply_to, 'group@example.com'); return Response.json({ success: true, result: { message_id: 'email-1', delivered: [], queued: body.to, permanent_bounces: [] } }); });
    await sendDirect({ channel: 'email', env: f.env, campaign: { emailPurpose: 'transactional', subject: 'Receipt', text: 'Requested receipt' }, contact: { email: 'person@example.com' } });
  } finally { await f.close(); }
});

// Restarting needs a second app on the same database, so this test injects one database into both apps instead of using testApp.
test('actual HTTP campaign sends, signed replies and receipts survive restart without replaying an interrupted reply', pg, async t => {
  const { pool, db } = await testDatabase(t), database = { pool, db };
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-sms-http-')), origin = 'https://campaign.example.test', env = { TWILIO_ACCOUNT_SID: token('AC', 1), TWILIO_AUTH_TOKEN: 'sms-http-fixture-secret', TWILIO_FROM_NUMBER: '+12025550100' }, originalFetch = globalThis.fetch;
  let app = await createApp({ dataDir, env, appUrl: origin, directScheduler: false, database }), cookie, base, writes = 0;
  globalThis.fetch = async (target, options = {}) => { const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options); assert.equal(url.hostname, 'api.twilio.com'); writes++; const body = new URLSearchParams(options.body); assert.equal(body.get('From'), env.TWILIO_FROM_NUMBER); assert.equal(body.get('To'), '+12025550123'); return Response.json({ sid: token('SM', 499 + writes), account_sid: env.TWILIO_ACCOUNT_SID, from: body.get('From'), to: body.get('To'), status: 'queued' }); };
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; }
  try {
    await listen();
    async function request(path, method = 'GET', body, options = {}) { const result = await fetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: result.status, data: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0] }; }
    const setup = await request('/api/auth/setup', 'POST', { name: 'SMS owner', email: 'sms-owner@example.test', password: 'sms fixture long passphrase' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
    const projectId = setup.data.projectId, path = `/api/projects/${projectId}/sms-inbox`;
    assert.equal((await request(`/api/projects/${projectId}/direct/contacts`, 'POST', { name: 'SMS test recipient', phone: '+12025550123', consents: { sms: true }, consentSource: 'Isolated test opt-in' })).status, 201);
    const draft = await request(`/api/projects/${projectId}/direct/campaigns`, 'POST', { name: 'HTTP campaign', channel: 'sms', text: 'Your requested service update.' }); assert.equal(draft.status, 201);
    const campaignPath = `/api/projects/${projectId}/direct/campaigns/${draft.data.campaign.id}`, preview = await request(campaignPath + '/preview', 'POST', {}); assert.equal(preview.data.audience.eligible, 1);
    assert.equal((await request(campaignPath + '/send', 'POST', { confirmed: true, previewToken: preview.data.previewToken })).status, 200); await app.direct.processPending(); assert.equal(writes, 1);
    async function callback(path, fields) { const body = new URLSearchParams({ AccountSid: env.TWILIO_ACCOUNT_SID, ...fields }), signature = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(origin + path + [...body.keys()].sort().map(key => key + body.get(key)).join('')).digest('base64'); return originalFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body }); }
    const inbound = await callback(`/api/webhooks/twilio/inbound/${projectId}`, { MessageSid: token('SM', 200), From: '+12025550123', To: env.TWILIO_FROM_NUMBER, Body: 'Please help', NumMedia: '0' }); assert.equal(inbound.status, 200);
    const conversation = (await request(path + '/conversations')).data.conversations[0]; assert.equal(conversation.lastMessage, 'Please help'); assert.equal((await request(path + `/conversations/${conversation.id}/messages`)).data.messages.length, 2);
    assert.equal((await request(path + '/conversations', 'GET', undefined, { headers: { Cookie: '' } })).status, 401);
    await pool.query("UPDATE memberships SET role = 'viewer'"); assert.equal((await request(path + `/conversations/${conversation.id}/reply`, 'POST', { message: 'Cannot send' }, { headers: { 'Idempotency-Key': randomUUID() } })).status, 403); assert.equal(writes, 1); await pool.query("UPDATE memberships SET role = 'owner'");
    const key = randomUUID(), reply = await request(path + `/conversations/${conversation.id}/reply`, 'POST', { message: 'One reply' }, { headers: { 'Idempotency-Key': key } }); assert.equal(reply.status, 200); assert.equal(writes, 2);
    assert.equal((await request(path + `/conversations/${conversation.id}/reply`, 'POST', { message: 'One reply' }, { headers: { 'Idempotency-Key': key } })).status, 200); assert.equal(writes, 2);
    // Simulate a crash after the provider accepted the request but before its acknowledgement was saved.
    await pool.query(`UPDATE sms_messages SET provider_id = NULL, data = (data::jsonb || '{"providerId": null, "status": "sending", "deliveryStatus": "sending"}'::jsonb)::json WHERE id = $1`, [reply.data.message.id]);
    await pool.query("UPDATE integration_operations SET status = 'pending', response = NULL, http_status = NULL WHERE request_key = $1", [key]);
    await app.close(); app = await createApp({ dataDir, env, appUrl: origin, directScheduler: false, database }); await listen();
    const restored = await request(path + `/conversations/${conversation.id}/messages`); assert.equal(restored.status, 200); assert.equal(restored.data.messages.length, 3); assert.equal(restored.data.messages[0].status, 'uncertain');
    for (const retryKey of [key, randomUUID()]) assert.equal((await request(path + `/conversations/${conversation.id}/reply`, 'POST', { message: 'One reply' }, { headers: { 'Idempotency-Key': retryKey } })).status, 409);
    assert.equal(writes, 2);
    assert.equal((await callback(`/api/webhooks/twilio/status/${reply.data.message.id}`, { MessageSid: token('SM', 501), MessageStatus: 'delivered', From: env.TWILIO_FROM_NUMBER, To: '+12025550123' })).status, 200);
    assert.equal((await request(path + `/conversations/${conversation.id}/messages`)).data.messages[0].status, 'delivered');
  } finally { await app.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});
