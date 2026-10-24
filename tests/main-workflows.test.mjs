import test from 'node:test';
import { postScheduleEntries } from '../shared/post-schedule.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { Button, Card, DangerZoneFlow, FormActions, Grid, Inline, Link, SegmentedControl, Stack, Text } from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = () => readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('the shared API client rejects unreadable receipts without treating a potentially accepted write as a known failure', async () => {
  const appSource = source(), start = appSource.indexOf('async function api('), end = appSource.indexOf('\nconst money =', start);
  assert.ok(start > 0 && end > start);
  const client = response => runInNewContext(stripTypeScriptTypes(appSource.slice(start, end)) + '; api', { fetch: async () => response });
  for (const status of [200, 502]) await assert.rejects(client(new Response('<html>upstream error</html>', { status }))('/test', 'POST', { value: 1 }, 'action-key'), error => error.message === 'The server returned an unreadable response.' && error.status === undefined);
  for (const invalid of [null, [], 'saved', 1, true]) await assert.rejects(client(Response.json(invalid))('/test', 'POST', {}, 'action-key'), error => error.message === 'The server returned an unreadable response.' && error.status === undefined);
  await assert.rejects(client(Response.json({ error: { code: 'OPERATION_UNCERTAIN', message: 'Check the provider.' }, operation: { id: 'receipt' } }, { status: 409 }))('/test'), error => error.status === 409 && error.code === 'OPERATION_UNCERTAIN' && error.operation.id === 'receipt');
  assert.equal((await client(Response.json({ saved: true }))('/test')).saved, true);
});

test('a 401 while signed in ends the session once, without a per-surface error, and sign-in failures stay form errors', async () => {
  const appSource = source(), start = appSource.indexOf('async function api('), end = appSource.indexOf('\nconst money =', start);
  const unauthorized = () => Response.json({ error: 'Sign in to continue.' }, { status: 401 });
  const client = handler => { const ended = []; return { ended, api: runInNewContext(stripTypeScriptTypes(appSource.slice(start, end)) + '; api', { fetch: async () => unauthorized(), DOMException, endSession: handler === undefined ? () => ended.push(1) : handler }) }; };
  const signedIn = client();
  await assert.rejects(signedIn.api('/projects/p/approvals'), error => error.name === 'AbortError' && error.message === 'Your session ended. Sign in again.');
  assert.equal(signedIn.ended.length, 1, 'The app returns to the sign-in screen.');
  await assert.rejects(signedIn.api('/auth/login', 'POST', {}), error => error.name !== 'AbortError' && error.status === 401 && error.message === 'Sign in to continue.');
  assert.equal(signedIn.ended.length, 1, 'A failed sign-in is shown by the sign-in form.');
  const signedOut = client(null);
  await assert.rejects(signedOut.api('/invitations/x/accept', 'POST', {}), error => error.status === 401, 'Without a signed-in session a 401 is an ordinary error.');
  // run() ignores AbortError, so no surface shows "Sign in to continue."; the startup reload ignores it too.
  assert.match(appSource, /else if \(activeProject\.current === requestProject && \(err as Error\)\.name !== 'AbortError'\) setError/);
  assert.match(appSource, /\.catch\(e => \{ if \(e\.name !== 'AbortError'\) setError\(e\.message\); \}\)/);
});

test('browser-pass copy: connection empty states, disabled-control reasons, results empty state and editor labels', async () => {
  const appSource = source(), declaration = appSource.match(/^function ConnectionEmpty\([^\r\n]+$/m)[0];
  const { code } = await transformWithOxc(declaration, 'ConnectionEmpty.tsx', { jsx: { runtime: 'classic' } });
  const ConnectionEmpty = new Function('React', 'Card', 'EmptyState', 'Button', code + '; return ConnectionEmpty;')(React, Card, (await import('@ten98/ui')).EmptyState, Button);
  let opened = 0; const html = renderToStaticMarkup(React.createElement(ConnectionEmpty, { subject: 'ad activity', onSettings: () => opened++ }));
  // Plain language: the job and where to do it, never the middleware or "provider".
  assert.match(html, /Connect your accounts to use ad activity/); assert.match(html, /Settings › Connections/); assert.match(html, />Open Connections</);
  assert.doesNotMatch(html, /Zernio|provider|Integrations/);
  for (const subject of (appSource.match(/subject="[^"]+"/g) || [])) assert.doesNotMatch(subject, /provider|Zernio|queue|destination|tracking tag/, subject);
  assert.match(appSource, /label=\{connected \? 'Accounts connected' : 'Connect your accounts'\} action=\{\{ label: 'Connections',/);
  for (const subject of (appSource.match(/subject="[^"]+"/g) || [])) assert.match(subject, /^subject="(?:the |[a-z]|WhatsApp|Google)/, subject);
  assert.doesNotMatch(appSource, /Open Integrations/, 'Button and prose casing is consistent within the shell.');
  for (const name of ['GoogleCalendar', 'UnifiedInbox']) assert.doesNotMatch(readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8'), /Open Integrations/, name + ' uses the same "Open integrations" casing.');
  assert.match(appSource, /\{!connected && <Text tone="muted" size="sm">Connect Zernio in Integrations to load channels\.<\/Text>\}<Button[^\r\n]*?disabled=\{busy \|\| !connected\}[^\r\n]*?>Load channels<\/Button>/);
  // src/AssetLibrary.tsx shows this reason beside its Sync Drive control (asset-library-ui.test.ts renders it).
  assert.match(appSource, /<AssetLibrary [^\r\n]*driveSyncReason=\{driveSyncReason\}[^\r\n]*onSync=\{\(\) => run\(async \(\) => \{ await integrate\('drive\/sync', \{\}\); await reload\(\); \}, 'Drive assets synced'\)\}/);
  const reason = new Function('canWrite', 'remote', appSource.match(/const driveSyncReason = ([^\r\n]+);/)[1].replace(/^/, 'return ') + ';');
  assert.match(reason(false, {}), /Viewers/); assert.equal(reason(true, {}), '', 'No reason before the status loads.');
  assert.match(reason(true, { status: { drive: { configured: false } } }), /Configure Google Drive/); assert.match(reason(true, { status: { drive: { configured: true, mapped: false } } }), /Map a Drive folder/);
  assert.equal(reason(true, { status: { drive: { configured: true, mapped: true } } }), '');
  assert.match(appSource, /<DataTable ariaLabel="Campaign results"[^\r\n]*?emptyTitle=\{state\.campaigns\.length \? 'No campaigns match this search' : 'No campaign results yet'\} emptyDescription=/);
  // The OOH booking rows and their per-placement Edit/View buttons are covered with the plan view in ooh-plan-ui.test.ts.
  assert.match(appSource, /providerManaged \|\| modal\.type === 'ad-details' \|\| !canWrite \? 'View '/, 'Read-only editors are titled View.');
  // The reporting currency select sizes to its options beside the summary instead of filling the row.
  assert.match(appSource, /<\/Text><UiSelect width="auto" aria-label="Reporting currency"[^\r\n]*?\/><\/Inline>/);
});

test('dashboard counts daily-campaign spend without adding daily budgets to total allocations or inventing missing metrics', () => {
  const appSource = source(), start = appSource.search(/  const (?:currencyCampaigns|currentCurrency) =/), end = appSource.indexOf('  const activeCampaigns =', start);
  assert.ok(start > 0 && end > start);
  const calculate = runInNewContext(`(state, currency) => { const numeric = value => typeof value === 'number' && Number.isFinite(value), money = value => String(value); ${appSource.slice(start, end)} return { spent, budget, impressions, chartCount: currentCurrency.length, caption: typeof spendCaption === 'undefined' ? '' : spendCaption }; }`);
  const manual = { currency: 'USD', budget: 100, spent: 10, impressions: 100 }, daily = { currency: 'USD', budgetType: 'daily', budget: 25, spent: 31.5, impressions: 1450 }, foreign = { currency: 'EUR', budget: 300, spent: 5, impressions: 50 };
  const totals = calculate({ campaigns: [manual, daily, foreign] }, 'USD');
  assert.equal(totals.spent, 41.5, 'Spend includes daily-budget advertising campaigns.'); assert.equal(totals.budget, 100, 'A daily spend limit cannot be added to a campaign-total allocation.'); assert.equal(totals.chartCount, 1); assert.equal(totals.impressions, 1600);
  assert.match(totals.caption, /daily budgets separate/); assert.doesNotMatch(totals.caption, /%/);
  assert.equal(calculate({ campaigns: [manual, { ...daily, spent: undefined, impressions: undefined }] }, 'USD').spent, undefined);
  assert.equal(calculate({ campaigns: [manual, { ...daily, impressions: null }] }, 'USD').impressions, undefined);
  assert.equal(calculate({ campaigns: [] }, 'USD').spent, 0);
});

test('campaign money and counts preserve fractional amounts and distinguish absent values from zero', () => {
  const appSource = source(), names = ['numeric', 'money', 'compact', 'budgetProgress'];
  const declarations = names.map(name => appSource.match(new RegExp(`^const ${name} = .+;$`, 'm'))?.[0]);
  assert.ok(declarations.every(Boolean));
  const { money, compact, budgetProgress } = runInNewContext(stripTypeScriptTypes(declarations.join('\n')) + '; ({money, compact, budgetProgress})');
  assert.equal(money(0.01, 'USD'), '$0.01'); assert.equal(money(25.75, 'USD'), '$25.75'); assert.equal(money(25, 'USD'), '$25'); assert.equal(money(25.125, 'KWD').includes('25.125'), true);
  for (const missing of [undefined, null, NaN, Infinity, '0']) { assert.equal(money(missing), '—'); assert.equal(compact(missing), '—'); }
  assert.equal(money(0, 'USD'), '$0'); assert.equal(compact(0), '0');
  assert.equal(budgetProgress(0.1, 0.25), 40); assert.equal(budgetProgress(5, 2), 100); assert.equal(budgetProgress(1, 0), 0); assert.equal(budgetProgress(undefined, 25), 0);
  assert.equal((appSource.match(/budgetProgress\(c\.spent, c\.budget\)/g) || []).length, 2, 'Both campaign bars use the shared fractional-budget calculation.');
});

test('post labels show a platform caption when shared content is empty and identify media-only posts', () => {
  const declaration = source().match(/^function postLabel\(post: Row\) \{[^\r\n]+\}$/m)?.[0];
  assert.ok(declaration);
  const label = runInNewContext(stripTypeScriptTypes(declaration) + '; postLabel');
  assert.equal(label({ content: 'Shared caption', platforms: ['twitter'], platformOverrides: { twitter: { content: 'Custom caption' } } }), 'Shared caption');
  assert.equal(label({ content: '', platforms: ['instagram', 'twitter'], platformOverrides: { twitter: { content: 'Custom caption' } } }), 'Custom caption');
  assert.equal(label({ content: '', platforms: ['instagram'], platformOverrides: { instagram: { mediaItems: [] } } }), 'Empty draft', 'A draft with no caption or media is not called a media post.');
  assert.equal(label({ content: ' ', platforms: ['linkedin'] }), 'Empty draft');
  assert.equal(label({ content: '', platforms: ['instagram'], assetId: 'asset-a' }), 'Media post');
  assert.equal(label({ content: '', platforms: ['instagram'], platformOverrides: { instagram: { mediaItems: [{ url: 'https://cdn.example/a.jpg' }] } } }), 'Media post');
  assert.equal(label({ content: '', accountOverrides: { page: { assetId: 'asset-b' } } }), 'Media post');
  assert.equal(label({ content: '', platforms: ['facebook'], accountOverrides: { page: { platform: 'facebook', content: 'Account-only caption' } } }), 'Account-only caption');
});

test('post cards name only saved recipient IDs using current project names and matching provider metadata', async () => {
  const appSource = source(), composer = readFileSync(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
  const declarations = [composer.match(/^const accountId = .+;$/m)?.[0], composer.match(/^export const accountLabel = .+;$/m)?.[0]?.replace('export ', '')];
  assert.ok(declarations.every(Boolean));
  const start = appSource.indexOf('function postRecipients('), end = appSource.indexOf('function calendarOverlayEvents(', start);
  assert.ok(start > 0 && end > start);
  assert.match(appSource, /import PostComposer, \{ accountLabel \} from '\.\/PostComposer'/);
  const recipients = runInNewContext(stripTypeScriptTypes(declarations.join('\n') + '\n' + appSource.slice(start, end)) + '; postRecipients');
  const accounts = [{ _id: 'one', displayName: 'Current page', platform: 'facebook' }, { _id: 'two', username: '@second', platform: 'facebook' }, { id: 'three', name: 'Named account' }];
  const post = { accounts: ['two', 'one', 'reported', 'missing'], platforms: ['facebook'], accountOverrides: { unselected: { platform: 'facebook' } }, providerResults: [{ accountId: { _id: 'one', displayName: 'Old page name' } }, { accountId: 'reported' }, { accountId: { _id: 'reported', displayName: 'Reported page' } }, { accountId: { _id: 'foreign', displayName: 'Unselected page' } }] };
  const before = structuredClone({ post, accounts });
  assert.equal(recipients(post, accounts), '@second (two), Current page (one), Reported page (reported), missing');
  assert.equal(recipients({ accounts: ['one', 'two'] }, [{ _id: 'one', displayName: 'Same page', platform: 'facebook' }, { _id: 'two', displayName: 'Same page', platform: 'facebook' }]), 'Same page (one), Same page (two)', 'Same-platform recipients retain distinct identities.');
  assert.equal(recipients({ accounts: ['three'] }, accounts), 'Named account (three)');
  assert.equal(recipients({ accounts: ['raw'] }, [{ _id: 'raw' }]), 'raw');
  assert.equal(recipients({ accounts: ['id-only'], providerResults: [{ accountId: { id: 'id-only', username: '@reported' } }] }), '@reported (id-only)');
  assert.equal(recipients(post), 'two, Old page name (one), Reported page (reported), missing', 'Unloaded names do not invent current directory data.');
  assert.equal(recipients({ ...post, accounts: [] }, accounts), 'No accounts selected');
  assert.equal(recipients({ platforms: ['facebook'], providerResults: post.providerResults, accountOverrides: post.accountOverrides }, accounts), 'Choose connected accounts');
  assert.deepEqual({ post, accounts }, before, 'Display resolution does not change saved identities or loaded accounts.');
  const markup = appSource.match(/<Text tone="muted" size="sm">Recipients: \{postRecipients\(p, remote\.accounts\?\.accounts \|\| \[\]\)\}<\/Text>/)?.[0];
  assert.ok(markup, 'Cards render recipient identities visibly.');
  const { code } = await transformWithOxc('const render = (p, remote) => ' + markup, 'PostRecipients.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'postRecipients', 'Text', code + '; return render;')(React, recipients, Text);
  const html = renderToStaticMarkup(render({ accounts: ['<unknown>'] }, {}));
  assert.match(html, /Recipients: &lt;unknown&gt;/); assert.doesNotMatch(html, /<unknown>/);
});

test('post status filter is one labelled segmented control bound to the local filter', async () => {
  const appSource = source(), start = appSource.indexOf('<SegmentedControl label="Post status"'), end = appSource.indexOf('/>', start) + 2;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc('const render = (tab, setTab) => ' + appSource.slice(start, end), 'PostStatus.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'SegmentedControl', 'title', code + '; return render;')(React, SegmentedControl, value => value[0].toUpperCase() + value.slice(1));
  const statuses = ['all', 'draft', 'scheduled', 'published', 'failed', 'cancelled']; let selected = 'all';
  for (const status of statuses) {
    const control = render(selected, value => { selected = value; });
    assert.equal(control.type, SegmentedControl); assert.equal(control.props.label, 'Post status'); assert.equal(control.props.value, selected);
    assert.deepEqual(control.props.options.map(option => option.value), statuses); assert.equal(control.props.options[0].label, 'All posts');
    assert.equal((renderToStaticMarkup(control).match(/aria-checked="true"|aria-pressed="true"/g) || []).length, 1, 'Exactly one status is marked as chosen.');
    control.props.onValueChange(status); assert.equal(selected, status);
  }
  const declaration = appSource.match(/^  const visiblePosts = .+;$/m)?.[0]; assert.ok(declaration);
  const filter = new Function('state', 'tab', 'filtered', declaration + '; return visiblePosts;');
  const posts = statuses.slice(1).map(status => ({ id: status, status }));
  for (const status of statuses) assert.deepEqual(filter({ posts }, status, rows => rows).map(post => post.id), status === 'all' ? statuses.slice(1) : [status]);
  assert.doesNotMatch(appSource, /sections\('Publishing sections'/, 'Publishing sections are homed by the area map, not a second tab row.');
  assert.match(appSource, />Repeating posts<\/Button>/); assert.match(appSource, /\{page === 'Publishing' && publishingView === 'queues' && settingsFrame\(/);
});

test('Overview campaign totals and channel counts use singular only for one campaign', async () => {
  const appSource = source(), declaration = appSource.match(/^const plural = .+;$/m)?.[0]; assert.ok(declaration);
  const plural = runInNewContext(stripTypeScriptTypes(declaration) + '; plural');
  assert.match(appSource, /\{plural\(activeCampaigns, 'active campaign'\)\}/); assert.match(appSource, /formatCount=\{count => plural\(count, 'campaign'\)\}/);
  for (const count of [0, 1, 2]) {
    const word = count === 1 ? 'campaign' : 'campaigns';
    assert.equal(plural(count, 'active campaign'), `${count} active ${word}`); assert.equal(plural(count, 'campaign'), `${count} ${word}`);
  }
});

test('local campaign results distinguish missing metrics from zero and never display NaN rates', () => {
  const appSource = source(), start = appSource.indexOf('<DataTable ariaLabel="Campaign results"'), row = appSource.slice(start, appSource.indexOf(']}/>', start) + 1);
  // The metric columns' render expressions, after the campaign name column.
  const cells = row.split('render: c => ').slice(2).map(segment => segment.slice(0, segment.lastIndexOf(' }')));
  assert.equal(cells.length, 5);
  const declaration = appSource.match(/^const numeric = .+;$/m)[0].replace('(value: unknown): value is number', '(value)');
  const numeric = runInNewContext(declaration + '; numeric');
  const render = campaign => cells.map(expression => new Function('c', 'numeric', 'compact', 'money', `return (${expression});`)(campaign, numeric, value => String(value), value => `AED ${value}`));
  assert.deepEqual(render({}), ['—', '—', '—', '—', '—']);
  assert.deepEqual(render({ impressions: 100, conversions: 2 }), ['100', '—', '—', 2, '—']);
  assert.deepEqual(render({ impressions: 100, clicks: 0, conversions: 2, spent: 0 }), ['100', '0', '0.00%', 2, 'AED 0']);
  assert.deepEqual(render({ impressions: 0, clicks: 0, conversions: 0, spent: 0 }), ['0', '0', '—', 0, '—']);
  assert.deepEqual(render({ impressions: Infinity, clicks: NaN, conversions: null, spent: undefined }), ['—', '—', '—', '—', '—']);
});

test('calendar dates stay on their intended day while timestamps follow the browser timezone', () => {
  const declaration = source().match(/^const date = .+;$/m)?.[0];
  assert.ok(declaration, 'Exercise the date formatter used by campaign and OOH cards.');
  const script = `${declaration.replace('(value: string)', '(value)')}\nconsole.log(JSON.stringify([date('2026-10-18'), date('2026-10-18T00:00:00Z'), date('')]));`;
  const west = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } });
  assert.equal(west.status, 0, west.stderr);
  assert.deepEqual(JSON.parse(west.stdout.trim()), ['18 Oct', '17 Oct', 'Not set']);
  const east = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Dubai' } });
  assert.equal(east.status, 0, east.stderr);
  assert.deepEqual(JSON.parse(east.stdout.trim()), ['18 Oct', '18 Oct', 'Not set']);
});

test('upcoming posts exclude past and completed work and sort by instant without changing the source list', () => {
  const declaration = source().match(/^function upcomingPosts\([^\r\n]+\}$/m)?.[0];
  assert.ok(declaration, 'Keep the upcoming-post selector available for this regression check.');
  const upcoming = runInNewContext(stripTypeScriptTypes(declaration) + '; upcomingPosts', { postScheduleEntries });
  const now = Date.parse('2026-10-18T10:00:00Z');
  const posts = [
    { id: 'latest', status: 'scheduled', scheduledAt: '2026-10-18T13:00:00Z' },
    { id: 'published', status: 'published', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'cancelled', status: 'cancelled', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'failed', status: 'failed', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'past', status: 'scheduled', scheduledAt: '2026-10-18T09:00:00Z' },
    { id: 'exactly-now', status: 'scheduled', scheduledAt: '2026-10-18T10:00:00Z' },
    { id: 'invalid', status: 'scheduled', scheduledAt: 'not-a-date' },
    { id: 'undated', status: 'draft' },
    { id: 'offset-earliest', status: 'draft', scheduledAt: '2026-10-18T15:00:00+04:00' },
    { id: 'submitted', status: 'submitted', scheduledAt: '2026-10-18T12:00:00Z' },
  ];
  const before = structuredClone(posts), result = upcoming(posts, now);
  assert.deepEqual(Array.from(result, row => row.id), ['offset-earliest', 'submitted', 'latest']);
  assert.deepEqual(posts, before);
  assert.equal(upcoming([], now).length, 0);
  const copy = { id: 'copies', status: 'scheduled', content: 'Shared', scheduledAt: '2026-10-18T14:00:00Z', platforms: ['facebook'], accounts: ['one', 'two'], accountOverrides: { two: { platform: 'facebook', content: 'Second account', scheduledAt: '2026-10-18T11:30:00Z' } } };
  const copies = upcoming([copy], now); assert.deepEqual(Array.from(copies, row => [row.id, row.content, row.scheduledAt]), [['copies:two', 'Second account', '2026-10-18T11:30:00Z'], ['copies:one', 'Shared', '2026-10-18T14:00:00Z']]); assert.ok(copies.every(row => row.post === copy), 'Calendar and overview entries must open the original post, not a flattened copy.');
});

test('calendar overlay hides only exact verified copies of visible local post entries', () => {
  const declaration = source().match(/^function calendarOverlayEvents\([^\r\n]+\}$/m)?.[0]; assert.ok(declaration);
  const overlay = runInNewContext(stripTypeScriptTypes(declaration) + '; calendarOverlayEvents');
  const post = { id: 'post', platforms: ['facebook'], content: 'Shared', scheduledAt: '2026-10-18T10:00:00Z', accounts: ['one', 'two'], accountOverrides: { two: { platform: 'facebook', content: 'Other caption', scheduledAt: '2026-10-18T11:00:00Z' } } };
  const entries = postScheduleEntries(post), event = { id: 'google', managed: true, projectId: 'project', plan: { collection: 'posts', recordId: 'post', accountId: 'two' }, summary: 'Social · Other caption', start: { dateTime: '2026-10-18T15:00:00+04:00' }, end: { dateTime: '2026-10-18T11:30:00Z' } };
  assert.equal(overlay([event], entries, 'project').length, 0);
  for (const change of [{ managed: false }, { projectId: 'foreign' }, { plan: undefined }, { plan: { ...event.plan, recordId: 'deleted' } }, { plan: { ...event.plan, accountId: 'one' } }, { plan: { ...event.plan, collection: 'campaigns' } }, { summary: 'Manually edited caption' }, { start: { dateTime: '2026-10-18T12:00:00Z' } }, { end: { dateTime: '2026-10-18T12:00:00Z' } }]) assert.equal(overlay([{ ...event, ...change }], entries, 'project').length, 1, JSON.stringify(change));
  assert.equal(overlay([event], [], 'project').length, 1, 'Orphan or currently invisible local entries stay visible.');
  assert.equal(overlay([{ ...event, plan: { collection: 'posts', recordId: 'ordinary' }, summary: 'Social · Ordinary' }], postScheduleEntries({ id: 'ordinary', content: 'Ordinary', scheduledAt: event.start.dateTime }), 'project').length, 0);
  assert.match(source(), /<CampaignPublishingAgenda posts=\{calendarPosts\} googleEvents=\{calendarOverlay\}/, 'The agenda shows local posts and only the unverified Google overlay.');
});

test('asset previews select safe actual media and fall back after a thumbnail fails', () => {
  const appSource = source(), start = appSource.indexOf('function AssetPreview('), body = appSource.indexOf('\n', start), end = appSource.indexOf('\n  return preview ?', body);
  assert.ok(start > -1 && end > body, 'Exercise the production preview selection before its JSX rendering.');
  const select = runInNewContext(`(item, useState) => { ${appSource.slice(body, end).replace('useState<string[]>([])', 'useState([])')} return preview; }`, { URL });
  const choose = (item, failed = []) => select(item, () => [failed, () => {}]);
  const thumbnailUrl = 'https://cdn.example.com/thumb.jpg', deliveryUrl = 'https://cdn.example.com/publish.jpg', original = 'https://drive.google.com/file/d/original/view';
  const image = { kind: 'image', thumbnailUrl, deliveryUrl, url: original };
  assert.equal(choose(image), thumbnailUrl);
  assert.equal(choose(image, [thumbnailUrl]), deliveryUrl, 'A failed thumbnail must use the public delivery media.');
  assert.equal(choose(image, [thumbnailUrl, deliveryUrl]), undefined, 'Failed media should become a placeholder instead of requesting forever.');
  assert.equal(choose({ ...image, thumbnailUrl: '', deliveryUrl: 'https://cdn.example.com/replacement.jpg' }, [deliveryUrl]), 'https://cdn.example.com/replacement.jpg', 'Changing a failed URL makes the new media eligible.');
  assert.equal(choose({ kind: 'image', deliveryUrl, url: original }), deliveryUrl);
  assert.equal(choose({ kind: 'image', url: 'https://cdn.example.com/original.jpg' }), 'https://cdn.example.com/original.jpg');
  assert.equal(choose({ kind: 'video', thumbnailUrl, url: 'https://cdn.example.com/movie.mp4' }), thumbnailUrl);
  assert.equal(choose({ kind: 'video', url: 'https://cdn.example.com/movie.mp4' }), undefined);
  assert.equal(choose({ ...image, deliverySource: 'zernio', deliveryKind: 'video', deliveryUrl: 'https://media.zernio.com/temp/movie.mp4' }), undefined, 'A different delivery kind must not reuse the original Drive thumbnail or render a video as an image.');
  assert.equal(choose({ kind: 'video', thumbnailUrl, url: original, deliverySource: 'zernio', deliveryKind: 'image', deliveryUrl }), deliveryUrl, 'The delivery file preview follows its observed kind, independently of the original.');
  for (const unsafe of ['http://cdn.example.com/a.jpg', 'javascript:alert(1)', 'https://user:secret@cdn.example.com/a.jpg', original, 'https://docs.google.com/document/d/private', 'https://localhost/a.jpg', 'https://127.1/a.jpg', 'https://0x7f000001/a.jpg', 'https://10.0.0.1/a.jpg', 'https://172.16.0.1/a.jpg', 'https://172.31.255.255/a.jpg', 'https://192.168.0.1/a.jpg', 'https://169.254.1.1/a.jpg', 'https://0.0.0.0/a.jpg', 'https://[::1]/a.jpg', 'https://media.local/a.jpg', 'https://media.internal/a.jpg']) {
    assert.equal(choose({ kind: 'image', thumbnailUrl: unsafe, url: unsafe, deliveryUrl: unsafe }), undefined, unsafe);
    assert.equal(choose({ ...image, thumbnailUrl: unsafe }), deliveryUrl, `An unsafe thumbnail must not hide safe delivery media: ${unsafe}`);
  }
  for (const publicUrl of ['https://172.15.0.1/a.jpg', 'https://172.32.0.1/a.jpg']) assert.equal(choose({ kind: 'image', url: publicUrl }), publicUrl, 'The 172.16/12 block must not cover neighboring public addresses.');
});


test('Settings shows one section at a time, keeps scoped receipt recovery, and hides sign-in setup from non-operators', async () => {
  const appSource = source(), start = appSource.indexOf("{page === 'Settings' && "), end = appSource.indexOf('\n', start);
  assert.ok(start > 0 && end > start);
  const expression = appSource.slice(start + 1, end - 1);
  const { code } = await transformWithOxc('const render = () => (' + expression + ');', 'SettingsComposition.tsx', { jsx: { runtime: 'classic' } });
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  const AccountSettings = () => React.createElement('section', { 'data-account-settings': true });
  const OperationRecovery = ({ projectId }) => React.createElement('section', { 'data-provider-recovery': projectId });
  const TeamSettings = () => React.createElement('section', { 'data-team-settings': true });
  const Frame = ({ children }) => React.createElement('div', { 'data-settings-frame': true }, children);
  const api = () => assert.fail('Rendering Settings must not submit an operation');
  const activeProject = { current: 'project-a' }, pendingKeys = { current: new Map([['retained', 'key']]) };
  const render = (section, isOperator = true) => {
    const context = { React, page: 'Settings', section, project: { id: 'project-a', name: 'Campaign project' }, state: { projectId: 'project-a', user: { id: 'viewer-a', isOperator } }, workspace: { id: 'workspace-a', role: 'admin', name: 'Workspace' }, session: { oidcEnabled: false }, canAdmin: true, sample: false, busy: false, activeProject, pendingKeys, api,
      Field: () => React.createElement('input', { name: 'name' }), Icon: () => null, Link, Grid, Stack, Card, DangerZoneFlow, Inline, Text, Button, FormActions, AccountSettings, OperationRecovery, TeamSettings, title: value => value, settingsFrame: content => React.createElement(Frame, null, content),
      run: () => assert.fail('Rendering must not run an action'), reload: () => assert.fail('Rendering must not reload'), setPage: () => {}, setModal: () => {}, clearSampleData: () => {}, leaveWorkspace: () => {} };
    return new Function(...Object.keys(context), code + '; return render();')(...Object.values(context));
  };
  const count = (tree, type) => nodes(tree).filter(node => node.type === type).length;
  assert.equal(renderToStaticMarkup(render('general')).includes('Project'), true); assert.equal(count(render('general'), OperationRecovery), 0);
  assert.deepEqual([count(render('members'), TeamSettings), count(render('members'), AccountSettings)], [1, 0]);
  assert.match(renderToStaticMarkup(render('members')), /Leave workspace[\s\S]*To return, you need a new invitation\./, 'An admin is offered Leave workspace (#142).');
  assert.deepEqual(nodes(render('profile')).filter(node => node.type === AccountSettings).map(node => node.props.part), ['profile']);
  assert.deepEqual(nodes(render('security')).filter(node => node.type === AccountSettings).map(node => node.props.part), ['security']);
  assert.match(renderToStaticMarkup(render('sign-in')), /Single sign-on is off/); assert.equal(renderToStaticMarkup(render('sign-in', false)).includes('Single sign-on'), false, 'Only operators see sign-in setup.');
  assert.equal(renderToStaticMarkup(render('members')).includes('OIDC'), false, 'Members no longer see instance sign-in configuration.');
  // Walk the raw children: React.Children.toArray would escape the key being checked.
  const raw = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(raw)];
  const recovery = raw(render('activity')).find(node => node.type === OperationRecovery);
  assert.equal(recovery.key, 'receipts:project-a', 'The existing recovery instance key is unchanged.');
  assert.equal(recovery.props.projectId, 'project-a'); assert.equal(recovery.props.role, 'admin'); assert.equal(recovery.props.isOperator, true); assert.equal(recovery.props.request, api);
  recovery.props.onReviewed('applied'); assert.equal(pendingKeys.current.size, 1);
  activeProject.current = 'another-project'; recovery.props.onReviewed('not_applied'); assert.equal(pendingKeys.current.size, 1, 'An old recovery callback cannot clear another project action keys.');
  activeProject.current = 'project-a'; recovery.props.onReviewed('not_applied'); assert.equal(pendingKeys.current.size, 0);
  // The section list lives in SettingsLayout: Advanced is operator-only and Connections opens the integrations page.
  assert.match(appSource, /\{ id: 'sign-in', label: 'Sign-in', group: 'operator', icon: 'server', href: settingsUrl\('sign-in'\), allowed: !!state\.user\.isOperator \}/);
  assert.match(appSource, /groupLabels=\{\{ operator: 'Advanced' \}\}/);
  assert.match(appSource, /\{page === 'Integrations' && project && settingsFrame\(<IntegrationSettings /);
});

test('post card publishing asks once and names every destination before calling the unchanged publish action', () => {
  const appSource = source();
  assert.doesNotMatch(appSource, /onClick=\{\(\) => publish\(p\)\}/, 'A card click never publishes directly.');
  assert.match(appSource, /disabled=\{busy \|\| !connected\} onClick=\{\(\) => setPublishing\(p\)\}>/);
  // A disabled Publish says why in visible text rather than a hover-only title.
  assert.doesNotMatch(appSource, /Connect Zernio in Settings/);
  assert.match(appSource, /\(!approval \|\| approval\.publishable\) && !connected && <Text tone="muted" size="sm">Connect Zernio in Integrations to publish this post\.<\/Text>\}<FormActions>/);
  const dialog = appSource.match(/<ConfirmDialog open=\{!!publishing\}[^\r\n]+?<\/ConfirmDialog>/)?.[0]; assert.ok(dialog);
  assert.match(dialog, /onConfirm=\{async \(\) => \{ const post = publishing; if \(post\) await publish\(post\); setPublishing\(null\); \}\}/);
  assert.match(dialog, /Accounts:<\/Text> \{postRecipients\(publishing, remote\.accounts\?\.accounts \|\| \[\]\)\}/);
  assert.match(appSource, /async function publish\(post: Row\) \{ await run\(async \(\) => \{ await integrate\('social\/publish', \{ postId: post\.id \}\); await reload\(\); \}/);
});

test('every member is offered to leave the workspace, through one confirmed danger action on their own membership', () => {
  const appSource = source();
  assert.ok(appSource.includes("{workspace && <DangerZoneFlow busy={busy} title=\"Leave workspace\""), 'Owners, admins, editors and viewers can all remove their own membership (#142).');
  assert.ok(appSource.includes("description: 'You lose access to every project in this workspace.' + (workspace.role === 'owner' ? ' A workspace keeps at least one owner, so make another member an owner first.' : ' To return, you need a new invitation.'), confirmLabel: 'Leave workspace' }]"), 'Only an owner is told about the last-owner rule.');
  assert.ok(appSource.includes("onConfirm={leaveWorkspace}/>}"));
  const handler = appSource.slice(appSource.indexOf('async function leaveWorkspace('), appSource.indexOf('  if (!session) return'));
  assert.ok(handler.includes("await api(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, 'DELETE'); window.location.reload();"), 'It removes the signed-in member only, then reloads the workspace list.');
  assert.ok(handler.includes('await run('), 'A refusal (for example the last owner) surfaces through the shared error path.');
});

test('a new campaign asks for name, dates and budget first; editing keeps every field and the tracked results', async () => {
  const appSource = source(), expression = appSource.match(/\{modal\.type === 'campaign' && <>.*?<\/>\}/)?.[0]; assert.ok(expression);
  const { code } = await transformWithOxc('const render = () => (<>' + expression + '</>);', 'CampaignForm.tsx', { jsx: { runtime: 'classic' } });
  const ui = await import('@ten98/ui'), app = await import('@ten98/ui/app');
  const Select = ({ label, name, value, options }) => React.createElement(app.AppSelect, { label, name, value, options: options.map(o => typeof o === 'string' ? [o, o] : o) });
  const render = item => renderToStaticMarkup(new Function('React', 'modal', 'channels', 'Field', 'Select', 'FormGrid', 'Disclosure', 'Text', code + '; return render();')(React, { type: 'campaign', item }, { mixed: 'Cross-channel', social: 'Social media' }, app.AppField, Select, ui.FormGrid, ui.Disclosure, ui.Text));
  const fresh = render(undefined), names = html => [...html.matchAll(/name="([^"]+)"/g)].map(match => match[1]);
  const beforeMore = fresh.slice(0, fresh.indexOf('More details'));
  assert.deepEqual(names(beforeMore), ['name', 'startDate', 'endDate', 'budget', 'currency'], 'Five fields before More details.');
  assert.doesNotMatch(fresh, /name="budget"[^>]*required/, 'Budget is optional; the server defaults it to 0.');
  assert.deepEqual(names(fresh).filter(name => ['spent', 'impressions', 'clicks', 'conversions'].includes(name)), [], 'No result fields when creating.');
  assert.doesNotMatch(fresh, /<details[^>]*open/, 'More details starts closed for a new campaign.');
  const editing = render({ id: 'c1', name: 'Launch', channel: 'social', status: 'active', spent: 10 });
  assert.deepEqual(new Set(names(editing)), new Set(['name', 'startDate', 'endDate', 'budget', 'currency', 'channel', 'status', 'description', 'spent', 'impressions', 'clicks', 'conversions']));
  assert.match(editing, /<details[^>]*open/, 'Editing or viewing opens More details, so every saved value is visible.');
});
