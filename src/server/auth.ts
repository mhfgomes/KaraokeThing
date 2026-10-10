import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, setting } from './db';

export const SESSION_COOKIE = 'karaoke_session';
export function passwordHash(password: string) {
  const salt = randomBytes(24).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password: string, encoded: string) {
  const [salt, digest] = encoded.split(':');
  if (!salt || !digest) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function sessionHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function cookieToken(request: Request) {
  return request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || '';
}
export function isAdmin(request: Request) {
  const token = cookieToken(request);
  if (!token) return false;
  const row = db.prepare('SELECT expires FROM sessions WHERE hash=?').get(sessionHash(token)) as { expires: number } | undefined;
  return !!row && row.expires > Date.now();
}
export function createSession(request: Request) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?)').run(sessionHash(token), Date.now() + 7 * 86400000);
  return sessionCookie(request, token, 7 * 86400);
}
export function sessionCookie(request: Request, token: string, seconds: number) {
  const secure = new URL(request.url).protocol === 'https:';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
export function requireAdmin(request: Request) {
  if (!isAdmin(request)) throw new HttpError(401, 'Sign in as host to change the library or session.');
}
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host') || new URL(request.url).host;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* fail closed */ }
    if (originHost !== host) throw new HttpError(403, 'Requests must come from this app.');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const loginAttempts = new Map<string, number[]>();
const globalLoginAttempts: number[] = [];
const LOGIN_WINDOW_MS = 10 * 60000;
const CLIENT_FAILURE_LIMIT = 15;
const GLOBAL_FAILURE_LIMIT = 100;
function clientKey(request: Request) {
  // Best-effort grouping only: these headers are spoofable without a trusted proxy.
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim().slice(0, 200) || request.headers.get('x-real-ip')?.slice(0, 200) || `unknown:${request.headers.get('user-agent')?.slice(0, 200) || 'client'}`;
}
export function checkLoginAttempts(request: Request) {
  const start = Date.now() - LOGIN_WINDOW_MS;
  while (globalLoginAttempts.length && globalLoginAttempts[0] <= start) globalLoginAttempts.shift();
  for (const [key, attempts] of loginAttempts) {
    while (attempts.length && attempts[0] <= start) attempts.shift();
    if (!attempts.length) loginAttempts.delete(key);
  }
  if (globalLoginAttempts.length >= GLOBAL_FAILURE_LIMIT || (loginAttempts.get(clientKey(request))?.length || 0) >= CLIENT_FAILURE_LIMIT) throw new HttpError(429, 'Too many sign-in attempts. Try again in ten minutes.');
}
export function recordFailedLogin(request: Request) {
  const now = Date.now();
  // Keep the hard limit independent of client bucket eviction and successful logins.
  globalLoginAttempts.push(now);
  const key = clientKey(request);
  if (!loginAttempts.has(key)) {
    if (loginAttempts.size >= 10000) loginAttempts.delete(loginAttempts.keys().next().value!);
    loginAttempts.set(key, []);
  }
  loginAttempts.get(key)!.push(now);
}
export function clearLoginAttempts(request: Request) { loginAttempts.delete(clientKey(request)); }
export function setupRequired() { return !setting('password'); }
