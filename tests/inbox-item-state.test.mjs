import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContacts } from '../server/contacts.ts';
import { createWebhookService } from '../server/webhooks.ts';
import { handleInbox } from '../server/inbox.ts';
import { blockWrites, lockWaiters, postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

// Team triage overlay (ten98-campaign#41 change 1): waiting/first reply from the webhook drain and confirmed replies,
// and the item-state read and update endpoints with their role, membership, lock and optimistic-concurrency gates.
const pg = { skip: postgresSkip };
const secret = 'inbox-state-fixture-signing-secret';
const sign = raw => createHmac('sha256', secret).update(raw).digest('hex');
const iso = offset => new Date(Date.now() + offset).toISOString();

// Every column the overlay may hold. Provider content (message text, names, pictures, ratings, URLs) must never appear.
const allowedColumns = ['project_id', 'profile_id', 'account_id', 'kind', 'resource_id', 'status', 'snoozed_until', 'assignee_id', 'waiting_since', 'first_reply_at', 'last_reply_at', 'updated_at', 'updated_by'];

test('the overlay table holds only key, triage and timing columns, never provider content', pg, async t => {
  const { pool } = await testDatabase(t);
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='inbox_item_state' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(columns, allowedColumns);
  // Notes hold the team's own text only, keyed like the state rows; no provider content columns.
  const notes = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='inbox_item_notes' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(notes, ['id', 'project_id', 'profile_id', 'account_id', 'kind', 'resource_id', 'author_id', 'body', 'created_at']);
});

async function drainFixture(t) {
  const { db, pool, sql } = await testDatabase(t);
  await pool.query("INSERT INTO workspaces (id, name) VALUES ('w', 'W'); INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES ('project-a', 'w', 'A', 'profile-a')");
  const service = createWebhookService({ db, contacts: createContacts({ db }), env: { ZERNIO_WEBHOOK_SECRET: secret } });
  const deliver = async payload => { const raw = Buffer.from(JSON.stringify(payload)); assert.equal((await service.receive(raw, { 'x-zernio-signature': sign(raw) })).status, 202); assert.equal((await service.processPending()).processed, 1); };
  const state = (kind, resourceId) => sql.get('SELECT * FROM inbox_item_state WHERE project_id=? AND profile_id=? AND account_id=? AND kind=? AND resource_id=?', 'project-a', 'profile-a', 'page-a', kind, resourceId);
  return { pool, sql, deliver, state };
}
const account = { accountId: 'page-a', id: 'page-a', profileId: 'profile-a', platform: 'facebook' };
const message = (timestamp, direction = 'incoming', conversation = 'conversation-a') => ({
  id: randomUUID(), event: 'message.received', timestamp, account,
  conversation: { id: conversation, platformConversationId: `thread-${conversation}`, participantId: 'participant-a', participantName: 'PRIVATE_NAME', platform: 'facebook' },
  message: { id: randomUUID(), conversationId: conversation, platform: 'facebook', direction, sender: { id: direction === 'incoming' ? 'participant-a' : 'page-a', name: 'PRIVATE_SENDER' }, text: 'PRIVATE_TEXT' },
});

test('the webhook drain marks inbound messages, comments and new reviews waiting once, and nothing else', pg, async t => {
  const f = await drainFixture(t), first = iso(-120000), later = iso(-60000);
  await f.deliver(message(first));
  assert.equal((await f.state('conversation', 'thread-conversation-a')).waiting_since, first, 'Keyed on the same conversation ID the inbox updates feed uses.');
  await f.deliver(message(later));
  assert.equal((await f.state('conversation', 'thread-conversation-a')).waiting_since, first, 'waiting_since is set only when blank.');
  await f.deliver(message(later, 'outgoing', 'conversation-b'));
  assert.equal(await f.state('conversation', 'thread-conversation-b'), undefined, 'An outgoing message is not a customer waiting.');
  await f.deliver({ id: randomUUID(), event: 'comment.received', timestamp: later, account, comment: { id: 'comment-1', platformPostId: 'post-1', message: 'PRIVATE_COMMENT' } });
  await f.deliver({ id: randomUUID(), event: 'review.new', timestamp: later, account, review: { id: 'review-1', text: 'PRIVATE_REVIEW' } });
  await f.deliver({ id: randomUUID(), event: 'review.updated', timestamp: later, account, review: { id: 'review-2' } });
  assert.equal((await f.state('comment', 'comment-1')).waiting_since, later);
  assert.equal((await f.state('review', 'review-1')).waiting_since, later);
  assert.equal(await f.state('review', 'review-2'), undefined, 'An edited review is not a new item awaiting a reply.');
  const rows = await f.sql.all('SELECT * FROM inbox_item_state');
  assert.equal(rows.length, 3); assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false);
  assert.ok(rows.every(row => row.status === 'open' && row.updated_at === null && row.first_reply_at === null), 'Waiting does not change the triage token.');
});

test('a late inbound delivery never undoes a later reply or resolve; a newer one reopens a resolved or snoozed item', pg, async t => {
  const f = await drainFixture(t), resolvedAt = iso(-60000);
  await f.pool.query("INSERT INTO inbox_item_state (project_id,profile_id,account_id,kind,resource_id,status,last_reply_at,updated_at) VALUES ('project-a','profile-a','page-a','conversation','thread-conversation-a','resolved',$1,$1)", [resolvedAt]);
  await f.deliver(message(iso(-120000)));
  assert.deepEqual(await f.state('conversation', 'thread-conversation-a'), { project_id: 'project-a', profile_id: 'profile-a', account_id: 'page-a', kind: 'conversation', resource_id: 'thread-conversation-a', status: 'resolved', snoozed_until: null, assignee_id: null, waiting_since: null, first_reply_at: null, last_reply_at: resolvedAt, updated_at: resolvedAt, updated_by: null });
  const newer = iso(-30000); await f.deliver(message(newer));
  const reopened = await f.state('conversation', 'thread-conversation-a');
  assert.equal(reopened.status, 'open'); assert.equal(reopened.waiting_since, newer); assert.ok(reopened.updated_at > resolvedAt, 'Reopening changes the triage token.'); assert.equal(reopened.updated_by, null);

  await f.pool.query("INSERT INTO inbox_item_state (project_id,profile_id,account_id,kind,resource_id,status,snoozed_until,updated_at) VALUES ('project-a','profile-a','page-a','conversation','thread-conversation-b','snoozed',$1,$2)", [iso(3600000), resolvedAt]);
  await f.deliver(message(iso(-90000), 'incoming', 'conversation-b'));
  const snoozed = await f.state('conversation', 'thread-conversation-b');
  assert.equal(snoozed.status, 'snoozed', 'A message older than the snooze leaves it snoozed.'); assert.ok(snoozed.waiting_since);
});

async function appFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-inbox-state-')), env = { ZERNIO_API_KEY: 'inbox-state-fixture-key', ZERNIO_WEBHOOK_SECRET: secret };
  const app = await testApp(t, { dataDir, env, appUrl: 'https://campaign.example.test', directScheduler: false }), originalFetch = globalThis.fetch, writes = [], calls = [];
  const accounts = [['tg', 'telegram'], ['gb', 'googlebusiness'], ['fb', 'facebook']].map(([_id, platform]) => ({ _id, platform, profileId: 'inbox-profile', username: `${platform}-account`, isActive: true }));
  const review = { id: 'review-1', accountId: 'gb', platform: 'googlebusiness', rating: 4, hasReply: false, reply: null };
  const paging = { hasMore: false, nextCursor: null };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    const body = options.body ? JSON.parse(options.body) : undefined, accountId = url.searchParams.get('accountId') || body?.accountId, platform = accounts.find(item => item._id === accountId)?.platform;
    calls.push(url.pathname); if (options.method && options.method !== 'GET') writes.push(url.pathname);
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts });
    if (url.pathname.endsWith('/inbox/conversations/thread-1')) return Response.json({ data: { id: 'thread-1', accountId, platform, participantId: 'participant-a', status: 'active', updatedTime: iso(-1000) } });
    if (url.pathname.endsWith('/inbox/conversations/thread-1/messages') && options.method === 'POST') return Response.json({ success: true, data: { messageId: randomUUID(), conversationId: 'thread-1' } });
    if (url.pathname.endsWith('/inbox/reviews')) return Response.json({ data: [{ ...review, accountId }], pagination: paging });
    if (url.pathname.endsWith('/inbox/reviews/review-1/reply')) { review.hasReply = true; review.reply = { id: 'reply-1', text: body.message, created: iso(0) }; return Response.json({ status: 'success', platform, reply: review.reply }); }
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [{ id: 'post-1', platform, accountId }], pagination: paging });
    if (url.pathname.endsWith('/inbox/comments/post-1')) {
      if (options.method === 'POST') return Response.json({ success: true, data: { commentId: randomUUID(), isReply: true } });
      return Response.json({ comments: [{ id: 'comment-1', platform, message: 'Question', from: { id: 'participant-a', isOwner: false }, canReply: true }], pagination: paging, meta: { accountId, platform, postId: 'post-1' } });
    }
    throw new Error(`Unexpected provider call: ${options.method || 'GET'} ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { Origin: 'https://campaign.example.test', ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const password = 'inbox state fixture passphrase long enough';
  const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner', email: 'owner@example.test', password } }); setup.data.projectId = await firstProject(app, setup);
  assert.equal(setup.status, 201); const owner = setup.cookie, projectId = setup.data.projectId;
  assert.equal((await request(`/api/projects/${projectId}`, { method: 'PATCH', body: { zernioProfileId: 'inbox-profile' }, cookie: owner })).status, 200);
  const { workspace_id: workspaceId } = await app.sql.get('SELECT workspace_id FROM projects WHERE id=?', projectId), ownerId = (await app.sql.get("SELECT id FROM users WHERE email='owner@example.test'")).id, hash = (await app.sql.get('SELECT password FROM users WHERE id=?', ownerId)).password;
  const people = {};
  for (const [name, role] of [['editor', 'editor'], ['second', 'editor'], ['viewer', 'viewer'], ['outsider', null]]) {
    const userId = randomUUID(); await app.sql.run('INSERT INTO users VALUES(?,?,?,?)', userId, name, `${name}@example.test`, hash);
    if (role) await app.sql.run('INSERT INTO memberships VALUES(?,?,?)', workspaceId, userId, role);
    people[name] = { id: userId, cookie: (await request('/api/auth/login', { method: 'POST', body: { email: `${name}@example.test`, password } })).cookie };
  }
  people.owner = { id: ownerId, cookie: owner };
  const path = `/api/projects/${projectId}/integrations/inbox`;
  const read = (ids, { cookie = owner, accountId = 'tg', kind = 'conversation', project = path } = {}) => request(`${project}/item-states?${new URLSearchParams([['accountId', accountId], ['kind', kind], ...ids.map(value => ['id', value])])}`, { cookie });
  const change = (body, cookie = people.editor.cookie) => request(`${path}/item-states`, { method: 'PATCH', body: { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', ...body }, cookie });
  const send = (action, body, cookie = owner) => request(`${path}/${action}`, { method: 'POST', body, cookie, headers: { 'Idempotency-Key': randomUUID() } });
  return { app, request, read, change, send, path, projectId, workspaceId, people, writes, calls };
}

test('an inbound webhook marks a thread waiting; a confirmed reply clears it and records the first reply once', pg, async t => {
  const f = await appFixture(t), received = iso(-60000);
  const raw = JSON.stringify({ id: randomUUID(), event: 'message.received', timestamp: received, account: { accountId: 'tg', id: 'tg', profileId: 'inbox-profile', platform: 'telegram' }, conversation: { id: 'thread-1', platform: 'telegram' }, message: { id: 'incoming-1', conversationId: 'thread-1', platform: 'telegram', direction: 'incoming', sender: { id: 'participant-a' } } });
  const hook = await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/webhooks/zernio`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zernio-Signature': sign(raw) }, body: raw });
  assert.equal(hook.status, 202);
  for (let attempt = 0; attempt < 20 && !(await f.app.sql.get("SELECT 1 AS found FROM inbox_item_state WHERE resource_id='thread-1'")); attempt++) await f.app.webhooks.processPending();
  const waiting = (await f.read(['thread-1'])).data.states[0];
  assert.equal(waiting.waitingSince, received); assert.equal(waiting.firstReplyAt, null); assert.equal(waiting.status, 'open');

  assert.equal((await f.send('conversations/thread-1/reply', { accountId: 'tg', message: 'First answer' })).status, 200);
  const answered = (await f.read(['thread-1'])).data.states[0];
  assert.equal(answered.waitingSince, null); assert.ok(answered.firstReplyAt > received); assert.equal(answered.updatedAt, null, 'A reply does not change the triage token.');
  assert.equal((await f.send('conversations/thread-1/reply', { accountId: 'tg', message: 'Second answer' })).status, 200);
  assert.equal((await f.read(['thread-1'])).data.states[0].firstReplyAt, answered.firstReplyAt, 'first_reply_at is set once.');

  // An inbound message newer than the reply stays waiting.
  const future = iso(3600000); await f.app.sql.run("UPDATE inbox_item_state SET waiting_since=? WHERE resource_id='thread-1'", future);
  assert.equal((await f.send('conversations/thread-1/reply', { accountId: 'tg', message: 'Third answer' })).status, 200);
  assert.equal((await f.read(['thread-1'])).data.states[0].waitingSince, future);

  await f.app.sql.run("INSERT INTO inbox_item_state (project_id,profile_id,account_id,kind,resource_id,waiting_since) VALUES (?,'inbox-profile','gb','review','review-1',?),(?,'inbox-profile','fb','comment','comment-1',?)", f.projectId, received, f.projectId, received);
  const version = (await f.request(`${f.path}/reviews?accountId=gb`, { cookie: f.people.owner.cookie })).data.reviews[0].replyVersion;
  assert.equal((await f.send('reviews/reply', { accountId: 'gb', reviewId: 'review-1', message: 'Thank you', expectedReplyVersion: version })).status, 200);
  assert.equal((await f.send('comments/reply', { accountId: 'fb', postId: 'post-1', commentId: 'comment-1', message: 'Answered' })).status, 200);
  const review = (await f.read(['review-1'], { accountId: 'gb', kind: 'review' })).data.states[0], comment = (await f.read(['comment-1'], { accountId: 'fb', kind: 'comment' })).data.states[0];
  assert.equal(review.waitingSince, null); assert.ok(review.firstReplyAt); assert.equal(comment.waitingSince, null); assert.ok(comment.firstReplyAt);
});

test('state reads are scoped to the project and its profile, and default for items with no saved state', pg, async t => {
  const f = await appFixture(t), other = randomUUID();
  await f.app.sql.run("INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES (?,?,'Other','other-profile')", other, f.workspaceId);
  await f.app.sql.run("INSERT INTO inbox_item_state (project_id,profile_id,account_id,kind,resource_id,status,updated_at) VALUES (?,'other-profile','tg','conversation','thread-1','resolved',?),(?,'stale-profile','tg','conversation','thread-1','pending',?)", other, iso(0), f.projectId, iso(0));
  const own = await f.read(['thread-1', 'thread-2', 'thread-1']);
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.states, ['thread-1', 'thread-2'].map(resourceId => ({ accountId: 'tg', kind: 'conversation', resourceId, status: 'open', snoozedUntil: null, assigneeId: null, waitingSince: null, firstReplyAt: null, updatedAt: null, updatedBy: null })), 'Another project or an earlier profile mapping is not visible.');
  assert.equal((await f.read(['thread-1'], { project: `/api/projects/${other}/integrations/inbox` })).data.states[0].status, 'resolved', 'Positive control: the other project reads its own row.');
  assert.equal((await f.read(['thread-1'], { cookie: f.people.outsider.cookie })).status, 404);
  assert.equal((await f.read(['thread-1'], { cookie: f.people.viewer.cookie })).status, 200, 'Viewers can read triage state.');
  assert.equal((await f.read([])).status, 400); assert.equal((await f.read(['thread-1'], { kind: 'post' })).status, 400);
  assert.equal((await f.read(Array.from({ length: 101 }, (_, index) => `t-${index}`))).status, 400);
  assert.deepEqual(f.calls, [], 'The state endpoints make no provider calls.');
});

test('updates need editing permission, an eligible assignee and the current updatedAt', pg, async t => {
  const f = await appFixture(t);
  assert.equal((await f.change({ expectedUpdatedAt: null, status: 'pending' }, f.people.viewer.cookie)).status, 403);
  const blocked = await f.change({ expectedUpdatedAt: null, assigneeId: f.people.outsider.id });
  assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'ASSIGNEE_NOT_ELIGIBLE');
  assert.equal((await f.change({ expectedUpdatedAt: null, assigneeId: f.people.viewer.id })).data.error.code, 'ASSIGNEE_NOT_ELIGIBLE', 'A viewer cannot act on an assignment.');
  assert.equal((await f.change({ expectedUpdatedAt: null, assigneeId: 'missing-user' })).status, 409);
  assert.equal((await f.change({ expectedUpdatedAt: null, unknown: true, status: 'open' })).status, 400);
  assert.equal((await f.change({ expectedUpdatedAt: null })).status, 400);
  assert.equal((await f.change({ status: 'open' })).status, 400, 'expectedUpdatedAt is required.');
  assert.equal((await f.change({ expectedUpdatedAt: null, status: 'snoozed', snoozedUntil: iso(-1000) })).status, 400);
  assert.equal((await f.change({ expectedUpdatedAt: null, status: 'open', snoozedUntil: iso(60000) })).status, 400);
  assert.equal(await f.app.sql.get('SELECT * FROM inbox_item_state'), undefined, 'Refused updates write nothing.');

  const assigned = await f.change({ expectedUpdatedAt: null, assigneeId: f.people.second.id, status: 'pending' });
  assert.equal(assigned.status, 200);
  assert.deepEqual({ ...assigned.data.state, updatedAt: typeof assigned.data.state.updatedAt }, { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', status: 'pending', snoozedUntil: null, assigneeId: f.people.second.id, waitingSince: null, firstReplyAt: null, updatedAt: 'string', updatedBy: f.people.editor.id });
  const stale = await f.change({ expectedUpdatedAt: null, status: 'resolved' });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'INBOX_STATE_CHANGED');
  assert.equal((await f.change({ expectedUpdatedAt: new Date(Date.parse(assigned.data.state.updatedAt) - 1).toISOString(), status: 'resolved' })).status, 409);
  await f.app.sql.run("UPDATE inbox_item_state SET waiting_since=?", iso(-5000));
  const resolved = await f.change({ expectedUpdatedAt: assigned.data.state.updatedAt, status: 'resolved' });
  assert.equal(resolved.status, 200); assert.equal(resolved.data.state.status, 'resolved'); assert.equal(resolved.data.state.waitingSince, null, 'Resolving clears waiting.');
  assert.equal(resolved.data.state.assigneeId, f.people.second.id); assert.ok(resolved.data.state.updatedAt > assigned.data.state.updatedAt);
  const unassigned = await f.change({ expectedUpdatedAt: resolved.data.state.updatedAt, assigneeId: null }, f.people.owner.cookie);
  assert.equal(unassigned.data.state.assigneeId, null); assert.equal(unassigned.data.state.status, 'resolved');
});

test('an assignee who leaves the workspace reads as unassigned and is dropped on the next update', pg, async t => {
  const f = await appFixture(t);
  const assigned = await f.change({ expectedUpdatedAt: null, assigneeId: f.people.second.id });
  assert.equal((await f.read(['thread-1'])).data.states[0].assigneeId, f.people.second.id);
  await f.app.sql.run('DELETE FROM memberships WHERE user_id=?', f.people.second.id);
  assert.equal((await f.read(['thread-1'])).data.states[0].assigneeId, null);
  const next = await f.change({ expectedUpdatedAt: assigned.data.state.updatedAt, status: 'pending' });
  assert.equal(next.status, 200); assert.equal(next.data.state.assigneeId, null);
  assert.equal((await f.app.sql.get('SELECT assignee_id FROM inbox_item_state')).assignee_id, null);
});

test('the item-state route refuses a viewer itself, before any database work', async () => {
  let response;
  const handled = await handleInbox({ req: { method: 'PATCH', headers: {} }, url: new URL('https://campaign.example.test/api/projects/p/integrations/inbox/item-states'), project: { id: 'p', zernioProfileId: 'profile' }, role: 'viewer', user: { id: 'u' }, body: { accountId: 'a', kind: 'conversation', resourceId: 'r', expectedUpdatedAt: null, status: 'open' }, send: (status, body) => { response = { status, body }; } });
  assert.equal(handled, true); assert.deepEqual(response, { status: 403, body: { error: { code: 'WRITE_PERMISSION_REQUIRED', message: 'Editing permission is required for this inbox action.' } } });
});

test('a snoozed item reads as open once snoozed_until passes', pg, async t => {
  const f = await appFixture(t), until = iso(3600000);
  const snoozed = await f.change({ expectedUpdatedAt: null, status: 'snoozed', snoozedUntil: until });
  assert.equal(snoozed.status, 200); assert.equal(snoozed.data.state.snoozedUntil, until);
  assert.equal((await f.read(['thread-1'])).data.states[0].status, 'snoozed');
  await f.app.sql.run('UPDATE inbox_item_state SET snoozed_until=?', iso(-1000));
  const woke = (await f.read(['thread-1'])).data.states[0];
  assert.equal(woke.status, 'open'); assert.equal(woke.snoozedUntil, null); assert.equal(woke.updatedAt, snoozed.data.state.updatedAt, 'Waking is computed at read time; the token is unchanged.');
});

test('parallel updates with the same expectedUpdatedAt: exactly one succeeds, for a new and a saved item', pg, async t => {
  const f = await appFixture(t);
  for (const expectedUpdatedAt of [null, 'saved']) {
    const expected = expectedUpdatedAt === 'saved' ? (await f.read(['thread-1'])).data.states[0].updatedAt : null;
    const block = await blockWrites(f.app.pool, 'inbox_item_state');
    const pending = [f.change({ expectedUpdatedAt: expected, status: 'pending' }), f.change({ expectedUpdatedAt: expected, assigneeId: f.people.second.id }, f.people.second.cookie)];
    await block.waiting(2); await block.release();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409], `expectedUpdatedAt ${expectedUpdatedAt}`);
    assert.equal(results.find(result => result.status === 409).data.error.code, 'INBOX_STATE_CHANGED');
  }
});

test('an assignee removed, or an actor demoted, while the update waits on the workspace lock is refused', pg, async t => {
  const f = await appFixture(t);
  for (const [label, body, cookie, change, code] of [
    ['assignee removed', { assigneeId: f.people.second.id }, f.people.editor.cookie, ['DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.people.second.id]], 409],
    ['actor demoted', { status: 'resolved' }, f.people.editor.cookie, ["UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.people.editor.id]], 403],
  ]) {
    const client = await f.app.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
      const pending = f.change({ expectedUpdatedAt: null, ...body }, cookie);
      await lockWaiters(client, 1); await client.query(change[0], change[1]); await client.query('COMMIT');
      const result = await pending;
      assert.equal(result.status, code, label);
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    assert.equal(await f.app.sql.get('SELECT * FROM inbox_item_state'), undefined, `${label}: nothing is written`);
  }
});

test('internal notes on an inbox item: viewers read, editors add, the author or an administrator deletes, nothing reaches the provider', pg, async t => {
  const f = await appFixture(t), other = randomUUID(), key = { accountId: 'fb', kind: 'comment', resourceId: 'comment-1' };
  const notes = ({ cookie = f.people.owner.cookie, project = f.path, query = key } = {}) => f.request(`${project}/item-notes?${new URLSearchParams(query)}`, { cookie });
  const add = (body, cookie = f.people.editor.cookie) => f.request(`${f.path}/item-notes`, { method: 'POST', body: { ...key, ...body }, cookie });
  const remove = (noteId, cookie) => f.request(`${f.path}/item-notes/${encodeURIComponent(noteId)}`, { method: 'DELETE', cookie });
  assert.deepEqual((await notes()).data, { notes: [], truncated: false });
  // Viewers cannot add; bodies are bounded; unknown fields are refused.
  assert.equal((await add({ body: 'Viewer note' }, f.people.viewer.cookie)).status, 403);
  for (const body of ['', '   ', 'x'.repeat(4001), 'bell\u0007']) assert.equal((await add({ body })).data.error?.code, 'INVALID_INBOX_NOTE', JSON.stringify(body));
  assert.equal((await add({ body: 'ok', extra: 1 })).status, 400);
  const first = (await add({ body: '  Called the customer back.\nWaiting on their order number.  ' })).data.note;
  assert.equal(first.body, 'Called the customer back.\nWaiting on their order number.'); assert.equal(first.authorId, f.people.editor.id);
  const second = (await add({ body: 'Second editor note' }, f.people.second.cookie)).data.note;
  // Viewers read them oldest first, with author names; another project or item reads none; a non-member gets 404.
  const listed = await notes({ cookie: f.people.viewer.cookie });
  assert.equal(listed.status, 200); assert.deepEqual(listed.data.notes.map(note => [note.id, note.authorName]), [[first.id, 'editor'], [second.id, 'second']]);
  await f.app.sql.run("INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES (?,?,'Other','other-notes-profile')", other, f.workspaceId);
  assert.deepEqual((await notes({ project: `/api/projects/${other}/integrations/inbox` })).data.notes, []);
  assert.deepEqual((await notes({ query: { ...key, resourceId: 'comment-2' } })).data.notes, []);
  assert.equal((await notes({ cookie: f.people.outsider.cookie })).status, 404);
  // Only the author or an owner/administrator deletes a note.
  assert.equal((await remove(first.id, f.people.second.cookie)).status, 404, 'Another editor cannot delete it.');
  assert.equal((await remove(first.id, f.people.viewer.cookie)).status, 403);
  assert.equal((await remove(first.id, f.people.editor.cookie)).status, 200);
  assert.equal((await remove(second.id, f.people.owner.cookie)).status, 200, 'An owner can delete any note.');
  assert.deepEqual((await notes()).data.notes, []);
  assert.deepEqual(f.calls, [], 'Notes never reach the provider.');
});

test('note reads return the newest 500 oldest first and say when older ones exist; a retried add with its id saves one note', pg, async t => {
  const f = await appFixture(t), key = { accountId: 'fb', kind: 'comment', resourceId: 'comment-many' };
  const notes = () => f.request(`${f.path}/item-notes?${new URLSearchParams(key)}`, { cookie: f.people.owner.cookie });
  const add = body => f.request(`${f.path}/item-notes`, { method: 'POST', body: { ...key, ...body }, cookie: f.people.editor.cookie });
  // 502 notes, one second apart: the window holds the newest 500 (2..501), oldest first.
  await f.app.sql.run(`INSERT INTO inbox_item_notes (id,project_id,profile_id,account_id,kind,resource_id,author_id,body,created_at)
    SELECT 'n-' || lpad(i::text, 4, '0'), ?, 'inbox-profile', 'fb', 'comment', 'comment-many', ?, 'Note ' || i, to_char(timestamp '2026-10-01' + i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM generate_series(0, 501) i`, f.projectId, f.people.editor.id);
  let read = (await notes()).data;
  assert.equal(read.notes.length, 500); assert.equal(read.truncated, true); assert.equal(read.notes[0].body, 'Note 2'); assert.equal(read.notes.at(-1).body, 'Note 501');
  await f.app.sql.run("DELETE FROM inbox_item_notes WHERE resource_id='comment-many'");
  assert.equal((await notes()).data.truncated, false);
  // Retrying with the same id after a lost response returns the saved note and adds nothing.
  const id = randomUUID(), first = await add({ id, body: 'Follow up tomorrow.' }), again = await add({ id, body: 'Follow up tomorrow.' });
  assert.equal(first.status, 200); assert.equal(again.status, 200); assert.equal(again.data.note.id, id); assert.equal(again.data.note.createdAt, first.data.note.createdAt);
  assert.equal((await notes()).data.notes.length, 1);
  // The id cannot be reused for a different note, and must be a UUID.
  assert.equal((await add({ id, body: 'Something else' })).data.error.code, 'INBOX_NOTE_CONFLICT');
  assert.equal((await add({ id: 'not-a-uuid', body: 'x' })).data.error.code, 'INVALID_INBOX_NOTE');
  assert.equal((await notes()).data.notes.length, 1);
});
