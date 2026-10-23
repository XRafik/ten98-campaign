import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

test('HTTP OOH inventory, proposals, booking, delivery and cancellation preserve exact scope and concurrent action receipts', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-ooh-workflows-')), origin = 'http://127.0.0.1:3000';
  const app = await testApp(t, { dataDir, appUrl: origin, env: { BROADSIGN_API_KEY: 'mock-ooh-key', BROADSIGN_ENVIRONMENT: 'sandbox' }, directScheduler: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, originalFetch = globalThis.fetch, providerCalls = []; let cookie, providerStatus = 1, proposal, item, duringItemRead;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://direct-sandbox.broadsign.com'); assert.equal(options.headers.Authorization, 'Broadsign mock-ooh-key');
    const payload = options.body && JSON.parse(options.body); providerCalls.push({ path: url.pathname, method: options.method, payload }); let result;
    if (url.pathname === '/api/v1/user/current_user') result = { id: 1, domain_id: 7 };
    else if (url.pathname.startsWith('/api/v1/screen/')) result = { id: url.pathname.split('/').at(-1), domain_id: '7', name: 'Approved screen', address: 'Dubai', lat: 0, long: 55.27, secret: 'NOT_PUBLIC' };
    else if (url.pathname === '/api/v1/proposal') { proposal = { ...payload, id: 800, domain_id: 7, status: 1, proposal_item_id_list: [] }; result = proposal; }
    else if (url.pathname === '/api/v1/proposal/add_screens') { assert.deepEqual(payload.screens, [101, 102]); assert.equal(payload.multiplier, 366); item = { ...payload, id: 1800, actual_impressions: 0, actual_repetitions: 0 }; proposal.proposal_item_id_list = [item.id]; result = item; }
    else if (url.pathname === '/api/v1/proposal/800/availability') { assert.equal(url.searchParams.get('type'), 'book'); result = { proposal_id: 800, availability: 'available', requested_screen_count: 2, bookable_screen_count: 2 }; }
    else if (url.pathname === '/api/v1/proposal/book_proposal/800') { assert.equal(options.method, 'POST'); providerStatus = 9; result = { success: true }; }
    else if (url.pathname === '/api/v1/proposal/proposal_item/1800/cancel') { assert.equal(options.method, 'POST'); assert.equal(options.body, undefined); return new Response(null, { status: 204 }); }
    else if (url.pathname === '/api/v1/proposal/800') result = { ...proposal, status: providerStatus };
    else if (url.pathname === '/api/v1/proposal/proposal_item/1800') { if (duringItemRead) { const callback = duringItemRead; duringItemRead = undefined; await callback(); } result = { ...item }; }
    else throw new Error('Unexpected OOH endpoint: ' + url.pathname);
    return new Response(JSON.stringify(result));
  };
  async function request(path, method = 'GET', body, key) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'OOH fixture', email: 'ooh@example.test', password: 'a sufficiently long fixture password' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
    const state = (await request('/api/state')).data, project = `/api/projects/${state.projectId}`, path = project + '/ooh';
    const connection = { domainId: 7, clientId: 'brand', clientName: 'Fixture brand', screenIds: [101, 102] };
    assert.equal((await request(path + '/connection', 'POST', connection)).status, 200);
    let result = await request(path + '/sync', 'POST', {}); assert.equal(result.status, 200); assert.deepEqual(result.data.inventory.map(screen => screen.id), [101, 102]);
    assert.equal(result.data.inventory[0].latitude, 0); assert.equal(JSON.stringify(result.data).includes('NOT_PUBLIC'), false);
    assert.equal((await request(path + '/connection', 'POST', connection)).status, 200);
    assert.equal((await request(path + '/inventory')).data.inventory.length, 2, 'Reapproving the same mapping must preserve synced screens.');
    const draft = { name: 'OOH regression', screenIds: [101, 102], startDate: '2026-10-20', endDate: '2027-10-20', slotDuration: 10, price: 150, inventoryType: 'digital' }, beforeInvalid = providerCalls.length;
    assert.equal((await request(path + '/bookings', 'POST', { ...draft, endDate: '2027-10-21' }, 'ooh-long-range')).status, 400);
    assert.equal(providerCalls.length, beforeInvalid, 'A 367-day inclusive booking must fail before provider calls.');
    result = await request(path + '/bookings', 'POST', draft, 'ooh-http-draft'); assert.equal(result.status, 200, JSON.stringify(result.data)); const booking = result.data.booking, bookingPath = `${path}/bookings/${booking.id}`;
    assert.equal((await request(bookingPath + '/availability')).data.availability, 'available');
    result = await request(bookingPath + '/submit', 'POST', {}, 'ooh-no-approval'); assert.equal(result.status, 400);
    result = await request(bookingPath + '/submit', 'POST', { confirmBooking: true }, 'ooh-http-submit'); assert.equal(result.status, 200); assert.equal(result.data.booking.providerStatus, 9);
    assert.equal(result.data.placements.length, 2); assert.ok(result.data.placements.every(placement => placement.status === 'booked' && placement.cost === null));
    const foreign = await request('/api/projects', 'POST', { workspaceId: state.workspaces[0].id, name: 'Another OOH project' });
    assert.equal((await request(`/api/projects/${foreign.data.project.id}/ooh/bookings`)).data.bookings.length, 0);
    assert.equal((await request(`/api/projects/${foreign.data.project.id}/ooh/connection`, 'POST', connection)).status, 409, 'Approved screens cannot be shared by projects.');
    result = await request(bookingPath + '/report'); assert.equal(result.status, 200); assert.equal(result.data.report.actualImpressions, 0); assert.equal(result.data.report.actualPlays, 0);
    item.actual_impressions = -1; item.actual_repetitions = -2;
    result = await request(bookingPath + '/report'); assert.equal(result.data.report.actualImpressions, null); assert.equal(result.data.report.actualPlays, null);
    let cancellation;
    duringItemRead = async () => { cancellation = await request(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-racing-cancel'); assert.equal(cancellation.status, 200); assert.equal(cancellation.data.booking.stage, 'cancellation-requested'); };
    result = await request(bookingPath + '/report'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OOH_BOOKING_CHANGED');
    const current = (await request(path + '/bookings')).data.bookings.find(row => row.id === booking.id);
    assert.equal(current.stage, 'cancellation-requested'); assert.equal(current.cancellationOperationId, cancellation.data.operation.id, 'A stale report must not erase the pending cancellation receipt.');
    const cancelWrites = () => providerCalls.filter(call => call.path.endsWith('/cancel')).length;
    result = await request(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-no-double-cancel'); assert.equal(result.status, 409); assert.equal(cancelWrites(), 1);
    providerStatus = 12; result = await request(bookingPath + '/report'); assert.equal(result.status, 200); assert.equal(result.data.booking.stage, 'cancelled'); assert.ok(result.data.placements.every(placement => placement.status === 'cancelled'));
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});

test('OOH write keys allow a manual retry after definitive rejection and preserve ambiguous or acknowledged requests', async () => {
  const source = await readFile(new URL('../src/OohProviders.tsx', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function write('), source.indexOf('  async function load()')).replace('target: string, body: unknown', 'target, body').replace('error as any', 'error');
  const pendingKeys = { current: new Map() }, refreshNeeded = { current: false }, calls = []; let nextKey = 0, error, reloadError, refreshRequired = false, notice = '';
  const load = async () => { if (reloadError) throw reloadError; }, setRefreshRequired = value => { refreshRequired = value; };
  const write = new Function('pendingKeys', 'refreshNeeded', 'setRefreshRequired', 'crypto', 'request', 'load', 'onChanged', 'active', `return (${code});`)(pendingKeys, refreshNeeded, setRefreshRequired, { randomUUID: () => `operation-key-${++nextKey}` }, async (target, method, body, key) => { calls.push(key); if (error) throw error; return { acknowledged: true }; }, load, undefined, { current: true });
  const target = '/projects/a/ooh/bookings', body = { name: 'Draft' }, signature = JSON.stringify([target, body]);
  error = Object.assign(new Error('Rejected'), { operation: { status: 'failed' } }); await assert.rejects(write(target, body), /Rejected/); assert.equal(pendingKeys.current.has(signature), false);
  error = Object.assign(new Error('Uncertain'), { operation: { status: 'uncertain' } }); await assert.rejects(write(target, body), /Uncertain/); assert.equal(pendingKeys.current.get(signature), 'operation-key-2');
  await assert.rejects(write(target, body), /Uncertain/); assert.deepEqual(calls, ['operation-key-1', 'operation-key-2', 'operation-key-2']);
  error = undefined; reloadError = new Error('Reload failed'); assert.deepEqual(await write(target, body), { acknowledged: true }, 'A confirmed write remains successful if the follow-up read fails.'); assert.equal(pendingKeys.current.get(signature), 'operation-key-2'); assert.equal(refreshRequired, true); assert.equal(refreshNeeded.current, true);
  const writesBeforeRefresh = calls.length;
  await assert.rejects(write(target, { name: 'Changed draft' }), /Refresh provider details/); assert.equal(calls.length, writesBeforeRefresh, 'A changed proposal cannot bypass the stale-details lock with a fresh request key.');
  assert.match(source, /<Stack as="fieldset" disabled=\{refreshRequired\}>/); assert.match(source, /Broadsign saved the action/);
  const refreshCode = source.slice(source.indexOf('async function refresh()'), source.indexOf('  useEffect('));
  const refresh = new Function('action', 'load', 'onChanged', 'pendingKeys', 'refreshNeeded', 'setRefreshRequired', 'setNotice', `return (${refreshCode});`)(run => run(), load, undefined, pendingKeys, refreshNeeded, setRefreshRequired, value => { notice = value; });
  await assert.rejects(refresh(), /Reload failed/); assert.equal(refreshRequired, true); assert.equal(pendingKeys.current.get(signature), 'operation-key-2');
  reloadError = undefined; await refresh(); assert.equal(refreshRequired, false); assert.equal(refreshNeeded.current, false); assert.equal(pendingKeys.current.size, 0); assert.equal(notice, 'Provider details refreshed.'); assert.equal(calls.length, writesBeforeRefresh, 'Refreshing never replays a provider write.');
  assert.deepEqual(await write(target, { name: 'New reviewed proposal' }), { acknowledged: true }); assert.equal(calls.at(-1), 'operation-key-3');
});
