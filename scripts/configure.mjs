import { randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const index = process.argv.indexOf('--origin');
const origin = new URL(index === -1 ? 'http://127.0.0.1:4318' : process.argv[index + 1]);
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
if ((!local && origin.protocol !== 'https:') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Use a local origin or public HTTPS origin without path/query/credentials.');
const target = path.join(root, '.env');
try { await access(target); throw Error('.env already exists. This script never replaces encryption keys.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const content = [`NODE_ENV=${local ? 'development' : 'production'}`,`HOST=${local ? '127.0.0.1' : '0.0.0.0'}`,'PORT=4318',`PUBLIC_ORIGIN=${origin.origin}`,'DATA_DIR=.data','BOOKING_MODE=rehearsal','LIVE_BOOKING_ENABLED=false','MAX_ACCOUNTS=30','MAX_CONCURRENT_WORKERS=30','BROWSER_HEADLESS=true',`SESSION_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,...(!local ? [`SCHEDULER_DOMAIN=${origin.hostname}`] : []),''].join('\n');
await writeFile(target, content, { flag: 'wx', mode: 0o600 });
console.log('Created private .env. Rehearsal mode remains active. Keep this file and its key outside GitHub.');
