import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { createApp } from '../server/index.ts';
import pgDriver from 'pg';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const pg = { skip: postgresSkip };

const linkedInReactionTypes = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'];

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-inbox-')), originalFetch = globalThis.fetch, calls = [], env = { ZERNIO_API_KEY: 'inbox-fixture-key', ZERNIO_WEBHOOK_SECRET: 'inbox-fixture-signing-secret' };
  const config = { dataDir, env, appUrl: 'https://campaign.example.test', directScheduler: false }, first = await testApp(t, config); let app = first;
  const accounts = [['fb', 'facebook'], ['ig', 'instagram'], ['yt', 'youtube'], ['gb', 'googlebusiness'], ['bs', 'bluesky'], ['ads', 'metaads'], ['tt', 'tiktok'], ['sl', 'slack'], ['rc', 'rcs'], ['sm', 'sms'], ['wa', 'whatsapp'], ['xx', 'twitter'], ['rd', 'reddit']].map(([_id, platform]) => ({ _id, platform, profileId: 'inbox-profile', username: `${platform}-account`, isActive: true }));
  const review = { id: 'review-1', accountId: 'gb', platform: 'googlebusiness', rating: 5, reviewer: { name: 'Alex' }, text: 'Good service', hasReply: false, reply: null }, comments = [{ id: 'comment-1', platform: 'facebook', message: 'Question', from: { id: 'participant-a', name: 'Alex', isOwner: false }, canReply: true, canHide: true, canLike: true, canDelete: true, isHidden: false, isLiked: false }];
  let base, cookie, projectId, hook, lastIncoming = Date.now(), sourceForeign = false, malformedHistory = false;
  const json = data => Response.json(data), paging = { hasMore: false, nextCursor: null };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${env.ZERNIO_API_KEY}`);
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (hook) { const result = await hook(url, options); if (result !== undefined) return result; }
    if (url.pathname.endsWith('/accounts')) { assert.equal(url.searchParams.get('profileId'), 'inbox-profile'); return json({ accounts: [...accounts, { _id: 'foreign', profileId: 'foreign-profile', platform: 'facebook' }] }); }
    const accountId = url.searchParams.get('accountId') || (options.body ? JSON.parse(options.body).accountId : undefined), account = accounts.find(item => item._id === accountId), platform = account?.platform;
    const thread = { id: 'thread-1', accountId: sourceForeign ? 'foreign' : accountId, platform, participantId: 'participant-a', participantName: 'Alex Messenger', participantPicture: null, status: 'active', lastMessage: 'Question', updatedTime: new Date(lastIncoming).toISOString(), unreadCount: 1 };
    if (url.pathname.endsWith('/inbox/conversations')) return json({ data: [thread], pagination: paging, meta: { accountsQueried: 1 } });
    if (url.pathname.endsWith('/inbox/conversations/thread-1')) {
      if (options.method === 'PUT') return json({ success: true, data: { ...thread, status: JSON.parse(options.body).status } });
      return json({ data: thread });
    }
    if (url.pathname.endsWith('/messages')) {
      if (options.method === 'POST') return json({ success: true, data: { messageId: 'sent-message-1', conversationId: 'thread-1' } });
      return json({ messages: [{ id: 'received-1', conversationId: malformedHistory ? 'foreign-thread' : 'thread-1', accountId, platform, message: 'Please help', senderId: 'participant-a', senderName: 'Alex', direction: 'incoming', createdAt: new Date(lastIncoming).toISOString(), attachments: [] }], pagination: paging, sortOrderApplied: 'desc' });
    }
    if (url.pathname.endsWith('/read')) return json({ success: true, markedCount: 1 });
    if (url.pathname.endsWith('/inbox/comments')) return json({ data: accountId === 'ads' ? [{ id: 'ad-1:instagram', adId: 'ad-1', isAd: true, placement: 'instagram', platform: 'instagram', accountId: 'ads', content: 'Dark ad', commentCount: 1 }] : [{ id: 'post-1', platform, accountId: sourceForeign ? 'foreign' : accountId, content: 'A campaign post', cid: 'post-cid', commentCount: comments.length }], pagination: paging });
    if (url.pathname.endsWith('/ads/ad-1/comments')) return json({ status: 'success', comments: [{ ...comments[0], platform: 'instagram' }], pagination: paging, meta: { platform: 'instagram', accountId: 'ads', adId: 'ad-1', effectiveStoryId: 'ad-media-1', instagramAccountId: 'ig', placement: 'instagram' } });
    if (url.pathname.endsWith('/inbox/comments/post-1') || url.pathname.endsWith('/inbox/comments/ad-media-1')) {
      if (options.method === 'POST') return json({ success: true, data: { commentId: 'new-comment-1', isReply: true } });
      if (options.method === 'DELETE') return json({ success: true, data: { message: 'Deleted' } });
      return json({ status: 'success', comments: comments.map(row => ({ ...row, platform })), pagination: paging, meta: { accountId, platform, postId: 'post-1' } });
    }
    if (/\/comments\/[^/]+\/comment-1\/(hide|like)$/.test(url.pathname)) {
      const hiding = url.pathname.endsWith('/hide'), enabled = options.method === 'POST'; comments[0][hiding ? 'isHidden' : 'isLiked'] = enabled;
      return json({ status: 'success', commentId: 'comment-1', platform, [hiding ? 'hidden' : 'liked']: enabled });
    }
    if (url.pathname.endsWith('/moderation')) return json({ success: true });
    if (url.pathname.endsWith('/inbox/reviews')) return json({ status: 'success', data: [{ ...review, accountId, platform }], pagination: paging, summary: { totalReviews: 1, averageRating: 5 } });
    if (url.pathname.endsWith('/inbox/reviews/review-1/reply')) {
      if (options.method === 'DELETE') { review.reply = null; review.hasReply = false; return json({ status: 'success', platform, message: 'Deleted' }); }
      review.hasReply = true; review.reply = { id: 'review-reply', text: JSON.parse(options.body).message, created: new Date().toISOString() }; return json({ status: 'success', platform, reply: review.reply });
    }
    if (url.pathname.endsWith('/tools/validate/media')) return json({ valid: true, size: 1024, contentType: 'image/jpeg' });
    assert.fail(`Unexpected provider call: ${options.method} ${url}`);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, key = randomUUID()) {
    const response = await fetch(base + path, { method, headers: { Origin: 'https://campaign.example.test', ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'Inbox owner', email: 'inbox-owner@example.test', password: 'inbox fixture passphrase long enough' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
  await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: 'inbox-profile' }); const path = `/api/projects/${projectId}/integrations/inbox`;
  return { get app() { return app; }, projectId, path, calls, comments, review, accounts, request, writes: () => calls.filter(call => call.options.method !== 'GET' && !call.url.pathname.includes('/tools/validate/')), setHook(value) { hook = value; }, setForeign(value) { sourceForeign = value; }, setMalformedHistory(value) { malformedHistory = value; }, setIncoming(value) { lastIncoming = value; }, async reopen() { await app.close(); app = Object.assign(await createApp({ ...config, database: { pool: first.database.pool, db: first.database.db } }), { sql: first.sql }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; return app; }, async close() { if (app !== first) await app.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

async function actionFixture(t, platform = 'telegram') {
  const f = await fixture(t), account = f.accounts.find(item => item.platform === platform) || { _id: 'action-account', platform, profileId: 'inbox-profile', isActive: true };
  if (!f.accounts.includes(account)) f.accounts.push(account);
  const state = { messages: [{ id: 'own-message', message: 'Original sent text', direction: 'outgoing', createdAt: new Date(Date.now() - 60000).toISOString(), attachments: [], reactions: [] }, { id: 'incoming-message', message: 'A recent question', senderId: 'participant-a', direction: 'incoming', createdAt: new Date(Date.now() - 30000).toISOString(), attachments: [], reactions: [] }], control: 'app', pendingRequest: false, malformed: false, unchanged: false, readFailure: false, wrote: false, hold: null };
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/inbox/conversations/thread-1') && options.method === 'GET') return Response.json({ data: { id: 'thread-1', accountId: account._id, platform, participantId: 'participant-a', participantName: 'Alex', lastMessage: state.messages.at(-1)?.message || '', updatedTime: state.messages.at(-1)?.createdAt || new Date().toISOString(), status: 'active', threadControl: state.control } });
    if (url.pathname.endsWith('/inbox/conversations') && options.method === 'GET' && url.searchParams.get('folder') === 'requests') return Response.json({ data: state.pendingRequest ? [{ id: 'thread-1', accountId: account._id, platform, participantId: 'participant-a', folder: 'requests', status: 'active' }] : [], pagination: { hasMore: false, nextCursor: null } });
    if (url.pathname.endsWith('/messages') && options.method === 'GET') {
      if (state.wrote && state.readFailure) return Response.json({ error: 'Unavailable' }, { status: 502 });
      return Response.json({ messages: state.messages.map(item => ({ ...item, accountId: account._id, platform, conversationId: 'thread-1' })), pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
    }
    const messageAction = /\/messages\/([^/]+)(\/reactions)?$/.exec(url.pathname);
    if (messageAction) {
      const target = state.messages.find(item => item.id === decodeURIComponent(messageAction[1])); assert.ok(target);
      state.wrote = true; state.onWrite?.(); if (state.hold) await state.hold;
      const payload = options.body ? JSON.parse(options.body) : null;
      if (messageAction[2]) {
        if (!state.unchanged) target.reactions = [...target.reactions.filter(row => !row.fromMe), ...(options.method === 'POST' ? [{ emoji: payload.emoji, fromMe: true, reactedAt: new Date().toISOString() }] : [])];
        return Response.json(state.malformed ? { success: true, messageId: 'stored-message', platformMessageId: 'wrong-message' } : { success: true, messageId: 'stored-message', platformMessageId: target.id });
      }
      if (options.method === 'PATCH') { if (!state.unchanged) { target.editHistory = [{ text: target.message, attachments: [], editedAt: new Date().toISOString() }]; target.message = payload.text; target.isEdited = true; target.editedAt = new Date().toISOString(); } return Response.json(state.malformed ? {} : { success: true, data: { messageId: target.id } }); }
      assert.equal(options.method, 'DELETE'); if (!state.unchanged) { if (['bluesky', 'reddit'].includes(platform)) state.messages.splice(state.messages.indexOf(target), 1); else target.isDeleted = true; } return Response.json(state.malformed ? {} : { success: true });
    }
    if (url.pathname.endsWith('/thread-control')) {
      const payload = JSON.parse(options.body); state.wrote = true;
      const owner = payload.action === 'take' ? 'app' : payload.action === 'pass' ? 'other' : platform === 'whatsapp' ? 'ai_agent' : payload.action === 'request' ? state.control : 'other';
      if (!state.unchanged) state.control = owner;
      return Response.json(state.malformed ? {} : { success: true, control: { owner, ...(payload.action === 'pass' ? { ownerAppId: payload.targetAppId } : {}) } });
    }
    if (url.pathname.endsWith('/accept')) {
      const payload = JSON.parse(options.body); state.wrote = true; if (!state.unchanged) { state.pendingRequest = false; state.messages.push({ id: 'acceptance-reply', direction: 'outgoing', message: payload.message, createdAt: new Date().toISOString(), attachments: [], reactions: [] }); }
      return Response.json(state.malformed ? {} : { success: true, data: { messageId: 'acceptance-reply' } });
    }
  });
  const thread = () => f.request(`${f.path}/conversations/thread-1/messages?accountId=${account._id}`);
  const write = (message, verb, extra = {}, key = randomUUID()) => f.request(`${f.path}/conversations/thread-1/messages/${encodeURIComponent(message.id)}/${verb}`, 'POST', { accountId: account._id, expectedMessageVersion: message.version, ...extra }, key);
  return { ...f, state, account, thread, write };
}

async function commentReactionFixture(t) {
  const f = await fixture(t);
  f.accounts.push({ _id: 'li', platform: 'linkedin', profileId: 'inbox-profile', isActive: true });
  f.comments[0].id = 'urn:li:comment:(urn:li:activity:42,7)';
  const body = { accountId: 'li', postId: 'post-1', commentId: f.comments[0].id }, state = { response: null, before: null, alreadyReacted: false };
  f.setHook(async (url, options) => {
    const intercepted = await state.before?.(url, options); if (intercepted !== undefined) return intercepted;
    if (!url.pathname.endsWith('/like')) return;
    if (state.response) return state.response(url, options);
    const liked = options.method === 'POST', payload = options.body ? JSON.parse(options.body) : {};
    f.comments[0].isLiked = liked;
    return Response.json({ status: 'success', platform: 'linkedin', commentId: body.commentId, liked, ...(liked ? { reactionType: payload.reactionType, alreadyReacted: state.alreadyReacted } : {}) });
  });
  return { ...f, body, state, react: (extra = {}, key = randomUUID(), kind = 'like') => f.request(f.path + '/comments/' + kind, 'POST', { ...body, ...extra }, key) };
}

async function commentEditFixture(t) {
  const f = await fixture(t), account = f.accounts.find(row => row._id === 'rd'); account.platformUserId = 'reddit-native';
  f.comments[0] = { id: 't1_own', message: 'Original comment', from: { id: 'reddit-native', isOwner: true }, canLike: true };
  const state = { before: null, receipt: null, unchanged: false, wrote: false, badReadback: false };
  f.setHook(async (url, options) => {
    const intercepted = await state.before?.(url, options); if (intercepted !== undefined) return intercepted;
    if (options.method === 'GET' && url.pathname.endsWith('/inbox/comments/post-1') && state.wrote && state.badReadback) return Response.json({ comments: [{ ...f.comments[0], id: 'foreign', platform: 'reddit' }], pagination: { hasMore: false }, meta: { accountId: url.searchParams.get('accountId'), postId: 'post-1', platform: 'reddit' } });
    if (!url.pathname.endsWith('/inbox/comments/post-1/t1_own') || options.method !== 'PATCH') return;
    state.wrote = true; if (!state.unchanged) (f.comments[0].replies?.[0] || f.comments[0]).message = JSON.parse(options.body).content;
    if (state.receipt) return state.receipt(url, options);
    return Response.json({ status: 'success', commentId: 't1_own', platform: 'reddit' });
  });
  const thread = (accountId = 'rd') => f.request(f.path + '/comments/thread?accountId=' + accountId + '&postId=post-1');
  const draft = async (accountId = 'rd') => { const result = await thread(accountId); assert.equal(result.status, 200); const row = result.data.comments[0].replies?.[0] || result.data.comments[0]; return { accountId, postId: 'post-1', commentId: row.id, content: 'Corrected comment', expectedCommentVersion: row.editVersion, confirmEdit: true }; };
  return { ...f, state, account, thread, draft, edit: (body, key = randomUUID(), path = f.path) => f.request(path + '/comments/edit', 'POST', body, key) };
}

test('Reddit own comment edits PATCH the exact reviewed target and confirm same-ID nested readback', pg, async t => {
  const f = await commentEditFixture(t);
  try {
    f.comments[0] = { id: 'parent', message: 'Parent', replies: [f.comments[0]] };
    const body = await f.draft(); assert.match(body.expectedCommentVersion || '', /^[a-f0-9]{64}$/);
    const key = randomUUID(), result = await f.edit(body, key); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.edited, true); assert.equal(result.data.content, body.content); assert.equal(result.data.commentId, body.commentId); assert.notEqual(result.data.comment.editVersion, body.expectedCommentVersion);
    assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].options.method, 'PATCH'); assert.deepEqual(f.writes()[0].body, { accountId: 'rd', platform: 'reddit', content: body.content });
    assert.equal((await f.edit(body, key)).status, 200); assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('Reddit comment edits reject stale reviews, nonowners, foreign scope, empty content and revoked permission', pg, async t => {
  const f = await commentEditFixture(t);
  try {
    const body = await f.draft();
    for (const changes of [{ content: ' ' }, { content: '' }, { confirmEdit: false }, { expectedCommentVersion: 'stale' }, { accountId: 'fb' }, { extra: true }]) assert.ok((await f.edit({ ...body, ...changes })).status >= 400);
    for (const owner of [false, undefined]) { f.comments[0].from.isOwner = owner; assert.equal((await f.edit(body)).status, 422); }
    f.comments[0].from.isOwner = true; f.comments[0].message = 'Externally changed'; assert.equal((await f.edit(body)).status, 409); f.comments[0].message = 'Original comment';
    f.account.platformUserId = 'another-native'; assert.equal((await f.edit(body)).status, 409); f.account.platformUserId = 'reddit-native';
    f.setForeign(true); assert.equal((await f.edit(body)).status, 502); f.setForeign(false);
    f.state.before = async (url, options) => { if (url.pathname.endsWith('/inbox/comments/post-1') && options.method === 'GET') await f.app.sql.run("UPDATE memberships SET role='viewer'"); };
    assert.ok((await f.edit(body)).status >= 400); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('unknown Reddit edits retain durable receipts and fence reactions and edits across aliases and reopen', pg, async t => {
  for (const outcome of ['wrong-receipt', 'lost', 'unchanged', 'wrong-readback']) {
    const f = await commentEditFixture(t);
    try {
      f.accounts.push({ ...f.account, _id: 'reddit-alias' });
      const body = await f.draft();
      if (outcome === 'wrong-receipt') f.state.receipt = () => Response.json({ status: 'success', commentId: 'foreign', platform: 'reddit' });
      if (outcome === 'lost') f.state.receipt = () => { throw new TypeError('Lost receipt'); };
      f.state.unchanged = outcome === 'unchanged'; f.state.badReadback = outcome === 'wrong-readback';
      const result = await f.edit(body); assert.equal(result.status, 409, outcome); assert.equal(result.data.operation.status, 'uncertain');
      await f.reopen(); f.state.badReadback = false;
      const alias = await f.draft('reddit-alias'); assert.equal((await f.edit(alias)).status, 409);
      for (const action of ['like', 'unlike']) assert.equal((await f.request(f.path + '/comments/' + action, 'POST', { accountId: 'reddit-alias', postId: body.postId, commentId: body.commentId })).status, 409);
      assert.equal(f.writes().length, 1);
    } finally { await f.close(); }
  }
});

test('the final awaited Reddit edit preflight cannot race a native alias reaction', pg, async t => {
  const f = await commentEditFixture(t); let reads = 0, release, reached;
  const hold = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  try {
    const body = await f.draft(); f.accounts.push({ ...f.account, _id: 'reddit-alias' });
    f.state.before = async (url, options) => {
      if (url.pathname.endsWith('/accounts') && ++reads === 2) { reached(); await hold; }
    };
    f.state.receipt = () => { throw new TypeError('Lost native edit acknowledgment'); };
    const pendingEdit = f.edit(body); await ready;
    const reaction = await f.request(f.path + '/comments/like', 'POST', { accountId: 'reddit-alias', postId: body.postId, commentId: body.commentId }); assert.equal(reaction.status, 409); assert.equal(reaction.data.error.code, 'COMMENT_REACTION_UNCERTAIN'); assert.equal(f.writes().length, 0);
    release(); assert.equal((await pendingEdit).status, 409); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].options.method, 'PATCH');
  } finally { release?.(); await f.close(); }
});

test('uncertain Reddit reactions fence comment edits after native-account project handoff', pg, async t => {
  const f = await commentEditFixture(t);
  try {
    const body = await f.draft(); f.accounts.push({ ...f.account, _id: 'reddit-alias' });
    f.state.before = (url, options) => { if (url.pathname.endsWith('/like')) throw new TypeError('Lost reaction acknowledgment'); };
    const reaction = await f.request(f.path + '/comments/like', 'POST', { accountId: 'rd', postId: body.postId, commentId: body.commentId }); assert.equal(reaction.data.operation.status, 'uncertain');
    const reopened = await f.reopen(), workspaceId = (await reopened.sql.get('SELECT workspace_id FROM projects WHERE id=?', f.projectId)).workspace_id;
    const created = await f.request('/api/projects', 'POST', { name: 'Reddit handoff', workspaceId }); assert.equal(created.status, 201);
    const nextId = created.data.project.id; await f.request('/api/projects/' + f.projectId, 'PATCH', { zernioProfileId: '' }); await f.request('/api/projects/' + nextId, 'PATCH', { zernioProfileId: 'inbox-profile' });
    const nextPath = '/api/projects/' + nextId + '/integrations/inbox', thread = await f.request(nextPath + '/comments/thread?accountId=reddit-alias&postId=post-1'); assert.equal(thread.status, 200);
    const edit = await f.edit({ ...body, accountId: 'reddit-alias', expectedCommentVersion: thread.data.comments[0].editVersion }, randomUUID(), nextPath); assert.equal(edit.status, 409); assert.equal(edit.data.error.code, 'COMMENT_REACTION_UNCERTAIN'); assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('LinkedIn comment reactions forward all six explicit types and validate already-reacted receipts without inventing GET types', pg, async t => {
  const f = await commentReactionFixture(t);
  try {
    for (const alreadyReacted of [false, true]) for (const reactionType of linkedInReactionTypes) {
      f.state.alreadyReacted = alreadyReacted;
      const key = randomUUID(), result = await f.react({ reactionType }, key);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.reactionType, reactionType); assert.equal(result.data.alreadyReacted, alreadyReacted);
      assert.equal(result.data.accountId, 'li'); assert.equal(result.data.postId, 'post-1'); assert.equal(result.data.platform, 'linkedin'); assert.equal(result.data.commentId, f.body.commentId);
      assert.deepEqual(f.writes().at(-1).body, { accountId: 'li', reactionType }); assert.ok(f.writes().at(-1).url.pathname.endsWith('/' + encodeURIComponent(f.body.commentId) + '/like'));
      const count = f.writes().length; assert.deepEqual((await f.react({ reactionType }, key)).data, result.data); assert.equal(f.writes().length, count);
    }
    const defaultLike = await f.react(); assert.equal(defaultLike.status, 200); assert.equal(defaultLike.data.reactionType, 'LIKE');
    const thread = await f.request(f.path + '/comments/thread?accountId=li&postId=post-1'); assert.equal(thread.data.comments[0].isLiked, true); assert.equal(Object.hasOwn(thread.data.comments[0], 'reactionType'), false);
    const removed = await f.react({}, randomUUID(), 'unlike'); assert.equal(removed.status, 200); assert.equal(removed.data.liked, false); assert.equal(Object.hasOwn(removed.data, 'reactionType'), false);
    const deletion = f.writes().at(-1); assert.equal(deletion.options.method, 'DELETE'); assert.equal(deletion.url.searchParams.get('accountId'), 'li'); assert.equal(deletion.body, undefined);
  } finally { await f.close(); }
});

test('comment reaction types are rejected outside LinkedIn likes and Bluesky retains its native references', pg, async t => {
  const f = await fixture(t);
  f.accounts.push({ _id: 'li', platform: 'linkedin', profileId: 'inbox-profile', isActive: true });
  const body = { accountId: 'li', postId: 'post-1', commentId: 'comment-1' };
  try {
    for (const reactionType of ['like', 'UNKNOWN', '', null, 3, {}, ['LIKE']]) assert.equal((await f.request(f.path + '/comments/like', 'POST', { ...body, reactionType })).status, 400);
    for (const accountId of ['fb', 'bs', 'rd', 'xx', 'ig']) assert.equal((await f.request(f.path + '/comments/like', 'POST', { ...body, accountId, reactionType: 'LIKE' })).status, 400);
    assert.equal((await f.request(f.path + '/comments/unlike', 'POST', { ...body, reactionType: 'LIKE' })).status, 400); assert.equal(f.writes().length, 0);
    const blue = { ...body, accountId: 'bs' }; assert.equal((await f.request(f.path + '/comments/like', 'POST', blue)).data.error.code, 'COMMENT_REFERENCE_REQUIRED');
    f.comments[0].cid = 'comment-cid'; f.comments[0].likeUri = 'at://did:plc:account/app.bsky.feed.like/like-1';
    for (const kind of ['like', 'unlike']) { assert.equal((await f.request(f.path + '/comments/' + kind, 'POST', blue)).status, 200); const call = f.writes().at(-1); if (kind === 'like') assert.equal(call.body.cid, 'comment-cid'); else assert.equal(call.url.searchParams.get('likeUri'), f.comments[0].likeUri); }
  } finally { await f.close(); }
});

test('LinkedIn 403 and 409 rejections never remove or replace an existing reaction', pg, async t => {
  const f = await commentReactionFixture(t); let providerStatus = 403;
  f.state.response = () => Response.json({ code: providerStatus === 403 ? 'linkedin_reconnect_required' : 'invalid_resource_state', secret: 'PRIVATE_PROVIDER_BODY' }, { status: providerStatus });
  try {
    for (const status of [403, 409]) {
      providerStatus = status; const key = randomUUID(), before = f.writes().length, result = await f.react({ reactionType: 'PRAISE' }, key);
      assert.equal(result.status, status); assert.equal(result.data.operation.status, 'failed'); assert.equal(result.data.error.code, status === 403 ? 'LINKEDIN_REACTION_PERMISSION_REQUIRED' : 'LINKEDIN_REACTION_CONFLICT');
      assert.equal(JSON.stringify(result.data).includes('PRIVATE_PROVIDER_BODY'), false);
      assert.equal(f.writes().length, before + 1); assert.equal(f.writes().at(-1).options.method, 'POST');
      await f.react({ reactionType: 'PRAISE' }, key); assert.equal(f.writes().length, before + 1);
    }
    f.state.response = null; assert.equal((await f.react({}, randomUUID(), 'unlike')).status, 200, 'Removal requires a separate explicit request.');
  } finally { await f.close(); }
});

test('malformed and lost LinkedIn reaction acknowledgments remain durable and block retries and replacement reactions', pg, async t => {
  for (const mutation of [{ commentId: 'foreign' }, { platform: 'facebook' }, { accountId: 'foreign' }, { postId: 'foreign' }, { liked: false }, { reactionType: 'LIKE' }, { reactionType: undefined }, { alreadyReacted: 'yes' }, 'unreadable', 'lost']) {
    const f = await commentReactionFixture(t);
    f.state.response = () => { if (mutation === 'lost') throw new TypeError('Lost acknowledgment'); if (mutation === 'unreadable') return new Response('{', { status: 200 }); return Response.json({ status: 'success', platform: 'linkedin', commentId: f.body.commentId, liked: true, reactionType: 'PRAISE', ...mutation }); };
    try {
      const key = randomUUID(), result = await f.react({ reactionType: 'PRAISE' }, key); assert.equal(result.status, 409, JSON.stringify(mutation)); assert.equal(result.data.operation.status, 'uncertain');
      assert.equal((await f.app.sql.get('SELECT status FROM integration_operations WHERE id=?', result.data.operation.id)).status, 'uncertain');
      for (const [extra, retryKey, kind] of [[{ reactionType: 'PRAISE' }, key, 'like'], [{ reactionType: 'EMPATHY' }, randomUUID(), 'like'], [{}, randomUUID(), 'unlike']]) assert.equal((await f.react(extra, retryKey, kind)).status, 409);
      assert.equal(f.writes().length, 1, 'An unknown outcome cannot dispatch a second reaction or removal.');
    } finally { await f.close(); }
  }
});

test('LinkedIn reaction boundaries recheck role, account, post and comment identities before dispatch', pg, async t => {
  for (const mode of ['viewer', 'inactive', 'remapped-account', 'foreign-post', 'missing-comment']) {
    const f = await commentReactionFixture(t);
    f.state.before = async (url, options) => {
      if (options.method !== 'GET') return;
      if (url.pathname.endsWith('/inbox/comments') && mode === 'foreign-post') return Response.json({ data: [{ id: 'post-1', accountId: 'fb', platform: 'facebook' }], pagination: { hasMore: false, nextCursor: null } });
      if (!url.pathname.endsWith('/inbox/comments/post-1')) return;
      if (mode === 'viewer') await f.app.sql.run("UPDATE memberships SET role='viewer'");
      if (mode === 'inactive') f.accounts.find(row => row._id === 'li').isActive = false;
      if (mode === 'remapped-account') f.accounts.find(row => row._id === 'li').profileId = 'another-profile';
      if (mode === 'missing-comment') return Response.json({ comments: [], meta: { accountId: 'li', platform: 'linkedin', postId: 'post-1' }, pagination: { hasMore: false, nextCursor: null } });
    };
    try { const result = await f.react({ reactionType: 'PRAISE' }); assert.ok([403, 409, 502].includes(result.status), mode + ': ' + JSON.stringify(result.data)); assert.equal(f.writes().length, 0); }
    finally { await f.close(); }
  }
});

test('native comment uncertainty survives an app reopen, project mapping handoff and account aliases until an explicit review', pg, async t => {
  for (const legacy of [false, true]) {
    const f = await commentReactionFixture(t);
    f.accounts.find(row => row._id === 'li').platformUserId = 'native-linkedin-42';
    f.accounts.push({ _id: 'li-alias', platform: 'linkedin', platformUserId: 'native-linkedin-42', profileId: 'inbox-profile', isActive: true });
    f.state.response = () => { throw new TypeError('Provider applied the reaction but its acknowledgment was lost'); };
    try {
      const original = await f.react({ reactionType: 'PRAISE' }); assert.equal(original.data.operation.status, 'uncertain'); assert.equal(f.writes().length, 1);
      if (legacy) await f.app.sql.run('DELETE FROM inbox_comment_reactions');
      const reopened = await f.reopen(), workspaceId = (await reopened.sql.get('SELECT workspace_id FROM projects WHERE id=?', f.projectId)).workspace_id;
      assert.equal((await reopened.sql.get('SELECT status FROM integration_operations WHERE id=?', original.data.operation.id)).status, 'uncertain');
      const created = await f.request('/api/projects', 'POST', { name: 'Reaction mapping handoff', workspaceId }); assert.equal(created.status, 201, JSON.stringify(created.data));
      const secondId = created.data.project.id, route = `/api/projects/${secondId}/integrations/inbox/comments/`;
      assert.equal((await f.request(`/api/projects/${f.projectId}`, 'PATCH', { zernioProfileId: '' })).status, 200);
      assert.equal((await f.request(`/api/projects/${secondId}`, 'PATCH', { zernioProfileId: 'inbox-profile' })).status, 200);
      const aliasBody = { ...f.body, accountId: 'li-alias' };
      for (const [kind, extra] of [['like', { reactionType: 'PRAISE' }], ['like', { reactionType: 'EMPATHY' }], ['unlike', {}]]) { const blocked = await f.request(route + kind, 'POST', { ...aliasBody, ...extra }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'COMMENT_REACTION_UNCERTAIN'); }
      assert.equal(f.writes().length, 1);
      const reviewed = await f.request(`/api/projects/${f.projectId}/operations/${original.data.operation.id}/review`, 'POST', { resolution: 'applied', confirmChecked: true, note: 'Checked LinkedIn and confirmed the original reaction is present.' }); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
      assert.equal((await f.request(route + 'like', 'POST', { ...aliasBody, reactionType: 'PRAISE' })).status, 409); assert.equal(f.writes().length, 1);
      f.state.response = null; assert.equal((await f.request(route + 'unlike', 'POST', aliasBody)).status, 200, 'A reconciled applied reaction permits a new explicit removal.'); assert.equal(f.writes().length, 2); assert.equal(f.writes().at(-1).options.method, 'DELETE');
    } finally { await f.close(); }
  }
});

test('the final awaited account preflight cannot race a concurrent native-comment dispatch', pg, async t => {
  const f = await commentReactionFixture(t);
  f.accounts.find(row => row._id === 'li').platformUserId = 'native-linkedin-42';
  f.accounts.push({ _id: 'li-alias', platform: 'linkedin', platformUserId: 'native-linkedin-42', profileId: 'inbox-profile', isActive: true });
  let accountReads = 0, releasePreflight, reachedPreflight;
  const held = new Promise(resolve => { releasePreflight = resolve; }), reached = new Promise(resolve => { reachedPreflight = resolve; });
  f.state.before = async url => { if (url.pathname.endsWith('/accounts') && ++accountReads === 2) { reachedPreflight(); await held; } };
  f.state.response = () => { throw new TypeError('Lost concurrent acknowledgment'); };
  try {
    const first = f.react({ reactionType: 'PRAISE' }); await reached;
    const second = await f.react({ accountId: 'li-alias', reactionType: 'EMPATHY' }); assert.equal(second.data.error.code, 'COMMENT_REACTION_UNCERTAIN'); assert.equal(f.writes().length, 0); releasePreflight();
    const resumed = await first; assert.equal(resumed.status, 409); assert.equal(resumed.data.operation.status, 'uncertain'); assert.equal(f.writes().length, 1);
  } finally { releasePreflight(); await f.close(); }
});

async function privateReplyFixture(t, accountId = 'fb') {
  const f = await fixture(t), state = { before: null, response: null, onSend: null };
  f.comments[0].createdTime = new Date(Date.now() - 60000).toISOString();
  f.setHook(async (url, options) => {
    const intercepted = await state.before?.(url, options); if (intercepted !== undefined) return intercepted;
    if (!url.pathname.endsWith('/private-reply')) return;
    await state.onSend?.(url, options);
    return state.response ? state.response(url, options) : Response.json({ status: 'success', messageId: 'private-message-1', commentId: decodeURIComponent(url.pathname.split('/').at(-2)), platform: f.accounts.find(row => row._id === JSON.parse(options.body).accountId)?.platform });
  });
  const thread = () => f.request(`${f.path}/comments/thread?` + new URLSearchParams({ accountId, postId: accountId === 'ads' ? 'ad-1:instagram' : 'post-1' }));
  const draft = async (extra = {}) => { const result = await thread(); assert.equal(result.status, 200, JSON.stringify(result.data)); const row = result.data.comments[0]; return { accountId, postId: accountId === 'ads' ? 'ad-1:instagram' : 'post-1', commentId: row.id, expectedCommentVersion: row.privateReplyVersion, message: 'Thanks for your question. How can we help?', confirmSend: true, ...extra }; };
  const send = (body, key = randomUUID()) => f.request(f.path + '/comments/private-reply', 'POST', body, key);
  return { ...f, state, thread, draft, send };
}

test('private comment replies require an explicit reviewed Meta comment, bridge ads correctly and persist one send per comment', pg, async t => {
  for (const accountId of ['fb', 'ig', 'ads']) {
    const f = await privateReplyFixture(t, accountId);
    try {
      const status = await f.request(f.path + '/status'); assert.equal(status.data.accounts.find(row => row.id === accountId).capabilities.commentPrivateReply, true);
      const initial = await f.thread(); assert.equal(initial.data.comments[0].privateReplyEligible, true); assert.equal(f.writes().length, 0, 'Reading and opening the composer never sends.');
      const body = await f.draft(), key = randomUUID(), accepted = await f.send(body, key);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.operation.status, 'complete'); assert.equal(accepted.data.sent, true); assert.equal(accepted.data.accountId, accountId); assert.equal(accepted.data.commentId, body.commentId); assert.equal(accepted.data.postId, body.postId);
      const sent = f.writes().at(-1); assert.equal(sent.url.pathname, `/api/v1/inbox/comments/${accountId === 'ads' ? 'ad-media-1' : 'post-1'}/comment-1/private-reply`); assert.equal(sent.options.headers['Idempotency-Key'], key); assert.deepEqual(sent.body, { accountId: accountId === 'ads' ? 'ig' : accountId, message: body.message });
      assert.equal((await f.send(body, key)).status, 200); const blocked = await f.send({ ...body, message: 'A different message and action key must still not resend.' }); assert.equal(blocked.data.error.code, 'PRIVATE_REPLY_RECORDED'); assert.equal(f.writes().length, 1);
      const refreshed = await f.thread(); assert.equal(refreshed.data.comments[0].privateReplyEligible, false); assert.equal(refreshed.data.comments[0].privateReplyStatus, 'sent');
      assert.equal((await f.app.sql.get('SELECT status FROM inbox_private_replies')).status, 'sent'); assert.equal((await f.app.sql.get('SELECT COUNT(*) AS count FROM direct_contacts')).count, 0, 'A comment or outbound reply must not manufacture marketing permission.');
    } finally { await f.close(); }
  }
});

test('private reply eligibility rejects stale reviews, unsupported platforms, unknown authors and expired or future comment times before sending', pg, async t => {
  const f = await privateReplyFixture(t);
  try {
    const body = await f.draft(), original = structuredClone(f.comments[0]);
    for (const patch of [{ createdTime: new Date(Date.now() - 7 * 86400000).toISOString() }, { createdTime: new Date(Date.now() + 86400000).toISOString() }, { createdTime: undefined }, { from: { ...original.from, isOwner: true } }, { from: { ...original.from, isOwner: undefined } }, { from: { isOwner: false } }, { canReply: false }]) {
      Object.assign(f.comments[0], original, patch); assert.equal((await f.thread()).data.comments[0].privateReplyEligible, false);
      assert.equal((await f.send(body)).data.error.code, 'PRIVATE_REPLY_INELIGIBLE');
    }
    Object.assign(f.comments[0], original, { message: 'This comment was edited after review.' }); assert.equal((await f.send(body)).data.error.code, 'PRIVATE_REPLY_REVIEW_REQUIRED');
    Object.assign(f.comments[0], original); assert.equal((await f.send({ ...body, confirmSend: false })).data.error.code, 'PRIVATE_REPLY_REVIEW_REQUIRED');
    assert.equal((await f.send({ ...body, postId: 'other-post' })).data.error.code, 'INBOX_ITEM_OUTSIDE_PROJECT');
    assert.equal((await f.send({ ...body, commentId: 'other-comment' })).data.error.code, 'COMMENT_OUTSIDE_POST');
    assert.equal((await f.send({ ...body, accountId: 'yt' })).data.error.code, 'INBOX_FEATURE_UNSUPPORTED');
    assert.equal((await f.send({ ...body, accountId: 'foreign' })).status, 403);
    f.setForeign(true); assert.equal((await f.send(body)).data.error.code, 'INVALID_PROVIDER_SCOPE'); f.setForeign(false);
    assert.equal(f.writes().length, 0);
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); const before = f.calls.length; assert.equal((await f.send(body)).status, 403); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('private replies validate Meta buttons and quick replies and keep invalid payloads definitely failed and retryable', pg, async t => {
  const f = await privateReplyFixture(t);
  try {
    const body = await f.draft(), invalid = [
      { buttons: [] }, { buttons: Array.from({ length: 4 }, () => ({ type: 'url', title: 'Link', url: 'https://example.com' })) },
      { buttons: [{ type: 'url', title: 'An excessively long label', url: 'https://example.com' }] }, { buttons: [{ type: 'url', title: 'Link', url: 'http://127.0.0.1/private' }] },
      { buttons: [{ type: 'postback', title: 'Reply', payload: '' }] }, { buttons: [{ type: 'phone', title: 'Call', phone: '555' }] }, { buttons: [{ type: 'url', title: 'Link', url: 'https://example.com', payload: 'unexpected' }] },
      { quickReplies: Array.from({ length: 14 }, () => ({ title: 'Yes', payload: 'YES' })) }, { quickReplies: [{ title: 'Yes', payload: 'YES', imageUrl: 'https://192.168.1.1/icon' }] },
      { buttons: [{ type: 'url', title: 'Link', url: 'https://example.com' }], quickReplies: [{ title: 'Yes', payload: 'YES' }] }, { template: {} }, { message: 'a'.repeat(2001) },
    ];
    for (const extra of invalid) { const rejected = await f.send({ ...body, ...extra }); assert.ok([400, 422].includes(rejected.status), JSON.stringify(rejected.data)); assert.equal(rejected.data.operation.status, 'failed'); }
    assert.equal(f.writes().length, 0);
    const buttons = [{ type: 'url', title: 'More information', url: 'https://example.com/details' }, { type: 'postback', title: 'Talk to us', payload: 'ASK_SUPPORT' }, { type: 'phone', title: 'Phone us', phone: '+15551234567' }];
    assert.equal((await f.send({ ...body, buttons })).status, 200); assert.deepEqual(f.writes().at(-1).body.buttons, buttons);
    f.comments[0].id = 'comment-2'; const quickReplies = Array.from({ length: 13 }, (_, index) => ({ title: `Option ${index + 1}`, payload: `OPTION_${index + 1}`, ...(index === 0 ? { imageUrl: 'https://example.com/icon.png' } : {}) }));
    assert.equal((await f.send(await f.draft({ quickReplies }))).status, 200); assert.deepEqual(f.writes().at(-1).body.quickReplies, quickReplies);
    f.comments[0].id = 'comment-3'; const igThread = await f.request(f.path + '/comments/thread?accountId=ig&postId=post-1'), ig = { ...body, commentId: 'comment-3', expectedCommentVersion: igThread.data.comments[0].privateReplyVersion, accountId: 'ig', buttons: [{ type: 'phone', title: 'Call', phone: '+15551234567' }] }; assert.equal((await f.send(ig)).data.error.code, 'INVALID_PRIVATE_REPLY'); assert.equal(f.writes().length, 2);
  } finally { await f.close(); }
});

test('private reply consumed and unknown outcomes survive new keys and operator review cannot reopen spent comments', pg, async t => {
  for (const mode of ['consumed', 'unknown', 'malformed400', 'lost', 'bad-receipt']) {
    const f = await privateReplyFixture(t, 'ig');
    try {
      const body = await f.draft(), key = randomUUID();
      f.state.response = () => mode === 'consumed' ? Response.json({ error: 'Do not expose provider body or apiKey', apiKey: 'never-return-this', details: { privateReplyConsumed: true } }, { status: 400 }) : mode === 'unknown' ? Response.json({ details: { privateReplyOutcome: 'unknown' } }, { status: 502 }) : mode === 'malformed400' ? new Response('unreadable', { status: 400 }) : mode === 'lost' ? (() => { throw new Error('Lost acknowledgement'); })() : Response.json({ status: 'success', messageId: 'sent-1', commentId: 'different-comment', platform: 'instagram' });
      const result = await f.send(body, key); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.operation.status, mode === 'consumed' ? 'failed' : 'uncertain'); assert.equal(JSON.stringify(result.data).includes('never-return-this'), false);
      assert.equal((await f.send(body, key)).status, 409); assert.equal((await f.send({ ...body, message: 'Do not repeat an unknown or consumed private reply.' })).status, 409); assert.equal(f.writes().length, 1);
      const state = (await f.thread()).data.comments[0]; assert.equal(state.privateReplyEligible, false); assert.equal(state.privateReplyStatus, mode === 'consumed' ? 'consumed' : 'uncertain');
      const review = await f.request(`/api/projects/${f.projectId}/operations/${result.data.operation.id}/review`, 'POST', { resolution: 'not_applied', confirmChecked: true, note: 'Checked the synthetic fixture conversation and provider receipt.' }); assert.equal(review.status, mode === 'consumed' ? 409 : 200, JSON.stringify(review.data));
      f.state.response = null;
      const fresh = await f.send({ ...body, message: 'Explicit new send after verified non-application.' }); assert.equal(fresh.status, mode === 'consumed' ? 409 : 200, JSON.stringify(fresh.data)); assert.equal(f.writes().length, mode === 'consumed' ? 1 : 2);
    } finally { await f.close(); }
  }
});

test('known nonconsumed private reply rejection releases the fence and concurrent changed payloads cannot dispatch twice', pg, async t => {
  const f = await privateReplyFixture(t); let release;
  try {
    const body = await f.draft(); f.state.response = () => Response.json({ error: 'Invalid input', code: 'invalid_field_value' }, { status: 400 });
    const failed = await f.send(body); assert.equal(failed.status, 400); assert.equal(failed.data.operation.status, 'failed'); assert.equal((await f.app.sql.get('SELECT COUNT(*) AS count FROM inbox_private_replies')).count, 0); assert.equal((await f.thread()).data.comments[0].privateReplyEligible, true);
    f.state.response = null; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { f.state.onSend = async () => { resolve(); await held; }; });
    const first = f.send(body); await started;
    const competing = await f.send({ ...body, message: 'A concurrent different reply to the same comment.' }); assert.equal(competing.data.error.code, 'PRIVATE_REPLY_RECORDED');
    release(); assert.equal((await first).status, 200); assert.equal(f.writes().length, 2, 'One known rejected request and one accepted send; the competing request never dispatches.');
  } finally { release?.(); await f.close(); }
});

test('private reply rechecks account activity, exact platform, project mapping and current role after thread lookup', pg, async t => {
  for (const mode of ['inactive', 'platform', 'mapping', 'viewer']) {
    const f = await privateReplyFixture(t, 'ads'); let reads = 0;
    try {
      const body = await f.draft();
      f.state.before = async (url, options) => {
        if (url.pathname.endsWith('/accounts') && options.method === 'GET' && ++reads === 2) {
          if (mode === 'inactive') f.accounts.find(row => row._id === 'ig').isActive = false;
          if (mode === 'platform') f.accounts.find(row => row._id === 'ig').platform = 'facebook';
          if (mode === 'mapping') await f.app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile'");
          if (mode === 'viewer') await f.app.sql.run("UPDATE memberships SET role='viewer'");
        }
      };
      const denied = await f.send(body); assert.ok([400, 403, 409, 422].includes(denied.status), JSON.stringify(denied.data)); assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  }
});

test('X and Instagram attachment replies use DM limits, inspect exact URLs and replay accepted sends without duplicates', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply'; let metadata;
  f.setHook(url => url.pathname.endsWith('/tools/validate/media') ? Response.json(metadata) : undefined);
  try {
    const status = await f.request(f.path + '/status'), x = status.data.accounts.find(item => item.id === 'xx'), ig = status.data.accounts.find(item => item.id === 'ig');
    assert.deepEqual(x.capabilities.attachmentTypes, ['image', 'video']); assert.equal(x.capabilities.attachmentRules.video.maxMB, 25); assert.deepEqual(ig.capabilities.attachmentTypes, ['image', 'video', 'audio', 'file']); assert.equal(ig.capabilities.attachmentRules.image.maxMB, 8);
    for (const [index, [accountId, attachmentType, contentType, mb]] of [
      ['xx', 'image', 'image/png', 25], ['xx', 'video', 'video/mp4', 25],
      ['ig', 'image', 'image/jpeg', 8], ['ig', 'video', 'video/quicktime', 25], ['ig', 'video', 'video/ogg', 25], ['ig', 'video', 'video/x-msvideo', 25], ['ig', 'video', 'video/webm', 25],
      ['ig', 'audio', 'audio/aac', 25], ['ig', 'audio', 'audio/mp4', 25], ['ig', 'audio', 'audio/wav', 25], ['ig', 'file', 'application/pdf', 25],
    ].entries()) {
      const body = { accountId, attachmentUrl: `https://cdn.example.com/attachment-${index}`, attachmentType }, key = randomUUID(); metadata = { valid: true, url: body.attachmentUrl, size: mb * 1024 * 1024, contentType };
      const sent = await f.request(route, 'POST', body, key); assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.platform, accountId === 'ig' ? 'instagram' : 'twitter'); assert.equal(sent.data.accountId, accountId); assert.deepEqual(f.writes().at(-1).body, body);
      const beforeReplay = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, beforeReplay);
    }
    const rejected = [
      ['xx', 'image', { valid: true, size: 25 * 1024 * 1024 + 1, contentType: 'image/png' }], ['xx', 'video', { valid: true, size: 100, contentType: 'text/html' }],
      ['xx', 'audio', { valid: true, size: 100, contentType: 'audio/mp4' }], ['ig', 'image', { valid: true, size: 8 * 1024 * 1024 + 1, contentType: 'image/png' }],
      ['ig', 'image', { valid: true, size: 100, contentType: 'image/gif' }], ['ig', 'audio', { valid: true, size: 100, contentType: 'audio/mpeg' }], ['ig', 'audio', { valid: true, size: 100, contentType: 'audio/ogg' }],
      ['ig', 'file', { valid: true, size: 100, contentType: 'text/plain' }], ['ig', 'file', { valid: true, size: 25 * 1024 * 1024 + 1, contentType: 'application/pdf' }],
      ['ig', 'file', { valid: true, size: null, contentType: 'application/pdf' }], ['ig', 'file', { valid: false, size: 100, contentType: 'application/pdf' }],
      ['ig', 'file', { valid: true, size: 100, contentType: 'application/pdf', url: 'https://cdn.example.com/different.pdf' }],
    ];
    const beforeRejected = f.writes().length;
    for (const [index, [accountId, attachmentType, checked]] of rejected.entries()) { metadata = checked; const result = await f.request(route, 'POST', { accountId, attachmentUrl: `https://cdn.example.com/rejected-${index}`, attachmentType }); assert.ok([400, 409, 422].includes(result.status), JSON.stringify(result.data)); assert.equal(result.data.operation?.status, 'failed', 'A media preflight failure is not an uncertain send.'); }
    assert.equal(f.writes().length, beforeRejected);
  } finally { await f.close(); }
});

test('attachment preflight cannot outlive current account, recipient, project access, reply window or hosted-file expiry', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply', originalAccount = f.accounts.find(item => item._id === 'ig'); let mode = '', inspected = false;
  const asset = await f.app.store.create(f.projectId, 'assets', { name: 'Hosted inbox PDF', source: 'zernio', url: 'https://media.zernio.com/temp/inbox.pdf', deliveryUrl: 'https://media.zernio.com/temp/inbox.pdf', deliverySource: 'zernio', deliveryUploadedAt: new Date(Date.now() - 86400000).toISOString(), deliveryExpiresAt: new Date(Date.now() + 86400000).toISOString() });
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/tools/validate/media')) {
      inspected = true;
      if (mode === 'inactive') originalAccount.isActive = false;
      if (mode === 'foreign') originalAccount.profileId = 'foreign-profile';
      if (mode === 'viewer') await f.app.sql.run("UPDATE memberships SET role='viewer'");
      if (mode === 'mapping') await f.app.sql.run("UPDATE projects SET zernio_profile_id='different-profile'");
      if (mode === 'window') f.setIncoming(Date.now() - 25 * 3600000);
      if (mode === 'expiry') await f.app.store.update(f.projectId, 'assets', asset.id, { deliveryExpiresAt: new Date(Date.now() - 1000).toISOString() });
      return Response.json({ valid: true, size: 100, contentType: 'application/pdf' });
    }
    if (inspected && mode === 'recipient' && url.pathname.endsWith('/inbox/conversations/thread-1') && options.method === 'GET') return Response.json({ data: { id: 'thread-1', accountId: 'ig', platform: 'instagram', participantId: 'changed-recipient', status: 'active' } });
  });
  try {
    for (const next of ['inactive', 'foreign', 'viewer', 'mapping', 'recipient', 'window', 'expiry']) {
      mode = next; inspected = false; originalAccount.isActive = true; originalAccount.profileId = 'inbox-profile'; f.setIncoming(Date.now()); await f.app.sql.run("UPDATE memberships SET role='owner'"); await f.app.sql.run("UPDATE projects SET zernio_profile_id='inbox-profile'");
      const before = f.writes().length, result = await f.request(route, 'POST', { accountId: 'ig', attachmentUrl: mode === 'expiry' ? asset.deliveryUrl : `https://cdn.example.com/${mode}.pdf`, attachmentType: 'file' });
      assert.ok([403, 409, 422].includes(result.status), `${mode}: ${JSON.stringify(result.data)}`); assert.equal(f.writes().length, before, `${mode} must stop before an external send.`);
    }
    // ten98-campaign#54 item 5: the hosted-file check reads assets by delivery URL, not the project's whole asset collection.
    await f.app.sql.run("INSERT INTO records (id, project_id, collection, data) SELECT 'asset-' || n, ?, 'assets', json_build_object('id', 'asset-' || n, 'deliveryUrl', 'https://cdn.example.com/other-' || n) FROM generate_series(1, 300) n", f.projectId);
    let rows = 0; const query = pgDriver.Client.prototype.query;
    // Pool queries use pg's callback form and transactions the promise form; count rows from records either way.
    pgDriver.Client.prototype.query = function (...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || '', count = value => { if (/"records"/.test(text)) rows += value?.rows?.length || 0; }, done = args.at(-1);
      if (typeof done === 'function') args[args.length - 1] = (error, value) => { if (!error) count(value); return done(error, value); };
      const result = query.apply(this, args); if (result?.then) result.then(count, () => {}); return result;
    };
    const expired = await f.app.store.create(f.projectId, 'assets', { name: 'Expired inbox PDF', source: 'zernio', url: 'https://media.zernio.com/temp/expired.pdf', deliveryUrl: 'https://media.zernio.com/temp/expired.pdf', deliverySource: 'zernio', deliveryUploadedAt: new Date(Date.now() - 86400000).toISOString(), deliveryExpiresAt: new Date(Date.now() - 1000).toISOString() });
    try { mode = ''; const result = await f.request(route, 'POST', { accountId: 'ig', attachmentUrl: expired.deliveryUrl, attachmentType: 'file' }); assert.equal(result.data.error?.code, 'ATTACHMENT_EXPIRED', JSON.stringify(result.data)); }
    finally { pgDriver.Client.prototype.query = query; }
    assert.ok(rows < 20, `The attachment check read ${rows} asset rows; loading every asset reads more than 300.`);
  } finally { await f.close(); }
});

test('Meta combined replies validate independent message IDs and partial text failures before completing an operation', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply'; let receipt;
  f.setHook((url, options) => url.pathname.endsWith('/messages') && options.method === 'POST' ? Response.json({ success: true, data: { messageId: 'attachment-sent', conversationId: 'thread-1', ...receipt } }) : undefined);
  try {
    const body = { accountId: 'ig', message: 'Text after attachment', attachmentUrl: 'https://cdn.example.com/details.png', attachmentType: 'image' };
    receipt = { messageIds: ['attachment-sent', 'text-sent'], attachments: [{ type: 'image', url: 'https://cdn.example.com/sent.png', privateToken: 'must-not-return' }] };
    const success = await f.request(route, 'POST', body); assert.equal(success.status, 200); assert.deepEqual(success.data.messageIds, ['attachment-sent', 'text-sent']); assert.equal(success.data.attachments[0].privateToken, undefined);
    receipt = { partialFailure: { part: 'text', error: 'Synthetic text rejection', platformError: { code: 10, subcode: 20, type: 'OAuthException', fbtraceId: 'synthetic', privateToken: 'must-not-return' } }, messageIds: ['attachment-sent'] };
    const partialBody = { ...body, message: 'Unsent text retained by client' }, key = randomUUID(), partial = await f.request(route, 'POST', partialBody, key);
    assert.equal(partial.status, 200); assert.equal(partial.data.operation.status, 'complete'); assert.equal(partial.data.partialFailure.part, 'text'); assert.equal(partial.data.partialFailure.platformError.privateToken, undefined); const writes = f.writes().length; assert.equal((await f.request(route, 'POST', partialBody, key)).status, 200); assert.equal(f.writes().length, writes);
    delete receipt.messageIds; assert.equal((await f.request(route, 'POST', { ...body, message: 'Explicit partial failure needs only its attachment message ID' })).status, 200);
    for (const [index, bad] of [
      {}, { messageIds: ['different', 'text-sent'] }, { messageIds: ['attachment-sent', 'attachment-sent'] }, { messageIds: ['attachment-sent', {}] },
      { partialFailure: true }, { partialFailure: { part: 'attachment', error: 'Wrong part' } }, { partialFailure: { part: 'text', error: '' } }, { partialFailure: { part: 'text', error: 'Bad diagnostics', platformError: { code: 'invalid' } } },
      { partialFailure: { part: 'text', error: 'Contradictory success' }, messageIds: ['attachment-sent', 'text-sent'] }, { attachments: [{ type: 'video', url: 'https://cdn.example.com/file.mp4' }] },
    ].entries()) {
      receipt = bad; const malformedBody = { ...body, message: `Malformed receipt ${index}` }, malformedKey = randomUUID(), before = f.writes().length, result = await f.request(route, 'POST', malformedBody, malformedKey);
      assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'uncertain'); assert.equal((await f.request(route, 'POST', malformedBody, malformedKey)).status, 409); assert.equal((await f.request(route, 'POST', malformedBody)).status, 409); assert.equal(f.writes().length, before + 1);
      await f.app.sql.run("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?", result.data.operation.id);
    }
  } finally { await f.close(); }
});

test('the actual UI writer retries a definitely failed media inspection without duplicating the accepted message', pg, async t => {
  const f = await fixture(t), suffix = 'conversations/thread-1/reply', body = { accountId: 'ig', attachmentUrl: 'https://cdn.example.com/recover.pdf', attachmentType: 'file' }, keys = { current: new Map() }, sentKeys = []; let inspectionCalls = 0;
  f.setHook(url => url.pathname.endsWith('/tools/validate/media') ? ++inspectionCalls === 1 ? Response.json({ error: 'Synthetic inspection outage' }, { status: 502 }) : Response.json({ valid: true, size: 100, contentType: 'application/pdf' }) : undefined);
  try {
    const source = await readFile(new URL('../src/UnifiedInbox.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), handler = source.slice(start, source.indexOf('  async function loadAccounts(', start));
    const context = { readOnly: false, path: f.path.replace(/^\/api/, ''), keys, crypto: globalThis.crypto, account: { platform: 'instagram' }, requester: { current: async (path, method, payload, key) => { sentKeys.push(key); const response = await f.request('/api' + path, method, payload, key); if (response.status >= 400) throw Object.assign(new Error(response.data.error.message), { status: response.status, code: response.data.error.code, operation: response.data.operation }); return response.data; } } };
    const write = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
    await assert.rejects(write(suffix, body), error => error.status === 502 && error.operation.status === 'failed'); assert.equal(keys.current.size, 0); assert.equal(f.writes().length, 0);
    const sent = await write(suffix, body); assert.equal(sent.operation.status, 'complete'); assert.equal(inspectionCalls, 2); assert.equal(f.writes().length, 1); assert.notEqual(sentKeys[0], sentKeys[1]);
    assert.equal((await f.request(f.path + '/' + suffix, 'POST', body, sentKeys[1])).status, 200); assert.equal(inspectionCalls, 2); assert.equal(f.writes().length, 1, 'The accepted retry still replays its exact receipt without a second message.');
  } finally { await f.close(); }
});

test('attachment resolution proves account, conversation, message and index before requesting a fresh public link', pg, async t => {
  const f = await fixture(t); let mode = 'valid';
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'media/message', conversationId: 'thread-1', accountId: 'ig', platform: 'instagram', direction: 'incoming', createdAt: new Date().toISOString(), attachments: [{ type: 'image', url: 'https://cdn.example.test/expired.jpg', refreshUrl: 'https://evil.example.test/never-follow' }] }], pagination: { hasMore: false, nextCursor: null } });
    if (url.pathname.endsWith('/attachments/0')) {
      assert.equal(options.method, 'GET'); assert.equal(url.searchParams.get('format'), 'json'); assert.equal(url.searchParams.get('accountId'), 'ig');
      return mode === 'expired' ? Response.json({}, { status: 404 }) : Response.json({ status: 'success', url: mode === 'private' ? 'https://127.0.0.1/private' : 'https://cdn.example.test/fresh.jpg', refreshed: true });
    }
  });
  try {
    const target = `${f.path}/conversations/thread-1/messages/media%2Fmessage/attachments/0?accountId=ig`;
    let result = await f.request(target); assert.equal(result.status, 200); assert.deepEqual(result.data.attachment, { type: 'image', url: 'https://cdn.example.test/fresh.jpg', refreshed: true });
    const count = f.calls.filter(call => call.url.pathname.endsWith('/attachments/0')).length;
    assert.equal((await f.request(target.replace('/attachments/0', '/attachments/1'))).status, 404);
    assert.equal((await f.request(target.replace('media%2Fmessage', 'foreign-message'))).status, 404);
    assert.equal((await f.request(target.replace('accountId=ig', 'accountId=foreign'))).status, 403);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/attachments/0')).length, count);
    mode = 'private'; assert.equal((await f.request(target)).status, 502);
    mode = 'expired'; assert.equal((await f.request(target)).status, 410);
    assert.equal(f.calls.some(call => call.url.hostname === 'evil.example.test'), false); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('WhatsApp attachment downloads keep credentials server-side and reject unsafe, expired, oversized and changed-access responses', pg, async t => {
  const f = await fixture(t); let mode = 'valid', mediaUrl = 'https://zernio.com/api/v1/whatsapp/media/media-id?accountId=wa';
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'media-message', accountId: 'wa', platform: 'whatsapp', conversationId: 'thread-1', direction: 'incoming', createdAt: new Date().toISOString(), attachments: [{ type: 'image', url: mediaUrl, payload: { id: 'media-id' } }] }], pagination: { hasMore: false, nextCursor: null } });
    if (url.pathname.endsWith('/whatsapp/media/media-id')) {
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer inbox-fixture-key');
      assert.equal(url.searchParams.get('accountId'), 'wa');
      if (mode === 'expired') return Response.json({}, { status: 400 });
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example.test/never-follow' } });
      if (mode === 'stream-oversized') return new Response(Buffer.alloc(6 * 1024 * 1024), { headers: { 'Content-Type': 'image/jpeg' } });
      if (mode === 'access') await f.app.sql.run("UPDATE memberships SET role='viewer'");
      return new Response(Buffer.from('image bytes'), { headers: { 'Content-Type': mode === 'html' ? 'text/html' : 'image/jpeg', 'Content-Length': mode === 'oversized' ? String(6 * 1024 * 1024) : '11' } });
    }
  });
  try {
    const target = `${f.path}/conversations/thread-1/messages/media-message/attachments/0?accountId=wa`;
    let result = await f.request(target); assert.equal(result.status, 200); assert.equal(result.data.attachment.url, undefined); assert.equal(result.data.attachment.downloadUrl, target + '&download=1');
    assert.equal(f.calls.some(call => call.url.pathname.includes('/whatsapp/media/')), false, 'Descriptor loading does not fetch the binary or generate a read receipt.');
    result = await f.request(target + '&download=1'); assert.equal(result.status, 200); assert.equal(result.data.toString(), 'image bytes'); assert.equal(result.headers.get('content-disposition'), 'attachment; filename="inbox-attachment.jpg"'); assert.equal(result.headers.get('cache-control'), 'private, no-store');
    for (mode of ['html', 'oversized', 'stream-oversized', 'redirect', 'expired']) { result = await f.request(target + '&download=1'); assert.equal(result.status, mode === 'expired' ? 410 : 502, JSON.stringify(result.data)); }
    mediaUrl = 'https://evil.example.test/api/v1/whatsapp/media/media-id?accountId=wa'; assert.equal((await f.request(target + '&download=1')).status, 502);
    mediaUrl = 'https://zernio.com/api/v1/whatsapp/media/media-id?accountId=other'; assert.equal((await f.request(target + '&download=1')).status, 502);
    mediaUrl = 'https://zernio.com/api/v1/whatsapp/media/media-id'; mode = 'valid'; assert.equal((await f.request(target + '&download=1')).status, 200, 'A verified attachment without the query receives the scoped account parameter.');
    mode = 'access'; assert.equal((await f.request(target + '&download=1')).status, 403);
  } finally { await f.close(); }
});

test('typing is an explicit scoped action and a provider no-op never becomes delivered', pg, async t => {
  const f = await fixture(t); let delivered = false;
  f.setHook(url => url.pathname.endsWith('/typing') ? Response.json({ success: delivered }) : undefined);
  try {
    const target = `${f.path}/conversations/thread-1/typing`;
    assert.equal((await f.request(target, 'POST', { accountId: 'wa' })).status, 400);
    assert.equal((await f.request(target, 'POST', { accountId: 'xx', confirmTyping: true })).status, 422);
    let result = await f.request(target, 'POST', { accountId: 'wa', confirmTyping: true }); assert.equal(result.status, 200); assert.equal(result.data.delivered, false); assert.equal(result.data.mayMarkRead, true);
    delivered = true; result = await f.request(target, 'POST', { accountId: 'wa', confirmTyping: true }); assert.equal(result.data.delivered, true);
    const count = f.writes().length; await f.app.sql.run("UPDATE memberships SET role='viewer'"); assert.equal((await f.request(target, 'POST', { accountId: 'wa', confirmTyping: true })).status, 403); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('stored-copy deletion binds the latest message and protects completed or unknown outcomes across fresh keys', pg, async t => {
  for (const outcome of ['success', 'malformed', 'network']) {
    const f = await fixture(t); let latest = 'message-a', retryAllowed = false;
    f.setHook((url, options) => {
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [...new Set(['message-a', latest])].map(id => ({ id, accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', senderId: 'participant-a', message: id, createdAt: '2026-10-18T12:00:00Z', attachments: [] })), pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
      if (url.pathname.endsWith('/inbox/conversations/thread-1') && options.method === 'DELETE') {
        if (outcome === 'network' && !retryAllowed) throw new Error('Lost deletion receipt');
        return Response.json({ success: true, data: { id: outcome === 'malformed' ? 'other-thread' : 'thread-1', accountId: 'fb', platform: 'facebook', deletedMessages: 2 } });
      }
    });
    try {
      const target = `${f.path}/conversations/thread-1`, detail = await f.request(target + '/messages?accountId=fb');
      const body = { accountId: 'fb', expectedDeleteVersion: detail.data.conversation.deleteVersion, confirmConversationId: 'thread-1' }, contactCount = (await f.app.sql.get('SELECT COUNT(*) AS count FROM direct_contacts')).count;
      latest = '0-new-arrival'; assert.equal((await f.request(target + '/delete', 'POST', body)).status, 409); assert.equal(f.writes().length, 0, 'An arrival with the same timestamp invalidates review even when its ID sorts below the old latest message.');
      body.expectedDeleteVersion = (await f.request(target + '/messages?accountId=fb')).data.conversation.deleteVersion;
      const result = await f.request(target + '/delete', 'POST', body, 'stored-delete-key'); assert.equal(result.status, outcome === 'success' ? 200 : 409);
      if (outcome === 'success') { assert.equal(result.data.scope, 'zernio_copy'); assert.equal(result.data.deletedMessages, 2); }
      assert.equal((await f.request(target + '/delete', 'POST', body, 'stored-delete-fresh-key')).status, 409); assert.equal(f.writes().length, 1);
      assert.equal((await f.app.sql.get('SELECT COUNT(*) AS count FROM direct_contacts')).count, contactCount);
      assert.equal(f.calls.some(call => /\/contacts\//.test(call.url.pathname)), false);
      if (outcome !== 'success') {
        const review = await f.request(`/api/projects/${f.projectId}/operations/${result.data.operation.id}/review`, 'POST', { resolution: outcome === 'network' ? 'not_applied' : 'applied', confirmChecked: true, note: 'Fixture operator checked the provider outcome.' }); assert.equal(review.status, 200);
        retryAllowed = true;
        const retried = await f.request(target + '/delete', 'POST', body, 'stored-delete-after-review'); assert.equal(retried.status, outcome === 'network' ? 200 : 409); assert.equal(f.writes().length, outcome === 'network' ? 2 : 1, 'Only an explicit not-applied review releases the original resource fence.');
        assert.equal((await f.request(target + '/delete', 'POST', body, 'stored-delete-key')).status, 409, 'An operator-reviewed original key always remains closed.');
      }
    } finally { await f.close(); }
  }
});

test('a parallel duplicate of an in-flight stored-copy deletion reaches the provider once', pg, async t => {
  const f = await fixture(t); let release, started;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'message-a', accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', senderId: 'participant-a', message: 'message-a', createdAt: '2026-10-18T12:00:00Z', attachments: [] }], pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
    if (url.pathname.endsWith('/inbox/conversations/thread-1') && options.method === 'DELETE') { started(); await held; return Response.json({ success: true, data: { id: 'thread-1', accountId: 'fb', platform: 'facebook', deletedMessages: 1 } }); }
  });
  try {
    const target = `${f.path}/conversations/thread-1`, detail = await f.request(target + '/messages?accountId=fb');
    const body = { accountId: 'fb', expectedDeleteVersion: detail.data.conversation.deleteVersion, confirmConversationId: 'thread-1' };
    const first = f.request(target + '/delete', 'POST', body, 'parallel-delete-key'); await entered;
    const duplicate = await f.request(target + '/delete', 'POST', body, 'parallel-delete-key'); assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error.code, 'OPERATION_UNCERTAIN');
    const otherKey = await f.request(target + '/delete', 'POST', body, 'parallel-delete-other-key'); assert.equal(otherKey.status, 409); assert.equal(otherKey.data.error.code, 'OPERATION_NOT_SENT');
    release(); assert.equal((await first).status, 200);
    assert.equal(f.writes().filter(call => call.options.method === 'DELETE').length, 1, 'Exactly one provider deletion for the in-flight action, its same-key duplicate and a fresh-key duplicate.');
    assert.equal((await f.app.sql.get('SELECT status FROM inbox_conversation_deletions')).status, 'deleted');
  } finally { release?.(); await f.close(); }
});

test('own text edits and platform deletions revalidate scoped snapshots and confirm exact message history', pg, async t => {
  const f = await actionFixture(t);
  try {
    let history = await f.thread(), own = history.data.messages.find(item => item.direction === 'outgoing'); assert.equal(own.actions.canEdit, true); assert.match(own.version, /^[a-f0-9]{64}$/); assert.equal(history.data.messages.find(item => item.direction === 'incoming').actions.canDelete, false);
    const key = randomUUID(), accepted = await f.write(own, 'edit', { text: 'Updated sent text' }, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.message.message, 'Updated sent text'); assert.equal(accepted.data.message.editHistory[0].text, 'Original sent text'); assert.equal(f.writes().at(-1).options.method, 'PATCH'); assert.deepEqual(f.writes().at(-1).body, { accountId: f.account._id, text: 'Updated sent text' });
    const writes = f.writes().length; assert.equal((await f.write(own, 'edit', { text: 'Updated sent text' }, key)).status, 200); assert.equal(f.writes().length, writes);
    assert.equal((await f.write(own, 'edit', { text: 'Stale edit' })).status, 409); own = (await f.thread()).data.messages.find(item => item.direction === 'outgoing');
    assert.equal((await f.write(own, 'delete')).status, 400); const deleted = await f.write(own, 'delete', { confirmMessageId: own.id }); assert.equal(deleted.status, 200); assert.equal(deleted.data.message.isDeleted, true); assert.equal(deleted.data.deleteScope, 'platform');
    history = await f.thread(); assert.equal(history.data.messages.find(item => item.id === own.id).actions.canEdit, false); assert.equal(history.data.messages.find(item => item.id === own.id).actions.canReact, false);
  } finally { await f.close(); }
});

test('iMessage time windows and self-only deletion stay distinct from unsupported or incoming-message actions', pg, async t => {
  const apple = await actionFixture(t, 'imessage');
  try {
    let own = (await apple.thread()).data.messages[0]; assert.equal(own.actions.canEdit, true); assert.equal(own.actions.canDelete, true); assert.equal(own.actions.deleteScope, 'unsend');
    apple.state.messages[0].createdAt = new Date(Date.now() - 3 * 60000).toISOString(); own = (await apple.thread()).data.messages[0]; assert.equal(own.actions.canEdit, true); assert.equal(own.actions.canDelete, false); assert.equal((await apple.write(own, 'delete', { confirmMessageId: own.id })).status, 409);
    apple.state.messages[0].createdAt = new Date(Date.now() - 16 * 60000).toISOString(); own = (await apple.thread()).data.messages[0]; assert.equal(own.actions.canEdit, false); assert.equal((await apple.write(own, 'edit', { text: 'Late edit' })).status, 409); assert.equal(apple.writes().length, 0);
  } finally { await apple.close(); }
  for (const platform of ['bluesky', 'reddit', 'facebook']) {
    const f = await actionFixture(t, platform);
    try {
      const rows = (await f.thread()).data.messages, own = rows[0], incoming = rows[1];
      assert.ok([409, 422].includes((await f.write(incoming, 'delete', { confirmMessageId: incoming.id })).status));
      if (platform === 'facebook') { assert.equal(own.actions.canDelete, false); assert.equal((await f.write(own, 'delete', { confirmMessageId: own.id })).status, 422); }
      else { const result = await f.write(own, 'delete', { confirmMessageId: own.id }); assert.equal(result.status, 200); assert.equal(result.data.deleteScope, 'self'); assert.equal(f.state.messages.some(item => item.id === own.id), false); }
    } finally { await f.close(); }
  }
});

test('reactions preserve contact reactions, enforce Meta windows and Slack names, and distinguish acceptance from observation', pg, async t => {
  for (const platform of ['telegram', 'facebook', 'slack']) {
    const f = await actionFixture(t, platform);
    try {
      let target = (await f.thread()).data.messages[1], emoji = platform === 'slack' ? ':thumbsup:' : '👍';
      f.state.messages[1].reactions = [{ emoji: '❤️', fromMe: false }]; target = (await f.thread()).data.messages[1];
      const before = f.writes().length; assert.equal((await f.write(target, 'unreact')).status, 409); assert.equal((await f.write(target, 'react', { emoji: platform === 'slack' ? '👍' : 'not-an-emoji' })).status, 400); assert.equal(f.writes().length, before);
      let result = await f.write(target, 'react', { emoji }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.observed, true); assert.equal(result.data.message.reactions.length, 2);
      target = result.data.message; result = await f.write(target, 'unreact'); assert.equal(result.status, 200); assert.equal(result.data.observed, true); assert.deepEqual(result.data.message.reactions.map(item => item.fromMe), [false]); assert.equal(f.writes().at(-1).options.method, 'DELETE');
      target = result.data.message; f.state.unchanged = true; result = await f.write(target, 'react', { emoji }); assert.equal(result.status, 200); assert.equal(result.data.accepted, true); assert.equal(result.data.observed, false, 'A success receipt alone cannot establish reaction placement.');
      if (platform === 'facebook') { f.state.messages[1].createdAt = new Date(Date.now() - 2 * 86400000).toISOString(); target = (await f.thread()).data.messages[1]; assert.equal(target.actions.canReact, false); assert.equal((await f.write(target, 'react', { emoji })).status, 409); }
    } finally { await f.close(); }
  }
});

test('message actions reject foreign scope and preserve unknown mutation receipts without sending duplicates', pg, async t => {
  for (const mode of ['malformed', 'readFailure', 'unchanged']) {
    const f = await actionFixture(t);
    try {
      const own = (await f.thread()).data.messages[0]; f.state[mode] = true;
      const result = await f.write(own, 'edit', { text: 'Unconfirmed edit' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const writes = f.writes().length;
      assert.equal((await f.write(own, 'edit', { text: 'Unconfirmed edit' })).status, 409); assert.equal(f.writes().length, writes);
    } finally { await f.close(); }
  }
  const f = await actionFixture(t);
  try {
    const own = (await f.thread()).data.messages[0], before = f.writes().length;
    assert.equal((await f.request(f.path + '/conversations/thread-1/messages/missing/edit', 'POST', { accountId: f.account._id, expectedMessageVersion: own.version, text: 'Wrong item' })).status, 403);
    assert.equal((await f.request(f.path + '/conversations/thread-1/messages/own-message/edit', 'POST', { accountId: 'foreign', expectedMessageVersion: own.version, text: 'Wrong tenant' })).status, 403);
    assert.equal((await f.request(f.path + '/conversations/%broken/messages/own-message/edit', 'POST', { accountId: f.account._id, expectedMessageVersion: own.version, text: 'Wrong path' })).status, 400); assert.equal(f.writes().length, before);
  } finally { await f.close(); }
});

test('handover requires fresh deliberate review, gates Instagram Login and confirms actual owner rather than a request', pg, async t => {
  const f = await actionFixture(t, 'facebook'), route = f.path + '/conversations/thread-1/thread-control';
  try {
    let conversation = (await f.thread()).data.conversation;
    assert.deepEqual(conversation.controlActions, ['take', 'request', 'pass', 'release']);
    assert.equal((await f.request(route, 'POST', { accountId: f.account._id, action: 'pass', targetAppId: '263902037430900', expectedConversationVersion: conversation.version })).status, 409); assert.equal(f.writes().length, 0);
    const transfer = { accountId: f.account._id, action: 'pass', targetAppId: '263902037430900', metadata: 'Customer asked for Page Inbox', expectedConversationVersion: conversation.version, confirmControl: true }, accepted = await f.request(route, 'POST', transfer); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.conversation.threadControl, 'other');
    assert.equal((await f.request(route, 'POST', { ...transfer, action: 'take', targetAppId: undefined })).status, 409);
    conversation = (await f.thread()).data.conversation; const requested = await f.request(route, 'POST', { accountId: f.account._id, action: 'request', expectedConversationVersion: conversation.version, confirmControl: true }); assert.equal(requested.status, 200); assert.equal(requested.data.requested, true); assert.equal(requested.data.control.owner, 'other');
    f.state.malformed = true; const unknown = await f.request(route, 'POST', { accountId: f.account._id, action: 'take', expectedConversationVersion: conversation.version, confirmControl: true }); assert.equal(unknown.status, 409); assert.equal(unknown.data.operation.status, 'uncertain');
  } finally { await f.close(); }
  const instagram = await actionFixture(t, 'instagram');
  try { const conversation = (await instagram.thread()).data.conversation; assert.deepEqual(conversation.controlActions, ['pass', 'release']); const result = await instagram.request(instagram.path + '/conversations/thread-1/thread-control', 'POST', { accountId: instagram.account._id, action: 'take', expectedConversationVersion: conversation.version, confirmControl: true }); assert.equal(result.status, 422); assert.equal(instagram.writes().length, 0); }
  finally { await instagram.close(); }
});

test('request acceptance sends one reviewed reply only for a freshly proven pending Meta request', pg, async t => {
  const f = await actionFixture(t, 'facebook'), route = f.path + '/conversations/thread-1/accept';
  try {
    const conversation = (await f.thread()).data.conversation, body = { accountId: f.account._id, expectedConversationVersion: conversation.version, message: 'Thanks for your request', confirmSend: true };
    assert.equal((await f.request(route, 'POST', { ...body, confirmSend: false })).status, 409); assert.equal((await f.request(route, 'POST', body)).status, 409); assert.equal(f.writes().length, 0);
    f.state.pendingRequest = true; const key = randomUUID(), accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true); assert.equal(f.state.pendingRequest, false); assert.equal(f.state.messages.at(-1).message, body.message);
    const writes = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, writes);
  } finally { await f.close(); }
});

test('inbox message actions share a conversation lock and viewers cannot dispatch them', pg, async t => {
  const f = await actionFixture(t); let release, entered;
  try {
    const own = (await f.thread()).data.messages[0]; f.state.hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; }); f.state.onWrite = entered;
    const pending = f.write(own, 'edit', { text: 'Held edit' }); await started;
    const simultaneous = await f.write(own, 'delete', { confirmMessageId: own.id }); assert.equal(simultaneous.status, 409); assert.equal(simultaneous.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(simultaneous.data.operation.status, 'failed'); assert.equal(f.writes().some(call => call.options.method === 'DELETE'), false);
    release(); f.state.hold = null; assert.equal((await pending).status, 200);
    const fresh = (await f.thread()).data.messages[0]; await f.app.sql.run("UPDATE memberships SET role='viewer'"); const writes = f.writes().length;
    assert.equal((await f.write(fresh, 'delete', { confirmMessageId: fresh.id })).status, 403); assert.equal(f.writes().length, writes);
  } finally { release?.(); await f.close(); }
});

test('unreadable reactions and accepted request replies remain uncertain without a second provider write', pg, async t => {
  for (const action of ['react', 'accept']) {
    const f = await actionFixture(t, 'facebook');
    try {
      const history = await f.thread(), target = history.data.messages[1], conversation = history.data.conversation;
      f.state.malformed = true; f.state.pendingRequest = true;
      const route = action === 'react' ? `${f.path}/conversations/thread-1/messages/${target.id}/react` : `${f.path}/conversations/thread-1/accept`, body = action === 'react' ? { accountId: f.account._id, expectedMessageVersion: target.version, emoji: '👍' } : { accountId: f.account._id, expectedConversationVersion: conversation.version, message: 'Do not send twice', confirmSend: true };
      const result = await f.request(route, 'POST', body); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const writes = f.writes().length;
      assert.equal((await f.request(route, 'POST', body)).status, 409); assert.equal(f.writes().length, writes);
    } finally { await f.close(); }
  }
});

test('full-history search forwards the scoped query and opaque pages, validates snippets and reports skipped accounts', pg, async t => {
  const f = await fixture(t); let mode = 'normal';
  f.setHook(url => {
    if (!url.pathname.endsWith('/inbox/conversations/search')) return;
    const accountId = url.searchParams.get('accountId'), account = f.accounts.find(row => row._id === accountId);
    assert.equal(url.searchParams.get('profileId'), 'inbox-profile'); assert.equal(url.searchParams.get('query'), 'old invoice');
    if (accountId === 'bs') return Response.json({ data: [], pagination: { hasMore: false, nextCursor: null }, meta: { accountsQueried: 0, accountsSkipped: [{ accountId, platform: 'bluesky' }] } });
    const paged = url.searchParams.has('cursor'); if (paged) assert.equal(url.searchParams.get('cursor'), 'opaque +/cursor');
    return Response.json({ data: [{ conversation: { id: paged ? 'older-thread' : 'thread-1', accountId: mode === 'foreign' ? 'foreign' : accountId, platform: account.platform, participantName: 'Older conversation', participantUsername: 'older', status: 'archived', lastMessage: 'A different recent preview' }, matchCount: 1, matches: [{ id: 'old-message', text: mode === 'bad-text' ? {} : 'Your old invoice', direction: mode === 'bad-direction' ? 'outgoing' : 'incoming', timestamp: '2023-01-01T00:00:00Z', apiKey: 'do-not-return' }] }], pagination: { hasMore: !paged, nextCursor: paged ? null : 'opaque +/cursor' }, meta: mode === 'bad-meta' ? { accountsSkipped: [{ accountId: 'foreign', platform: 'facebook' }] } : { accountsQueried: 1 } });
  });
  try {
    const route = f.path + '/conversations/search?', params = new URLSearchParams({ accountId: 'fb', query: 'old invoice', direction: 'incoming', limit: '20' });
    const first = await f.request(route + params); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.conversations[0].matches[0].text, 'Your old invoice'); assert.equal(first.data.conversations[0].matches[0].apiKey, undefined); assert.equal(first.data.conversations[0].status, 'archived');
    params.set('cursor', first.data.pagination.nextCursor); const next = await f.request(route + params); assert.equal(next.data.conversations[0].id, 'older-thread'); assert.equal(next.data.pagination.hasMore, false);
    const skipped = await f.request(route + new URLSearchParams({ accountId: 'bs', query: 'old invoice' })); assert.equal(skipped.data.meta.accountsSkipped[0].accountId, 'bs'); assert.deepEqual(skipped.data.conversations, []);
    for (mode of ['foreign', 'bad-text', 'bad-direction', 'bad-meta']) assert.equal((await f.request(route + params)).status, 502, mode);
    const before = f.calls.length; for (const bad of ['accountId=fb&query=x', 'accountId=fb&query=old+invoice&limit=51', 'accountId=fb&query=old+invoice&direction=both']) assert.equal((await f.request(route + bad)).status, 400);
    assert.equal(f.calls.length, before + 3, 'Invalid search filters make only the scoped account read, never a search call.'); assert.equal(f.writes().length, 0); assert.equal((await f.app.direct.contacts.list(f.projectId)).length, 0, 'Search snippets are not proof of a new inbound Messenger contact.');
    assert.equal((await f.request(route + 'accountId=foreign&query=old+invoice')).status, 403);
  } finally { await f.close(); }
});

test('new text conversations check platform recipients, keep X eligibility enabled and reuse accepted or uncertain receipts', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/start'; let malformed = false;
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/inbox/conversations') && options.method === 'POST') return Response.json({ success: true, data: { messageId: 'opening-1', conversationId: 'thread-1', participantName: malformed ? {} : 'Alex', apiKey: 'private' } });
    if (url.pathname.endsWith('/slack-members')) return Response.json({ members: [{ id: 'U01ABCDEF', name: 'Alex', username: 'alex' }] });
  });
  try {
    for (const body of [{ accountId: 'xx', participantUsername: '@alex', message: 'Hello Alex' }, { accountId: 'fb', participantUsername: 'alex', message: 'Hello', confirmSend: true }, { accountId: 'xx', participantId: 1234, message: 'Hello', confirmSend: true }, { accountId: 'xx', participantUsername: 'alex', message: 'Hello', confirmSend: true, skipDmCheck: true }]) assert.ok([400, 422].includes((await f.request(route, 'POST', body)).status));
    assert.equal(f.writes().length, 0);
    const body = { accountId: 'xx', participantUsername: '@alex', message: 'Hello Alex', confirmSend: true }, key = randomUUID();
    const accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true); assert.equal(accepted.data.apiKey, undefined); assert.deepEqual(f.writes().at(-1).body, { accountId: 'xx', participantUsername: 'alex', message: 'Hello Alex' });
    const count = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, count);
    const history = await f.request(f.path + '/conversations/' + accepted.data.conversationId + '/messages?accountId=xx'); assert.equal(history.status, 200);
    for (const [accountId, participantUsername] of [['bs', 'alex.bsky.social'], ['rd', 'u/alex']]) assert.equal((await f.request(route, 'POST', { ...body, accountId, participantUsername })).status, 200);
    const recipients = await f.request(f.path + '/conversations/recipients?accountId=sl'); assert.equal(recipients.data.recipients[0].id, 'U01ABCDEF');
    const beforeSlack = f.writes().length; assert.equal((await f.request(route, 'POST', { accountId: 'sl', participantId: 'UFOREIGN', message: 'Hello', confirmSend: true })).status, 422); assert.equal(f.writes().length, beforeSlack);
    assert.equal((await f.request(route, 'POST', { accountId: 'sl', participantId: 'U01ABCDEF', message: 'Hello coworker', confirmSend: true })).status, 200);
    f.setHook((url, options) => url.pathname.endsWith('/inbox/conversations') && options.method === 'POST' ? Response.json({ success: true, data: { messageId: 'wrong-recipient', conversationId: 'thread-1', participantId: '9999' } }) : undefined);
    const wrongRecipient = await f.request(route, 'POST', { accountId: 'xx', participantId: '1234', message: 'Exact recipient must match', confirmSend: true }); assert.equal(wrongRecipient.data.operation.status, 'uncertain');
    f.setHook((url, options) => url.pathname.endsWith('/inbox/conversations') && options.method === 'POST' ? Response.json({ success: true, data: { messageId: 'opening-1', conversationId: 'thread-1', participantName: {} } }) : undefined);
    malformed = true; const uncertainBody = { ...body, message: 'A unique ambiguous send' }, uncertainKey = randomUUID(), beforeUncertain = f.writes().length;
    assert.equal((await f.request(route, 'POST', uncertainBody, uncertainKey)).data.operation.status, 'uncertain');
    assert.equal((await f.request(route, 'POST', uncertainBody, uncertainKey)).status, 409); assert.equal((await f.request(route, 'POST', uncertainBody)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); const beforeViewer = f.calls.length; assert.equal((await f.request(route, 'POST', body)).status, 403); assert.equal(f.calls.length, beforeViewer);
  } finally { await f.close(); }
});

test('new WhatsApp and Zernio SMS conversations require current local permission and exact approved template values', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/start', contacts = f.app.direct.contacts;
  const ready = await contacts.save(f.projectId, { name: 'Permitted', phone: '+12025550101', consents: { whatsapp: true, sms: true }, consentSource: 'Synthetic opt-in record' });
  const notPermitted = await contacts.save(f.projectId, { name: 'No permission', phone: '+12025550102' }); let revoke = false;
  const template = { id: 'approved-template', name: 'appointment_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', text: 'Appointment {{1}}', format: 'TEXT' }, { type: 'BODY', text: 'Your appointment is {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Details', url: 'https://example.com/{{1}}' }] }] };
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/whatsapp/templates')) { if (revoke) await contacts.suppress(f.projectId, ready.id, 'whatsapp', 'Recipient opted out during lookup'); return Response.json({ success: true, templates: [template] }); }
    if (url.pathname.endsWith('/inbox/conversations') && options.method === 'POST') return Response.json({ success: true, data: { messageId: 'opening-1', conversationId: 'thread-1' } });
  });
  try {
    const recipients = await f.request(f.path + '/conversations/recipients?accountId=wa'); assert.deepEqual(recipients.data.recipients.map(row => row.id), [ready.id]);
    const body = { accountId: 'wa', contactId: ready.id, templateName: 'appointment_update', templateLanguage: 'en', templateComponents: [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'appointment-1' }] }, { type: 'body', parameters: [{ type: 'text', text: 'Friday' }] }, { type: 'header', parameters: [{ type: 'text', text: 'A1' }] }], confirmSend: true };
    for (const changed of [{ contactId: notPermitted.id }, { contactId: randomUUID() }, { participantId: '+12025550101' }, { message: 'Free-form opening' }, { templateLanguage: 'fr' }, { templateComponents: [] }]) assert.ok([400, 409].includes((await f.request(route, 'POST', { ...body, ...changed })).status));
    assert.equal(f.writes().length, 0);
    const accepted = await f.request(route, 'POST', body); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.deepEqual(f.writes().at(-1).body, { accountId: 'wa', participantId: '12025550101', templateName: 'appointment_update', templateLanguage: 'en', templateParams: ['A1', 'Friday', 'appointment-1'] });
    assert.equal((await f.request(route, 'POST', { accountId: 'sm', contactId: ready.id, message: 'Your appointment is confirmed', confirmSend: true })).status, 200);
    await contacts.suppressSmsGlobally(ready.phone, 'STOP'); const beforeStop = f.writes().length; assert.equal((await f.request(route, 'POST', { accountId: 'sm', contactId: ready.id, message: 'Blocked after STOP', confirmSend: true })).status, 409); assert.equal(f.writes().length, beforeStop);
    revoke = true; const beforeRevoke = f.writes().length; assert.equal((await f.request(route, 'POST', { ...body, templateComponents: body.templateComponents.map(row => row.type === 'body' ? { ...row, parameters: [{ type: 'text', text: 'Saturday' }] } : row) })).status, 409); assert.equal(f.writes().length, beforeRevoke);
  } finally { await f.close(); }
});

test('inbox reads are scoped, side-effect-free and create identity-only contacts from verified incoming Messenger history', pg, async t => {
  const f = await fixture(t);
  try {
    const before = f.calls.length;
    for (const route of ['/thread/messages?accountId=fb', '/thread/reply', '/reviews/hide']) assert.equal((await f.request(f.path + route)).status, 404);
    assert.equal(f.calls.length, before);
    const updates = await f.request(f.path + '/updates?accountId=fb'); assert.equal(updates.status, 200); assert.equal(f.calls.length, before, 'Local update polling does not make provider calls.');
    const status = await f.request(f.path + '/status'); assert.equal(status.status, 200); assert.equal(status.data.webhookConfigured, true); assert.equal(status.data.accounts.some(row => row.id === 'foreign'), false); assert.equal(status.data.accounts.find(row => row.id === 'yt').capabilities.messages, false); assert.equal(status.data.accounts.find(row => row.id === 'ig').capabilities.commentLike, false);
    const list = await f.request(f.path + '/conversations?accountId=fb'); assert.equal(list.data.conversations.length, 1);
    assert.equal((await f.app.direct.contacts.list(f.projectId)).length, 0, 'A list preview does not imply an incoming participant.');
    const messages = await f.request(f.path + '/conversations/thread-1/messages?accountId=fb'); assert.equal(messages.status, 200); assert.equal(messages.data.messages[0].message, 'Please help'); assert.ok(messages.data.contact.id); assert.equal(messages.data.contact.email, ''); assert.equal(messages.data.contact.phone, ''); assert.deepEqual(messages.data.contact.consents, { email: false, sms: false, whatsapp: false });
    await f.request(f.path + '/conversations/thread-1/messages?accountId=fb'); assert.equal((await f.app.direct.contacts.list(f.projectId)).length, 1);
    assert.equal(f.writes().length, 0); assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM integration_operations')).total, 0, 'Reads must not create operation receipts.');
    const beforeForeign = f.calls.length; assert.equal((await f.request(f.path + '/conversations?accountId=foreign')).status, 403); assert.equal(f.calls.length, beforeForeign + 1);
    f.setForeign(true); assert.equal((await f.request(f.path + '/conversations?accountId=fb')).status, 502); f.setForeign(false);
    f.setMalformedHistory(true); assert.equal((await f.request(f.path + '/conversations/thread-1/messages?accountId=fb')).status, 502);
  } finally { await f.close(); }
});

test('WhatsApp selected-button history projects only scoped incoming selection facts and rejects malformed metadata', pg, async t => {
  const f = await fixture(t), route = accountId => `${f.path}/conversations/thread-1/messages?accountId=${accountId}`;
  let rows = [{ id: 'button-response', message: '', metadata: { interactiveType: 'button_reply', interactiveId: 'reply_2', access_token: 'never-return-selection-secret', waInteractive: { buttons: ['untrusted'] } } }];
  f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith('/messages') ? Response.json({ messages: rows.map(row => ({ accountId: url.searchParams.get('accountId'), platform: f.accounts.find(account => account._id === url.searchParams.get('accountId'))?.platform, conversationId: 'thread-1', direction: 'incoming', senderId: 'participant-a', createdAt: new Date().toISOString(), ...row })), pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' }) : undefined);
  try {
    await f.app.sql.run("UPDATE memberships SET role='viewer'");
    const selected = await f.request(route('wa')); assert.equal(selected.status, 200, JSON.stringify(selected.data)); assert.equal(selected.data.messages[0].message, ''); assert.deepEqual(selected.data.messages[0].metadata, { interactiveType: 'button_reply', interactiveId: 'reply_2' }); assert.equal(JSON.stringify(selected.data).includes('never-return-selection-secret'), false);
    rows = [{ id: 'labelled', message: '<b>Yes & please</b>', metadata: { interactiveType: 'button_reply', interactiveId: '<script>reply_1</script>' } }, { id: 'deleted', message: 'Deleted label', isDeleted: true, metadata: { interactiveType: 'button_reply', interactiveId: 'reply_3' } }];
    const labelled = await f.request(route('wa')); assert.equal(labelled.status, 200); assert.equal(labelled.data.messages[0].message, rows[0].message); assert.equal(labelled.data.messages[0].metadata.interactiveId, rows[0].metadata.interactiveId); assert.equal(labelled.data.messages[1].isDeleted, true);
    for (const row of [{ metadata: null }, { metadata: { interactiveType: 'list_reply', interactiveId: 'list-row', arbitrary: 'hidden' } }, { direction: 'outgoing', metadata: { interactiveType: 'button_reply', interactiveId: { ignored: true } } }]) {
      rows = [{ id: 'not-a-button-response', message: 'Ordinary text', ...row }]; const result = await f.request(route('wa')); assert.equal(result.status, 200); assert.equal(result.data.messages[0].metadata, undefined);
    }
    rows = [{ id: 'other-platform', message: 'Unchanged text', metadata: { interactiveType: 'button_reply', interactiveId: { ignored: true } } }];
    const other = await f.request(route('bs')); assert.equal(other.status, 200); assert.equal(other.data.messages[0].message, 'Unchanged text'); assert.equal(other.data.messages[0].metadata, undefined);
    for (const metadata of [[], 'invalid', { interactiveType: 3 }, ...[undefined, null, '', ' ', {}, 'x'.repeat(2001), 'bad\u0000id'].map(interactiveId => ({ interactiveType: 'button_reply', interactiveId }))]) {
      rows = [{ id: 'bad-button-response', message: '', metadata }]; const result = await f.request(route('wa')); assert.equal(result.status, 502, JSON.stringify(metadata)); assert.equal(result.data.error.code, 'INVALID_PROVIDER_RESPONSE'); assert.equal(result.data.messages, undefined);
    }
    rows = [{ id: 'foreign-response', accountId: 'foreign', message: '', metadata: { interactiveType: 'button_reply', interactiveId: 'foreign-secret-id' } }];
    const foreign = await f.request(route('wa')); assert.equal(foreign.status, 502); assert.equal(JSON.stringify(foreign.data).includes('foreign-secret-id'), false); assert.equal(f.writes().length, 0);
    await f.app.sql.run("UPDATE memberships SET role='owner'"); rows = [{ id: 'bad-button-response', message: '', metadata: { interactiveType: 'button_reply', interactiveId: {} } }];
    const reply = await f.request(f.path + '/conversations/thread-1/reply', 'POST', { accountId: 'wa', message: 'Do not send against malformed history' }); assert.equal(reply.status, 502); assert.equal(reply.data.operation.status, 'failed'); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('inbox replies, read and archive use durable receipts, platform windows, limits and uncertain retry protection', pg, async t => {
  const f = await fixture(t);
  try {
    const url = f.path + '/conversations/thread-1/reply', body = { accountId: 'fb', message: 'Hello Alex' }, key = randomUUID();
    const first = await f.request(url, 'POST', body, key); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.sent, true); const writes = f.writes().length;
    assert.equal((await f.request(url, 'POST', body, key)).status, 200); assert.equal(f.writes().length, writes); assert.equal((await f.request(url, 'POST', { ...body, message: 'Changed' }, key)).status, 409);
    const read = await f.request(f.path + '/conversations/thread-1/read', 'POST', { accountId: 'fb' }); assert.equal(read.data.markedCount, 1);
    const archive = await f.request(f.path + '/conversations/thread-1/status', 'POST', { accountId: 'fb', status: 'archived' }); assert.equal(archive.data.conversation.status, 'archived'); assert.equal(f.writes().at(-1).options.method, 'PUT');
    const beforeBad = f.writes().length; assert.equal((await f.request(url, 'POST', { accountId: 'fb', message: 'x'.repeat(2001) })).status, 400); assert.equal((await f.request(url, 'POST', { accountId: 'fb', message: 'Reply', voiceNote: true })).status, 400); assert.equal(f.writes().length, beforeBad);
    f.setIncoming(Date.now() - 3 * 86400000); assert.equal((await f.request(url, 'POST', { ...body, message: 'Outside window' })).status, 409); assert.equal((await f.request(url, 'POST', { ...body, messageTag: 'ACCOUNT_UPDATE' })).status, 200);
    assert.equal((await f.request(url, 'POST', { accountId: 'ig', message: 'Reply', messageTag: 'ACCOUNT_UPDATE' })).status, 400);
    f.setIncoming(Date.now()); assert.equal((await f.request(url, 'POST', { accountId: 'tt', message: 'Caption', attachmentUrl: 'https://cdn.example.com/image.jpg', attachmentType: 'image' })).status, 422);
    for (const [accountId, length] of [['ig', 1001], ['wa', 4097], ['rc', 3073]]) assert.equal((await f.request(url, 'POST', { accountId, message: 'x'.repeat(length) })).status, 400);
    f.setHook(target => target.pathname.endsWith('/tools/validate/media') ? Response.json({ valid: true, size: 3 * 1024 * 1024 + 1, contentType: 'image/jpeg' }) : undefined);
    const beforeMedia = f.writes().length;
    assert.equal((await f.request(url, 'POST', { accountId: 'tt', attachmentUrl: 'https://cdn.example.com/image.jpg', attachmentType: 'image' })).status, 400); assert.equal(f.writes().length, beforeMedia);
    f.setHook(undefined); assert.equal((await f.request(url, 'POST', { accountId: 'tt', attachmentUrl: 'https://cdn.example.com/image.jpg', attachmentType: 'image' })).status, 200);
    f.setHook((target, options) => { if (target.pathname.endsWith('/messages') && options.method === 'POST') throw new Error('Provider acknowledgement lost'); });
    const uncertain = { ...body, message: 'Unique uncertain reply' }, beforeUncertain = f.writes().length, uncertainKey = randomUUID(); const result = await f.request(url, 'POST', uncertain, uncertainKey); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal((await f.request(url, 'POST', uncertain, uncertainKey)).status, 409); assert.equal((await f.request(url, 'POST', uncertain)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); const beforeViewer = f.calls.length; assert.equal((await f.request(f.path + '/conversations/thread-1/read', 'POST', { accountId: 'fb' })).status, 403); assert.equal(f.calls.length, beforeViewer);
  } finally { await f.close(); }
});

test('comments scope posts and individual permissions, route Meta ad moderation correctly and validate acknowledgements', pg, async t => {
  const f = await fixture(t);
  try {
    const list = await f.request(f.path + '/comments?accountId=fb'); assert.equal(list.data.posts[0].id, 'post-1');
    const thread = await f.request(f.path + '/comments/thread?accountId=fb&postId=post-1'); assert.equal(thread.data.comments[0].canReply, true);
    const payload = { accountId: 'fb', postId: 'post-1', commentId: 'comment-1' };
    for (const action of ['reply', 'hide', 'unhide', 'like', 'unlike', 'delete']) { const result = await f.request(f.path + '/comments/' + action, 'POST', { ...payload, ...(action === 'reply' ? { message: 'Thanks for asking' } : {}) }); assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.data)}`); }
    const beforeMissing = f.writes().length; assert.equal((await f.request(f.path + '/comments/reply', 'POST', { ...payload, commentId: 'not-this-post', message: 'Never sent' })).status, 403); assert.equal(f.writes().length, beforeMissing);
    f.comments[0].canDelete = false; assert.equal((await f.request(f.path + '/comments/delete', 'POST', payload)).status, 422); f.comments[0].canDelete = true;
    const moderation = await f.request(f.path + '/comments/moderate', 'POST', { ...payload, accountId: 'yt', moderationStatus: 'rejected', banAuthor: true }); assert.equal(moderation.status, 200); assert.equal(f.writes().at(-1).body.platform, 'youtube');
    const ad = await f.request(f.path + '/comments/reply', 'POST', { accountId: 'ads', postId: 'ad-1:instagram', commentId: 'comment-1', message: 'Ad reply' }); assert.equal(ad.status, 200, JSON.stringify(ad.data)); assert.equal(f.writes().at(-1).url.pathname, '/api/v1/inbox/comments/ad-media-1'); assert.equal(f.writes().at(-1).body.accountId, 'ig');
    const instagram = { accountId: 'ig', postId: 'post-1', commentId: 'comment-1' };
    assert.equal((await f.request(f.path + '/comments/hide', 'POST', instagram)).status, 200);
    f.setHook((url, options) => url.pathname.endsWith('/inbox/comments/post-1') && options.method === 'GET' && url.searchParams.get('accountId') === 'ig' ? Response.json({ comments: [], pagination: { hasMore: false, cursor: null }, meta: { accountId: 'ig', platform: 'instagram', postId: 'post-1' } }) : undefined);
    assert.equal((await f.request(f.path + '/comments/unhide', 'POST', instagram)).status, 200, 'A completed scoped hide receipt allows unhide when Meta omits the hidden row.');
    assert.equal((await f.request(f.path + '/comments/unhide', 'POST', { ...instagram, commentId: 'arbitrary-hidden-comment' })).status, 403);
    f.setHook((url, options) => url.pathname.endsWith('/hide') && options.method === 'POST' ? Response.json({ status: 'success', commentId: 'wrong-comment', hidden: true, platform: 'facebook' }) : undefined);
    const result = await f.request(f.path + '/comments/hide', 'POST', payload); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
  } finally { await f.close(); }
});

test('LinkedIn mentions force the project and active account, validate each page and remain read only', pg, async t => {
  const f = await fixture(t), endpoint = f.path + '/mentions', cursor = 'opaque +/first', next = 'opaque +/next';
  f.accounts.push({ _id: 'li', platform: 'linkedin', profileId: 'inbox-profile', isActive: true }, { _id: 'li-other', platform: 'linkedin', profileId: 'inbox-profile', isActive: true }, { _id: 'li-inactive', platform: 'linkedin', profileId: 'inbox-profile', isActive: false });
  const mention = { id: 'mention-document-1', accountId: 'li', platform: 'linkedin', organizationalEntity: 'urn:li:organization:42', content: 'Team report', permalink: null, authorName: null, authorUsername: null, authorPicture: null, authorUrn: null, publishedAt: '2026-10-18T12:00:00Z', createdAt: '2026-10-18T12:01:00Z', apiKey: 'never-return-this' };
  const good = { data: [mention], pagination: { hasMore: true, cursor: next }, meta: { total: 2, sortOrder: 'asc' } };
  let response = good;
  const reads = () => f.calls.filter(call => call.url.pathname.endsWith('/inbox/mentions'));
  f.setHook(url => url.pathname.endsWith('/inbox/mentions') ? Response.json(response) : undefined);
  try {
    const params = new URLSearchParams({ accountId: 'li', profileId: 'foreign-profile', limit: '2', sortOrder: 'asc', cursor });
    const first = await f.request(endpoint + '?' + params); assert.equal(first.status, 200); assert.equal(first.data.mentions[0].id, mention.id); assert.equal(first.data.mentions[0].authorName, null); assert.equal(JSON.stringify(first.data).includes('never-return-this'), false);
    assert.deepEqual(Object.fromEntries(reads().at(-1).url.searchParams), { profileId: 'inbox-profile', accountId: 'li', limit: '2', sortOrder: 'asc', cursor });
    assert.deepEqual(first.data.pagination, { hasMore: true, nextCursor: next }); assert.deepEqual(first.data.meta, good.meta);
    response = { data: [], pagination: { hasMore: false, cursor: null } };
    assert.equal((await f.request(endpoint + '?' + new URLSearchParams({ accountId: 'li', cursor: next }))).status, 200); assert.equal(reads().at(-1).url.searchParams.get('cursor'), next);
    const before = reads().length;
    for (const query of ['accountId=foreign', 'accountId=fb', 'accountId=li-inactive']) assert.ok([403, 422].includes((await f.request(endpoint + '?' + query)).status), query);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'sortOrder=newest', 'cursor=%0A']) assert.equal((await f.request(endpoint + '?accountId=li&' + query)).status, 400, query);
    assert.equal((await f.request(endpoint, 'POST', { accountId: 'li' })).status, 405); assert.equal((await f.request(endpoint + '/reply', 'POST', { accountId: 'li' })).status, 404); assert.equal(reads().length, before);
    const badRows = [{ ...mention, id: '' }, { ...mention, accountId: 'li-other' }, { ...mention, platform: 'facebook' }, { ...mention, authorName: {} }, { ...mention, permalink: {} }, { ...mention, organizationalEntity: null }, { ...mention, publishedAt: 'not-a-date' }];
    const badPages = [
      ...badRows.map(row => ({ ...good, data: [row] })),
      { ...good, data: [mention, mention] }, { ...good, data: [mention, { ...mention, id: 'second' }, { ...mention, id: 'third' }] }, { ...good, data: [] },
      { ...good, pagination: { hasMore: true } }, { ...good, pagination: { hasMore: true, cursor } }, { ...good, pagination: { hasMore: true, cursor: '\n' } },
      { ...good, pagination: { hasMore: true, cursor: null, nextCursor: next } }, { ...good, pagination: { hasMore: true, cursor, nextCursor: next } },
      { ...good, meta: { total: 1.5 } }, { ...good, meta: { sortOrder: 'desc' } },
    ];
    for (response of badPages) assert.equal((await f.request(endpoint + '?' + params)).status, 502, JSON.stringify(response));
    response = { data: [], pagination: { hasMore: false, cursor: null } };
    await f.app.sql.run("UPDATE memberships SET role='viewer'");
    assert.deepEqual((await f.request(endpoint + '?accountId=li')).data.mentions, [], 'Viewers can read an empty feed without an organization-type guess.');
    const status = await f.request(f.path + '/status'); assert.equal(status.data.accounts.find(row => row.id === 'li').capabilities.mentions, true); assert.equal(status.data.accounts.find(row => row.id === 'li-inactive').capabilities.mentions, false);
    assert.equal(f.writes().length, 0); assert.equal((await f.app.direct.contacts.list(f.projectId)).length, 0); assert.equal((await f.app.sql.get('SELECT count(*) AS total FROM integration_operations')).total, 0, 'Reads must not create operation receipts.');
  } finally { await f.close(); }
});

test('mention access failures stay distinct from empty results and revoked project access returns no content', pg, async t => {
  const f = await fixture(t), endpoint = f.path + '/mentions?accountId=li';
  f.accounts.push({ _id: 'li', platform: 'linkedin', profileId: 'inbox-profile', isActive: true });
  let status = 403;
  f.setHook(url => url.pathname.endsWith('/inbox/mentions') ? Response.json({ error: 'PRIVATE_PROVIDER_DETAILS' }, { status }) : undefined);
  try {
    const denied = await f.request(endpoint); assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'MENTIONS_ACCESS_REQUIRED'); assert.match(denied.data.error.message, /Inbox add-on.*access/); assert.equal(JSON.stringify(denied.data).includes('PRIVATE_PROVIDER_DETAILS'), false); assert.equal(denied.data.mentions, undefined);
    for (status of [401, 429, 503]) { const failed = await f.request(endpoint); assert.ok(failed.status >= 400); assert.equal(failed.data.mentions, undefined); }
    f.setHook(async url => { if (url.pathname.endsWith('/inbox/mentions')) { await f.app.sql.run('DELETE FROM memberships'); return Response.json({ data: [{ id: 'private-mention', accountId: 'li', platform: 'linkedin', organizationalEntity: 'urn:li:organization:42', content: 'PRIVATE_MENTION_TEXT' }], pagination: { hasMore: false, cursor: null } }); } });
    const revoked = await f.request(endpoint); assert.equal(revoked.status, 404); assert.equal(JSON.stringify(revoked.data).includes('PRIVATE_MENTION_TEXT'), false); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('review filters forward exact scoped values and reject invalid ratings, reply states and sorts before provider retrieval', pg, async t => {
  const f = await fixture(t), endpoint = f.path + '/reviews', reviewCalls = () => f.calls.filter(call => call.url.pathname.endsWith('/inbox/reviews'));
  try {
    const filters = { minRating: '1', maxRating: '5', hasReply: 'false', sortBy: 'rating', sortOrder: 'asc', limit: '50', cursor: 'opaque +/cursor' };
    const result = await f.request(endpoint + '?' + new URLSearchParams({ accountId: 'gb', ...filters })); assert.equal(result.status, 200); assert.equal(result.data.reviews[0].id, 'review-1');
    assert.deepEqual(Object.fromEntries(reviewCalls().at(-1).url.searchParams), { profileId: 'inbox-profile', accountId: 'gb', ...filters });
    assert.match(result.data.reviews[0].replyVersion, /^[a-f0-9]{64}$/);
    for (const query of ['', '&minRating=&maxRating=&hasReply=&sortBy=&sortOrder=']) {
      assert.equal((await f.request(endpoint + '?accountId=fb' + query)).status, 200);
      assert.deepEqual(Object.fromEntries(reviewCalls().at(-1).url.searchParams), { profileId: 'inbox-profile', accountId: 'fb', limit: '25' }, 'Unset review filters use the provider defaults.');
    }
    assert.equal((await f.request(endpoint + '?accountId=gb&hasReply=true&sortBy=date&sortOrder=desc&minRating=5&maxRating=5')).status, 200);
    assert.equal(reviewCalls().at(-1).url.searchParams.get('hasReply'), 'true');
    const before = reviewCalls().length;
    for (const invalid of ['minRating=0', 'maxRating=6', 'minRating=2.5', 'minRating=01', 'minRating=1e0', 'maxRating=-1', 'minRating=4&maxRating=3', 'hasReply=0', 'hasReply=False', 'hasReply=yes', 'sortBy=comments', 'sortOrder=newest', 'limit=51']) {
      const response = await f.request(endpoint + '?accountId=gb&' + invalid); assert.equal(response.status, 400, invalid); assert.equal(response.data.error.code, 'INVALID_INBOX_FILTER');
    }
    assert.equal(reviewCalls().length, before, 'Invalid filters never reach the review endpoint.');
    assert.equal((await f.request(endpoint + '?accountId=foreign&hasReply=false')).status, 403);
    assert.equal((await f.request(endpoint + '?accountId=ig&hasReply=false')).status, 422);
    assert.equal(reviewCalls().length, before);
    f.setHook(url => url.pathname.endsWith('/inbox/reviews') ? Response.json({ data: [{ ...f.review, accountId: 'fb', platform: 'facebook' }], pagination: { hasMore: false, nextCursor: null } }) : undefined);
    const foreign = await f.request(endpoint + '?accountId=gb&hasReply=false'); assert.equal(foreign.status, 502); assert.equal(foreign.data.error.code, 'INVALID_PROVIDER_SCOPE');
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('review replies require current versions and replacement confirmation and preserve uncertain outcomes', pg, async t => {
  const f = await fixture(t);
  try {
    const list = await f.request(f.path + '/reviews?accountId=gb'), first = list.data.reviews[0], route = f.path + '/reviews/reply'; assert.match(first.replyVersion, /^[a-f0-9]{64}$/);
    const payload = { accountId: 'gb', reviewId: first.id, message: 'Thank you', expectedReplyVersion: first.replyVersion };
    const before = f.writes().length; assert.equal((await f.request(route, 'POST', { ...payload, expectedReplyVersion: 'stale' })).status, 409); assert.equal(f.writes().length, before);
    assert.equal((await f.request(route, 'POST', payload)).status, 200);
    const current = (await f.request(f.path + '/reviews?accountId=gb')).data.reviews[0]; assert.equal((await f.request(route, 'POST', { ...payload, message: 'Edited', expectedReplyVersion: current.replyVersion })).status, 409);
    assert.equal((await f.request(route, 'POST', { ...payload, message: 'Edited', expectedReplyVersion: current.replyVersion, confirmReplace: true })).status, 200);
    const updated = (await f.request(f.path + '/reviews?accountId=gb')).data.reviews[0]; assert.equal((await f.request(f.path + '/reviews/delete-reply', 'POST', { accountId: 'gb', reviewId: first.id, expectedReplyVersion: updated.replyVersion, confirmReplace: true })).status, 200); assert.equal(f.writes().at(-1).options.method, 'DELETE');
    const fb = (await f.request(f.path + '/reviews?accountId=fb')).data.reviews[0]; assert.equal((await f.request(f.path + '/reviews/delete-reply', 'POST', { accountId: 'fb', reviewId: fb.id, expectedReplyVersion: fb.replyVersion, confirmReplace: true })).status, 422);
    const fresh = (await f.request(f.path + '/reviews?accountId=gb')).data.reviews[0]; f.setHook((url, options) => url.pathname.endsWith('/reviews/review-1/reply') && options.method === 'POST' ? Response.json({ status: 'success', platform: 'facebook', reply: { text: 'Unknown' } }) : undefined);
    const unknown = await f.request(route, 'POST', { ...payload, message: 'Unknown', expectedReplyVersion: fresh.replyVersion }); assert.equal(unknown.data.operation.status, 'uncertain');
  } finally { await f.close(); }
});

test('visible paged child comments can be replied to and moderated only with exact focused parent and post proof', pg, async t => {
  const f = await fixture(t); let focusMode = 'valid';
  const parent = { ...f.comments[0], id: 'parent-1', replies: [{ ...f.comments[0], id: 'reply-1', parentId: 'parent-1' }], repliesHasMore: true }, child = { ...f.comments[0], id: 'reply-2', parentId: 'parent-1' };
  f.setHook((url, options) => {
    if (options.method === 'GET' && url.pathname.endsWith('/inbox/comments/post-1')) {
      const focused = url.searchParams.get('commentId'), meta = { platform: 'facebook', accountId: 'fb', postId: 'post-1' }, paging = { hasMore: false, cursor: null };
      if (focused === 'parent-1') return Response.json({ comments: [child], comment: parent, pagination: paging, meta });
      if (focused === 'reply-2') return Response.json({ comments: [], comment: focusMode === 'wrong-parent' ? { ...child, id: 'foreign-parent' } : child, pagination: paging, meta: focusMode === 'wrong-post' ? { ...meta, postId: 'foreign-post' } : focusMode === 'wrong-account' ? { ...meta, accountId: 'ig' } : meta });
      return Response.json({ comments: [parent], pagination: paging, meta });
    }
    if (options.method === 'POST' && url.pathname.endsWith('/reply-2/hide')) return Response.json({ status: 'success', commentId: 'reply-2', platform: 'facebook', hidden: true });
  });
  try {
    const visible = await f.request(f.path + '/comments/thread?accountId=fb&postId=post-1&commentId=parent-1'); assert.equal(visible.status, 200); assert.equal(visible.data.comments[0].id, 'reply-2');
    const body = { accountId: 'fb', postId: 'post-1', commentId: 'reply-2' };
    assert.equal((await f.request(f.path + '/comments/reply', 'POST', { ...body, message: 'Reply to the loaded child' })).status, 200); assert.equal(f.writes().at(-1).body.commentId, 'reply-2');
    assert.equal((await f.request(f.path + '/comments/hide', 'POST', body)).status, 200);
    const writes = f.writes().length;
    for (const mode of ['wrong-parent', 'wrong-post', 'wrong-account']) { focusMode = mode; const result = await f.request(f.path + '/comments/reply', 'POST', { ...body, message: `Do not send ${mode}` }); assert.equal(result.status, 502, JSON.stringify(result.data)); }
    assert.equal(f.writes().length, writes, 'Foreign focused comments never reach a provider mutation.');
  } finally { await f.close(); }
});

test('ad comment bridges reject another ad or contradictory placement before any moderation write', pg, async t => {
  const f = await fixture(t); let mode = 'ad';
  f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith('/ads/ad-1/comments') ? Response.json({ status: 'success', comments: [{ ...f.comments[0], platform: 'instagram' }], pagination: { hasMore: false, cursor: null }, meta: { platform: 'instagram', accountId: 'ads', adId: mode === 'ad' ? 'different-ad' : 'ad-1', effectiveStoryId: 'different-post', instagramAccountId: 'ig', placement: mode === 'placement' ? 'facebook' : 'instagram' } }) : undefined);
  try {
    for (const value of ['ad', 'placement']) { mode = value; const result = await f.request(f.path + '/comments/reply', 'POST', { accountId: 'ads', postId: 'ad-1:instagram', commentId: 'comment-1', message: `Never send ${mode}` }); assert.equal(result.status, 502); }
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('inbox rejects malformed rendered names, message text, comment authors and nested review replies before returning data', pg, async t => {
  const f = await fixture(t);
  const cases = [
    { route: '/conversations?accountId=fb', path: '/inbox/conversations', data: { data: [{ id: 'thread-1', accountId: 'fb', platform: 'facebook', participantName: { unsafe: true } }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/conversations/thread-1/messages?accountId=fb', path: '/messages', data: { messages: [{ id: 'msg-1', accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', message: { unsafe: true }, senderName: 'Alex' }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/conversations/thread-1/messages?accountId=fb', path: '/messages', data: { messages: [{ id: 'msg-1', accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', message: 'Hi', attachments: [{ type: 'image', url: 'https://cdn.example.com/file.jpg', filename: { unsafe: true } }] }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/comments/thread?accountId=fb&postId=post-1', path: '/inbox/comments/post-1', data: { comments: [{ id: 'comment-1', platform: 'facebook', message: 'Hello', from: { name: { unsafe: true } } }], pagination: { hasMore: false, cursor: null }, meta: { platform: 'facebook', accountId: 'fb', postId: 'post-1' } } },
    { route: '/reviews?accountId=gb', path: '/inbox/reviews', data: { data: [{ id: 'review-1', accountId: 'gb', platform: 'googlebusiness', reviewer: { name: { unsafe: true } }, text: 'Good' }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/reviews?accountId=gb', path: '/inbox/reviews', data: { data: [{ id: 'review-1', accountId: 'gb', platform: 'googlebusiness', reviewer: { name: 'Alex' }, reply: { text: { unsafe: true } } }], pagination: { hasMore: false, nextCursor: null } } },
  ];
  try {
    for (const item of cases) { f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith(item.path) ? Response.json(item.data) : undefined); const result = await f.request(f.path + item.route); assert.equal(result.status, 502, item.route); assert.equal(result.data.error.code, 'INVALID_PROVIDER_RESPONSE'); }
    f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith('/inbox/conversations') ? Response.json({ data: [{ id: 'thread-1', accountId: 'fb', platform: 'facebook', participantName: null, lastMessage: null, instagramProfile: null, unreadCount: null }], pagination: { hasMore: false, nextCursor: null } }) : undefined);
    assert.equal((await f.request(f.path + '/conversations?accountId=fb')).status, 200, 'Optional null values remain valid.'); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('membership changes while a provider read is pending stop writes and prevent returning inbox data', pg, async t => {
  const f = await fixture(t); let revoke = 'viewer';
  f.setHook(async url => { if (url.pathname.endsWith('/accounts')) { if (revoke === 'viewer') await f.app.sql.run("UPDATE memberships SET role='viewer'"); else await f.app.sql.run('DELETE FROM memberships'); } });
  try {
    const denied = await f.request(f.path + '/conversations/thread-1/reply', 'POST', { accountId: 'fb', message: 'No permission to send' }); assert.equal(denied.status, 403); assert.equal(f.writes().length, 0); assert.equal(JSON.stringify(denied.data).includes('Alex Messenger'), false);
    revoke = 'removed'; const hidden = await f.request(f.path + '/conversations?accountId=fb'); assert.equal(hidden.status, 404); assert.equal(JSON.stringify(hidden.data).includes('participant-a'), false);
  } finally { await f.close(); }
});

test('archive receipts must identify the requested or resolved conversation and cannot be replayed after mismatch', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/status'; let receiptId = 'stored-thread-1';
  f.setHook((url, options) => {
    if (!url.pathname.endsWith('/inbox/conversations/thread-1')) return;
    return Response.json({ success: true, data: { id: options.method === 'PUT' ? receiptId : 'stored-thread-1', accountId: 'fb', platform: 'facebook', participantId: 'participant-a', status: options.method === 'PUT' ? JSON.parse(options.body).status : 'active' } });
  });
  try {
    assert.equal((await f.request(route, 'POST', { accountId: 'fb', status: 'archived' })).status, 200, 'Meta may return the detail-resolved stored ID.');
    receiptId = 'thread-1'; assert.equal((await f.request(route, 'POST', { accountId: 'fb', status: 'active' })).status, 200, 'The originally requested platform ID remains valid.');
    receiptId = 'other-conversation'; const body = { accountId: 'fb', status: 'archived' }, key = randomUUID(), before = f.writes().length;
    const result = await f.request(route, 'POST', body, key);
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(result.data.conversation, undefined);
    assert.equal((await f.request(route, 'POST', body, key)).status, 409); assert.equal((await f.request(route, 'POST', body)).status, 409);
    assert.equal(f.writes().length, before + 1, 'An unconfirmed archive must not be repeated with a fresh key.');
  } finally { await f.close(); }
});

test('WhatsApp replies round-trip delivery history, enforce the session and use exact approved templates outside it', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply';
  const template = { id: 'appointment-template', name: 'appointment_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Your appointment is now on {{1}}.' }] };
  let sent, deliveryStatus = 'sent', mode = 'normal';
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/whatsapp/templates')) { assert.equal(url.searchParams.get('accountId'), 'wa'); assert.equal(url.searchParams.get('status'), 'APPROVED'); return Response.json({ success: true, templates: [template] }); }
    if (!url.pathname.endsWith('/messages')) return;
    if (options.method === 'POST') {
      sent = JSON.parse(options.body);
      if (mode === 'timeout') throw new Error('Synthetic provider acknowledgement lost');
      return Response.json({ success: true, data: { messageId: 'wamid.sent-reply', conversationId: 'thread-1' }, warnings: mode === 'bad-warning' ? [{ message: { unexpected: true } }] : [{ code: 'test_warning', message: 'Synthetic provider warning', apiKey: 'never-return-this' }] });
    }
    if (sent) return Response.json({ messages: [{ id: 'wamid.sent-reply', accountId: 'wa', platform: 'whatsapp', conversationId: 'thread-1', message: sent.message || 'Your appointment is now on Friday.', direction: 'outgoing', senderId: 'business-account', createdAt: new Date().toISOString(), deliveryStatus }], pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
  });
  try {
    const status = await f.request(f.path + '/status'); assert.equal(status.data.accounts.find(row => row.id === 'wa').capabilities.reply, true);
    const conversations = await f.request(f.path + '/conversations?accountId=wa'); assert.equal(conversations.data.conversations[0].accountId, 'wa');
    assert.equal((await f.request(f.path + '/conversations/thread-1/messages?accountId=wa')).data.messages[0].direction, 'incoming');
    const body = { accountId: 'wa', message: 'Friday works for your appointment.' }, key = randomUUID();
    const accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true);
    assert.deepEqual(accepted.data.warnings, [{ code: 'test_warning', message: 'Synthetic provider warning' }]);
    assert.deepEqual(sent, body); assert.equal(f.writes().at(-1).options.headers['Idempotency-Key'], key);
    const beforeReplay = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, beforeReplay);
    deliveryStatus = 'read'; const readBack = await f.request(f.path + '/conversations/thread-1/messages?accountId=wa'); assert.equal(readBack.data.messages[0].message, body.message); assert.equal(readBack.data.messages[0].deliveryStatus, 'read');

    sent = undefined; f.setIncoming(Date.now());
    const mediaBody = { accountId: 'wa', message: 'Appointment details', attachmentUrl: 'https://cdn.example.com/appointment.jpg', attachmentType: 'image' };
    assert.equal((await f.request(route, 'POST', mediaBody)).status, 200); assert.deepEqual(sent, mediaBody);
    sent = undefined; f.setIncoming(Date.now() - 25 * 3600000);
    const beforeClosed = f.writes().length, closed = await f.request(route, 'POST', { accountId: 'wa', message: 'Closed session must not send' });
    assert.equal(closed.status, 409); assert.equal(closed.data.error.code, 'MESSAGING_WINDOW_CLOSED'); assert.equal(f.writes().length, beforeClosed);
    const templateBody = { accountId: 'wa', templateName: 'appointment_update', templateLanguage: 'en', templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Friday' }] }] };
    const missing = await f.request(route, 'POST', { ...templateBody, templateComponents: [] }); assert.equal(missing.status, 400); assert.equal(f.writes().length, beforeClosed);
    assert.equal((await f.request(route, 'POST', templateBody)).status, 200);
    assert.deepEqual(sent, { accountId: 'wa', template: { elements: [{ name: 'appointment_update', language: 'en', components: templateBody.templateComponents }] } });
    const beforeInvalid = f.writes().length;
    assert.equal((await f.request(route, 'POST', { ...templateBody, templateLanguage: 'en_US' })).data.error.code, 'TEMPLATE_NOT_APPROVED'); assert.equal(f.writes().length, beforeInvalid);

    sent = undefined; f.setIncoming(Date.now()); mode = 'bad-warning';
    const uncertainBody = { accountId: 'wa', message: 'Warning acknowledgement requires review' }, uncertainKey = randomUUID(), beforeUncertain = f.writes().length;
    const malformed = await f.request(route, 'POST', uncertainBody, uncertainKey); assert.equal(malformed.status, 409); assert.equal(malformed.data.operation.status, 'uncertain');
    assert.equal((await f.request(route, 'POST', uncertainBody, uncertainKey)).status, 409); assert.equal((await f.request(route, 'POST', uncertainBody)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);
    const recovery = await f.request(`/api/projects/${f.projectId}/operations/${malformed.data.operation.id}/review`, 'POST', { resolution: 'applied', confirmChecked: true, note: 'Verified the synthetic message was accepted in the provider fixture.', reference: 'wamid.sent-reply' }); assert.equal(recovery.status, 200);
    assert.equal((await f.request(route, 'POST', uncertainBody)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);

    sent = undefined; mode = 'timeout'; const lostBody = { accountId: 'wa', message: 'Different message with a lost acknowledgement' }, beforeTimeout = f.writes().length;
    assert.equal((await f.request(route, 'POST', lostBody)).data.operation.status, 'uncertain'); assert.equal((await f.request(route, 'POST', lostBody)).status, 409); assert.equal(f.writes().length, beforeTimeout + 1);
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); const beforeViewer = f.calls.length;
    assert.equal((await f.request(route, 'POST', templateBody)).status, 403); assert.equal(f.calls.length, beforeViewer);
  } finally { await f.close(); }
});

test('reply-window checks find recent customer messages after paged outgoing history and reject incomplete scans', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply'; let mode = 'open';
  f.setHook((url, options) => {
    if (!url.pathname.endsWith('/messages') || options.method !== 'GET') return;
    const accountId = url.searchParams.get('accountId'), platform = f.accounts.find(row => row._id === accountId).platform, cursor = url.searchParams.get('cursor');
    assert.equal(url.searchParams.get('sortOrder'), 'desc');
    const common = { conversationId: 'thread-1', accountId, platform, createdAt: new Date(Date.now() - 3600000).toISOString() };
    if (cursor && !['repeat', 'limit'].includes(mode)) return Response.json({ messages: [{ ...common, id: 'customer-message', direction: 'incoming', message: 'Please help', createdAt: new Date(Date.now() - (mode === 'closed' ? 25 : 2) * 3600000).toISOString() }], pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
    return Response.json({ messages: Array.from({ length: 100 }, (_, index) => ({ ...common, id: 'business-' + index, direction: 'outgoing', message: 'Status update' })), pagination: { hasMore: true, nextCursor: mode === 'limit' ? String(Number(cursor || 0) + 1) : 'older-messages' }, sortOrderApplied: 'desc' });
  });
  try {
    for (const accountId of ['fb', 'ig', 'wa']) {
      const accepted = await f.request(route, 'POST', { accountId, message: 'Reply with a verified open window' });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true);
      assert.equal(f.calls.filter(call => call.options.method === 'GET' && call.url.pathname.endsWith('/messages') && call.url.searchParams.get('accountId') === accountId).length, 2);
    }
    mode = 'closed'; const before = f.writes().length;
    assert.equal((await f.request(route, 'POST', { accountId: 'wa', message: 'Do not send outside the window' })).data.error.code, 'MESSAGING_WINDOW_CLOSED');
    mode = 'repeat'; const repeated = await f.request(route, 'POST', { accountId: 'wa', message: 'Do not send after a repeated cursor' });
    assert.equal(repeated.status, 502); assert.equal(f.writes().length, before);
    mode = 'limit'; const reads = f.calls.length, incomplete = await f.request(route, 'POST', { accountId: 'wa', message: 'Do not send after incomplete history' });
    assert.equal(incomplete.status, 503); assert.equal(incomplete.data.error.code, 'INCOMPLETE_PROVIDER_DATA'); assert.equal(f.writes().length, before);
    assert.equal(f.calls.slice(reads).filter(call => call.options.method === 'GET' && call.url.pathname.endsWith('/messages')).length, 20);
  } finally { await f.close(); }
});


test('WhatsApp reply buttons send only the exact text-only generated-ID subset and require an existing operation for checks', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply', buttons = [{ type: 'postback', title: 'Yes', payload: 'reply_1' }, { type: 'postback', title: 'No', payload: 'reply_2' }], body = { accountId: 'wa', message: 'Choose one', buttons }, key = randomUUID();
  try {
    const state = await f.request(f.path + '/status'); assert.equal(state.data.accounts.find(row => row.id === 'wa').capabilities.replyButtons, true); assert.equal(state.data.accounts.find(row => row.id === 'ig').capabilities.replyButtons, false);
    const absent = await f.request(route + '?check=1', 'POST', body, key); assert.equal(absent.data.error.code, 'OPERATION_OUTCOME_UNAVAILABLE'); assert.equal(f.writes().length, 0);
    for (const extra of [{ buttons: [] }, { buttons: [...buttons, ...buttons] }, { buttons: [{ ...buttons[0], title: '' }] }, { buttons: [{ ...buttons[0], title: ' Yes' }] }, { buttons: [{ ...buttons[0], title: 'Yes\nNo' }] }, { buttons: [{ ...buttons[0], title: 'x'.repeat(21) }] }, { buttons: [{ ...buttons[0], type: 'url' }] }, { buttons: [{ ...buttons[0], payload: 'arbitrary-id' }] }, { buttons: buttons.map(row => ({ ...row, title: 'Same' })) }, { buttons: [{ ...buttons[0], url: 'https://example.test' }] }, { message: '🙂'.repeat(257) }, { message: '' }, { attachmentUrl: 'https://example.test/image.jpg', attachmentType: 'image' }, { templateName: 'service_update' }, { messageTag: 'HUMAN_AGENT' }, { replyTo: 'previous-message' }, { accountId: 'ig' }]) {
      const denied = await f.request(route, 'POST', { ...body, ...extra }); assert.ok(denied.status >= 400, JSON.stringify(extra)); assert.equal(f.writes().length, 0);
    }
    const accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true); assert.deepEqual(f.writes()[0].body, body); assert.equal(f.writes()[0].options.headers['Idempotency-Key'], key);
    assert.equal((await f.request(route + '?check=1', 'POST', body, key)).status, 200); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(route + '?check=1', 'POST', { ...body, message: 'Different' }, key)).data.error.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(route + '?check=1', 'POST', body, randomUUID())).data.error.code, 'OPERATION_OUTCOME_UNAVAILABLE'); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(route, 'POST', { ...body, message: '🙂'.repeat(256) })).status, 200); assert.equal(f.writes().length, 2);
    f.setIncoming(Date.now() - 25 * 3600000); assert.equal((await f.request(route, 'POST', body)).data.error.code, 'MESSAGING_WINDOW_CLOSED'); assert.equal(f.writes().length, 2);
    await f.app.sql.run("UPDATE memberships SET role='viewer'"); const before = f.calls.length; assert.equal((await f.request(route, 'POST', body)).status, 403); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('WhatsApp reply-button final history reads cannot dispatch after sender, recipient, handover or access changes', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply', account = f.accounts.find(row => row._id === 'wa'), body = { accountId: 'wa', message: 'Choose one', buttons: [{ type: 'postback', title: 'Yes', payload: 'reply_1' }] };
  let mode = '', changed = false;
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/messages') && options.method === 'GET' && !changed) {
      changed = true;
      if (mode === 'inactive') account.isActive = false;
      if (mode === 'reconnect') account.needsReconnection = true;
      if (mode === 'sender') account.username = 'changed-sender';
      if (mode === 'viewer') await f.app.sql.run("UPDATE memberships SET role='viewer'");
      if (mode === 'mapping') await f.app.sql.run("UPDATE projects SET zernio_profile_id='changed-profile'");
    }
    if (changed && url.pathname.endsWith('/inbox/conversations/thread-1') && ['recipient', 'control'].includes(mode)) return Response.json({ data: { id: 'thread-1', accountId: 'wa', platform: 'whatsapp', participantId: mode === 'recipient' ? 'changed-participant' : 'participant-a', status: 'active', ...(mode === 'control' ? { threadControl: 'ai_agent' } : {}) } });
  });
  try {
    for (const value of ['inactive', 'reconnect', 'sender', 'recipient', 'control', 'viewer', 'mapping']) {
      mode = value; changed = false; account.isActive = true; account.needsReconnection = false; account.username = 'whatsapp-account'; await f.app.sql.run("UPDATE memberships SET role='owner'"); await f.app.sql.run("UPDATE projects SET zernio_profile_id='inbox-profile'");
      const denied = await f.request(route, 'POST', body); assert.ok([403, 409, 422].includes(denied.status), mode + ': ' + JSON.stringify(denied.data)); assert.equal(f.writes().length, 0, mode);
    }
  } finally { await f.close(); }
});

test('unknown WhatsApp button outcomes retain the durable request fence across exact checks, changed bodies and reopen', pg, async t => {
  const f = await fixture(t), route = f.path + '/conversations/thread-1/reply', body = { accountId: 'wa', message: 'Unknown button outcome', buttons: [{ type: 'postback', title: 'Yes', payload: 'reply_1' }] }, key = randomUUID();
  f.setHook((url, options) => { if (url.pathname.endsWith('/messages') && options.method === 'POST') throw new TypeError('Synthetic native acknowledgement lost'); });
  try {
    const first = await f.request(route, 'POST', body, key); assert.equal(first.data.operation.status, 'uncertain'); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(route + '?check=1', 'POST', body, key)).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(route + '?check=1', 'POST', { ...body, message: 'Changed' }, key)).data.error.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(f.writes().length, 1);
    assert.equal((await f.request(route, 'POST', { ...body, message: 'Changed' })).data.error.code, 'OPERATION_NOT_SENT'); assert.equal(f.writes().length, 1);
    await f.reopen(); assert.equal((await f.request(route + '?check=1', 'POST', body, key)).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});
