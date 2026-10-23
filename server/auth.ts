import { randomBytes, scrypt, timingSafeEqual, createHmac, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { parseTrustedProxies, resolveClientAddress } from '@ten98/runtime';
import type { Database, Executor } from './database.ts';
import { joinInvitation, lockInvitation } from './invitations.ts';

export interface AuthConfig { appUrl: string; sessionSecret: string; oidcEnabled?: boolean; oidcIssuer: string; oidcClientId: string; oidcClientSecret?: string; oidcAllowedEmails: string[]; trustedProxies?: string | string[] }
export interface PublicUser { id: string; name: string; email: string; isOperator: boolean }
type UserRow = { id: string; name: string; email: string; password?: string | null; isOperator?: unknown; expiresAt?: number };
type OidcFlow = { state: string; verifier: string; nonce: string; invite_hash: string | null };

const derive = promisify(scrypt) as (password: string, salt: string, keylen: number, options: { N: number; maxmem: number }) => Promise<Buffer>;
const maxAge = 7 * 86400, oidcWindow = 600, callbackPath = '/api/auth/oidc/callback';
// Password sign-in attempts per 15 minutes. One client reaches at most 10 attempts per account in a window (20 across two
// overlapping windows), so only failures from several clients can reach the account-wide limit.
export const signInLimits = { client: 30, clientAccount: 10, account: 50 };
export class HttpError extends Error { status: number; code?: string; constructor(status: number, message: string, code?: string) { super(message); this.status = status; if (code) this.code = code; } }
export const publicUser = (user: UserRow | null | undefined): PublicUser | null => user ? { id: user.id, name: user.name, email: user.email, isOperator: Boolean(user.isOperator) } : null;
function storedSecret(dataDir: string, provided: string | undefined, filename: string, label: string): string {
  if (provided) { if (provided.length < 32) throw new Error(`${label} must contain at least 32 characters.`); return provided; }
  const path = join(dataDir, filename);
  try { const value = readFileSync(path, 'utf8').trim(); if (value.length < 32) throw new Error(`The saved ${filename} is invalid.`); return value; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(48).toString('base64url');
    try { writeFileSync(path, value, { flag: 'wx', mode: 0o600 }); return value; }
    catch (race) { if ((race as NodeJS.ErrnoException).code === 'EEXIST') return storedSecret(dataDir, undefined, filename, label); throw race; }
  }
}
export const sessionSecret = (dataDir: string, provided?: string) => storedSecret(dataDir, provided, 'session-secret', 'SESSION_SECRET');
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt, 64, { N: 65536, maxmem: 128 * 1024 * 1024 })).toString('hex')}`;
}
async function verify(password: string, encoded: string | null | undefined): Promise<boolean> {
  const [, salt = 'absent-account', expected = '0'.repeat(128)] = (encoded || '').split('$');
  const actual = await derive(password, salt, 64, { N: 65536, maxmem: 128 * 1024 * 1024 });
  const saved = Buffer.from(expected, 'hex');
  return Boolean(encoded) && saved.length === actual.length && timingSafeEqual(saved, actual);
}
export function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s)).filter(part => part[0]).map(([key, value]) => [key, value || '']));
}
const first = async <T>(query: Promise<{ rows: unknown[] }>): Promise<T | undefined> => (await query).rows[0] as T | undefined;
// Lock order (issue #25): installation → workspaces → invitations → advisory (email:, oidc:) → users row.
export const advisoryLock = (tx: Executor, key: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
export const lockUser = (tx: Executor, userId: string) => first<{ id: string; password: string | null }>(tx.execute(sql`SELECT id, password FROM users WHERE id = ${userId} FOR UPDATE`));
/** Per-workspace mutex for membership, ownership and invitation changes; returns false when the workspace is gone. */
export const lockWorkspace = async (tx: Executor, workspaceId: string) => Boolean((await tx.execute(sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`)).rowCount);
export const memberRole = async (executor: Executor, workspaceId: string, userId: string) => (await first<{ role: string }>(executor.execute(sql`SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`)))?.role;

type OpenIdClient = typeof import('openid-client');
// The OIDC client loader is injectable so tests can exercise the real flow without an identity provider.
export function createAuth(db: Database, config: AuthConfig, { openidClient = () => import('openid-client') }: { openidClient?: () => Promise<OpenIdClient> } = {}) {
  const digest = (value: string) => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  const proxies = (() => { try { return parseTrustedProxies([config.trustedProxies ?? ''].flat().join(',')); } catch { throw new Error('TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges.'); } })();
  // The shared resolver ignores X-Forwarded-For unless the peer is a trusted proxy. It returns null when the address is
  // unknown (an invalid peer, or a missing, malformed or all-trusted chain behind a trusted proxy); those share one bucket.
  const clientAddress = (req: IncomingMessage): string => resolveClientAddress(req.socket?.remoteAddress, req.headers?.['x-forwarded-for'] as string | undefined, proxies) ?? 'unknown';
  // Cookies are shared across ports; include the configured origin so local instances can coexist.
  const scope = createHash('sha256').update(new URL(config.appUrl).origin).digest('hex').slice(0, 16), sessionName = 'ten98_session_' + scope, oidcName = 'ten98_oidc_' + scope, inviteName = 'ten98_oidc_invite_' + scope;
  function cookie(name: string, value: string, age = maxAge, path = '/') {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${config.appUrl.startsWith('https:') ? '; Secure' : ''}`;
  }
  function setCookie(res: ServerResponse, value: string) {
    const previous = res.getHeader?.('Set-Cookie'), name = value.slice(0, value.indexOf('='));
    const values = [value, ...(Array.isArray(previous) ? previous : previous ? [previous] : []).map(String).filter(item => !item.startsWith(name + '='))];
    res.setHeader('Set-Cookie', values.length === 1 ? values[0] : values);
  }
  async function findSession(executor: Executor, token: string | undefined): Promise<UserRow | null | undefined> {
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    return first<UserRow>(executor.execute(sql`SELECT u.id, u.name, u.email, s.expires_at AS "expiresAt", EXISTS (SELECT 1 FROM instance_operators o WHERE o.user_id = u.id) AS "isOperator" FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ${digest(token)} AND s.expires_at > ${Date.now()}`));
  }
  function sessionToken(req: IncomingMessage): string | undefined { const values = cookies(req); return Object.hasOwn(values, sessionName) ? values[sessionName] : values.ten98_session; }
  // Callers that check credentials pass their transaction so the check and the new session commit together.
  async function establish(res: ServerResponse, userId: string, req?: IncomingMessage, executor: Executor = db) {
    const legacy = req && cookies(req).ten98_session;
    if (await findSession(executor, legacy)) { await executor.execute(sql`DELETE FROM sessions WHERE token = ${digest(legacy!)}`); setCookie(res, cookie('ten98_session', '', 0)); }
    const token = randomBytes(32).toString('base64url');
    await executor.execute(sql`DELETE FROM sessions WHERE expires_at <= ${Date.now()}`);
    await executor.execute(sql`INSERT INTO sessions VALUES (${digest(token)}, ${userId}, ${Date.now() + maxAge * 1000})`);
    setCookie(res, cookie(sessionName, token));
  }
  async function user(req: IncomingMessage, res?: ServerResponse): Promise<PublicUser | null> {
    const token = sessionToken(req), found = await findSession(db, token);
    if (found && res && !Object.hasOwn(cookies(req), sessionName)) {
      setCookie(res, cookie('ten98_session', '', 0));
      setCookie(res, cookie(sessionName, token!, Math.max(0, Math.floor((found.expiresAt! - Date.now()) / 1000))));
    }
    return publicUser(found);
  }
  // One conditional upsert: parallel attempts cannot all pass a separate read before any of them increments.
  async function limit(key: string, maximum = 10): Promise<void> {
    const now = Date.now();
    await db.execute(sql`DELETE FROM login_limits WHERE expires_at <= ${now}`);
    const counted = await db.execute(sql`INSERT INTO login_limits VALUES (${key}, 1, ${now + 900000}) ON CONFLICT (key) DO UPDATE SET count = login_limits.count + 1 WHERE login_limits.count < ${maximum}`);
    if (!counted.rowCount) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }
  let oidcConfig: import('openid-client').Configuration | undefined;
  async function oidc() {
    const client = await openidClient();
    // ID token signatures are checked against the issuer's JWKS rather than relying on the TLS channel alone.
    if (!oidcConfig) oidcConfig = await client.discovery(new URL(config.oidcIssuer), config.oidcClientId, config.oidcClientSecret || undefined, undefined, { execute: [client.enableNonRepudiationChecks] });
    return { client, provider: oidcConfig };
  }
  // The invitation token rides in a callback-scoped cookie as "<expiresAt>.<token>"; the database keeps only its keyed hash.
  function invitation(req: IncomingMessage, stored: string | null): string {
    const value = cookies(req)[inviteName] || '', [expires, token = ''] = value.split(/\.(.*)/s);
    if (!stored || !/^[A-Za-z0-9_-]{43}$/.test(token) || !(Number(expires) > Date.now())) return '';
    return timingSafeEqual(Buffer.from(digest(value)), Buffer.from(stored)) ? token : '';
  }
  return {
    user, establish, limit, clientAddress,
    /** The stored key of this request's session cookie, or '' when it carries none, for guards that join on sessions. */
    sessionKey(req: IncomingMessage): string { const token = sessionToken(req); return token && /^[\w-]{43}$/.test(token) ? digest(token) : ''; },
    async account(userId: string) {
      const row = await first<{ password: string | null; sessions: number }>(db.execute(sql`SELECT password, (SELECT count(*) FROM sessions WHERE user_id = ${userId} AND expires_at > ${Date.now()}) AS sessions FROM users WHERE id = ${userId}`));
      return { localPassword: Boolean(row?.password), activeSessions: row?.sessions ?? 0 };
    },
    revokeOtherSessions(req: IncomingMessage, userId: string): Promise<number> {
      return db.transaction(async tx => { await lockUser(tx, userId); return (await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${userId} AND token <> ${digest(sessionToken(req) || '')}`)).rowCount ?? 0; });
    },
    async changePassword(req: IncomingMessage, res: ServerResponse, userId: string, currentPassword: string, newPassword: string): Promise<void> {
      await limit('password:' + userId);
      const previous = (await first<{ password: string | null }>(db.execute(sql`SELECT password FROM users WHERE id = ${userId}`)))?.password;
      if (!previous || !await verify(currentPassword, previous)) throw new HttpError(400, 'The current password is incorrect.');
      const next = await hashPassword(newPassword);
      await db.transaction(async tx => {
        const locked = await lockUser(tx, userId);
        if ((await findSession(tx, sessionToken(req)))?.id !== userId) throw new HttpError(403, 'Your sign-in session ended. Sign in again before changing your password.');
        if (locked?.password !== previous) throw new HttpError(409, 'Your password changed during this request. Sign in again.');
        await tx.execute(sql`UPDATE users SET password = ${next} WHERE id = ${userId}`);
        await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
        await establish(res, userId, req, tx);
      });
    },
    async login(req: IncomingMessage, res: ServerResponse, body: { email: string; password: string }): Promise<PublicUser | null> {
      const client = clientAddress(req), account = body.email.toLowerCase(), clientAccount = 'client-email:' + digest(JSON.stringify([client, account]));
      await limit('ip:' + client, signInLimits.client); await limit(clientAccount, signInLimits.clientAccount); await limit('email:' + digest(account), signInLimits.account);
      const found = await first<UserRow>(db.execute(sql`SELECT u.*, EXISTS (SELECT 1 FROM instance_operators o WHERE o.user_id = u.id) AS "isOperator" FROM users u WHERE email = ${body.email}`));
      if (!await verify(body.password, found?.password)) throw new HttpError(401, 'Email or password is incorrect.');
      return db.transaction(async tx => {
        if ((await lockUser(tx, found!.id))?.password !== found!.password) throw new HttpError(401, 'Your password changed. Sign in again.');
        await tx.execute(sql`DELETE FROM login_limits WHERE key = ${clientAccount}`);
        await establish(res, found!.id, req, tx); return publicUser(found);
      });
    },
    async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const token = sessionToken(req), legacy = cookies(req).ten98_session;
      if (await findSession(db, legacy)) { await db.execute(sql`DELETE FROM sessions WHERE token = ${digest(legacy)}`); setCookie(res, cookie('ten98_session', '', 0)); }
      if (token) await db.execute(sql`DELETE FROM sessions WHERE token = ${digest(token)}`);
      setCookie(res, cookie(sessionName, '', 0));
    },
    // The GET start and the callback are full-page navigations, so a failure redirects to the app with a fixed code (never
    // the message or an email address); the sign-in screen maps the code to its text. An invitation the browser already
    // holds is kept, in the #invite= fragment. GET start still reads ?invite= from clients made before the POST start.
    async oidcStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const held = new URL(req.url || '/api/auth/oidc/start', config.appUrl).searchParams.get('invite');
      try { const location = await startFlow(req, res, held); res.writeHead(302, { Location: location }); res.end(); }
      catch (error) { signInError(res, error, held && /^[A-Za-z0-9_-]{43}$/.test(held) ? held : ''); }
    },
    /** Invitation sign-in: the token comes in the POST body, and the caller returns the authorization URL as JSON. */
    oidcAuthorize(req: IncomingMessage, res: ServerResponse, invite: string | null): Promise<string> { return startFlow(req, res, invite); },
    async oidcCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const held = { invite: '' };
      try { await finishFlow(req, res, url, held); } catch (error) { signInError(res, error, held.invite); }
    },
  };
  function signInError(res: ServerResponse, error: unknown, invite: string) {
    const code = error instanceof HttpError && error.code ? error.code : error instanceof HttpError && error.status === 429 ? 'OIDC_RATE_LIMITED' : 'OIDC_SIGN_IN_FAILED';
    if (res.headersSent) { res.end(); return; }
    res.writeHead(302, { Location: `${config.appUrl}/?auth_error=${code}${invite ? '#invite=' + encodeURIComponent(invite) : ''}` }); res.end();
  }
  async function startFlow(req: IncomingMessage, res: ServerResponse, invite: string | null): Promise<string> {
      if (!config.oidcEnabled || !(await db.execute(sql`SELECT id FROM users LIMIT 1`)).rowCount) throw new HttpError(400, 'Identity sign-in is unavailable.');
      await limit('oidc:' + clientAddress(req), 30);
      const { client, provider } = await oidc();
      if (invite && !/^[A-Za-z0-9_-]{43}$/.test(invite)) throw new HttpError(400, 'Use a valid invitation link before signing in.');
      const state = client.randomState(), nonce = client.randomNonce(), verifier = client.randomPKCECodeVerifier(), browser = randomBytes(32).toString('base64url'), expires = Date.now() + oidcWindow * 1000;
      const continuation = invite ? `${expires}.${invite}` : '';
      await db.transaction(async tx => {
        await tx.execute(sql`DELETE FROM oidc_flows WHERE expires_at <= ${Date.now()}`);
        await tx.execute(sql`INSERT INTO oidc_flows VALUES (${digest(state)}, ${digest(browser)}, ${verifier}, ${nonce}, ${expires})`);
        if (continuation) await tx.execute(sql`INSERT INTO oidc_return_targets VALUES (${digest(state)}, ${digest(continuation)})`);
      });
      const location = client.buildAuthorizationUrl(provider, { redirect_uri: config.appUrl + callbackPath, scope: 'openid email profile', state, nonce, code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      // Without an invitation no hash is stored, so a stale continuation cookie is ignored and cleared at the callback.
      if (continuation) setCookie(res, cookie(inviteName, continuation, oidcWindow, callbackPath));
      setCookie(res, cookie(oidcName, browser, oidcWindow));
      return location.href;
  }
  async function finishFlow(req: IncomingMessage, res: ServerResponse, url: URL, held: { invite: string }): Promise<void> {
      const values = cookies(req), scoped = Object.hasOwn(values, oidcName), state = url.searchParams.get('state'), browser = scoped ? values[oidcName] : values.ten98_oidc;
      setCookie(res, cookie(inviteName, '', 0, callbackPath));
      if (!state || !browser || url.searchParams.getAll('state').length !== 1) throw new HttpError(400, 'Identity sign-in expired. Start again.');
      // Single use: the DELETE claims the flow atomically; the CTE reads its return target before the cascade removes it.
      const flow = await first<OidcFlow>(db.execute(sql`WITH f AS (DELETE FROM oidc_flows WHERE state = ${digest(state)} AND browser = ${digest(browser)} AND expires_at > ${Date.now()} RETURNING state, verifier, nonce) SELECT f.state, f.verifier, f.nonce, r.invite_hash FROM f LEFT JOIN oidc_return_targets r ON r.state = f.state`));
      if (!flow) throw new HttpError(400, 'Identity sign-in expired or was already used.');
      if (!scoped) setCookie(res, cookie('ten98_oidc', '', 0));
      setCookie(res, cookie(oidcName, '', 0));
      const invite = invitation(req, flow.invite_hash); held.invite = invite;
      try {
        const { client, provider } = await oidc();
        const tokens = await client.authorizationCodeGrant(provider, url, { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
        const claims = tokens.claims();
        if (!claims?.sub || typeof claims.sub !== 'string' || claims.sub.length > 1024) throw new Error('Missing subject.');
        let joined = false;
        await db.transaction(async tx => {
          // A usable invitation (re-checked under its workspace and row locks) provisions its exact verified email into that
          // workspace only; an unusable one leaves the allowlist rules in place.
          const invited = invite ? await lockInvitation(tx, invite).catch(error => { if (error instanceof HttpError) return undefined; throw error; }) : undefined;
          await advisoryLock(tx, 'oidc:' + JSON.stringify([claims.iss, claims.sub]));
          const existing = await first<{ user_id: string }>(tx.execute(sql`SELECT user_id FROM oidc_identities WHERE issuer = ${claims.iss} AND subject = ${claims.sub}`));
          if (existing) return establish(res, existing.user_id, req, tx);
          const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
          if (claims.email_verified !== true) throw new HttpError(403, 'Verify this email address with your identity provider first.', 'OIDC_EMAIL_UNVERIFIED');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(403, 'This identity is not provisioned. Ask the operator for access.', 'OIDC_NOT_PROVISIONED');
          if (invited && invited.email !== email) throw new HttpError(403, `This invitation is for ${invited.email}. Sign in with that identity to accept it.`, 'OIDC_INVITE_EMAIL_MISMATCH');
          if (!invited && !config.oidcAllowedEmails.includes(email)) throw new HttpError(403, 'This identity is not provisioned. Ask the operator for access.', 'OIDC_NOT_PROVISIONED');
          await advisoryLock(tx, 'email:' + email);
          if ((await tx.execute(sql`SELECT id FROM users WHERE email = ${email}`)).rowCount) throw new HttpError(403, 'This email already has an account. Automatic identity linking is disabled.', 'OIDC_ACCOUNT_EXISTS');
          const id = randomUUID(), workspace = randomUUID();
          await tx.execute(sql`INSERT INTO users VALUES (${id}, ${typeof claims.name === 'string' ? claims.name.slice(0, 120) : email}, ${email}, NULL)`);
          await tx.execute(sql`INSERT INTO oidc_identities VALUES (${claims.iss}, ${claims.sub}, ${id})`);
          if (invited) { await joinInvitation(tx, invited, id); joined = true; return establish(res, id, req, tx); }
          await tx.execute(sql`INSERT INTO workspaces (id, name) VALUES (${workspace}, 'My workspace')`);
          await tx.execute(sql`INSERT INTO memberships VALUES (${workspace}, ${id}, 'owner')`);
          await tx.execute(sql`INSERT INTO projects (id, workspace_id, name) VALUES (${randomUUID()}, ${workspace}, 'My project')`);
          return establish(res, id, req, tx);
        });
        res.writeHead(302, { Location: config.appUrl + '/' + (invite && !joined ? '#invite=' + encodeURIComponent(invite) : '') }); res.end();
      } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Identity sign-in could not be verified. Start again.'); }
  }
}
