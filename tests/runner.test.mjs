import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { Repository } from '../src/repository.mjs';
import { CourtRunner,outcomeStatus } from '../src/scheduler.mjs';
import { allowedBrowserUrl,BookingProvider } from '../src/provider.mjs';
import { RemoteLoginManager } from '../src/remote-login.mjs';

function config(mode='rehearsal') {return {databasePath:':memory:',encryptionKey:randomBytes(32),maxAccounts:30,sessionTtlMs:3600000,mode,liveEnabled:mode==='live',production:true,maxConcurrentWorkers:30,preparationMs:60000,bookingUrl:'https://usc.kuleuven.cloud/bookings/rent?tags=132'};}
function account(repo,index,mode='rehearsal') {
  const user=repo.register({name:`Person ${index}`,username:`person${index}`,passwordHash:'synthetic-only',invite:repo.createInvite()});
  repo.saveConnection(user.id,{status:mode==='live'?'connected':'simulated',accountLabel:`Rehearsal ${index}`,identity:mode==='live'?{kind:'configured_dom_identity',verified:true,id:`stable-${index}`}:{kind:'rehearsal',verified:false},...(mode==='live'?{state:{cookies:[],origins:[]}}:{})});
  return user;
}
function plan(repo,user,index=0,mode='rehearsal') {
  return repo.createJob(user.id,{date:`2027-01-${String(index+1).padStart(2,'0')}`,start:11,courts:[1,2,3],allowSwitch:true,authorization:false,idempotencyKey:randomUUID(),releaseAt:new Date(Date.now()+86400000).toISOString()},mode);
}
const quietProvider=()=>({closePrepared:async()=>{},close:async()=>{}});
async function settle(runner,repo,jobs) {
  const deadline=Date.now()+6000;
  while(jobs.some(j=>['armed','preparing','running'].includes(repo.getJob(j.userId,j.id).status))&&Date.now()<deadline){await runner.tick();await new Promise(r=>setTimeout(r,20));}
  assert.ok(jobs.every(j=>!['armed','preparing','running'].includes(repo.getJob(j.userId,j.id).status)),'Jobs must reach a terminal state within the fixture deadline.');
}

test('30 isolated accounts complete server-side rehearsals with tenant-scoped results',async()=>{
  const c=config(),repo=new Repository(c),runner=new CourtRunner({repository:repo,config:c,provider:quietProvider()});
  const jobs=[];
  try {
    for(let i=0;i<30;i++){
      const user=account(repo,i),job=plan(repo,user,i);
      await runner.testJob(user.id,job);repo.armJob(user.id,job.id,{authorization:true});
      repo.updateJob(user.id,job.id,{runAt:new Date(Date.now()-10).toISOString()});jobs.push(job);
    }
    await runner.start();await settle(runner,repo,jobs);
    for(const job of jobs){
      const result=repo.getJob(job.userId,job.id);
      assert.equal(result.status,'confirmed');assert.equal(result.results.length,2);
      assert.ok(result.results.every(a=>a.evidence==='rehearsal_only'));
      assert.equal(repo.listJobs(job.userId).length,1);
      const foreign=jobs.find(j=>j.userId!==job.userId);
      assert.equal(repo.getJob(foreign.userId,job.id),null);
    }
  }finally{await runner.stop();repo.close();}
});

test('shared court claims prevent four users from all confirming the same three courts',async()=>{
  const c=config(),repo=new Repository(c),runner=new CourtRunner({repository:repo,config:c,provider:quietProvider()}),jobs=[];
  try{
    for(let i=0;i<4;i++){const u=account(repo,i),j=plan(repo,u,0);await runner.testJob(u.id,j);repo.armJob(u.id,j.id,{authorization:true});repo.updateJob(u.id,j.id,{runAt:new Date(Date.now()-10).toISOString()});jobs.push(j);}
    await runner.start();await settle(runner,repo,jobs);
    const results=jobs.map(j=>repo.getJob(j.userId,j.id));
    assert.equal(results.filter(j=>j.status==='confirmed').length,3);
    assert.equal(results.filter(j=>j.status==='failed').length,1);
    const slots=results.flatMap(j=>j.results.filter(a=>a.status==='confirmed').map(a=>`${a.hour}/${a.court}`));
    assert.equal(new Set(slots).size,slots.length);
  }finally{await runner.stop();repo.close();}
});

test('ambiguous provider outcomes keep durable unknown attempts and never auto-repeat',async()=>{
  const c=config('live'),repo=new Repository(c);let submissions=0;
  const provider={...quietProvider(),test:async(j,connection)=>({accountLabel:connection.accountLabel,summary:'Fixture read-only check.'}),prepare:async()=>({available:[[1,2,3],[1,2,3]]}),readyCandidate:async()=>{},submit:async(_p,_j,_i,_c,beforeClick)=>{await beforeClick();submissions++;throw Error('Synthetic network failure after click');}};
  const runner=new CourtRunner({repository:repo,config:c,provider});
  try{
    const u=account(repo,1,'live'),j=plan(repo,u,0,'live');await runner.testJob(u.id,j);repo.armJob(u.id,j.id,{authorization:true});repo.updateJob(u.id,j.id,{runAt:new Date(Date.now()-10).toISOString()});
    await runner.start();await settle(runner,repo,[j]);
    assert.equal(submissions,2);const result=repo.getJob(u.id,j.id);assert.equal(result.status,'unknown');assert.ok(result.results.every(a=>a.status==='unknown'));
    for(let n=0;n<3;n++)await runner.tick();assert.equal(submissions,2);
    assert.throws(()=>repo.armJob(u.id,j.id,{authorization:true}));
  }finally{await runner.stop();repo.close();}
});

test('lease loss during final checks prevents every booking grant',async()=>{
  const c=config('live'),repo=new Repository(c);let submissions=0,runner;
  const provider={...quietProvider(),test:async(j,connection)=>({accountLabel:connection.accountLabel,summary:'Fixture check.'}),prepare:async()=>({available:[[1],[1]]}),readyCandidate:async()=>{repo.releaseLease('scheduler',runner.owner);},submit:async()=>{submissions++;return {status:'confirmed'};}};
  runner=new CourtRunner({repository:repo,config:c,provider});
  try{
    const u=account(repo,1,'live'),j=plan(repo,u,0,'live');await runner.testJob(u.id,j);repo.armJob(u.id,j.id,{authorization:true});repo.updateJob(u.id,j.id,{runAt:new Date(Date.now()-10).toISOString()});
    await runner.start();await settle(runner,repo,[j]);assert.equal(submissions,0);assert.equal(repo.getJob(u.id,j.id).results.length,0);
  }finally{await runner.stop();repo.close();}
});

test('live arm is blocked for display-name-only identity',async()=>{
  const c=config('live'),repo=new Repository(c),runner=new CourtRunner({repository:repo,config:c,provider:quietProvider()});
  try{
    const u=account(repo,1,'live');repo.saveConnection(u.id,{status:'connected',accountLabel:'A visible name',state:{cookies:[],origins:[]},identity:{kind:'visible_account_label',verified:false}});
    const j=plan(repo,u,0,'live');repo.updateJob(u.id,j.id,{checkedAt:new Date().toISOString(),checkedAccount:'A visible name'});
    assert.throws(()=>repo.armJob(u.id,j.id,{authorization:true}),/identity|verified/i);
  }finally{await runner.stop();repo.close();}
});

test('stopping during final readiness preserves stopped state and makes no submission',async()=>{
  const c=config('live'),repo=new Repository(c);let submissions=0,current;
  const provider={...quietProvider(),test:async(j,connection)=>({accountLabel:connection.accountLabel,summary:'Fixture check.'}),prepare:async()=>({available:[[1],[1]]}),readyCandidate:async()=>{repo.stopJob(current.userId,current.id);},submit:async()=>{submissions++;return {status:'confirmed'};}};
  const runner=new CourtRunner({repository:repo,config:c,provider});
  try{
    const u=account(repo,1,'live');current=plan(repo,u,0,'live');await runner.testJob(u.id,current);repo.armJob(u.id,current.id,{authorization:true});repo.updateJob(u.id,current.id,{runAt:new Date(Date.now()-10).toISOString()});
    await runner.start();await settle(runner,repo,[current]);await Promise.allSettled([...runner.inflight.values()].map(r=>r.promise));
    assert.equal(submissions,0);assert.equal(repo.getJob(u.id,current.id).status,'stopped');assert.deepEqual(repo.getJob(u.id,current.id).results,[]);
  }finally{await runner.stop();repo.close();}
});

test('remote browser requests deny local/arbitrary hosts and credentials in URLs',()=>{
  assert.equal(allowedBrowserUrl('https://usc.kuleuven.cloud/bookings/rent?tags=132'),true);
  for(const u of ['http://usc.kuleuven.cloud/','https://127.0.0.1/','https://localhost/','https://10.0.0.1/','https://example.com/','file:///C:/secret','https://usc.kuleuven.cloud.evil.test/','https://person:password@usc.kuleuven.cloud/','https://usc.kuleuven.cloud:444/'])assert.equal(allowedBrowserUrl(u),false,u);
});

test('browser context creation copies only the explicitly supplied account storage',async()=>{
  const options=[],contexts=[];
  const browser={once(){},newContext:async opts=>{options.push(opts);const c={on(){},route:async()=>{},addInitScript:async()=>{},close:async()=>{}};contexts.push(c);return c;},close:async()=>{}};
  const p=new BookingProvider({}, {launch:async()=>browser});
  try{
    const a={cookies:[{name:'session',value:'account-a'}],origins:[]},b={cookies:[{name:'session',value:'account-b'}],origins:[]};
    const ca=await p.createContext(a),cb=await p.createContext(b),fresh=await p.createContext();
    assert.notEqual(ca,cb);assert.notEqual(cb,fresh);assert.deepEqual(options[0].storageState,a);assert.deepEqual(options[1].storageState,b);assert.equal('storageState' in options[2],false);
    assert.equal(options[0].acceptDownloads,false);assert.equal(options[0].serviceWorkers,'block');
  }finally{await p.close();}
});

test('browser launch requires Chromium sandbox and never retries without it',async()=>{
  const calls=[];
  const provider=new BookingProvider({browserChannel:'msedge',chromiumSandbox:false},{launch:async options=>{calls.push(options);throw Error('Host cannot initialize sandbox');}});
  await assert.rejects(provider.browser(),/sandbox/);
  assert.equal(calls.length,1);assert.equal(calls[0].chromiumSandbox,true);assert.equal(calls[0].channel,'msedge');
  assert.equal('args' in calls[0],false);
  await assert.rejects(provider.browser(),/sandbox/);
  assert.equal(calls.length,2);assert.ok(calls.every(options=>options.chromiumSandbox===true));
  await provider.close();
});

function remoteFixture() {
  let saved=0,clock=1000,closed=false;
  const page={on(){},goto:async()=>{},url:()=> 'https://usc.kuleuven.cloud/bookings/rent?token=must-not-be-exposed',isClosed:()=>closed,screenshot:async()=>Buffer.from('synthetic pixels'),viewportSize:()=>({width:1100,height:820}),evaluate:async()=> 'Fixture Owner',mouse:{click:async()=>{},wheel:async()=>{}},keyboard:{insertText:async()=>{},press:async()=>{}}};
  const context={on(){},newPage:async()=>page,pages:()=>[page],storageState:async()=>({cookies:[],origins:[]}),close:async()=>{closed=true;}};
  const repo={listJobs:()=>[],saveConnection:()=>{saved++;},getConnection:()=>({status:'connected',accountLabel:'Fixture Owner'})};
  const provider={createContext:async()=>context,assertOfficial:async()=>{},readIdentity:async()=>({kind:'visible_account_label',verified:false})};
  const manager=new RemoteLoginManager({provider,repository:repo,config:{mode:'live',bookingUrl:'https://usc.kuleuven.cloud/bookings/rent?tags=132'},now:()=>clock});
  return {manager,provider,repo,page,context,get saved(){return saved;},advance:()=>{clock+=700000;}};
}

test('remote handoff is owner scoped, strips query strings, and validates input',async()=>{
  const f=remoteFixture();
  try{
    const s=await f.manager.start('account-a');
    await assert.rejects(f.manager.frame('account-b',s.id),e=>e.status===404);
    const frame=await f.manager.frame('account-a',s.id);assert.equal(frame.url,'https://usc.kuleuven.cloud/bookings/rent');
    await assert.rejects(f.manager.input('account-a',s.id,{type:'click',x:2000,y:0}),e=>e.status===400);
    await assert.rejects(f.manager.input('account-a',s.id,{type:'key',key:'Control+L'}),e=>e.status===400);
    await f.manager.cancel('account-a',s.id);await assert.rejects(f.manager.finish('account-a',s.id));assert.equal(f.saved,0);
  }finally{await f.manager.close();}
});

test('cancelled remote finish cannot revive a session after asynchronous identity checks',async()=>{
  const f=remoteFixture();let entered,continueIdentity;
  const waiting=new Promise(r=>{entered=r;});
  f.provider.readIdentity=async()=>{entered();await new Promise(r=>{continueIdentity=r;});return {kind:'visible_account_label',verified:false};};
  try{
    const s=await f.manager.start('account-a');const finish=f.manager.finish('account-a',s.id);await waiting;
    await f.manager.cancel('account-a',s.id);continueIdentity();await assert.rejects(finish,e=>e.status===410);assert.equal(f.saved,0);
  }finally{await f.manager.close();}
});

test('remote login expires and cannot be fetched after its deadline',async()=>{
  const f=remoteFixture();try{const s=await f.manager.start('account-a');f.advance();await assert.rejects(f.manager.frame('account-a',s.id),e=>e.status===410);}finally{await f.manager.close();}
});

test('unknown is distinct from partial and complete outcomes',()=>{
  assert.equal(outcomeStatus([{status:'confirmed'},{status:'unknown'}]),'unknown');
  assert.equal(outcomeStatus([{status:'confirmed'},{status:'rejected'}]),'partial');
  assert.equal(outcomeStatus([{status:'confirmed'},{status:'confirmed'}]),'confirmed');
});
