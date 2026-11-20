import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const originArg = process.argv[process.argv.indexOf('--origin') + 1];
if (!process.argv.includes('--origin') || !originArg) throw Error('Pass --origin https://your-device.your-tailnet.ts.net');
const origin = new URL(originArg);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.port) throw Error('Use a public HTTPS origin without port, path, query or credentials.');
const envPath = path.join(root, '.env');
const values = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const developmentKey = path.join(root, '.data', 'development-vault.key');
const key = values.SESSION_ENCRYPTION_KEY || (existsSync(developmentKey) ? readFileSync(developmentKey).toString('base64') : randomBytes(32).toString('base64'));
if (Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw Error('Existing encryption key is invalid; no changes made.');
Object.assign(values, {
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4318', PUBLIC_ORIGIN: origin.origin,
  DATA_DIR: '.data', SESSION_ENCRYPTION_KEY: key, BOOKING_MODE: 'rehearsal',
  LIVE_BOOKING_ENABLED: 'false', MAX_ACCOUNTS: '30', MAX_CONCURRENT_WORKERS: '30',
  BROWSER_HEADLESS: 'true', BROWSER_CHANNEL: 'msedge',
});
writeFileSync(envPath, Object.entries(values).map(([name,value]) => `${name}=${JSON.stringify(value)}`).join('\n')+'\n', {mode:0o600});
console.log(`Configured Windows host at ${origin.origin}. Existing vault key preserved. Rehearsal mode is active.`);
