import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BookingProvider } from './provider.mjs';
import { RemoteLoginManager } from './remote-login.mjs';

const fail = (text,status=409)=>Object.assign(new Error(text),{status,statusCode:status});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const ACTIVE = new Set(['armed','preparing','running']);
const MAX_LATENESS = 60000;
const DEADLINE = 120000;

export function outcomeStatus(results) {
  if(results.some(r=>r.status==='unknown'||r.status==='pending'))return 'unknown';
  const count=results.filter(r=>r.status==='confirmed').length;
  return count===2?'confirmed':count===1?'partial':'failed';
}

/** One host owns the scheduler lease. Account contexts never share login state.
 * The repository is the authority for submission grants; memory is not a booking ledger.
 */
export class CourtRunner {
  constructor({repository,config,provider,now=()=>Date.now()}) {
    this.repo=repository;this.config=config;this.now=now;
    this.provider=provider??new BookingProvider(config);
    this.owner=`scheduler-${randomUUID()}`;
    this.inflight=new Map();this.accounts=new Map();this.testing=new Set();
    this.running=false;this.stopping=false;this.ticking=false;this.lastHeartbeat=0;
    this.remote=new RemoteLoginManager({provider:this.provider,repository,config,now,assertIdle:id=>this.assertIdle(id)});
  }
  assertIdle(userId) {
    if(this.accounts.has(userId)||this.testing.has(userId))throw fail('This account is currently preparing, testing or executing a booking.');
  }
  connectionStart(userId){return this.remote.start(userId);}
  connectionFrame(userId,id){return this.remote.frame(userId,id);}
  connectionInput(userId,id,input){return this.remote.input(userId,id,input);}
  connectionCredentials(userId,id,input){return this.remote.credentials(userId,id,input);}
  connectionFinish(userId,id){return this.remote.finish(userId,id);}
  cancelConnection(userId,id){return this.remote.cancel(userId,id);}
  async disconnect(userId) {
    await this.repo.deleteConnection(userId);
    await this.remote.cancelUser(userId);
    for(const record of this.inflight.values()) if(record.job.userId===userId){record.cancelled=true;await this.provider.closePrepared(record.prepared);}
    return {status:'disconnected',accountLabel:null};
  }
  async connection(userId,expected) {
    const connection=await this.repo.getConnection(userId);
    const okay=this.config.mode==='rehearsal'
      ? connection?.status==='simulated'&&connection.identity?.kind==='rehearsal'
      : connection?.status==='connected';
    if(!okay||!connection.accountLabel)throw fail(this.config.mode==='rehearsal'?'Connect a rehearsal account first.':'Reconnect the booking account before continuing.');
    if(expected&&expected!==connection.accountLabel)throw fail('The connected account changed. Test the schedule again.');
    return connection;
  }
  async testJob(userId,job) {
    this.assertIdle(userId);
    if(this.remote.starting.has(userId)||[...this.remote.sessions.values()].some(s=>s.userId===userId))throw fail('Finish account connection before testing.');
    if(this.testing.size>=3)throw fail('Three account tests are already running. Try again shortly.',429);
    if(this.inflight.size)throw fail('Scheduled bookings are preparing or executing. Try the read-only test again after they finish.');
    if(!job||job.userId!==userId||job.mode!==this.config.mode)throw fail('Schedule not found.',404);
    if(!['draft','failed','blocked'].includes(job.status)||job.results?.length)throw fail('Only an unsubmitted draft can be tested.');
    this.testing.add(userId);
    try {
      const connection=await this.connection(userId);
      let result;
      if(this.config.mode==='rehearsal')result={accountLabel:connection.accountLabel,summary:'Rehearsal only: two simulated free sessions validated. No request was sent to KU Leuven.'};
      else result=await this.provider.test(job,connection,await this.repo.loadProviderSession(userId));
      await this.repo.updateJob(userId,job.id,{status:'draft',checkedAt:new Date(this.now()).toISOString(),checkedAccount:result.accountLabel,testSummary:result.summary,error:null});
      await this.repo.addEvent(userId,job.id,result.summary);
      return this.repo.getJob(userId,job.id);
    } catch(error) {
      await this.repo.updateJob(userId,job.id,{checkedAt:null,checkedAccount:null,testSummary:null,error:'The test could not validate this schedule. Check the account connection and official booking details.'});
      throw error;
    } finally {this.testing.delete(userId);}
  }
  async start() {
    if(this.running)return true;
    if(this.stopping)throw fail('The scheduler has stopped. Restart the service.');
    if(!await this.repo.acquireLease('scheduler',this.owner,30000))throw fail('Another process owns the scheduler. Only one service may run against this database.',503);
    this.running=true;this.lastHeartbeat=this.now();
    await this.repo.recoverInterruptedJobs(this.owner);
    this.timer=setInterval(()=>this.tick().catch(()=>{}),200);this.timer.unref?.();
    await this.tick();return true;
  }
  async tick() {
    if(!this.running||this.ticking||this.stopping)return;
    this.ticking=true;
    try {
      if(this.now()-this.lastHeartbeat>=10000){
        if(!await this.repo.renewLease('scheduler',this.owner,30000)){
          this.running=false;for(const r of this.inflight.values())r.cancelled=true;return;
        }
        this.lastHeartbeat=this.now();
      }
      const jobs=await this.repo.listRunnableJobs();
      const sorted=[...jobs].sort((a,b)=>Date.parse(a.runAt??a.releaseAt)-Date.parse(b.runAt??b.releaseAt)||a.createdAt.localeCompare(b.createdAt));
      for(const job of sorted) {
        const runAt=Date.parse(job.runAt??job.releaseAt);
        if(!Number.isFinite(runAt)){await this.repo.updateJob(job.userId,job.id,{status:'blocked',error:'Invalid schedule time.'});continue;}
        if(this.inflight.has(job.id)||this.accounts.has(job.userId)||this.testing.has(job.userId))continue;
        if(this.inflight.size>=Math.min(30,this.config.maxConcurrentWorkers??30))break;
        const prepMs=this.config.mode==='rehearsal'?5000:(this.config.preparationMs??60000);
        if(runAt-this.now()>prepMs)continue;
        if(!await this.repo.claimJob(job.userId,job.id,this.owner))continue;
        const record={job,runAt,prepared:null,cancelled:false,promise:null};
        this.accounts.set(job.userId,job.id);this.inflight.set(job.id,record);
        record.promise=this.execute(record).catch(()=>{}).finally(async()=>{
          await this.provider.closePrepared(record.prepared).catch(()=>{});
          try { await this.repo.releaseJob(job.userId,job.id,this.owner); } catch {}
          this.inflight.delete(job.id);if(this.accounts.get(job.userId)===job.id)this.accounts.delete(job.userId);
        });
      }
    } finally {this.ticking=false;}
  }
  async canRun(record) {
    if(record.cancelled||this.stopping||!this.running)throw fail('Execution stopped before the next submission.');
    if(!await this.repo.assertLease('scheduler',this.owner))throw fail('The scheduler no longer owns execution.');
    const latest=await this.repo.getJob(record.job.userId,record.job.id);
    if(!latest||!ACTIVE.has(latest.status))throw fail('The schedule is no longer active.');
    await this.connection(record.job.userId,record.job.checkedAccount);
    if(this.now()>record.runAt+DEADLINE)throw fail('The booking deadline passed.');
    return latest;
  }
  async execute(record) {
    const {job,runAt}=record;const userId=job.userId;
    try {
      if(job.mode!==this.config.mode)throw fail('This schedule belongs to another execution mode.');
      if(this.config.mode==='live'&&!this.config.liveEnabled)throw fail('Live booking is disabled.');
      if(this.now()>runAt+MAX_LATENESS)throw fail('The release was missed. No booking was submitted.');
      const testAt=Date.parse(job.checkedAt);
      if(!Number.isFinite(testAt)||this.now()-testAt>86400000||testAt>this.now())throw fail('The schedule requires a fresh read-only test.');
      const connection=await this.connection(userId,job.checkedAccount);
      if(this.config.mode==='live'&&(!connection.identity?.verified||connection.identity.kind!=='configured_dom_identity'))throw fail('Stable provider account identity has not been verified. Live execution is blocked.');
      await this.repo.updateJob(userId,job.id,{status:'preparing',preparationStartedAt:new Date(this.now()).toISOString(),error:null});
      await this.repo.addEvent(userId,job.id,this.config.mode==='rehearsal'?'Preparing isolated rehearsal account.':'Preparing two isolated booking pages. No reservation is submitted before release.');
      record.prepared=this.config.mode==='live'
        ?await this.provider.prepare(job,connection,await this.repo.loadProviderSession(userId))
        :{available:[job.courts.slice(),job.courts.slice()],accountLabel:connection.accountLabel,closed:true};
      await this.repo.updateJob(userId,job.id,{preparedAt:new Date(this.now()).toISOString()});
      const wall=this.now(),mono=performance.now();
      while(this.now()<runAt){
        await this.canRun(record);
        if(Math.abs((this.now()-wall)-(performance.now()-mono))>2000)throw fail('The host clock changed during preparation. Execution stopped.');
        await pause(Math.min(200,Math.max(1,runAt-this.now())));
      }
      await this.canRun(record);
      if(this.now()>runAt+MAX_LATENESS)throw fail('Preparation missed the release window. No booking was submitted.');
      await this.repo.updateJob(userId,job.id,{status:'running'});
      await this.repo.addEvent(userId,job.id,this.config.mode==='rehearsal'?'Rehearsal started. These results are simulated.':'Release reached. Starting the authorized booking attempt.');
      if(job.allowSwitch) {
        // Each hour has one durable grant. Independent accounts and hours can progress in parallel.
        await Promise.allSettled([this.runHour(record,0),this.runHour(record,1)]);
      } else {
        await this.runSameCourt(record);
      }
      const latest=await this.repo.getJob(userId,job.id);
      if(!latest||(!ACTIVE.has(latest.status)&&!(latest.results?.length)))return;
      const status=outcomeStatus(latest.results??[]);
      await this.repo.updateJob(userId,job.id,{status,finishedAt:new Date(this.now()).toISOString()});
      await this.repo.addEvent(userId,job.id,status==='unknown'?'An outcome needs review. Check My bookings on the official site before trying again.':status==='partial'?'One hour was confirmed. It has been kept; no reservation was cancelled.':status==='confirmed'?(this.config.mode==='rehearsal'?'Rehearsal completed with two simulated confirmations.':'Both official page confirmations were observed. Verify the reservation details in My bookings.'):'No two-hour booking was confirmed.');
    } catch {
      const latest=await this.repo.getJob(userId,job.id);
      if(!latest)return;
      const attempted=latest.results?.length>0;
      if(attempted){
        for(const a of latest.results.filter(r=>r.status==='pending'))await this.repo.finishAttempt(userId,job.id,a.id,{status:'unknown',evidence:null,message:'Execution interrupted after a submission grant. Check My bookings before retrying.'});
        const updated=await this.repo.getJob(userId,job.id);
        await this.repo.updateJob(userId,job.id,{status:outcomeStatus(updated.results??[]),finishedAt:new Date(this.now()).toISOString(),error:'Execution was interrupted. Existing results are retained; no automatic retry was made.'});
      }else if(ACTIVE.has(latest.status))await this.repo.updateJob(userId,job.id,{status:'blocked',finishedAt:new Date(this.now()).toISOString(),error:'Preparation or account validation failed, or execution was stopped. No final booking click was made.'});
      await this.repo.addEvent(userId,job.id,'Execution stopped. Inspect the result and reconnect or test again when required.');
    }
  }
  async ready(record,index,court) {
    await this.canRun(record);
    if(this.config.mode==='live')await this.provider.readyCandidate(record.prepared,record.job,index,court);
    await this.canRun(record);
  }
  async submit(record,index,court,attempt) {
    const {job}=record;
    try {
      await this.canRun(record);
      const outcome=this.config.mode==='live'
        ?await this.provider.submit(record.prepared,job,index,court,()=>this.canRun(record))
        :{status:'confirmed',evidence:'rehearsal_only'};
      await this.repo.finishAttempt(job.userId,job.id,attempt.id,{...outcome,message:outcome.status==='confirmed'?(this.config.mode==='live'?'Official booking-success marker observed.':'Simulated booking confirmation. No official booking was made.'):'The official site did not confirm this hour. Check My bookings.'});
    }catch{
      await this.repo.finishAttempt(job.userId,job.id,attempt.id,{status:'unknown',evidence:null,message:'A submission was authorized, but its result is unknown. Check My bookings; no automatic retry will occur.'});
    }
  }
  async runHour(record,index) {
    const {job}=record;
    for(const court of record.prepared.available[index]){
      try {await this.ready(record,index,court);}catch{continue;}
      let attempt;
      try {attempt=await this.repo.beginAttempt(job.userId,job.id,{hour:job.start+index,court,leaseOwner:this.owner});}
      catch(error){if(error.code==='RESOURCE_BUSY')continue;throw error;}
      await this.submit(record,index,court,attempt);return;
    }
    await this.repo.addEvent(job.userId,job.id,`No eligible permitted court could be submitted for ${String(job.start+index).padStart(2,'0')}:00.`);
  }
  async runSameCourt(record) {
    const {job}=record;
    const candidates=job.courts.filter(c=>record.prepared.available.every(list=>list.includes(c)));
    for(const court of candidates){
      try {await Promise.all([this.ready(record,0,court),this.ready(record,1,court)]);}catch{continue;}
      // Grants are acquired separately because provider bookings are not an atomic pair.
      // Once either hour receives a grant, never move the pair to another court.
      let first;
      try{first=await this.repo.beginAttempt(job.userId,job.id,{hour:job.start,court,leaseOwner:this.owner});}
      catch(error){if(error.code==='RESOURCE_BUSY')continue;throw error;}
      const writes=[this.submit(record,0,court,first)];
      try{
        const second=await this.repo.beginAttempt(job.userId,job.id,{hour:job.start+1,court,leaseOwner:this.owner});
        writes.push(this.submit(record,1,court,second));
      }catch{await this.repo.addEvent(job.userId,job.id,'The second hour could not receive a submission grant. No other court was substituted.');}
      await Promise.allSettled(writes);return;
    }
    await this.repo.addEvent(job.userId,job.id,'No single permitted court passed both hour checks. Nothing was submitted.');
  }
  async stop() {
    this.stopping=true;this.running=false;clearInterval(this.timer);
    for(const r of this.inflight.values())r.cancelled=true;
    await this.remote.close();
    await Promise.allSettled([...this.inflight.values()].map(r=>r.promise));
    await this.provider.close();
    await this.repo.releaseLease('scheduler',this.owner);
  }
}

export function createRunner(options){return new CourtRunner(options);}
