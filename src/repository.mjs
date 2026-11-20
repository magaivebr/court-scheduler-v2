import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { HttpError, token, digest, encryptState, decryptState } from './security.mjs';

const ACTIVE = ['armed', 'preparing', 'running'];
const safeJSON = value => value ? JSON.parse(value) : null;
export class Repository {
  constructor(config) {
    this.config = config;
    if (config.databasePath !== ':memory:') mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,label TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
      CREATE TABLE IF NOT EXISTS web_sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL,account_label TEXT NOT NULL,encrypted_state TEXT,identity_json TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_owners(provider_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,selection_json TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,release_at TEXT NOT NULL,run_at TEXT,checked_at TEXT,checked_account TEXT,test_summary TEXT,prepared_at TEXT,finished_at TEXT,error TEXT,created_at TEXT NOT NULL,UNIQUE(user_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id),at TEXT NOT NULL,message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id),hour INTEGER NOT NULL,court INTEGER NOT NULL,status TEXT NOT NULL,evidence TEXT,message TEXT,created_at TEXT NOT NULL,finished_at TEXT,UNIQUE(job_id,hour));
      CREATE TABLE IF NOT EXISTS account_locks(user_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(user_id,created_at);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,run_at);
      CREATE INDEX IF NOT EXISTS events_job ON events(user_id,job_id,id);
      CREATE INDEX IF NOT EXISTS sessions_user ON web_sessions(user_id);
    `);
    // Ownership outlives the reusable session. Disconnecting must not create a
    // second booking coordinator for an identity with historical/uncertain writes.
    for(const row of this.db.prepare('SELECT user_id,identity_json FROM connections').all()){
      const identity=safeJSON(row.identity_json);
      if(identity?.verified===true&&identity.id)this.db.prepare('INSERT OR IGNORE INTO provider_owners VALUES(?,?,?)').run(identity.id,row.user_id,new Date().toISOString());
    }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createInvite(label = '', ttlMs = 48 * 3600000) {
    const code = token(24);
    this.db.prepare('INSERT INTO invites(hash,label,expires_at) VALUES(?,?,?)').run(digest(code), String(label).slice(0,80), Date.now() + ttlMs);
    return code;
  }
  register({ name, username, passwordHash, invite }) {
    return this.transaction(() => {
      const invitation = this.db.prepare('SELECT * FROM invites WHERE hash=? AND used_at IS NULL AND expires_at>?').get(digest(invite), Date.now());
      if (!invitation) throw new HttpError(400, 'This invitation is invalid, expired or already used.');
      if (this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count >= this.config.maxAccounts) throw new HttpError(409, 'Account capacity has been reached. Contact the host.');
      if (this.db.prepare('SELECT id FROM users WHERE username=?').get(username)) throw new HttpError(409, 'This username is unavailable.');
      const user = { id: randomUUID(), name, username, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id, name, username, passwordHash, user.createdAt);
      this.db.prepare('UPDATE invites SET used_at=? WHERE hash=?').run(Date.now(), digest(invite));
      return user;
    });
  }
  findUser(username) {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    return row ? { id: row.id, name: row.name, username: row.username, passwordHash: row.password_hash } : null;
  }
  getUser(id) { return this.db.prepare('SELECT id,name,username FROM users WHERE id=?').get(id) || null; }
  listUsers() { return this.db.prepare('SELECT id,name,username,created_at AS createdAt FROM users ORDER BY created_at').all(); }
  createSession(userId) {
    const session = { token: token(), csrf: token(), expiresAt: Date.now() + this.config.sessionTtlMs };
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(digest(session.token), userId, session.csrf, session.expiresAt);
    return session;
  }
  getSession(rawToken) {
    if (!rawToken || rawToken.length > 100) return null;
    const row = this.db.prepare('SELECT s.user_id,s.csrf,s.expires_at,u.name,u.username FROM web_sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?').get(digest(rawToken), Date.now());
    return row ? { user: { id: row.user_id, name: row.name, username: row.username }, csrf: row.csrf, expiresAt: row.expires_at } : null;
  }
  deleteSession(rawToken) { if (rawToken) this.db.prepare('DELETE FROM web_sessions WHERE hash=?').run(digest(rawToken)); }
  getConnection(userId) {
    const row = this.db.prepare('SELECT status,account_label,identity_json,updated_at FROM connections WHERE user_id=?').get(userId);
    return row ? { status: row.status, accountLabel: row.account_label, identity: safeJSON(row.identity_json), updatedAt: row.updated_at } : { status: 'disconnected', accountLabel: '' };
  }
  saveConnection(userId, { status = 'connected', accountLabel, state, identity = null }) {
    if (!this.getUser(userId)) throw new HttpError(404, 'Account not found.');
    if (!['connected', 'simulated', 'rehearsal', 'needs_login', 'disconnected'].includes(status)) throw new HttpError(400, 'Invalid connection status.');
    if (typeof accountLabel !== 'string' || !accountLabel.trim() || accountLabel.length > 200) throw new HttpError(400, 'The booking account could not be identified.');
    return this.transaction(() => {
      const normalized = accountLabel.trim().toLocaleLowerCase('en');
      if(identity?.verified===true&&identity.id){
        if(typeof identity.id!=='string'||identity.id.length>256)throw new HttpError(400,'Invalid provider identity.');
        const owner=this.db.prepare('SELECT user_id FROM provider_owners WHERE provider_id=?').get(identity.id);
        if(owner&&owner.user_id!==userId)throw new HttpError(409,'This booking account belongs to another scheduler user, including previous connections. Contact the host to review account ownership.');
        const duplicate=this.db.prepare('SELECT identity_json FROM connections WHERE user_id<>? AND status=?').all(userId,'connected').some(row=>safeJSON(row.identity_json)?.id===identity.id);
        if(duplicate)throw new HttpError(409,'This booking account is already connected to another scheduler user.');
        this.db.prepare('INSERT OR IGNORE INTO provider_owners VALUES(?,?,?)').run(identity.id,userId,new Date().toISOString());
      }
      if (identity?.kind === 'visible_account_label' && this.db.prepare('SELECT user_id,account_label FROM connections WHERE user_id<>? AND status=?').all(userId, 'connected').some(row => row.account_label.trim().toLocaleLowerCase('en') === normalized)) throw new HttpError(409, 'This booking account label is already connected. Contact the host if this is a different person with the same name.');
      this.db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,account_label=excluded.account_label,encrypted_state=excluded.encrypted_state,identity_json=excluded.identity_json,updated_at=excluded.updated_at').run(userId, status, accountLabel.trim(), state ? encryptState(this.config.encryptionKey, userId, state) : null, JSON.stringify(identity), new Date().toISOString());
      return this.getConnection(userId);
    });
  }
  loadProviderSession(userId) {
    const row = this.db.prepare('SELECT encrypted_state FROM connections WHERE user_id=? AND status=?').get(userId, 'connected');
    return row?.encrypted_state ? decryptState(this.config.encryptionKey, userId, row.encrypted_state) : null;
  }
  deleteConnection(userId) {
    this.transaction(() => {
      if (this.db.prepare("SELECT id FROM jobs WHERE user_id=? AND status IN ('preparing','running')").get(userId)) throw new HttpError(409, 'A booking is executing. Stop it and check its result before disconnecting.');
      this.db.prepare('DELETE FROM connections WHERE user_id=?').run(userId);
      this.db.prepare("UPDATE jobs SET status='needs_login',error='Booking account disconnected.' WHERE user_id=? AND status='armed'").run(userId);
    });
    return this.getConnection(userId);
  }
  createJob(userId, plan, mode) {
    const selection = JSON.stringify({ date: plan.date, start: plan.start, courts: plan.courts, allowSwitch: plan.allowSwitch, authorization: false });
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,selection_json,mode FROM jobs WHERE user_id=? AND idempotency_key=?').get(userId, plan.idempotencyKey);
      if (existing) {
        const original = safeJSON(existing.selection_json); original.authorization = false;
        if (JSON.stringify(original) !== selection || existing.mode !== mode) throw new HttpError(409, 'That request identifier belongs to a different plan.');
        return this.getJob(userId, existing.id);
      }
      if (this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND status IN ('draft','armed','preparing','running')").get(userId).count >= 20) throw new HttpError(409, 'Keep at most 20 unfinished plans.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO jobs(id,user_id,idempotency_key,selection_json,mode,status,release_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,userId,plan.idempotencyKey,selection,mode,'draft',plan.releaseAt,new Date().toISOString());
      this.addEvent(userId,id,mode === 'rehearsal' ? 'Rehearsal draft saved. No real booking will be made.' : 'Draft saved. Test these exact sessions before scheduling.');
      return this.getJob(userId,id);
    });
  }
  #job(row) {
    if (!row) return null;
    const attempts = this.db.prepare('SELECT id,hour,court,status,evidence,message,created_at AS createdAt,finished_at AS finishedAt FROM attempts WHERE user_id=? AND job_id=? ORDER BY hour').all(row.user_id,row.id);
    const events = this.db.prepare('SELECT at,message FROM events WHERE user_id=? AND job_id=? ORDER BY id DESC LIMIT 100').all(row.user_id,row.id).reverse();
    return { id:row.id,userId:row.user_id,...safeJSON(row.selection_json),mode:row.mode,status:row.status,releaseAt:row.release_at,runAt:row.run_at,checkedAt:row.checked_at,checkedAccount:row.checked_account,testSummary:row.test_summary,preparedAt:row.prepared_at,finishedAt:row.finished_at,error:row.error,createdAt:row.created_at,results:attempts,events };
  }
  getJob(userId,id) { return this.#job(this.db.prepare('SELECT * FROM jobs WHERE user_id=? AND id=?').get(userId,id)); }
  listJobs(userId) { return this.db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId).map(row => this.#job(row)); }
  listRunnableJobs() { return this.db.prepare("SELECT * FROM jobs WHERE status IN ('armed','preparing') ORDER BY run_at,created_at").all().map(row=>this.#job(row)); }
  updateJob(userId,id,patch) {
    const names = { status:'status',runAt:'run_at',checkedAt:'checked_at',checkedAccount:'checked_account',testSummary:'test_summary',preparedAt:'prepared_at',preparationStartedAt:'prepared_at',finishedAt:'finished_at',error:'error' };
    if (!this.getJob(userId,id)) throw new HttpError(404, 'Schedule not found.');
    for (const key of Object.keys(patch)) if (!(key in names)) throw Error(`Unsupported job field ${key}.`);
    const entries = Object.entries(patch);
    if (entries.length) this.db.prepare(`UPDATE jobs SET ${entries.map(([key])=>`${names[key]}=?`).join(',')} WHERE user_id=? AND id=?`).run(...entries.map(([,value])=>value ?? null),userId,id);
    return this.getJob(userId,id);
  }
  addEvent(userId,jobId,message) {
    if (!this.db.prepare('SELECT id FROM jobs WHERE user_id=? AND id=?').get(userId,jobId)) throw new HttpError(404, 'Schedule not found.');
    this.db.prepare('INSERT INTO events(user_id,job_id,at,message) VALUES(?,?,?,?)').run(userId,jobId,new Date().toISOString(),String(message).slice(0,500));
  }
  armJob(userId,id,{authorization,now=Date.now()}={}) {
    return this.transaction(()=>{
      const job = this.getJob(userId,id), connection=this.getConnection(userId);
      if (!job) throw new HttpError(404,'Schedule not found.');
      if(authorization!==true)throw new HttpError(400,'Confirm authorization for these exact sessions.');
      if (job.status==='armed') return job;
      if (job.status!=='draft' || job.results.length) throw new HttpError(409,'This plan cannot be scheduled.');
      if (!job.checkedAt || now-Date.parse(job.checkedAt)>86400000 || Date.parse(job.checkedAt)>now || job.checkedAccount!==connection.accountLabel || Date.parse(connection.updatedAt)>Date.parse(job.checkedAt)) throw new HttpError(409,'Run a successful test for the connected account first.');
      if (!['connected','simulated','rehearsal'].includes(connection.status)) throw new HttpError(409,'Connect your booking account first.');
      if (job.mode !== this.config.mode) throw new HttpError(409,'The service mode changed. Create a new plan.');
      if (job.mode==='live' && (!this.config.liveEnabled || !this.config.production || connection.status!=='connected')) throw new HttpError(409,'Live booking is not enabled on this host.');
      if(job.mode==='live'&&!(connection.identity?.kind==='configured_dom_identity'&&connection.identity.verified===true&&connection.identity.id))throw new HttpError(409,'Live booking requires a verified stable account identity. The host must validate the provider integration first.');
      if (job.mode==='live' && Date.parse(job.releaseAt)<=now) throw new HttpError(409,'The release time has passed. Choose a future release.');
      for (const row of this.db.prepare("SELECT * FROM jobs WHERE user_id=? AND id<>? AND status IN ('armed','preparing','running','confirmed','partial','unknown','needs_review')").all(userId,id)) {
        const other=safeJSON(row.selection_json);
        if (other.date===job.date && job.start<other.start+2 && other.start<job.start+2) throw new HttpError(409,'An overlapping plan already exists for this account.');
      }
      const runAt = new Date(job.mode==='rehearsal'?now+5000:Date.parse(job.releaseAt)).toISOString();
      const selection=safeJSON(this.db.prepare('SELECT selection_json FROM jobs WHERE user_id=? AND id=?').get(userId,id).selection_json);
      selection.authorization=true;
      this.db.prepare('UPDATE jobs SET selection_json=? WHERE user_id=? AND id=?').run(JSON.stringify(selection),userId,id);
      this.updateJob(userId,id,{status:'armed',runAt,error:null});
      this.addEvent(userId,id,job.mode==='rehearsal'?'Rehearsal accepted by the server; it will run in five seconds.':'Schedule accepted by the server. You can close this page.');
      return this.getJob(userId,id);
    });
  }
  stopJob(userId,id) {
    return this.transaction(()=>{
      const job=this.getJob(userId,id);
      if(!job)throw new HttpError(404,'Schedule not found.');
      if(job.status==='stopped')return job;
      if(job.results.some(a=>['pending','unknown'].includes(a.status)))throw new HttpError(409,'A submission is unresolved. Check the official booking history.');
      if(!['draft','armed','preparing','running','needs_login','blocked'].includes(job.status))throw new HttpError(409,'This schedule has already finished. Existing reservations are unchanged.');
      this.updateJob(userId,id,{status:'stopped',finishedAt:new Date().toISOString()});
      this.addEvent(userId,id,'Future execution stopped. No existing reservation was cancelled.');
      return this.getJob(userId,id);
    });
  }
  acquireLease(name,owner,ttlMs,now=Date.now()) {
    return this.transaction(()=>{
      const lease=this.db.prepare('SELECT * FROM leases WHERE name=?').get(name);
      if(lease&&lease.owner!==owner&&lease.expires_at>now)return false;
      this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(name,owner,now+ttlMs);return true;
    });
  }
  renewLease(name,owner,ttlMs,now=Date.now()) { return this.db.prepare('UPDATE leases SET expires_at=? WHERE name=? AND owner=? AND expires_at>?').run(now+ttlMs,name,owner,now).changes===1; }
  assertLease(name,owner,now=Date.now()) { if(!owner||!this.db.prepare('SELECT name FROM leases WHERE name=? AND owner=? AND expires_at>?').get(name,owner,now))throw new HttpError(409,'The booking worker no longer owns its execution lease.');return true; }
  releaseLease(name,owner) { this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name,owner); }
  claimJob(userId,jobId,owner) {
    return this.transaction(()=>{
      this.assertLease('scheduler',owner);
      const job=this.getJob(userId,jobId);
      if(!job||!ACTIVE.includes(job.status))return false;
      const lock=this.db.prepare('SELECT * FROM account_locks WHERE user_id=?').get(userId);
      if(lock)return lock.job_id===jobId&&lock.owner===owner;
      this.db.prepare('INSERT INTO account_locks VALUES(?,?,?)').run(userId,jobId,owner);return true;
    });
  }
  releaseJob(userId,jobId,owner) { this.db.prepare('DELETE FROM account_locks WHERE user_id=? AND job_id=? AND owner=?').run(userId,jobId,owner); }
  beginAttempt(userId,jobId,{hour,court,leaseOwner}) {
    return this.transaction(()=>{
      this.assertLease('scheduler',leaseOwner);
      const job=this.getJob(userId,jobId), now=Date.now();
      if(!job||job.status!=='running'||!job.authorization||![job.start,job.start+1].includes(hour)||!job.courts.includes(court))throw new HttpError(409,'This submission is outside the authorized plan.');
      if(!job.runAt||now<Date.parse(job.runAt)||now>Date.parse(job.runAt)+120000)throw new HttpError(409,'This submission is outside the execution window.');
      if(!this.db.prepare('SELECT user_id FROM account_locks WHERE user_id=? AND job_id=? AND owner=?').get(userId,jobId,leaseOwner))throw new HttpError(409,'This account is controlled by another worker.');
      if(this.db.prepare('SELECT id FROM attempts WHERE job_id=? AND hour=?').get(jobId,hour))throw new HttpError(409,'This hour already has a recorded submission attempt.');
      const competing=this.db.prepare("SELECT a.id,j.selection_json FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.court=? AND a.hour=? AND a.status IN ('pending','confirmed','unknown') AND j.mode=?").all(court,hour,job.mode);
      if(competing.some(row=>safeJSON(row.selection_json).date===job.date)){ const error=new HttpError(409,'Another schedule already has an active claim on this court and hour.');error.code='RESOURCE_BUSY';throw error; }
      const attempt={id:randomUUID(),hour,court,status:'pending'};
      this.db.prepare('INSERT INTO attempts(id,user_id,job_id,hour,court,status,created_at) VALUES(?,?,?,?,?,?,?)').run(attempt.id,userId,jobId,hour,court,'pending',new Date().toISOString());
      this.addEvent(userId,jobId,`Submission intent recorded for court ${court}, ${String(hour).padStart(2,'0')}:00.`);
      return attempt;
    });
  }
  finishAttempt(userId,jobId,attemptId,{status,evidence=null,message=null}) {
    if(!['confirmed','unknown','rejected'].includes(status))throw Error('Invalid attempt result.');
    const result=this.db.prepare("UPDATE attempts SET status=?,evidence=?,message=?,finished_at=? WHERE id=? AND user_id=? AND job_id=? AND status IN ('pending','unknown')").run(status,evidence?String(evidence).slice(0,300):null,message?String(message).slice(0,500):null,new Date().toISOString(),attemptId,userId,jobId);
    if(!result.changes)throw new HttpError(409,'No matching unresolved submission exists.');
    return this.getJob(userId,jobId);
  }
  recoverInterruptedJobs(owner) {
    return this.transaction(()=>{
      this.assertLease('scheduler',owner);
      const jobs=this.db.prepare("SELECT * FROM jobs WHERE status IN ('running','preparing')").all();
      for(const row of jobs){
        const attempts=this.db.prepare('SELECT * FROM attempts WHERE job_id=?').all(row.id);
        this.db.prepare("UPDATE attempts SET status='unknown' WHERE job_id=? AND status='pending'").run(row.id);
        this.updateJob(row.user_id,row.id,{status:attempts.length?'unknown':'blocked',error:attempts.length?'Worker interrupted after a recorded attempt. Check official booking history; no automatic retry.':'Worker interrupted during preparation. Retest before scheduling.'});
        this.addEvent(row.user_id,row.id,'Interrupted execution recovered conservatively. No booking was repeated.');
      }
      this.db.prepare('DELETE FROM account_locks').run();return jobs.length;
    });
  }
  stats() { return { users:this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,jobs:this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,unresolved:this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status IN ('pending','unknown')").get().n }; }
}
export const createRepository = config => new Repository(config);
