import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformWithOxc } from 'vite';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const sid = (prefix, number) => prefix + String(number).padStart(32, '0');

test('protected SMS media downloads use project access and server-held credentials without leaking provider locations or accepting arbitrary URLs', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-sms-media-')), origin = 'https://campaign.example.test';
  const env = { TWILIO_ACCOUNT_SID: sid('AC', 1), TWILIO_AUTH_TOKEN: 'PRIVATE_MEDIA_AUTH_TOKEN', TWILIO_FROM_NUMBER: '+12025550100' };
  const app = await testApp(t, { dataDir, env, appUrl: origin, directScheduler: false }), originalFetch = globalThis.fetch, calls = [], bytes = Buffer.from('synthetic JPEG content');
  let cookie, mode = 'direct', hook;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    calls.push({ url: url.href, headers: options.headers });
    if (url.hostname === 'mms.twiliocdn.com') { assert.equal(options.headers?.Authorization, undefined); assert.equal(options.redirect, 'error'); return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } }); }
    assert.equal(url.hostname, 'api.twilio.com'); assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')); assert.equal(options.redirect, 'manual');
    if (hook) await hook();
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://mms.twiliocdn.com/private/signed-file?signature=PRIVATE_SIGNED_URL' } });
    if (mode === 'bad-redirect') return new Response(null, { status: 302, headers: { Location: 'https://localhost/private' } });
    if (mode === 'provider-error') return new Response('PRIVATE_PROVIDER_ERROR', { status: 401 });
    if (mode === 'wrong-type') return new Response('PRIVATE_PROVIDER_ERROR', { headers: { 'Content-Type': 'text/html' } });
    if (mode === 'too-large') return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(21 * 1024 * 1024) } });
    if (mode === 'oversized-stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(21 * 1024 * 1024)); controller.close(); } }), { headers: { 'Content-Type': 'image/jpeg' } });
    return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, auth = cookie) {
    return originalFetch(base + path, { method, headers: { Origin: origin, ...(auth ? { Cookie: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'SMS media operator', email: 'sms-media@example.test', password: 'isolated fixture passphrase' });
    assert.equal(setup.status, 201); cookie = setup.headers.get('set-cookie').split(';')[0]; const { workspaceId, user } = await setup.json(), projectId = await firstProject(app, { status: setup.status, data: { workspaceId }, cookie });
    await app.smsInbox.recordOutbound({ id: randomUUID(), projectId, accountSid: env.TWILIO_ACCOUNT_SID, sender: env.TWILIO_FROM_NUMBER, recipient: '+12025550123', providerId: sid('SM', 10), message: 'Original campaign message' });
    const messageSid = sid('MM', 11), mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${messageSid}/Media/${sid('ME', 1)}`;
    const incomingPath = `/api/webhooks/twilio/inbound/${projectId}`, form = new URLSearchParams({ AccountSid: env.TWILIO_ACCOUNT_SID, MessageSid: messageSid, From: '+12025550123', To: env.TWILIO_FROM_NUMBER, Body: 'Please review this image', NumMedia: '1', MediaUrl0: mediaUrl, MediaContentType0: 'image/jpeg' });
    const signature = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(origin + incomingPath + [...form.keys()].sort().map(key => key + form.get(key)).join('')).digest('base64');
    const receive = value => originalFetch(base + incomingPath, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': value }, body: form });
    assert.equal((await receive('invalid')).status, 401); assert.equal((await receive(signature)).status, 200);
    const message = await app.sql.get('SELECT id,data FROM sms_messages WHERE provider_id=?', messageSid), mediaPath = `/api/projects/${projectId}/sms-inbox/media/${message.id}/0`;
    assert.equal(calls.length, 0, 'Receiving and reading attachment references must not download files implicitly.');
    assert.equal((await request(mediaPath, 'GET', undefined, '')).status, 401);
    const other = await (await request('/api/workspaces', 'POST', { name: 'Another project' })).json();
    assert.equal((await request(mediaPath.replace(projectId, other.projectId))).status, 404); assert.equal((await request(mediaPath.replace('/0', '/1'))).status, 404); assert.equal(calls.length, 0);
    for (const role of ['owner', 'viewer']) {
      await app.sql.run('UPDATE memberships SET role=? WHERE user_id=? AND workspace_id=(SELECT workspace_id FROM projects WHERE id=?)', role, user.id, projectId);
      for (mode of ['direct', 'redirect']) {
        const result = await request(mediaPath); assert.equal(result.status, 200, await result.clone().text()); assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
        assert.equal(result.headers.get('content-type'), 'image/jpeg'); assert.match(result.headers.get('content-disposition'), /^attachment; filename="sms-attachment\.jpeg"$/); assert.equal(result.headers.get('cache-control'), 'private, no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(result.headers.get('location'), null);
        assert.doesNotMatch(JSON.stringify([...result.headers]), /PRIVATE_/);
      }
    }
    for (mode of ['bad-redirect', 'provider-error', 'wrong-type', 'too-large', 'oversized-stream']) {
      const before = calls.length, result = await request(mediaPath); assert.equal(result.status, 502, mode); assert.doesNotMatch(await result.text(), /PRIVATE_/); assert.equal(calls.length, before + 1, 'Rejected media must not fetch an arbitrary redirect target.');
    }
    const stored = structuredClone(message.data); stored.attachments[0].url = 'https://localhost/private'; await app.sql.run('UPDATE sms_messages SET data=? WHERE id=?', JSON.stringify(stored), message.id);
    const before = calls.length; assert.equal((await request(mediaPath)).status, 502); assert.equal(calls.length, before);
    stored.attachments[0].url = mediaUrl; await app.sql.run('UPDATE sms_messages SET data=? WHERE id=?', JSON.stringify(stored), message.id); mode = 'direct';
    hook = async () => { await app.sql.run('DELETE FROM memberships WHERE user_id=? AND workspace_id=(SELECT workspace_id FROM projects WHERE id=?)', user.id, projectId); };
    const revoked = await request(mediaPath); assert.equal(revoked.status, 404); assert.doesNotMatch(await revoked.text(), /synthetic JPEG/);
    await app.sql.run("INSERT INTO memberships VALUES((SELECT workspace_id FROM projects WHERE id=?),?,'owner')", projectId, user.id);
    hook = async () => { const result = await request('/api/settings/integrations/twilio', 'PUT', { fields: { authToken: 'REPLACED_PRIVATE_MEDIA_AUTH_TOKEN' } }); assert.equal(result.status, 200); };
    const changed = await request(mediaPath); assert.equal(changed.status, 409); assert.doesNotMatch(await changed.text(), /synthetic JPEG/);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('SMS attachments link to their authenticated app download while generic inbox attachments retain HTTPS-only provider links', async () => {
  const source = await readFile(new URL('../src/UnifiedInbox.tsx', import.meta.url), 'utf8'), start = source.indexOf('function Attachment('), end = source.indexOf('\nfunction ZernioInbox(', start);
  const { code } = await transformWithOxc(source.slice(start, end), 'Attachment.tsx', { jsx: { runtime: 'classic' } });
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }, link = value => { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
  const ui = await import('@ten98/ui'), media = [ui.Image, ui.MediaPlayer, 'img', 'video', 'audio'];
  const Attachment = new Function('React', 'useState', 'link', ...Object.keys(ui), code + '\nreturn Attachment;')(React, () => [false, () => {}], link, ...Object.values(ui)), flatten = node => node && typeof node === 'object' ? [node, ...node.children.flat(Infinity).flatMap(flatten)] : [];
  const path = '/api/projects/a/sms-inbox/media/verified-message/0', item = { type: 'image', url: 'https://api.twilio.com/protected' }, download = flatten(Attachment({ item, downloadUrl: path }));
  assert.equal(download.find(node => node.type === ui.Link).props.href, path); assert.equal(download.some(node => media.includes(node.type)), false); assert.match(download.find(node => node.type === ui.Link).children.join(''), /Download image/);
  assert.equal(flatten(Attachment({ item: { url: '/untrusted-relative' } })).some(node => node.type === ui.Link), false);
  assert.equal(flatten(Attachment({ item: { type: 'image', url: 'https://cdn.example.test/image.jpeg' } })).find(node => node.type === ui.Image).props.src, 'https://cdn.example.test/image.jpeg');
  assert.match(source, /downloadUrl=\{`\/api\$\{path\}\/media\/\$\{encodeURIComponent\(item\.id\)\}\/\$\{index\}`\}/);
});
