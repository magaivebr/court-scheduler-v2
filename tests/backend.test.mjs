import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { Temporal } from '@js-temporal/polyfill';
import { loadConfig } from '../src/config.mjs';
import { Repository } from '../src/repository.mjs';
import { createApp } from '../src/server.mjs';
import { releaseForDate, validatePlan } from '../src/domain.mjs';
import { decryptState } from '../src/security.mjs';

function fixture(overrides={}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'court-v2-test-'));
  const config={...loadConfig({DATA_DIR:dir}),...overrides};
  const repository=new Repository(config);
  return {dir,config,repository,close(){repository.close();rmSync(dir,{recursive:true,force:true});}};
}
const dateAfter=(days=2)=>Temporal.Now.zonedDateTimeISO('Europe/Brussels').toPlainDate().add({days}).toString();
const plan=(overrides={})=>validatePlan({date:dateAfter(),start:11,courts:[1,2,3],allowSwitch:true,authorization:false,idempotencyKey:randomUUID(),...overrides});
function addUser(repo,index=0){return repo.register({name:`Person ${index}`,username:`person${index}`,passwordHash:'test-only',invite:repo.createInvite()});}
function testedJob(repo,user,config,overrides={}){
  repo.saveConnection(user.id,{status:'simulated',accountLabel:`Rehearsal ${user.id}`,identity:{kind:'rehearsal',verified:false}});
  const job=repo.createJob(user.id,plan(overrides),config.mode);
  return repo.updateJob(user.id,job.id,{checkedAt:new Date().toISOString(),checkedAccount:repo.getConnection(user.id).accountLabel,testSummary:'Synthetic read-only validation'});
}

test('Brussels release follows calendar days across both DST transitions',()=>{
  assert.equal(releaseForDate('2026-03-29'),'2026-03-28T08:00:00Z');
  assert.equal(releaseForDate('2026-03-30'),'2026-03-29T07:00:00Z');
  assert.equal(releaseForDate('2026-10-25'),'2026-10-24T07:00:00Z');
  assert.equal(releaseForDate('2026-10-26'),'2026-10-25T08:00:00Z');
  assert.throws(()=>validatePlan({...plan(),userId:'somebody-else'}),/Unknown/);
});

test('production rejects missing HTTPS and vault key',()=>{
  assert.throws(()=>loadConfig({NODE_ENV:'production'}),/HTTPS/);
  const dir=mkdtempSync(path.join(os.tmpdir(),'court-v2-config-'));
  try{assert.throws(()=>loadConfig({NODE_ENV:'production',PUBLIC_ORIGIN:'https://court.example',DATA_DIR:dir}),/SESSION_ENCRYPTION_KEY/);}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('isolated encrypted sessions cannot be swapped across users',()=>{
  const f=fixture();try{
    const a=addUser(f.repository,1),b=addUser(f.repository,2),stateA={cookies:[{name:'a',value:'private-a'}],origins:[]},stateB={cookies:[{name:'b',value:'private-b'}],origins:[]};
    f.repository.saveConnection(a.id,{status:'connected',accountLabel:'Account A',state:stateA,identity:{kind:'configured_dom_identity',id:'identity-a',verified:true}});
    f.repository.saveConnection(b.id,{status:'connected',accountLabel:'Account B',state:stateB,identity:{kind:'configured_dom_identity',id:'identity-b',verified:true}});
    assert.deepEqual(f.repository.loadProviderSession(a.id),stateA);
    assert.deepEqual(f.repository.loadProviderSession(b.id),stateB);
    const encrypted=f.repository.db.prepare('SELECT encrypted_state FROM connections WHERE user_id=?').get(a.id).encrypted_state;
    assert.ok(!encrypted.includes('private-a'));
    assert.throws(()=>decryptState(f.config.encryptionKey,b.id,encrypted));
    assert.ok(!JSON.stringify(f.repository.getConnection(a.id)).includes('private-a'));
    assert.throws(()=>f.repository.saveConnection(b.id,{status:'connected',accountLabel:'Different display',state:stateB,identity:{kind:'configured_dom_identity',id:'identity-a',verified:true}}),/another scheduler user/);
    f.repository.deleteConnection(a.id);
    assert.equal(f.repository.loadProviderSession(a.id),null);
    assert.deepEqual(f.repository.loadProviderSession(b.id),stateB);
    assert.throws(()=>f.repository.saveConnection(b.id,{status:'connected',accountLabel:'Renamed after disconnect',state:stateB,identity:{kind:'configured_dom_identity',id:'identity-a',verified:true}}),/previous connections/);
    assert.deepEqual(f.repository.loadProviderSession(b.id),stateB);
    f.repository.saveConnection(a.id,{status:'connected',accountLabel:'Account A reconnected',state:stateA,identity:{kind:'configured_dom_identity',id:'identity-a',verified:true}});
    assert.deepEqual(f.repository.loadProviderSession(a.id),stateA);
  }finally{f.close();}
});

test('draft consent, idempotency and stale account tests are enforced transactionally',()=>{
  const f=fixture();try{
    const u=addUser(f.repository),p=plan(),job=f.repository.createJob(u.id,p,f.config.mode);
    assert.equal(job.authorization,false);
    assert.equal(f.repository.createJob(u.id,p,f.config.mode).id,job.id);
    assert.throws(()=>f.repository.createJob(u.id,{...p,start:12},f.config.mode),/different plan/);
    assert.throws(()=>f.repository.armJob(u.id,job.id,{authorization:false}),/authorization/);
    assert.throws(()=>f.repository.armJob(u.id,job.id,{authorization:true}),/successful test/);
    f.repository.saveConnection(u.id,{status:'simulated',accountLabel:'Rehearsal account',identity:{kind:'rehearsal'}});
    f.repository.updateJob(u.id,job.id,{checkedAt:new Date().toISOString(),checkedAccount:'Rehearsal account'});
    const armed=f.repository.armJob(u.id,job.id,{authorization:true});
    assert.equal(armed.authorization,true);assert.equal(armed.status,'armed');
    assert.ok(Date.parse(armed.runAt)>Date.now());
    assert.equal(f.repository.createJob(u.id,p,f.config.mode).id,job.id);
    assert.equal(f.repository.armJob(u.id,job.id,{authorization:true}).id,job.id);
  }finally{f.close();}
});

test('submission grant is fenced, single-use and coordinates competing users',()=>{
  const f=fixture();try{
    const a=addUser(f.repository,1),b=addUser(f.repository,2),ja=testedJob(f.repository,a,f.config),jb=testedJob(f.repository,b,f.config);
    for(const [user,job] of [[a,ja],[b,jb]]){
      f.repository.armJob(user.id,job.id,{authorization:true});
      f.repository.updateJob(user.id,job.id,{status:'running',runAt:new Date(Date.now()-100).toISOString()});
    }
    assert.ok(f.repository.acquireLease('scheduler','worker-a',30000));
    assert.equal(f.repository.acquireLease('scheduler','worker-b',30000),false);
    for(const [u,j] of [[a,ja],[b,jb]])assert.ok(f.repository.claimJob(u.id,j.id,'worker-a'));
    assert.throws(()=>f.repository.beginAttempt(a.id,ja.id,{hour:11,court:1,leaseOwner:'worker-b'}),/lease/);
    const attempt=f.repository.beginAttempt(a.id,ja.id,{hour:11,court:1,leaseOwner:'worker-a'});
    assert.throws(()=>f.repository.beginAttempt(a.id,ja.id,{hour:11,court:2,leaseOwner:'worker-a'}),/already/);
    assert.throws(()=>f.repository.beginAttempt(b.id,jb.id,{hour:11,court:1,leaseOwner:'worker-a'}),error=>error.code==='RESOURCE_BUSY');
    assert.equal(f.repository.getJob(b.id,jb.id).results.length,0);
    assert.ok(f.repository.beginAttempt(b.id,jb.id,{hour:11,court:2,leaseOwner:'worker-a'}));
    f.repository.finishAttempt(a.id,ja.id,attempt.id,{status:'unknown',message:'Response lost'});
    assert.throws(()=>f.repository.stopJob(a.id,ja.id),/unresolved/);
    assert.throws(()=>f.repository.beginAttempt(a.id,ja.id,{hour:11,court:3,leaseOwner:'worker-a'}),/already/);
    assert.equal(f.repository.getJob(b.id,ja.id),null);
  }finally{f.close();}
});

test('completed rehearsals do not block live plans, while live overlaps remain blocked',()=>{
  const f=fixture();try{
    const user=addUser(f.repository),rehearsalJob=testedJob(f.repository,user,f.config);
    f.repository.updateJob(user.id,rehearsalJob.id,{status:'confirmed'});
    Object.assign(f.config,{mode:'live',liveEnabled:true,production:true});
    f.repository.saveConnection(user.id,{status:'connected',accountLabel:'Fixture live account',identity:{kind:'configured_dom_identity',id:'fixture-stable-identity',verified:true}});
    const checked=()=>{
      const job=f.repository.createJob(user.id,plan(),f.config.mode);
      return f.repository.updateJob(user.id,job.id,{checkedAt:new Date().toISOString(),checkedAccount:'Fixture live account'});
    };
    const first=checked();assert.equal(f.repository.armJob(user.id,first.id,{authorization:true}).status,'armed');
    const second=checked();assert.throws(()=>f.repository.armJob(user.id,second.id,{authorization:true}),/overlapping plan/);
  }finally{f.close();}
});

test('interrupted submission survives database reopen and is never rearmed',()=>{
  const f=fixture(),user=addUser(f.repository),job=testedJob(f.repository,user,f.config);
  try{
    f.repository.armJob(user.id,job.id,{authorization:true});
    f.repository.updateJob(user.id,job.id,{status:'running',runAt:new Date(Date.now()-100).toISOString()});
    f.repository.acquireLease('scheduler','old',30000);f.repository.claimJob(user.id,job.id,'old');
    f.repository.beginAttempt(user.id,job.id,{hour:11,court:1,leaseOwner:'old'});
    f.repository.releaseLease('scheduler','old');f.repository.close();
    const reopened=new Repository(f.config);f.repository=reopened;
    reopened.acquireLease('scheduler','new',30000);assert.equal(reopened.recoverInterruptedJobs('new'),1);
    const recovered=reopened.getJob(user.id,job.id);
    assert.equal(recovered.status,'unknown');assert.equal(recovered.results[0].status,'unknown');
    assert.throws(()=>reopened.armJob(user.id,job.id,{authorization:true}),/cannot be scheduled/);
    assert.equal(reopened.listRunnableJobs().length,0);
  }finally{f.repository.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('HTTP authentication, one-use invites, CSRF and tenant ownership',async()=>{
  const f=fixture();
  const runner={async testJob(userId,job){return f.repository.updateJob(userId,job.id,{checkedAt:new Date().toISOString(),checkedAccount:f.repository.getConnection(userId).accountLabel});}};
  const {server}=createApp({...f,runner});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  f.config.origin=`http://127.0.0.1:${server.address().port}`;
  async function request(route,{method='GET',data,cookie,csrf,origin=f.config.origin,host}={}){
    const headers={};if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;if(origin!==null)headers.Origin=origin;if(host)headers.Host=host;
    if(data!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(f.config.origin+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  try{
    assert.equal((await request('/healthz')).status,200);
    runner.running=false;
    assert.equal((await request('/healthz')).status,503);
    runner.running=true;
    const invite=f.repository.createInvite();
    const a=await request('/api/auth/register',{method:'POST',data:{name:'Alice',username:'alice',password:'a secure example password',invite}});
    assert.equal(a.status,201);assert.ok(a.cookie);assert.ok(a.headers.get('set-cookie').includes('HttpOnly'));assert.ok(a.headers.get('set-cookie').includes('SameSite=Lax'));
    const reuse=await request('/api/auth/register',{method:'POST',data:{name:'Bob',username:'bob',password:'another safe example password',invite}});assert.equal(reuse.status,400);
    const b=await request('/api/auth/register',{method:'POST',data:{name:'Bob',username:'bob',password:'another safe example password',invite:f.repository.createInvite()}});assert.equal(b.status,201);
    assert.equal((await request('/api/me')).status,401);
    const hostileHost=await new Promise((resolve,reject)=>{const req=http.get(f.config.origin+'/api/config',{headers:{Host:'hostile.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
    assert.equal(hostileHost,403);
    assert.equal((await request('/api/rehearsal/connect',{method:'POST',cookie:a.cookie,csrf:a.body.csrf,origin:'https://hostile.example',data:{}})).status,403);
    assert.equal((await request('/api/rehearsal/connect',{method:'POST',cookie:a.cookie,csrf:'wrong',data:{}})).status,403);
    const authA={cookie:a.cookie,csrf:a.body.csrf},authB={cookie:b.cookie,csrf:b.body.csrf};
    assert.equal((await request('/api/rehearsal/connect',{method:'POST',...authA,data:{}})).status,200);
    const payload={date:dateAfter(),start:11,courts:[1,2,3],allowSwitch:true,authorization:false,idempotencyKey:randomUUID()};
    const created=await request('/api/jobs',{method:'POST',...authA,data:payload});assert.equal(created.status,201);assert.equal(created.body.job.authorization,false);
    assert.equal((await request('/api/jobs',{...authB})).body.jobs.length,0);
    for(const action of ['test','arm','stop'])assert.equal((await request(`/api/jobs/${created.body.job.id}/${action}`,{method:'POST',...authB,data:{authorization:true}})).status,404);
    assert.equal((await request(`/api/jobs/${created.body.job.id}/test`,{method:'POST',...authA,data:{}})).status,200);
    assert.equal((await request(`/api/jobs/${created.body.job.id}/arm`,{method:'POST',...authA,data:{authorization:false}})).status,400);
    assert.equal((await request(`/api/jobs/${created.body.job.id}/arm`,{method:'POST',...authA,data:{authorization:true}})).status,200);
    assert.equal((await request('/api/auth/logout',{method:'POST',...authA,data:{}})).status,200);
    assert.equal((await request('/api/me',{cookie:a.cookie})).status,401);
    const logged=await request('/api/auth/login',{method:'POST',data:{username:'ALICE',password:'a secure example password'}});assert.equal(logged.status,200);assert.notEqual(logged.cookie,a.cookie);
    assert.equal((await request('/api/auth/login',{method:'POST',data:{username:'alice',password:'incorrect password'}})).status,401);
    assert.equal((await request('/.env')).status,404);
    assert.ok(!JSON.stringify(created.body).includes('password'));
  }finally{await new Promise(resolve=>server.close(resolve));f.close();}
});
