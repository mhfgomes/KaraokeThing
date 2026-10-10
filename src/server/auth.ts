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
const loginAttempts: number[] = [];
export function checkLoginAttempts() {
  const start = Date.now() - 10 * 60000;
  while (loginAttempts[0] < start) loginAttempts.shift();
  if (loginAttempts.length >= 15) throw new HttpError(429, 'Too many sign-in attempts. Try again in ten minutes.');
}
export function recordFailedLogin() { loginAttempts.push(Date.now()); }
export function setupRequired() { return !setting('password'); }
