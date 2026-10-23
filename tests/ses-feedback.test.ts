import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

type Fields = Record<string, any>;

// ten98-campaign#77: Amazon SES sends direct email through @ten98/runtime's sendSesEmail, and its SNS feedback is verified
// by verifySnsMessage and classified by classifyEmailFeedback. Campaign owns the settings, storage, counters and alerts.
// Stubbed transports only: nothing here reaches AWS.

// A throwaway self-signed certificate stands in for the AWS SNS signing certificate. Ported from ten98-code-system
// tests/sns-notification.test.mjs at v0.1.17 (a89c1b4), MIT.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? Buffer.from([body.length]) : ((bytes: number[]) => Buffer.from([0x80 | bytes.length, ...bytes]))([...Buffer.from(body.length.toString(16).padStart(body.length > 255 ? 4 : 2, '0'), 'hex')]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
const utcTime = (ms: number) => der(0x17, Buffer.from(new Date(ms).toISOString().replace(/^\d\d|[-:T]|\.\d+/g, ''), 'ascii'));
function selfSignedPem(notBefore: number, notAfter: number) {
  const sha256WithRsa = der(0x30, oid('2a864886f70d01010b'), Buffer.from([0x05, 0x00]));
  const name = der(0x30, der(0x31, der(0x30, oid('550403'), der(0x0c, Buffer.from('sns.amazonaws.com')))));
  const tbs = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), sha256WithRsa, name, der(0x30, utcTime(notBefore), utcTime(notAfter)), name, publicKey.export({ type: 'spki', format: 'der' }));
  const cert = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.from([0]), createSign('sha256').update(tbs).sign(privateKey)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}
const pem = selfSignedPem(Date.now() - 86400000, Date.now() + 86400000);
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-feedback', CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem';
const SIGNED: Record<string, string[]> = { Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'], SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] };
function envelope(fields: Fields, key: KeyObject = privateKey) {
  const body: Fields = { MessageId: randomUUID(), TopicArn: TOPIC, Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: CERT_URL, ...fields };
  const text = SIGNED[body.Type].filter(name => body[name] !== undefined).map(name => `${name}\n${body[name]}\n`).join('');
  return JSON.stringify({ ...body, Signature: createSign('RSA-SHA256').update(text).sign(key, 'base64') });
}
const notification = (message: Fields, fields: Fields = {}) => envelope({ Type: 'Notification', Message: JSON.stringify(message), ...fields });
const bounce = (messageId: string, recipient: string, bounceType: string, bounceSubType: string, extra: Fields = {}): Fields => ({ notificationType: 'Bounce', mail: { messageId, timestamp: new Date().toISOString(), destination: [recipient] }, bounce: { bounceType, bounceSubType, feedbackId: randomUUID(), timestamp: new Date().toISOString(), bouncedRecipients: [{ emailAddress: recipient, ...extra }] } });

const SES: Fields = { EMAIL_PROVIDER: 'ses', AWS_SES_REGION: 'us-east-1', AWS_SES_ACCESS_KEY_ID: 'AKIAFIXTUREKEY000000', AWS_SES_SECRET_ACCESS_KEY: 'fixture-secret-access-key-0000000000000000', AWS_SES_FROM_ADDRESS: 'receipts@example.com', AWS_SES_FROM_NAME: 'Équipe Receipts', AWS_SES_CONFIGURATION_SET: 'campaign-feedback', AWS_SES_SNS_TOPIC_ARN: TOPIC };

async function fixture(t: TestContext, sesEnv: Fields = SES) {
  const origin = 'https://campaign.example.test', env: Fields = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'test-cloudflare-token', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'receipts@example.com', ...sesEnv };
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-ses-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, env, appUrl: origin, directScheduler: false }), originalFetch = globalThis.fetch, calls: { url: URL; options: any }[] = [];
  let sesResponse: (body: Fields) => Response = () => Response.json({ MessageId: 'ses-' + randomUUID() });
  globalThis.fetch = async (target: any, options: any = {}) => {
    const url = new URL(target);
    if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    calls.push({ url, options });
    if (url.href === 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails' && options.method === 'POST') return sesResponse(JSON.parse(options.body));
    if (url.href === CERT_URL) return new Response(pem);
    if (url.origin === 'https://sns.us-east-1.amazonaws.com' && url.searchParams.get('Action') === 'ConfirmSubscription') return new Response('<ConfirmSubscriptionResponse/>');
    throw new Error('Unexpected provider request: ' + url.href);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; let cookie: string | undefined;
  async function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: any; cookie?: string }> {
    const response = await fetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'QA owner', email: 'ses-owner@example.test', password: 'fixture-passphrase-long-enough' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
  const path = `/api/projects/${setup.data.projectId}/direct`;
  const person = async (email: string) => { const result = await request(path + '/contacts', 'POST', { name: 'Robin', email, consents: { email: true }, consentSource: 'Customer request, recorded in CRM' }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.contact; };
  const contact = async (id: string) => (await request(path + '/contacts')).data.contacts.find((row: Fields) => row.id === id);
  // Sends one email campaign to `people` and returns its deliveries.
  async function send(people: Fields[]) {
    const created = await request(path + '/campaigns', 'POST', { name: 'Receipt', channel: 'email', subject: 'Your receipt', text: 'Thank you.', html: '<p>Thank you.</p>', contactIds: people.map((row: Fields) => row.id) }); assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.campaign.id, preview = await request(path + `/campaigns/${id}/preview`, 'POST', {});
    assert.equal((await request(path + `/campaigns/${id}/send`, 'POST', { confirmed: true, transactionalConfirmed: true, previewToken: preview.data.previewToken })).status, 200);
    // The worker sends one email recipient per pass.
    for (const _ of people) await app.direct.processPending();
    return (await request(path + `/campaigns/${id}`)).data;
  }
  const sns = async (body: string) => { const response = await fetch(base + '/api/webhooks/ses/sns', { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': JSON.parse(body).Type }, body }); return { status: response.status, body: await response.text() }; };
  return { app, env, path, calls, request, person, contact, send, sns, pool: app.database.pool, setSesResponse(value: (body: Fields) => Response) { sesResponse = value; } };
}

test('SES sends signed direct email with its sender, configuration set, unsubscribe headers and correlation tag', { skip: postgresSkip }, async t => {
  const f = await fixture(t), alex = await f.person('alex@example.com');
  const status = (await f.request(f.path + '/status')).data;
  assert.equal(status.emailProvider, 'ses'); assert.equal(status.providers.email, true); assert.equal(status.sesWebhookUrl, 'https://campaign.example.test/api/webhooks/ses/sns');
  const { campaign, deliveries } = await f.send([alex]);
  assert.equal(campaign.emailProvider, 'ses'); assert.equal(deliveries[0].status, 'accepted'); assert.match(deliveries[0].providerId, /^ses-/);
  const sent = f.calls.filter(call => call.url.hostname === 'email.us-east-1.amazonaws.com'), body = JSON.parse(sent[0].options.body);
  assert.equal(sent.length, 1); assert.equal(f.calls.some(call => call.url.hostname === 'api.cloudflare.com'), false, 'Cloudflare is not used, not even for its suppression list.');
  assert.match(sent[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAFIXTUREKEY000000\/\d{8}\/us-east-1\/ses\/aws4_request, /);
  assert.equal(body.FromEmailAddress, `=?UTF-8?B?${Buffer.from('Équipe Receipts').toString('base64')}?= <receipts@example.com>`);
  assert.deepEqual(body.Destination, { ToAddresses: ['alex@example.com'] }); assert.equal(body.ConfigurationSetName, 'campaign-feedback');
  assert.deepEqual(body.EmailTags, [{ Name: 'idempotency-key', Value: deliveries[0].id }]);
  assert.ok(body.Content.Simple.Headers.some((header: Fields) => header.Name === 'List-Unsubscribe' && header.Value.startsWith('<https://campaign.example.test/api/direct/unsubscribe/')));
  assert.match(body.Content.Simple.Body.Text.Data, /Manage email preferences: https:\/\/campaign\.example\.test\//);
  assert.equal(JSON.stringify(f.calls.map(call => call.url.href)).includes(SES.AWS_SES_SECRET_ACCESS_KEY), false);
});

test('SES uncertain, throttled and sender-blocked sends stop the campaign for review instead of resending', { skip: postgresSkip }, async t => {
  const f = await fixture(t), people = [await f.person('one@example.com'), await f.person('two@example.com')];
  const cases: [() => Response, string, RegExp][] = [[() => new Response('{}', { status: 500 }), 'uncertain', /did not confirm/], [() => new Response('{}', { status: 429 }), 'failed', /throttling/], [() => new Response('{}', { status: 400, headers: { 'x-amzn-ErrorType': 'AccountSuspendedException' } }), 'failed', /refused this sender/]];
  for (const [response, status, error] of cases) {
    f.setSesResponse(response); const { campaign, deliveries } = await f.send(people);
    assert.equal(campaign.status, 'attention'); assert.match(campaign.lastError, error);
    assert.deepEqual(deliveries.map((row: Fields) => row.status), [status, 'pending'], 'The second recipient is not tried.');
  }
});

test('SNS feedback is verified and applied once: bounces, complaints, transient accumulation, policy and undetermined alerts', { skip: postgresSkip }, async t => {
  const f = await fixture(t), emails = ['gone@example.com', 'full@example.com', 'policy@example.com', 'odd@example.com', 'angry@example.com', 'blocked@example.com'];
  const people = []; for (const email of emails) people.push(await f.person(email));
  const { campaign, deliveries } = await f.send(people), id = Object.fromEntries(deliveries.map((row: Fields) => [row.recipient, row.providerId]));
  const [gone, full, policy, odd, angry, blocked] = people;
  // Refusals: bad signature, another topic, a stale timestamp and an unsigned body change nothing.
  for (const body of [envelope({ Type: 'Notification', Message: JSON.stringify(bounce(id[gone.email], gone.email, 'Permanent', 'General')) }, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), notification(bounce(id[gone.email], gone.email, 'Permanent', 'General'), { TopicArn: 'arn:aws:sns:us-east-1:123456789012:other' }), notification(bounce(id[gone.email], gone.email, 'Permanent', 'General'), { Timestamp: '2020-01-01T00:00:00.000Z' }), '{"Type":"Notification"}']) {
    assert.deepEqual(await f.sns(body), { status: 400, body: '{}' });
  }
  assert.equal((await f.contact(gone.id)).consents.email, true);
  // A permanent bounce suppresses; the same SNS message redelivered is acknowledged without being applied again.
  const hard = notification(bounce(id[gone.email], gone.email, 'Permanent', 'General', { status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }));
  assert.equal((await f.sns(hard)).status, 200); assert.equal((await f.sns(hard)).status, 200);
  const suppressed = await f.contact(gone.id); assert.deepEqual([suppressed.consents.email, suppressed.suppression.email.reason], [false, 'hard-bounce']);
  // Transient bounces count per provider event: two, plus a redelivery of the second under a new SNS MessageId, do not suppress; the third does.
  const transient = () => bounce(id[full.email], full.email, 'Transient', 'MailboxFull', { status: '4.2.2' });
  const second = transient();
  for (const message of [transient(), second, second]) assert.equal((await f.sns(notification(message))).status, 200);
  assert.equal((await f.contact(full.id)).suppression.email, undefined, 'Two transient bounces do not suppress.');
  assert.equal((await f.sns(notification(transient()))).status, 200);
  assert.equal((await f.contact(full.id)).suppression.email.reason, 'repeated-transient-bounce');
  // A 5.7.x policy rejection and an undetermined bounce alert without suppressing the recipient.
  assert.equal((await f.sns(notification(bounce(id[policy.email], policy.email, 'Permanent', 'General', { status: '5.7.1', diagnosticCode: 'smtp; 550 5.7.1 message rejected by policy' })))).status, 200);
  assert.equal((await f.sns(notification(bounce(id[odd.email], odd.email, 'Undetermined', 'Undetermined')))).status, 200);
  for (const person of [policy, odd]) { const row = await f.contact(person.id); assert.deepEqual([row.consents.email, row.suppression.email], [true, undefined]); }
  const alerts = (await f.request(f.path + '/status')).data.deliverabilityAlerts.map(({ provider, kind, contacts }: Fields) => ({ provider, kind, contacts }));
  assert.deepEqual(alerts, [{ provider: 'ses', kind: 'policy', contacts: 1 }, { provider: 'ses', kind: 'undetermined', contacts: 1 }]);
  // A complaint suppresses; an address already on the SES account suppression list only marks the delivery.
  assert.equal((await f.sns(notification({ notificationType: 'Complaint', mail: { messageId: id[angry.email] }, complaint: { complainedRecipients: [{ emailAddress: angry.email }], complaintFeedbackType: 'abuse', feedbackId: randomUUID(), timestamp: new Date().toISOString() } }))).status, 200);
  assert.equal((await f.contact(angry.id)).suppression.email.reason, 'complaint');
  assert.equal((await f.sns(notification(bounce(id[blocked.email], blocked.email, 'Permanent', 'OnAccountSuppressionList')))).status, 200);
  assert.equal((await f.contact(blocked.id)).consents.email, true);
  const after = (await f.request(f.path + `/campaigns/${campaign.id}`)).data.deliveries, by = Object.fromEntries(after.map((row: Fields) => [row.recipient, row.status]));
  assert.deepEqual([by[gone.email], by[blocked.email], by[angry.email]], ['failed', 'suppressed', 'accepted']);
  // Feedback for a message no campaign sent changes nothing.
  assert.equal((await f.sns(notification(bounce('unknown-message', 'stranger@example.com', 'Permanent', 'General')))).status, 200);
});

test('SNS messages with another certificate host or path, or SignatureVersion 1, are refused before any certificate fetch', { skip: postgresSkip }, async t => {
  const f = await fixture(t), robin = await f.person('robin@example.com'), { deliveries } = await f.send([robin]), message = bounce(deliveries[0].providerId, robin.email, 'Permanent', 'General');
  const before = f.calls.length;
  for (const fields of [{ SigningCertURL: 'https://sns.us-east-1.amazonaws.com.attacker.example/SimpleNotificationService-fixture.pem' }, { SigningCertURL: 'https://attacker.example/SimpleNotificationService-fixture.pem' }, { SigningCertURL: 'https://sns.us-east-1.amazonaws.com/a/SimpleNotificationService-fixture.pem' }, { SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem?x=1' }, { SignatureVersion: '1' }]) {
    assert.deepEqual(await f.sns(notification(message, fields)), { status: 400, body: '{}' }, JSON.stringify(fields));
  }
  assert.equal(f.calls.length, before, 'Nothing was fetched for a refused message.'); assert.equal((await f.contact(robin.id)).consents.email, true);
});

test('transient bounces count only within seven days of each other, and concurrent ones still reach the threshold', { skip: postgresSkip }, async t => {
  const f = await fixture(t), late = await f.person('late@example.com'), busy = await f.person('busy@example.com'), { deliveries } = await f.send([late, busy]), id = Object.fromEntries(deliveries.map((row: Fields) => [row.recipient, row.providerId]));
  const at = (email: string, time: number) => { const message = bounce(id[email], email, 'Transient', 'General'); message.bounce.timestamp = new Date(time).toISOString(); return notification(message); };
  const now = Date.now(), day = 86400000;
  // The first is a minute outside the window of the third, so the third makes only two in seven days.
  for (const time of [now - 7 * day - 60000, now - day, now]) assert.equal((await f.sns(at(late.email, time))).status, 200);
  assert.equal((await f.contact(late.id)).suppression.email, undefined);
  assert.equal((await f.sns(at(late.email, now))).status, 200);
  assert.equal((await f.contact(late.id)).suppression.email.reason, 'repeated-transient-bounce');
  // One counted, then two at once: the recipient lock makes the later of the two see both earlier bounces.
  assert.equal((await f.sns(at(busy.email, now - day))).status, 200);
  const results = await Promise.all([f.sns(at(busy.email, now)), f.sns(at(busy.email, now))]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal((await f.contact(busy.id)).suppression.email?.reason, 'repeated-transient-bounce');
});

test('a failed feedback write leaves nothing behind, so the redelivered message is applied in full', { skip: postgresSkip }, async t => {
  const f = await fixture(t), full = await f.person('full@example.com'), { deliveries } = await f.send([full]), providerId = deliveries[0].providerId;
  const transient = () => notification(bounce(providerId, full.email, 'Transient', 'MailboxFull'));
  for (let index = 0; index < 2; index++) assert.equal((await f.sns(transient())).status, 200);
  const third = transient(), suppress = f.app.direct.contacts.suppressDestination;
  f.app.direct.contacts.suppressDestination = async () => { throw new Error('storage unavailable'); };
  assert.equal((await f.sns(third)).status, 500, 'SNS is asked to redeliver.');
  f.app.direct.contacts.suppressDestination = suppress;
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM direct_email_feedback`)).rows[0].n, 2, 'The third bounce was not counted.');
  assert.equal((await f.sns(third)).status, 200);
  assert.equal((await f.contact(full.id)).suppression.email.reason, 'repeated-transient-bounce');
});

test('feedback for an earlier SES send still applies after the installation switches to Cloudflare', { skip: postgresSkip }, async t => {
  const f = await fixture(t), gone = await f.person('gone@example.com'), { deliveries } = await f.send([gone]);
  f.env.EMAIL_PROVIDER = 'cloudflare';
  assert.equal((await f.sns(notification(bounce(deliveries[0].providerId, gone.email, 'Permanent', 'General')))).status, 200);
  assert.equal((await f.contact(gone.id)).suppression.email.reason, 'hard-bounce');
});

test('with both email providers configured, sending waits for EMAIL_PROVIDER, which then picks the provider', { skip: postgresSkip }, async t => {
  const f = await fixture(t, { ...SES, EMAIL_PROVIDER: undefined }), robin = await f.person('robin@example.com');
  const status = (await f.request(f.path + '/status')).data; assert.deepEqual([status.emailProvider, status.providers.email], [null, false]);
  const created = await f.request(f.path + '/campaigns', 'POST', { name: 'Receipt', channel: 'email', subject: 'Receipt', text: 'Thanks.', contactIds: [robin.id] }), preview = await f.request(f.path + `/campaigns/${created.data.campaign.id}/preview`, 'POST', {});
  const refused = await f.request(f.path + `/campaigns/${created.data.campaign.id}/send`, 'POST', { confirmed: true, transactionalConfirmed: true, previewToken: preview.data.previewToken });
  assert.deepEqual([refused.status, refused.data.error.code], [409, 'EMAIL_PROVIDER_REQUIRED']); assert.equal(f.calls.length, 0);
  f.env.EMAIL_PROVIDER = 'cloudflare'; assert.equal((await f.request(f.path + '/status')).data.emailProvider, 'cloudflare');
  f.env.EMAIL_PROVIDER = 'ses'; const { campaign } = await f.send([robin]); assert.equal(campaign.emailProvider, 'ses');
});

test('SNS subscription is confirmed only for the configured topic, and the webhook is closed until SES is configured', { skip: postgresSkip }, async t => {
  const f = await fixture(t), confirm = (topic: string) => envelope({ Type: 'SubscriptionConfirmation', Token: 'token', TopicArn: topic, Message: 'Confirm', SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${topic}&Token=token` });
  assert.equal((await f.sns(confirm('arn:aws:sns:us-east-1:123456789012:other'))).status, 400);
  assert.equal(f.calls.some(call => call.url.searchParams.get('Action') === 'ConfirmSubscription'), false);
  assert.equal((await f.sns(confirm(TOPIC))).status, 200);
  assert.equal(f.calls.filter(call => call.url.searchParams.get('Action') === 'ConfirmSubscription').length, 1);
  const closed = await fixture(t, {});
  assert.equal((await closed.sns(confirm(TOPIC))).status, 503);
});
