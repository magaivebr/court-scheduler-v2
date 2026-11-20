import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'public');
const output = path.join(root, 'dist');
let backendUrl = process.env.PUBLIC_BACKEND_URL || '';
if (backendUrl) {
  const url = new URL(backendUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('PUBLIC_BACKEND_URL must be a public HTTPS origin without credentials, query or fragment.');
  backendUrl = url.origin;
}
async function copy(dir, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copy(path.join(dir, entry.name), path.join(to, entry.name));
    else await copyFile(path.join(dir, entry.name), path.join(to, entry.name));
  }
}
await copy(source, output);
await writeFile(path.join(output, 'config.json'), JSON.stringify({ backendUrl }, null, 2) + '\n');
await writeFile(path.join(output, '.nojekyll'), '');
const index = await readFile(path.join(output, 'index.html'), 'utf8');
if (!index.includes('Court Scheduler')) throw Error('Unexpected static entry point.');
console.log(`Public website built in dist. Booking service ${backendUrl ? 'configured' : 'not connected; scheduling remains unavailable'}.`);
