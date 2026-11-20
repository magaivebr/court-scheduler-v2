import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function equalSecret(a, b) {
  const aa = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, work, salt, expected] = String(encoded).split('$');
    if (algorithm !== 'scrypt' || work !== '32768') return false;
    const key = await scrypt(password, Buffer.from(salt, 'base64'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const target = Buffer.from(expected, 'base64');
    return key.length === target.length && timingSafeEqual(key, target);
  } catch { return false; }
}
export function encryptState(key, userId, state) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`court-scheduler-v2:${userId}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
}
export function decryptState(key, userId, encrypted) {
  const value = JSON.parse(encrypted);
  if (value.v !== 1) throw Error('Unsupported session vault format.');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
  cipher.setAAD(Buffer.from(`court-scheduler-v2:${userId}`));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.body, 'base64')), cipher.final()]).toString('utf8'));
}
export function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1)); } catch { /* malformed cookie is ignored */ }
  }
  return cookies;
}
export class RateLimiter {
  #windows = new Map();
  check(key, limit, windowMs, now = Date.now()) {
    if (this.#windows.size > 10000) {
      for (const [k, item] of this.#windows) if (item.until <= now) this.#windows.delete(k);
      if (this.#windows.size > 10000) throw new HttpError(503, 'Please try again later.');
    }
    let item = this.#windows.get(key);
    if (!item || item.until <= now) { item = { count: 0, until: now + windowMs }; this.#windows.set(key, item); }
    item.count++;
    if (item.count > limit) throw new HttpError(429, 'Too many attempts. Please wait and try again.');
  }
}
