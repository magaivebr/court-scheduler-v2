import { Temporal } from '@js-temporal/polyfill';
import { HttpError } from './security.mjs';

export const TIME_ZONE = 'Europe/Brussels';
export function releaseForDate(date) {
  return Temporal.PlainDate.from(date).subtract({ days: 1 }).toZonedDateTime({ timeZone: TIME_ZONE, plainTime: '09:00' }).toInstant().toString();
}
export function validatePlan(input, now = Date.now()) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new HttpError(400, 'A booking plan is required.');
  const allowed = new Set(['date', 'start', 'courts', 'allowSwitch', 'authorization', 'idempotencyKey']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new HttpError(400, 'Unknown booking field.');
  let date;
  try { date = Temporal.PlainDate.from(input.date).toString(); } catch { throw new HttpError(400, 'Choose a valid playing date.'); }
  if (date !== input.date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Choose a valid playing date.');
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(TIME_ZONE).toPlainDate();
  if (Temporal.PlainDate.compare(date, today) < 0 || Temporal.PlainDate.compare(date, today.add({ days: 31 })) > 0) throw new HttpError(400, 'Choose a date within the next 31 days.');
  if (!Number.isInteger(input.start) || input.start < 0 || input.start > 22) throw new HttpError(400, 'Choose two consecutive hourly sessions.');
  // Accept old clients' fields, but new plans always use the automatic court policy.
  if (input.courts !== undefined && (!Array.isArray(input.courts) || input.courts.length < 1 || input.courts.length > 3 || input.courts.some(c => ![1, 2, 3].includes(c)) || new Set(input.courts).size !== input.courts.length)) throw new HttpError(400, 'Invalid courts.');
  if ((input.allowSwitch !== undefined && typeof input.allowSwitch !== 'boolean') || typeof input.authorization !== 'boolean') throw new HttpError(400, 'Invalid booking authorization.');
  if (typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.idempotencyKey)) throw new HttpError(400, 'A valid request identifier is required.');
  return { date, start: input.start, courts: [1, 2, 3], allowSwitch: true, authorization: false, idempotencyKey: input.idempotencyKey, releaseAt: releaseForDate(date) };
}
export function validateRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Enter your account details.');
  if (Object.keys(input).some(k => !['name', 'username', 'password', 'invite'].includes(k))) throw new HttpError(400, 'Unknown account field.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new HttpError(400, 'Enter a display name of 1–80 characters.');
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) throw new HttpError(400, 'Username must be 3–50 letters, numbers, dots, underscores or hyphens.');
  if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new HttpError(400, 'Use a password of 12–128 characters.');
  if (typeof input.invite !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(input.invite)) throw new HttpError(400, 'Enter a valid invitation code.');
  return { name, username, password: input.password, invite: input.invite };
}
