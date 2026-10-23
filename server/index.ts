import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { oidcEndpoint, workspaceRoles as roles, mayManageWorkspaceMember } from '@ten98/runtime';
import { assertSchema, closeDatabase, createStore, collections, getDatabase, type Connection, type Executor, type Store } from './database.ts';
import { createAuth, sessionSecret, hashPassword, HttpError, lockWorkspace, memberRole, publicUser, type AuthConfig, type PublicUser } from './auth.ts';
import { setInstanceOperator } from './instance-operators.ts';
import { seedSample } from './seed.ts';
import { handleIntegration } from './integrations.ts';
import { IntegrationError, mediaUrl, type ProviderRecord, type OperationContext } from './provider-core.ts';
import { createIntegrationSettings } from './integration-settings.ts';
import { handleInvitations, revokeMemberInvitations } from './invitations.ts';
import { handleOperationRecovery } from './operation-recovery.ts';
import { handleApprovals, assertPublishingApproval, assertProviderPostEdit } from './approvals.ts';
import { createWebhookService, WEBHOOK_MAX_BYTES } from './webhooks.ts';
import { handleCalendar } from './calendar.ts';
import { handleAgent } from './agent.ts';
import { handleOoh } from './ooh.ts';
import { handleNativeGoogleAds } from './native-google-ads.ts';
import { handleMicrosoftAds } from './native-microsoft-ads.ts';
import { createDirectCampaigns } from './direct-campaigns.ts';
import { handleInbox } from './inbox.ts';
import { createSmsInbox } from './sms-inbox.ts';
import { createLinks } from './links.ts';
import { normalizePostVariants, normalizeAccountVariants, normalizeMediaItems, normalizePostTags } from '../shared/social-posts.ts';
import { validateQueueIntent } from './zernio-queues.ts';
import { MEDIA_UPLOAD_TIMEOUT, MEDIA_DELIVERY_FIELDS, closeMediaUploads } from './zernio-media.ts';

type Env = Record<string, string | undefined>;
type Send = (status: number, data: unknown) => void;
type ProjectRow = { id: string; workspaceId: string; name: string; color: string; zernioProfileId: string | null; driveFolderId: string | null };
type ProjectAccessRow = ProjectRow & { role: string };
type ProjectInput = { name: string; color: string; zernioProfileId: string; driveFolderId: string };
export interface AppOptions { env?: Env; dataDir?: string; appUrl?: string; sessionSecret?: string; distDir?: string; directScheduler?: boolean; database?: Connection }
type AppConfig = AppOptions & AuthConfig & { env: Env; dataDir: string; oidcClientSecret: string };
type RequestContext = OperationContext & { req: IncomingMessage; res: ServerResponse; body: ProviderRecord; user: PublicUser; project: ProjectAccessRow; role: string; send: Send; store: Store };

// PostgreSQL folds unquoted aliases to lowercase, so camelCase aliases are quoted.
const projectFields = sql.raw('p.id,p.workspace_id AS "workspaceId",p.name,p.color,p.zernio_profile_id AS "zernioProfileId",p.drive_folder_id AS "driveFolderId"');
const first = async <T>(query: Promise<{ rows: unknown[] }>): Promise<T | undefined> => (await query).rows[0] as T | undefined;
const claimed = async (db: Executor) => Boolean((await first<{ claimed: boolean }>(db.execute(sql`SELECT claimed FROM installation WHERE id = 1`)))?.claimed);
const bad: (message?: string) => never = message => { throw new HttpError(400, message || 'Check the submitted fields.'); };
function object(value: unknown): ProviderRecord { if (!value || typeof value !== 'object' || Array.isArray(value)) bad('A JSON object is required.'); return value as ProviderRecord; }
function text(value: unknown, label: string, max = 120, optional = false): string {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) bad(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
// Omitted or blank names fall back to the shared default, as in Discover's first-user setup.
function workspaceName(value: unknown): string { return value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? 'My workspace' : text(value, 'Workspace name'); }
function email(value: unknown): string { const result = text(value, 'Email', 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) bad('Enter a valid email address.'); return result; }
function password(value: unknown): string { if (typeof value !== 'string' || value.length < 12 || value.length > 128) bad('Use a password between 12 and 128 characters.'); return value; }
function loginPassword(value: unknown): string { if (typeof value !== 'string' || !value.length || value.length > 128) bad('Enter your password.'); return value; }
function choice(value: any, options: readonly string[], label: string): string { if (!options.includes(value)) bad(`${label} is invalid.`); return value; }
function money(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) bad(`${label} must be a nonnegative number.`); return value; }
function date(value: unknown, label: string): void {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) bad(`${label} must be a valid ISO date.`);
}
function strings(value: unknown, label: string, limit = 30): string[] { if (!Array.isArray(value) || value.length > limit) bad(`${label} must be a list of at most ${limit} items.`); return value.map(item => text(item, label, 120)); }
function safeUrl(value: string): string { let url: URL; try { url = new URL(value); } catch { bad('Use an HTTPS asset URL.'); } if (url.protocol !== 'https:' || url.username || url.password || value.length > 4096) bad('Use an HTTPS asset URL without credentials.'); return url.href; }
function validateRecord(collection: string, raw: unknown): ProviderRecord {
  const data = { ...object(raw) };
  for (const key of ['id', 'projectId', 'createdAt', 'updatedAt', 'sample']) delete data[key];
  for (const [key, value] of Object.entries(data)) if (typeof value === 'string' && value.length > (collection === 'posts' && key === 'content' ? 100000 : 16000)) bad(`${key} is too long.`);
  if (collection === 'campaigns') {
    data.name = text(data.name, 'Campaign name'); data.channel = choice(data.channel ?? 'mixed', ['social', 'paid', 'ooh', 'mixed'], 'Channel');
    data.status = choice(data.status ?? 'draft', ['draft', 'active', 'paused', 'completed'], 'Status'); data.budget = money(data.budget ?? 0, 'Budget'); data.spent = money(data.spent ?? 0, 'Spend');
  } else if (collection === 'posts') {
    data.content ??= '';
    if (typeof data.content !== 'string' || data.content.length > 100000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(data.content)) bad('Post content must be text of at most 100,000 characters.');
    data.platforms = strings(data.platforms ?? [], 'Platforms', 20);
    data.status = choice(data.status ?? 'draft', ['draft', 'scheduled', 'published', 'failed', 'cancelled'], 'Status');
    if (data.scheduledFor && !data.scheduledAt) data.scheduledAt = data.scheduledFor;
    date(data.scheduledAt, 'Scheduled time');
    if (data.status === 'scheduled' && (!data.scheduledAt || Date.parse(data.scheduledAt) <= Date.now())) bad('Scheduled posts need a future scheduled time.');
    if (data.accounts !== undefined) data.accounts = strings(data.accounts, 'Accounts', 50);
    validateQueueIntent(data);
    try {
      if (data.tags !== undefined) data.tags = normalizePostTags(data.tags);
      if (data.mediaItems !== undefined && data.mediaItems !== null) data.mediaItems = normalizeMediaItems(data.mediaItems);
      if (data.platformOverrides !== undefined) data.platformOverrides = normalizePostVariants(data);
      if (data.accountOverrides !== undefined) {
        data.accountOverrides = normalizeAccountVariants(data);
        for (const [id, variant] of Object.entries(data.accountOverrides)) if (!data.accounts?.includes(id) || !data.platforms.includes((variant as ProviderRecord).platform)) bad('Each account customization must belong to a selected account and platform.');
      }
    } catch (error: any) { bad(error.message); }
  } else if (collection === 'placements') {
    data.name = text(data.name, 'Placement name'); data.type = choice(data.type ?? 'billboard', ['billboard', 'digital', 'transit', 'street'], 'Placement type');
    data.location = text(data.location, 'Location', 500); data.cost = money(data.cost ?? 0, 'Cost'); data.status = choice(data.status ?? 'draft', ['draft', 'requested', 'booked', 'live', 'completed', 'cancelled'], 'Status');
    if (data.latitude !== undefined || data.longitude !== undefined) { const { latitude, longitude } = data; if (!(latitude === null && longitude === null) && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) bad('Enter both latitude (-90 to 90) and longitude (-180 to 180).'); }
    if (data.proofUrl) data.proofUrl = safeUrl(text(data.proofUrl, 'Proof URL', 4096));
  } else if (collection === 'assets') {
    data.name = text(data.name, 'Asset name', 250); data.kind = choice(data.kind ?? 'image', ['image', 'video', 'document'], 'Asset kind'); data.url = safeUrl(text(data.url, 'Asset URL', 4096)); data.approval = choice(data.approval ?? 'pending', ['pending', 'approved', 'rejected'], 'Approval');
    if (data.deliveryUrl !== undefined) data.deliveryUrl = data.deliveryUrl === '' ? '' : mediaUrl(text(data.deliveryUrl, 'Public delivery URL', 4096));
    if (data.tags !== undefined) data.tags = strings(data.tags, 'Tags');
  } else if (collection === 'providers') {
    data.name = text(data.name, 'Provider name'); data.type = choice(data.type ?? 'ooh', ['ooh', 'media'], 'Provider type'); data.contact = data.contact ? email(data.contact) : '';

  }
  for (const key of ['startDate', 'endDate', 'startAt', 'endAt']) date(data[key], key);
  for (const [start, end] of [['startDate', 'endDate'], ['startAt', 'endAt']]) if (data[start] && data[end] && Date.parse(data[start]) > Date.parse(data[end])) bad('The end date must be after the start date.');
  for (const key of ['campaignId', 'providerId', 'assetId']) if (data[key] !== undefined && data[key] !== '') data[key] = text(data[key], key, 100);
  if (data.currency !== undefined) data.currency = choice(data.currency, ['AED', 'USD', 'EUR', 'GBP'], 'Currency');
  for (const key of ['impressions', 'clicks', 'conversions', 'inventory']) if (data[key] !== undefined) { money(data[key], key); if (!Number.isSafeInteger(data[key])) bad(`${key} must be a whole number.`); }
  return data;
}
async function readRawBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > maximum) { req.resume(); throw new HttpError(413, 'Request is too large.'); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > maximum) { req.resume(); throw new HttpError(413, 'Request is too large.'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readBody(req: IncomingMessage, maximum = 65536): Promise<ProviderRecord> {
  if (req.headers['content-length'] === '0' || (!req.headers['content-length'] && !req.headers['transfer-encoding'])) return {};
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON content.');
  const raw = await readRawBody(req, maximum);
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); } catch (error) { if (error instanceof HttpError) throw error; bad('Send valid UTF-8 JSON.'); }
}

export async function createApp(options: AppOptions = {}) {
  const env = options.env || { ...process.env }, dataDir = resolve(options.dataDir || env.DATA_DIR || 'data');
  const appUrl = (options.appUrl || env.APP_URL || 'http://127.0.0.1:3018').replace(/\/$/, '');
  const parsed = new URL(appUrl);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== appUrl || parsed.username || parsed.password || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('APP_URL must be an HTTPS origin, or HTTP loopback for local use.');
  if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID) oidcEndpoint(env.OIDC_ISSUER, { issuer: true });
  // DIRECT_SCHEDULER=off starts the app without sending due direct campaigns (for example to verify an upgrade before
  // switching traffic). Unset or empty (as a copied `DIRECT_SCHEDULER=` line gives) means on; any other value than on/off
  // refuses to start, so a typo cannot leave sending enabled.
  const directScheduler = env.DIRECT_SCHEDULER || 'on';
  if (!['on', 'off'].includes(directScheduler)) throw new Error('DIRECT_SCHEDULER must be on or off.');
  // Install-wide: Broadsign bookings are approved in this currency (Integrations validates the same rule when saved).
  if (env.BROADSIGN_CURRENCY && !/^[A-Z]{3}$/.test(env.BROADSIGN_CURRENCY)) throw new Error('BROADSIGN_CURRENCY must be a three-letter ISO currency code, such as USD.');
  const { pool, db } = options.database || getDatabase(env.DATABASE_URL), store = createStore(db);
  await assertSchema(pool);
  const config: AppConfig = { ...options, env, dataDir, appUrl, sessionSecret: sessionSecret(dataDir, options.sessionSecret || env.SESSION_SECRET), oidcIssuer: env.OIDC_ISSUER || '', oidcClientId: env.OIDC_CLIENT_ID || '', oidcClientSecret: env.OIDC_CLIENT_SECRET || '', oidcAllowedEmails: (env.OIDC_ALLOWED_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean), trustedProxies: env.TRUSTED_PROXIES || '' };
  config.oidcEnabled = Boolean(config.oidcIssuer && config.oidcClientId);
  const auth = createAuth(db, config), dist = resolve(options.distDir || 'dist');
  const integrationSettings = await createIntegrationSettings({ db, env, secret: config.sessionSecret });
  const direct = createDirectCampaigns({ db, env, appUrl, secret: config.sessionSecret, store });
  const smsInbox = createSmsInbox({ db, env, appUrl, contacts: direct.contacts });
  await direct.attachSmsInbox(smsInbox);
  const links = createLinks({ db, appUrl });
  const directTimer = options.directScheduler === false || directScheduler === 'off' ? undefined : setInterval(() => { direct.processPending().catch(() => console.error('Direct campaign processing deferred.')); }, 1000); directTimer?.unref();
  const webhooks = createWebhookService({ db, contacts: direct.contacts, env });
  // One drain at a time; close() waits for the one in flight before the pool ends.
  let draining: Promise<void> | undefined;
  const drainWebhooks = () => { draining ??= webhooks.processPending().then(() => undefined, () => { console.error('Webhook processing deferred.'); }).finally(() => { draining = undefined; }); };
  drainWebhooks(); const webhookTimer = setInterval(drainWebhooks, 1000); webhookTimer.unref();
  async function workspaceAccess(workspaceId: string, userId: string, write = false, executor: Executor = db): Promise<string> {
    const role = await memberRole(executor, workspaceId, userId);
    if (!role || (write && role === 'viewer')) throw new HttpError(404, 'Workspace not found or unavailable.');
    return role;
  }
  async function projectAccess(projectId: string, userId: string): Promise<ProjectAccessRow> {
    const project = await first<ProjectAccessRow>(db.execute(sql`SELECT ${projectFields},m.role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=${projectId} AND m.user_id=${userId}`));
    if (!project) throw new HttpError(404, 'Project not found or unavailable.');
    return project;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', env.GOOGLE_MAPS_BROWSER_API_KEY ? 'strict-origin-when-cross-origin' : 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    const nonce = randomBytes(18).toString('base64');
    const mapsPolicy = env.GOOGLE_MAPS_BROWSER_API_KEY ? " 'unsafe-eval'" : '';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic' 'self'${mapsPolicy}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com; font-src 'self' https://fonts.gstatic.com; frame-src https://*.google.com; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (parsed.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send: Send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    let bodyTimer: NodeJS.Timeout | undefined, rawMediaContent = false;
    try {
      const url = new URL(req.url!, appUrl), path = url.pathname, mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method!);
      rawMediaContent = req.method === 'PUT' && /^\/api\/projects\/[^/]+\/integrations\/media\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i.test(path);
      if (req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) { bodyTimer = setTimeout(() => req.destroy(), rawMediaContent ? MEDIA_UPLOAD_TIMEOUT : 30000); bodyTimer.unref(); req.once('end', () => clearTimeout(bodyTimer)); req.once('close', () => clearTimeout(bodyTimer)); }
      if (await links.publicHandle({ req, res, url })) return;
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        if (path === '/api/webhooks/zernio' && req.method === 'POST') { const result = await webhooks.receive(await readRawBody(req, WEBHOOK_MAX_BYTES), req.headers); return send(result.status, result.body); }
        if (/^\/api\/webhooks\/twilio\/(?:inbound(?:\/[\w-]+)?|status\/[\w-]+)$/.test(path) && req.method === 'POST') { await direct.receiveTwilio({ rawBody: await readRawBody(req, 65536), headers: req.headers, url }); res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }); return res.end('<Response/>'); }
        // Amazon SES feedback via SNS: a raw text/plain JSON body of at most 256 KB, verified before it is read further.
        if (path === '/api/webhooks/ses/sns' && req.method === 'POST') return send(await direct.receiveSes(await readRawBody(req, 262144 + 4096)), {});
        const unsubscribe = path.match(/^\/api\/direct\/unsubscribe\/([A-Za-z0-9_.-]+)$/);
        if (unsubscribe && ['GET', 'POST'].includes(req.method!)) { if (req.method === 'POST') await readRawBody(req, 4096); const html = await direct.handleUnsubscribe(unsubscribe[1], req.method!); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Email preferences</title><main>' + html + '</main></html>'); }
        // Readiness includes PostgreSQL, so the Compose healthcheck and deploy verification fail while the database is down.
        if (path === '/api/health' && req.method === 'GET') return (await db.execute(sql`SELECT 1`).then(() => true, () => false)) ? send(200, { ok: true }) : send(503, { ok: false, error: 'The database is unavailable.' });
        if (mutating && req.headers.origin !== appUrl) throw new HttpError(403, 'A matching Origin header is required.');
        const body = mutating && req.method !== 'DELETE' && !rawMediaContent ? await readBody(req, /^\/api\/projects\/[^/]+\/integrations\/drive\/upload$/.test(path) ? 7 * 1024 * 1024 : /^\/api\/projects\/[^/]+\/(?:posts(?:\/[^/]+)?|integrations\/social\/(?:validate|update)|direct\/(?:contacts\/import|campaigns(?:\/[^/]+)?))$/.test(path) ? 2 * 1024 * 1024 : 65536) : {};
        if (path === '/api/session' && req.method === 'GET') {
          // A session cookie that matches no session (expired, revoked, or from before the PostgreSQL upgrade, which
          // carries no sessions over) is reported once and cleared, so the sign-in screen can say why.
          const current = await auth.user(req, res), sessionEnded = !current && Boolean(auth.sessionKey(req));
          if (sessionEnded) await auth.logout(req, res);
          return send(200, { user: publicUser(current), setupRequired: !await claimed(db), oidcEnabled: config.oidcEnabled, ...(sessionEnded ? { sessionEnded: true } : {}) });
        }
        if (path === '/api/auth/setup' && req.method === 'POST') {
          await auth.limit('setup:' + auth.clientAddress(req), 10);
          if (await claimed(db)) throw new HttpError(409, 'Setup is already complete. Sign in to continue.');
          // The first sign-up claims the installation as its owner (as in Discover); afterwards accounts join only by invitation.
          // Any legacy setup token in the body is ignored. The first project, and its optional sample, is the next step.
          const name = text(body.name, 'Name'), mail = email(body.email), hash = await hashPassword(password(body.password)), workspace = workspaceName(body.workspaceName);
          const id = randomUUID(), workspaceId = randomUUID();
          // The installation row lock makes setup single use under parallel requests.
          await db.transaction(async tx => {
            if ((await first<{ claimed: boolean }>(tx.execute(sql`SELECT claimed FROM installation WHERE id = 1 FOR UPDATE`)))?.claimed) throw new HttpError(409, 'Setup is already complete.');
            await tx.execute(sql`INSERT INTO users VALUES (${id}, ${name}, ${mail}, ${hash})`);
            await setInstanceOperator(tx, id, true, 'bootstrap');
            await tx.execute(sql`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, ${workspace})`); await tx.execute(sql`INSERT INTO memberships VALUES (${workspaceId}, ${id}, 'owner')`);
            await tx.execute(sql`UPDATE installation SET claimed = true WHERE id = 1`);
            await auth.establish(res, id, req, tx);
          });
          return send(201, { user: { id, name, email: mail, isOperator: true }, workspaceId });
        }
        if (path === '/api/auth/login' && req.method === 'POST') return send(200, { user: await auth.login(req, res, { email: email(body.email), password: loginPassword(body.password) }) });
        if (path === '/api/auth/logout' && req.method === 'POST') { await auth.logout(req, res); return send(200, { ok: true }); }
        if (path === '/api/auth/oidc/start' && req.method === 'GET') return await auth.oidcStart(req, res);
        if (path === '/api/auth/oidc/start' && req.method === 'POST') {
          if (Object.keys(body).some(key => key !== 'token') || (body.token !== undefined && typeof body.token !== 'string')) bad('Use a valid invitation link before signing in.');
          return send(200, { authorizationUrl: await auth.oidcAuthorize(req, res, body.token ?? null) });
        }
        if (path === '/api/auth/oidc/callback' && req.method === 'GET') return await auth.oidcCallback(req, res, url);
        const signedIn = await auth.user(req, res);
        if (await handleInvitations({ req, url, body, user: signedIn, db, auth, config, send, workspaceAccess, establish: (id: string, tx: Executor) => auth.establish(res, id, req, tx) })) return;
        const user = signedIn; if (!user) throw new HttpError(401, 'Sign in to continue.');
        if (path === '/api/account' && req.method === 'GET') return send(200, { user, ...await auth.account(user.id) });
        if (path === '/api/account' && req.method === 'PATCH') { if (Object.keys(body).some(key => key !== 'name')) bad('Only your display name can be changed here.'); await db.execute(sql`UPDATE users SET name = ${text(body.name, 'Name')} WHERE id = ${user.id}`); return send(200, { user: await auth.user(req, res) }); }
        if (path === '/api/account/password' && req.method === 'POST') { if (Object.keys(body).some(key => !['currentPassword', 'newPassword'].includes(key))) bad('Use the password fields.'); await auth.changePassword(req, res, user.id, loginPassword(body.currentPassword), password(body.newPassword)); return send(200, { changed: true }); }
        if (path === '/api/account/sessions/revoke' && req.method === 'POST') return send(200, { revoked: await auth.revokeOtherSessions(req, user.id) });
        const settingsRoute = path.match(/^\/api\/settings\/integrations(?:\/([A-Za-z]+)(?:\/(test))?)?$/);
        if (settingsRoute) {
          if (!user.isOperator) throw new HttpError(403, 'Only instance operators can configure shared integrations.');
          const [, provider, action] = settingsRoute;
          if (!provider && req.method === 'GET') return send(200, await integrationSettings.describe());
          if (provider && !action && req.method === 'PUT') { if (Object.keys(body).some(key => key !== 'fields')) bad('Use the integration settings fields.'); return send(200, await integrationSettings.save(provider, body.fields)); }
          if (provider && !action && req.method === 'DELETE') return send(200, await integrationSettings.reset(provider));
          if (provider && action === 'test' && req.method === 'POST') {
            if (Object.keys(body).some(key => key !== 'projectId')) bad('Choose a project to test its mapped connection.');
            await auth.limit('integration-tests:' + user.id, 60);
            const mapped = body.projectId ? await projectAccess(text(body.projectId, 'Project', 100), user.id) : null;
            const calendarOf = (projectId: string) => first<{ calendar_id: string | null }>(db.execute(sql`SELECT calendar_id FROM calendar_connections WHERE project_id = ${projectId}`));
            const calendar = mapped ? await calendarOf(mapped.id) : null;
            const result = await integrationSettings.test(provider, { driveFolderId: mapped?.driveFolderId, calendarId: calendar?.calendar_id });
            const currentUser = await auth.user(req);
            if (currentUser?.id !== user.id) throw new HttpError(403, 'Your sign-in session ended. Sign in again.');
            if (!currentUser.isOperator) throw new HttpError(403, 'Your instance operator access changed. Refresh before continuing.');
            if (mapped) {
              const current = await projectAccess(mapped.id, user.id);
              const currentCalendar = await calendarOf(mapped.id);
              if ((provider === 'googleDrive' && current.driveFolderId !== mapped.driveFolderId) || (provider === 'googleCalendar' && currentCalendar?.calendar_id !== calendar?.calendar_id)) throw new HttpError(409, 'The project connection changed during this test. Test the current mapping again.');
            }
            return send(200, result);
          }
          throw new HttpError(405, 'This integration settings action is not available.');
        }
        if (path === '/api/state' && req.method === 'GET') {
          const { rows: workspaces } = await db.execute(sql`SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=${user.id} ORDER BY w.seq`);
          const projects = (await db.execute(sql`SELECT ${projectFields} FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=${user.id} ORDER BY p.seq`)).rows as ProjectRow[];
          const projectId = url.searchParams.get('projectId') || projects[0]?.id || null;
          if (projectId) await projectAccess(projectId, user.id);
          const data = Object.fromEntries(await Promise.all(collections.map(async collection => [collection, projectId ? await store.list(projectId, collection) : []])));
          const activity = projectId ? (await db.execute(sql`SELECT id,project_id AS "projectId",message,created_at AS "createdAt",sample FROM activity WHERE project_id=${projectId} ORDER BY seq DESC LIMIT 50`)).rows : [];
          return send(200, { user, workspaces, projects, projectId, ...data, activity, connections: { zernio: Boolean(env.ZERNIO_API_KEY), drive: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) } });
        }
        if (path === '/api/workspaces' && req.method === 'POST') {
          const workspace = { id: randomUUID(), name: text(body.name, 'Workspace name'), role: 'owner' };
          const projectId = randomUUID();
          await db.transaction(async tx => { await tx.execute(sql`INSERT INTO workspaces (id, name) VALUES (${workspace.id}, ${workspace.name})`); await tx.execute(sql`INSERT INTO memberships VALUES (${workspace.id}, ${user.id}, 'owner')`); await tx.execute(sql`INSERT INTO projects (id, workspace_id, name) VALUES (${projectId}, ${workspace.id}, 'My project')`); await createStore(tx).activity(projectId, 'Workspace created.'); });
          return send(201, { workspace, projectId });
        }
        const memberRoute = path.match(/^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/);
        if (memberRoute && ['GET', 'PATCH', 'DELETE'].includes(req.method!)) {
          const role = await workspaceAccess(memberRoute[1], user.id);
          if (!['owner', 'admin'].includes(role)) throw new HttpError(403, 'Only workspace administrators can manage team members.');
          if (req.method === 'GET' && !memberRoute[2]) return send(200, { members: (await db.execute(sql`SELECT u.id,u.id AS "userId",u.name,u.email,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=${memberRoute[1]} ORDER BY u.name COLLATE "C", u.id`)).rows });
          if (!memberRoute[2] || req.method === 'GET') throw new HttpError(404, 'Team route not found.');
          const requested = req.method === 'DELETE' ? null : choice(body.role, roles, 'Role');
          // The workspace row lock serialises team changes, so parallel demotions cannot remove the last owner;
          // the actor's role is re-read under it because the one read above may be stale.
          await db.transaction(async tx => {
            const current = await lockWorkspace(tx, memberRoute[1]) ? await memberRole(tx, memberRoute[1], user.id) : undefined;
            if (!current) throw new HttpError(404, 'Workspace not found or unavailable.');
            if (!['owner', 'admin'].includes(current)) throw new HttpError(403, 'Only workspace administrators can manage team members.');
            const target = { id: memberRoute[2] }, previous = await memberRole(tx, memberRoute[1], target.id);
            if (!previous) throw new HttpError(404, 'Workspace member not found.');
            // The shared rule checks both the saved and the requested role; removal passes no next role.
            if (!mayManageWorkspaceMember(current, previous, requested ?? undefined)) throw new HttpError(403, 'Only an owner can manage administrators and owners.');
            if (previous === 'owner' && requested !== 'owner' && (await first<{ count: number }>(tx.execute(sql`SELECT count(*) AS count FROM memberships WHERE workspace_id=${memberRoute[1]} AND role='owner'`)))!.count <= 1) throw new HttpError(409, 'A workspace must keep at least one owner.');
            if (req.method === 'DELETE') await tx.execute(sql`DELETE FROM memberships WHERE workspace_id=${memberRoute[1]} AND user_id=${target.id}`);
            else await tx.execute(sql`UPDATE memberships SET role=${requested} WHERE workspace_id=${memberRoute[1]} AND user_id=${target.id}`);
            await revokeMemberInvitations(tx, memberRoute[1], target.id, requested);
            const activityStore = createStore(tx);
            for (const project of (await tx.execute(sql`SELECT id FROM projects WHERE workspace_id=${memberRoute[1]}`)).rows as { id: string }[]) await activityStore.activity(project.id, 'Workspace team membership updated.');
          });
          return send(200, { ok: true });
        }
        if (path === '/api/projects' && req.method === 'POST') {
          const workspaceId = text(body.workspaceId, 'Workspace', 100), role = await workspaceAccess(workspaceId, user.id, true);
          if ((Object.hasOwn(body, 'zernioProfileId') || Object.hasOwn(body, 'driveFolderId')) && (!user.isOperator || !['owner', 'admin'].includes(role))) throw new HttpError(403, 'Only an instance operator with workspace administration access can map provider connections.');
          if (body.sample !== undefined && typeof body.sample !== 'boolean') bad('Sample must be true or false.');
          if (body.sample && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'Only a workspace owner or administrator can add sample data.');
          const project = projectInput(body) as ProjectInput & { id: string; workspaceId: string }; await checkProfileMapping(db, project.zernioProfileId); project.id = randomUUID(); project.workspaceId = workspaceId;
          // The sample is seeded only into the project this request creates, in the same transaction.
          await profileWrite(db.transaction(async tx => {
            await tx.execute(sql`INSERT INTO projects (id, workspace_id, name, color, zernio_profile_id, drive_folder_id) VALUES (${project.id}, ${workspaceId}, ${project.name}, ${project.color}, ${project.zernioProfileId}, ${project.driveFolderId})`);
            const projectStore = createStore(tx); await projectStore.activity(project.id, 'Project created.');
            if (body.sample) await seedSample(projectStore, project.id);
          }));
          return send(201, { project });
        }
        const projectRoute = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
        if (projectRoute) {
          const project = await projectAccess(projectRoute[1], user.id), role = project.role;
          if (/^(?:inbox|engagement|conversations)(?:\/|$)/.test(projectRoute[2] || '')) throw new HttpError(404, 'API route not found.');
          if (mutating && role === 'viewer') throw new HttpError(403, 'Your workspace role is view only.');
          if (projectRoute[2] === 'sample-data' && req.method === 'DELETE') {
            if (!['owner', 'admin'].includes(role)) throw new HttpError(403, 'Only a workspace owner or administrator can remove sample data.');
            const samples = (await Promise.all(collections.map(async collection => (await store.list(project.id, collection)).filter(record => record.sample).map(record => ({ collection, record }))))).flat();
            for (const { collection, record } of samples) await checkDependants(store, project.id, collection, record.id, true);
            const activityRemoved = await db.transaction(async tx => { const scoped = createStore(tx); for (const { collection, record } of samples) await scoped.remove(project.id, collection, record.id); const removed = (await tx.execute(sql`DELETE FROM activity WHERE project_id=${project.id} AND sample`)).rowCount; await scoped.activity(project.id, 'Sample data removed.'); return removed; });
            return send(200, { removed: samples.length, activityRemoved });
          }
          // Members a project item can be assigned to (editors and above), for editors and above: no email addresses, unlike the
          // administrator-only team route.
          if (projectRoute[2] === 'assignees' && req.method === 'GET') {
            if (!['owner', 'admin', 'editor'].includes(role)) throw new HttpError(403, 'Editing permission is required to assign work.');
            return send(200, { members: (await db.execute(sql`SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=${project.workspaceId} AND m.role IN ('owner','admin','editor') ORDER BY u.name COLLATE "C", u.id`)).rows });
          }
          if (projectRoute[2] === 'maps/config' && req.method === 'GET') return send(200, { configured: Boolean(env.GOOGLE_MAPS_BROWSER_API_KEY), browserKey: env.GOOGLE_MAPS_BROWSER_API_KEY || '', mapId: env.GOOGLE_MAPS_MAP_ID || '' });
          const requestRevision = integrationSettings.revision;
          // One round trip per guard: the session, the actor's current role and the project's provider mappings.
          // Inside a transaction, pass its executor: a second pool connection can starve the pool and reads outside the lock.
          // Errors keep their precedence: session ended, then project unavailable, then role changed, then credentials.
          type CurrentAccess = { session: boolean; role: string | null; zernio_profile_id: string | null; drive_folder_id: string | null; project: string | null };
          const readAccess = async (executor: Executor): Promise<CurrentAccess> => {
            const current = (await first<CurrentAccess>(executor.execute(sql`SELECT EXISTS (SELECT 1 FROM sessions WHERE token = ${auth.sessionKey(req)} AND expires_at > ${Date.now()} AND user_id = ${user.id}) AS session,
              (SELECT m.role FROM memberships m WHERE m.workspace_id = p.workspace_id AND m.user_id = ${user.id}) AS role, p.id AS project, p.zernio_profile_id, p.drive_folder_id
              FROM (SELECT 1) one LEFT JOIN projects p ON p.id = ${project.id}`)))!;
            if (!current.session) throw new HttpError(403, 'Your sign-in session ended. Sign in again.');
            if (!current.project || !current.role) throw new HttpError(404, 'Project not found or unavailable.');
            if (current.role !== role) throw new HttpError(403, 'Your workspace role changed. Refresh this project before continuing.');
            return current;
          };
          // Guards often run back to back (a mapping check calls this, then the handler calls it again) with no I/O between
          // them. They share one read until the event loop's next check phase after it settles: anything awaited on I/O (a
          // provider call, another query) resumes after that phase and reads again, so each check after I/O sees current access.
          let sharedAccess: Promise<CurrentAccess> | undefined;
          const assertIntegrationSettings = async (executor: Executor = db): Promise<CurrentAccess> => {
            // The clear is scheduled once the read settles, so the calls that run straight after it still share it.
            const access = await (executor !== db ? readAccess(executor) : sharedAccess ??= readAccess(db).finally(() => setImmediate(() => { sharedAccess = undefined; })));
            if (integrationSettings.revision !== requestRevision) throw new HttpError(409, 'Integration credentials changed. Refresh this project before continuing.');
            return access;
          };
          const context: RequestContext = { req, res, url, body, user, project, role, db, send, store, config: { ...config, env: { ...env }, assertIntegrationSettings }, assertIntegrationSettings, assertProjectMapping: async (expected: string | null, executor: Executor = db) => { const current = await assertIntegrationSettings(executor); if (current.zernio_profile_id !== expected) throw new HttpError(409, 'The provider mapping changed. Refresh this project.'); }, assertDriveMapping: async (expected: string | null, executor: Executor = db) => { const current = await assertIntegrationSettings(executor); if (current.drive_folder_id !== expected) throw new HttpError(409, 'The Drive mapping changed. Refresh this project.'); }, prepareDraft: async (collection: string, fields: ProviderRecord) => { rejectProviderFields(fields, collection); const data = validateRecord(collection, { ...fields, status: 'draft' }); await checkReferences(store, project.id, data); return data; } };
          context.assertPublishingApproval = (post: ProviderRecord) => assertPublishingApproval(context, post);
          context.persistNativeRefreshToken = async (provider: string, expected: string | undefined, next: string) => {
            await assertIntegrationSettings();
            const name = ({ googleAdsNative: 'GOOGLE_ADS_REFRESH_TOKEN', microsoftAds: 'MICROSOFT_ADS_REFRESH_TOKEN' } as Record<string, string | undefined>)[provider];
            if (!name) throw new HttpError(409, 'The native ad authorization changed. Refresh before continuing.');
            // Parallel refreshes retain the first saved token; administrative changes still invalidate the request above.
            if (env[name] === expected) await integrationSettings.save(provider, { refreshToken: next }, { tokenRotation: true });
          };
          context.assertProviderPostEdit = () => assertProviderPostEdit(context);
          context.contacts = direct.contacts; context.webhooks = webhooks;
          if (projectRoute[2]?.startsWith('sms-inbox') && await smsInbox.handle(context)) return;
          if (projectRoute[2]?.startsWith('links') && await links.handle(context)) return;
          if (projectRoute[2]?.startsWith('integrations/inbox') && await handleInbox(context)) return;
          if (projectRoute[2]?.startsWith('direct/') && await direct.handle(context)) return;
          if (projectRoute[2]?.startsWith('operations') && await handleOperationRecovery(context)) return;
          if (projectRoute[2]?.startsWith('approvals/') && await handleApprovals(context)) return;
          if (projectRoute[2]?.startsWith('calendar/') && await handleCalendar(context)) return;
          if (projectRoute[2]?.startsWith('agent/') && await handleAgent(context)) return;
          if (projectRoute[2]?.startsWith('ooh/') && await handleOoh(context)) return;
          if (projectRoute[2]?.startsWith('native-google-ads/') && await handleNativeGoogleAds(context)) return;
          if (projectRoute[2]?.startsWith('microsoft-ads/') && await handleMicrosoftAds(context)) return;
          if (projectRoute[2]?.startsWith('integrations/')) {
            if (await handleIntegration(context)) return;
          }
          if (!projectRoute[2] && req.method === 'PATCH') {
            if ((Object.hasOwn(body, 'zernioProfileId') || Object.hasOwn(body, 'driveFolderId')) && (!user.isOperator || !['owner', 'admin'].includes(role))) throw new HttpError(403, 'Only an instance operator with workspace administration access can map provider connections.');
            // Merge into the row as it is now, under its lock, so a parallel PATCH of another field is not overwritten (#35).
            const updated = await db.transaction(async tx => {
              const current = await first<ProviderRecord>(tx.execute(sql`SELECT ${projectFields} FROM projects p WHERE p.id=${project.id} FOR UPDATE`));
              if (!current) throw new HttpError(404, 'Project not found.');
              const next = projectInput({ ...current, ...body }); await checkProfileMapping(tx, next.zernioProfileId, project.id);
              await profileWrite(tx.execute(sql`UPDATE projects SET name=${next.name},color=${next.color},zernio_profile_id=${next.zernioProfileId},drive_folder_id=${next.driveFolderId} WHERE id=${project.id}`));
              return next;
            });
            await store.activity(project.id, 'Project settings updated.'); return send(200, { project: { ...project, ...updated } });
          }
          const [collection, id, extra] = (projectRoute[2] || '').split('/');
          if (collections.includes(collection) && !extra) {
            if (!id && req.method === 'POST') {
              rejectProviderFields(body, collection);
              if (collection === 'posts' && body.status === 'published') bad('Publish through a connected provider to confirm publication.');
              const data = validateRecord(collection, collection === 'placements' && (Object.hasOwn(body, 'latitude') || Object.hasOwn(body, 'longitude')) ? { ...body, locationSource: 'manual' } : body); await checkReferences(store, project.id, data);
              if (collection === 'assets' && data.approval !== 'pending' && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'An owner or administrator must approve creative assets.');
              const record = await store.create(project.id, collection, data); await store.activity(project.id, `${collection.slice(0, -1)} created.`); return send(201, { record });
            }
            if (id && ['PATCH', 'DELETE'].includes(req.method!)) {
              const previous = await store.get(project.id, collection, id); if (!previous) throw new HttpError(404, 'Record not found.');
              if ((collection === 'placements' && previous.source === 'broadsign') || (collection === 'campaigns' && (previous.externalId || previous.nativeProvider)) || (collection === 'posts' && (previous.externalId || previous.status === 'published'))) bad('Provider-managed records must be changed through their connected provider controls.');
              if (req.method === 'DELETE') { await checkDependants(store, project.id, collection, id); await store.remove(project.id, collection, id); await store.activity(project.id, `${collection.slice(0, -1)} deleted.`); return send(200, { ok: true }); }
              rejectProviderFields(body, collection);
              if (collection === 'posts' && (body.status === 'published' || previous.status === 'published' || previous.externalId)) bad('Provider posts must be managed through their connected provider.');
              const data = validateRecord(collection, { ...previous, ...body, ...(collection === 'placements' && (Object.hasOwn(body, 'latitude') || Object.hasOwn(body, 'longitude')) ? { locationSource: 'manual' } : {}) }); await checkReferences(store, project.id, data);
              if (collection === 'assets') {
                if (body.approval !== undefined && body.approval !== previous.approval && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'An owner or administrator must approve creative assets.');
                if (['url', 'deliveryUrl', 'kind'].some(key => data[key] !== previous[key])) data.approval = 'pending';
                if (Object.hasOwn(body, 'deliveryUrl') && data.deliveryUrl !== previous.deliveryUrl) for (const key of MEDIA_DELIVERY_FIELDS) data[key] = null;
              }
              const record = await store.update(project.id, collection, id, data); await store.activity(project.id, `${collection.slice(0, -1)} updated.`); return send(200, { record });
            }
          }
        }
        throw new HttpError(404, 'API route not found.');
      }
      if (!['GET', 'HEAD'].includes(req.method!)) throw new HttpError(405, 'Method not allowed.');
      const decoded = decodeURIComponent(path); if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, 'Invalid path.');
      let file = resolve(dist, '.' + decoded), rel = relative(dist, file);
      if (rel.startsWith('..' + sep) || rel === '..' || resolve(file) === sep) throw new HttpError(403, 'Invalid path.');
      try { if (!(await stat(file)).isFile()) file = join(dist, 'index.html'); } catch { if (extname(decoded)) throw new HttpError(404, 'File not found.'); file = join(dist, 'index.html'); }
      let contents; try { contents = await readFile(file); } catch { throw new HttpError(404, 'Build the frontend before starting the production server.'); }
      if (extname(file) === '.html') contents = Buffer.from(contents.toString('utf8').replace(/<script\b/g, `<script nonce="${nonce}"`));
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': (mime[extname(file)] || 'application/octet-stream') + (['.html', '.js', '.css'].includes(extname(file)) ? '; charset=utf-8' : ''), 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) { if (rawMediaContent && !res.headersSent) { res.setHeader('Connection', 'close'); req.resume(); } if (!res.headersSent) send(error instanceof HttpError || error instanceof IntegrationError ? error.status : 500, { error: error instanceof HttpError ? error.message : error instanceof IntegrationError ? { code: error.code, message: error.message } : 'The request could not be completed.' }); else res.end(); }
    finally { clearTimeout(bodyTimer); }
  });
  server.requestTimeout = MEDIA_UPLOAD_TIMEOUT; server.headersTimeout = 10000;
  // An injected database belongs to the caller; the shared pool closes with the app.
  const release = async () => { await draining; if (!options.database) await closeDatabase(); };
  return { server, db, pool, store, config, webhooks, direct, smsInbox, links, close: async () => {
    closeMediaUploads(); clearInterval(directTimer); clearInterval(webhookTimer); direct.close(); await direct.idle();
    if (server.listening) await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections(); });
    await release();
  } };
}
const PROFILE_MAPPED = 'This Zernio profile is already mapped to another project. Use one profile per project for publishing and analytics.';
async function checkProfileMapping(db: Executor, profileId: string | null, projectId = ''): Promise<void> { if (profileId && (await db.execute(sql`SELECT id FROM projects WHERE zernio_profile_id=${profileId} AND id<>${projectId}`)).rowCount) throw new HttpError(409, PROFILE_MAPPED); }
// A parallel mapping can pass checkProfileMapping too; the projects_zernio_profile unique index then refuses the write.
async function profileWrite(write: Promise<unknown>): Promise<void> {
  try { await write; } catch (error: any) { const cause = error?.cause ?? error; if (cause?.code === '23505' && cause?.constraint === 'projects_zernio_profile') throw new HttpError(409, PROFILE_MAPPED); throw error; }
}
function projectInput(data: ProviderRecord): ProjectInput {
  const color = data.color || '#5943ce'; if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) bad('Use a six digit hex color.');
  return { name: text(data.name, 'Project name'), color, zernioProfileId: text(data.zernioProfileId, 'Zernio profile', 200, true), driveFolderId: text(data.driveFolderId, 'Drive folder', 200, true) };
}
async function checkReferences(store: Store, projectId: string, data: ProviderRecord): Promise<void> {
  for (const [key, collection] of [['campaignId', 'campaigns'], ['assetId', 'assets'], ['providerId', 'providers']]) if (data[key] && !await store.get(projectId, collection, data[key])) bad(`${key} does not belong to this project.`);
  for (const variant of [...Object.values((data.platformOverrides || {}) as ProviderRecord), ...Object.values((data.accountOverrides || {}) as ProviderRecord)]) if (variant?.assetId && !await store.get(projectId, 'assets', variant.assetId)) bad('A customized creative asset does not belong to this project.');
}
async function checkDependants(store: Store, projectId: string, collection: string, id: string, realOnly = false): Promise<void> {
  const field = ({ campaigns: 'campaignId', assets: 'assetId', providers: 'providerId' } as Record<string, string | undefined>)[collection];
  // ponytail: scan local project records for references; use indexed relationships if project size makes deletion checks slow.
  if (field && (await Promise.all(collections.map(name => store.list(projectId, name)))).some(list => list.some(record => (record[field] === id || (collection === 'assets' && [...Object.values((record.platformOverrides || {}) as ProviderRecord), ...Object.values((record.accountOverrides || {}) as ProviderRecord)].some(variant => variant?.assetId === id))) && (!realOnly || !record.sample)))) throw new HttpError(409, `This ${collection.slice(0, -1)} is assigned to ${realOnly ? 'a real record' : 'another record'}. Remove its assignments before deleting it${realOnly ? ' or removing sample data' : ''}.`);
}
function rejectProviderFields(body: ProviderRecord, collection = ''): void {
  if (collection === 'assets' && MEDIA_DELIVERY_FIELDS.some(key => Object.hasOwn(body, key))) bad('Hosted delivery metadata is managed by the upload workflow.');
  if (['nativeProvider', 'nativeCustomerId', 'nativeCampaignResource', 'nativeResources', 'nativeAccountId', 'nativeCampaignId', 'nativeAdGroupId', 'nativeAdId', 'externalId', 'zernioPostId', 'providerStatus', 'remoteId', 'publishedAt', 'syncedAt', 'driveFileId', 'externalConversationId', 'zernioProfileId', 'providerResults', 'platformCampaignId', 'driveId', 'source', 'accountId', 'profileId', 'isLive', 'zernioConversationId', 'locationSource', 'controlOwner', 'thumbnailUrl', 'mimeType', 'deliveryUrl', 'modifiedTime', 'md5Checksum', 'approvalStatus', 'approvedBy', 'reviewedBy', 'providerDeletedAt', 'proposalItemId', 'screenId', 'bookingId'].some(key => Object.hasOwn(body, key) && !(collection === 'assets' && key === 'deliveryUrl'))) bad('Provider identifiers and publication evidence are managed by integrations.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.server.listen(Number(process.env.PORT || 3018), process.env.HOST || '127.0.0.1', () => console.log(`Campaign manager available at ${app.config.appUrl}`));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
}
