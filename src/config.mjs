import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function integer(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw Error(`Invalid ${name}.`);
  return number;
}
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = integer(env.PORT, 4318, 1, 65535, 'PORT');
  const host = env.HOST || '127.0.0.1';
  const origin = new URL(env.PUBLIC_ORIGIN || env.APP_ORIGIN || `http://127.0.0.1:${port}`);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('PUBLIC_ORIGIN must be an origin, without credentials or a path.');
  if (production && (!(env.PUBLIC_ORIGIN || env.APP_ORIGIN) || origin.protocol !== 'https:')) throw Error('Production requires PUBLIC_ORIGIN with HTTPS.');
  if (!production && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw Error('Non-local deployment requires NODE_ENV=production and HTTPS.');
  if (!production && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw Error('Development must bind to loopback.');
  const dataDir = path.resolve(env.DATA_DIR || path.join(projectRoot, '.data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let encryptionKey;
  if (env.SESSION_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.SESSION_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== env.SESSION_ENCRYPTION_KEY) throw Error('SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
  } else {
    if (production) throw Error('Production requires SESSION_ENCRYPTION_KEY.');
    const keyPath = path.join(dataDir, 'development-vault.key');
    if (!existsSync(keyPath)) { try { writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    encryptionKey = readFileSync(keyPath);
    if (encryptionKey.length !== 32) throw Error('Invalid local session vault key.');
  }
  const mode = env.BOOKING_MODE || 'rehearsal';
  if (!['rehearsal', 'live'].includes(mode)) throw Error('BOOKING_MODE must be rehearsal or live.');
  const liveEnabled = mode === 'live' && env.LIVE_BOOKING_ENABLED === 'true';
  const providerIdentitySource = env.PROVIDER_IDENTITY_SOURCE || '';
  if (!['', 'profile-person-id'].includes(providerIdentitySource)) throw Error('Invalid PROVIDER_IDENTITY_SOURCE.');
  return {
    production, port, host, origin: origin.origin, publicOrigin: origin.origin,
    secureCookies: production, cookieName: production ? '__Host-court_session' : 'court_session',
    dataDir, databasePath: path.join(dataDir, 'court-scheduler.sqlite'), encryptionKey,
    publicDir: path.join(projectRoot, 'public'), mode, liveEnabled,
    bookingUrl: 'https://usc.kuleuven.cloud/bookings/rent?tags=132',
    maxAccounts: integer(env.MAX_ACCOUNTS, 30, 1, 30, 'MAX_ACCOUNTS'),
    maxConcurrentWorkers: integer(env.MAX_CONCURRENT_WORKERS, 30, 1, 30, 'MAX_CONCURRENT_WORKERS'),
    preparationMs: 60000, sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    headless: env.BROWSER_HEADLESS !== 'false', browserChannel: env.BROWSER_CHANNEL || undefined,
    browserExecutablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
    providerIdentitySelector: env.PROVIDER_IDENTITY_SELECTOR || '',
    providerIdentitySource,
    providerIdentityAttribute: env.PROVIDER_IDENTITY_ATTRIBUTE || '',
    loginAllowedHosts: (env.LOGIN_ALLOWED_HOSTS || '').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean),
    loginTtlMs: 600000,
  };
}
