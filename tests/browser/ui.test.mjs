import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../../src/config.mjs';
import { startService } from '../../src/server.mjs';

let browser, service, tempRoot, origin;
before(async()=>{
  tempRoot=await mkdtemp(path.join(os.tmpdir(),'court-v2-ui-'));
  const config=loadConfig({DATA_DIR:tempRoot,BOOKING_MODE:'rehearsal'});
  config.port=0;
  service=await startService(config);
  origin=`http://127.0.0.1:${service.server.address().port}`;
  config.origin=origin;config.publicOrigin=origin;
  const channel=process.env.BROWSER_CHANNEL || (process.platform==='win32'?'msedge':undefined);
  browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
});
after(async()=>{
  await browser?.close();
  await service?.close();
  if(tempRoot&&path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir())+path.sep+'court-v2-ui-'))await rm(tempRoot,{recursive:true,force:true});
});
async function assertNoOverflow(page){
  const sizes=await page.evaluate(()=>({window:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert.ok(sizes.document<=sizes.window+1,`Document overflows: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.body<=sizes.window+1,`Body overflows: ${JSON.stringify(sizes)}`);
}
async function waitVisible(page,selector){await page.locator(selector).waitFor({state:'visible',timeout:12000});}

test('desktop and mobile: one scheduling click runs checks and persists the authorized result',{timeout:40000},async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin);
    await page.locator('#service-notice.rehearsal').waitFor();
    assert.equal(await page.locator('#allow-switch, [data-prefer], [data-court]').count(),0);
    assert.equal(await page.locator('#review-dialog, #test-button, #authorization').count(),0);
    assert.match(await page.locator('#booking-card').innerText(),/Any available court/);
    await assertNoOverflow(page);
    await page.locator('#account-button').click();
    await page.locator('#register-tab').click();
    const invite=service.repository.createInvite('Synthetic UI test');
    await page.locator('#auth-name').fill('Fixture Player');
    await page.locator('#auth-username').fill('fixture_player');
    await page.locator('#auth-password').fill('Synthetic-test-pass-123');
    await page.locator('#auth-invite').fill(invite);
    await page.locator('#auth-submit').click();
    await waitVisible(page,'#account-dialog');
    assert.match(await page.locator('#signed-in-as').innerText(),/Fixture Player/);
    await page.locator('#rehearsal-connect').click();
    await page.waitForFunction(()=>document.querySelector('#connection-card').textContent.includes('Rehearsal account connected'));
    await page.locator('[data-close="account-dialog"]').last().click();
    assert.equal(service.repository.listJobs(service.repository.findUser('fixture_player').id).length,0,'Selecting sessions must not create or authorize a plan');
    await page.locator('#schedule-button').click();
    await waitVisible(page,'#schedules-view');
    await page.waitForFunction(()=>document.querySelector('.job-badge')?.textContent==='Booked',null,{timeout:15000});
    assert.equal(await page.locator('.job-session').count(),1);
    assert.equal(service.repository.listJobs(service.repository.findUser('fixture_player').id)[0].results[0].hour,11);
    assert.match(await page.locator('.mode-note').innerText(),/No real court reservation/);
    assert.equal(service.repository.listJobs(service.repository.findUser('fixture_player').id).length,1);
    await page.setViewportSize({width:390,height:844});
    await assertNoOverflow(page);
    await page.locator('#schedules-tab').click();
    await page.locator('.job-badge.confirmed').waitFor();
    await assertNoOverflow(page);
    await page.locator('#facilities-tab').click();
    await assertNoOverflow(page);
    await page.locator('#schedule-button').click();
    await waitVisible(page,'#schedules-view');
    assert.equal(service.repository.listJobs(service.repository.findUser('fixture_player').id).length,1,'Repeating the same selection must recover the accepted plan');
    await assertNoOverflow(page);
    await page.locator('#new-schedule').click();await page.locator('[data-hour="12"]').click();
    assert.equal(await page.locator('#booking-hours').innerText(),'12:00–13:00');
    await page.locator('#schedule-button').click();await waitVisible(page,'#schedules-view');
    await page.waitForFunction(()=>document.querySelectorAll('.job-badge.confirmed').length===2,null,{timeout:15000});
    const saved=service.repository.listJobs(service.repository.findUser('fixture_player').id);
    assert.equal(saved.length,2);assert.ok(saved.every(j=>j.durationHours===1&&j.results.length===1));
    assert.deepEqual(saved.map(j=>j.results[0].hour).sort(),[11,12]);
    await page.reload();await page.locator('#account-name').filter({hasText:'Fixture Player'}).waitFor();
    await page.locator('#schedules-tab').click();await page.locator('.job-badge.confirmed').first().waitFor();
    assert.deepEqual(errors,[]);
    const stranger=await browser.newContext();
    const secondPage=await stranger.newPage();
    await secondPage.goto(origin);
    await secondPage.locator('#service-notice.rehearsal').waitFor();
    await secondPage.locator('#schedules-tab').click();
    assert.equal(await secondPage.locator('.job-card').count(),0);
    assert.equal(await secondPage.locator('#account-name').innerText(),'Connect account');
    await stranger.close();
  }finally{await context.close();}
});

test('GitHub Pages mode exposes no credential entry or runnable schedule',{timeout:20000},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  try{
    await page.route('**/api/**',route=>route.fulfill({status:404,contentType:'text/html',body:'Not found'}));
    await page.route('**/config.json',route=>route.fulfill({json:{backendUrl:''}}));
    await page.goto(origin);
    await page.waitForFunction(()=>document.querySelector('#service-notice').textContent.includes('Booking service not connected yet'));
    await page.locator('#account-button').click();
    assert.equal(await page.locator('#auth-dialog').isVisible(),false);
    assert.equal(await page.locator('#auth-password').isVisible(),false);
    assert.equal(await page.locator('#schedule-button').isDisabled(),true);
    assert.equal(await page.locator('#review-dialog').count(),0);
    await assertNoOverflow(page);
    await page.setViewportSize({width:1440,height:1000});
    await assertNoOverflow(page);
  }finally{await context.close();}
});

test('direct scheduling stops on failed checks and recovers a lost acceptance without duplicate arming',async()=>{
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage();
    let job=null,tests=0,arms=0,releaseCheck;
    const keys=[];
    const gate=new Promise(resolve=>{releaseCheck=resolve;});
    try{
      await page.route('**/api/**',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.pathname==='/api/config')return route.fulfill({json:{mode:'rehearsal',liveEnabled:false}});
        if(url.pathname==='/api/me')return route.fulfill({json:{user:{id:'fixture',name:'Booking Fixture'},csrf:'fixture-csrf',connection:{status:'simulated',accountLabel:'Fixture'},jobs:[]}});
        if(url.pathname==='/api/jobs'&&request.method()==='GET')return route.fulfill({json:{jobs:job?[job]:[]}});
        assert.equal(request.headers()['x-csrf-token'],'fixture-csrf');
        if(url.pathname==='/api/jobs'){
          const body=request.postDataJSON();keys.push(body.idempotencyKey);assert.equal(body.authorization,false);
          job??={id:'fixture-job',...body,courts:[1,2,3],allowSwitch:true,status:'draft',mode:'rehearsal',releaseAt:new Date().toISOString(),results:[]};
          return route.fulfill({json:{job}});
        }
        if(url.pathname.endsWith('/test')){
          tests++;
          if(tests===1){await gate;return route.fulfill({status:409,json:{error:'Synthetic check failed.'}});}
          job.checkedAt=new Date().toISOString();return route.fulfill({json:{job}});
        }
        if(url.pathname.endsWith('/arm')){
          assert.equal(request.postDataJSON().authorization,true);arms++;
          job={...job,status:'armed',authorization:true};
          return route.fulfill({status:503,json:{error:'Synthetic lost acceptance response.'}});
        }
        return route.fulfill({status:404,json:{error:'Not found'}});
      });
      await page.goto(origin);await page.locator('#account-name').filter({hasText:'Booking Fixture'}).waitFor();
      assert.equal(keys.length,0);
      await page.locator('#schedule-button').click();
      await page.locator('#booking-progress').filter({hasText:'Checking your session'}).waitFor();
      assert.equal(await page.locator('#schedule-button').isDisabled(),true);
      assert.equal(await page.locator('#playing-date').isDisabled(),true);
      assert.equal(await page.locator('[data-hour="12"]').isDisabled(),true);
      await assertNoOverflow(page);
      releaseCheck();await page.locator('#booking-error').filter({hasText:'Synthetic check failed'}).waitFor();
      assert.equal(arms,0);assert.equal(await page.locator('#schedule-button').isEnabled(),true);
      await page.locator('#schedule-button').click();
      await page.locator('#booking-error').filter({hasText:'Synthetic lost acceptance'}).waitFor();
      assert.match(await page.locator('#booking-progress').innerText(),/Check My schedules/);
      await page.locator('#schedule-button').click();await waitVisible(page,'#schedules-view');
      assert.equal(tests,2);assert.equal(arms,1);assert.equal(keys.length,3);assert.equal(new Set(keys).size,1);
      assert.equal(await page.locator('.job-card').count(),1);
    }finally{releaseCheck();await context.close();}
  }
});

test('direct scheduling remains disabled when the host has not enabled live booking',async()=>{
  const context=await browser.newContext(),page=await context.newPage();let writes=0;
  try{
    await page.route('**/api/**',route=>{
      if(route.request().method()!=='GET')writes++;
      const url=new URL(route.request().url());
      if(url.pathname==='/api/config')return route.fulfill({json:{mode:'live',liveEnabled:false}});
      if(url.pathname==='/api/me')return route.fulfill({json:{user:{id:'fixture',name:'Connected Fixture'},csrf:'fixture',connection:{status:'connected'},jobs:[]}});
      return route.fulfill({json:{jobs:[]}});
    });
    await page.goto(origin);await page.locator('#account-name').filter({hasText:'Connected Fixture'}).waitFor();
    assert.equal(await page.locator('#schedule-button').isDisabled(),true);assert.equal(writes,0);
    assert.equal(await page.locator('#review-dialog').count(),0);
  }finally{await context.close();}
});

test('simple booking login clears passwords, supports retry and connects without a save step',async()=>{
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage();
    let connected=false,calls=0;
    try{
      await page.route('**/api/**',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.pathname==='/api/config')return route.fulfill({json:{mode:'live',liveEnabled:false}});
        if(url.pathname==='/api/me')return route.fulfill({json:{user:{id:'fixture',name:'Simple Fixture'},csrf:'fixture-csrf',connection:{status:connected?'connected':'disconnected',accountLabel:connected?'Official Fixture':''},jobs:[]}});
        if(url.pathname==='/api/connection/start')return route.fulfill({json:{id:'fixture-login'}});
        if(url.pathname==='/api/connection/fixture-login/credentials'){
          const data=request.postDataJSON();assert.equal(data.email,'fixture@example.invalid');assert.equal(request.headers()['x-csrf-token'],'fixture-csrf');
          calls++;
          if(calls===1)return route.fulfill({json:{status:'credentials_required',message:'Check your email and password.'}});
          connected=true;return route.fulfill({json:{status:'connected',connection:{status:'connected'}}});
        }
        if(url.pathname==='/api/jobs')return route.fulfill({json:{jobs:[]}});
        return route.fulfill({status:404,json:{error:'Not found'}});
      });
      await page.goto(origin);await page.locator('#account-name').filter({hasText:'Simple Fixture'}).waitFor();
      await page.locator('#account-button').click();await page.locator('#connect-provider').click();
      await page.locator('#booking-email').fill('fixture@example.invalid');await page.locator('#booking-password').fill('synthetic password');
      await assertNoOverflow(page);await page.locator('#booking-connect').click();
      await page.locator('#booking-login-error').filter({hasText:'Check your email'}).waitFor();assert.equal(await page.locator('#booking-password').inputValue(),'');
      await page.locator('#booking-password').fill('synthetic retry');await page.locator('#booking-connect').click();
      await page.waitForFunction(()=>!document.querySelector('#remote-dialog').open);
      assert.equal(await page.locator('#booking-password').inputValue(),'');assert.equal(calls,2);assert.equal(connected,true);
    }finally{await context.close();}
  }
});

test('mobile remote login sends scaled inputs only to its own session and clears text',{timeout:20000},async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  const inputs=[];let cancelled=false;
  const loginId='10000000-0000-4000-8000-000000000001';
  const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  try{
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==='/api/config')return route.fulfill({json:{mode:'live',liveEnabled:false}});
      if(url.pathname==='/api/me')return route.fulfill({json:{user:{id:'fixture',name:'Remote Fixture'},csrf:'fixture-csrf',connection:{status:'disconnected'},jobs:[]}});
      if(url.pathname==='/api/jobs')return route.fulfill({json:{jobs:[]}});
      if(url.pathname==='/api/connection/start')return route.fulfill({json:{id:loginId}});
      if(url.pathname===`/api/connection/${loginId}/frame`)return route.fulfill({json:{image:pixel,width:1280,height:900,url:'https://usc.kuleuven.cloud/pages/login',status:'active'}});
      if(url.pathname===`/api/connection/${loginId}/input`){assert.equal(request.headers()['x-csrf-token'],'fixture-csrf');inputs.push(request.postDataJSON());return route.fulfill({json:{ok:true}});}
      if(url.pathname===`/api/connection/${loginId}`&&request.method()==='DELETE'){cancelled=true;return route.fulfill({json:{closed:true}});}
      return route.fulfill({status:404,json:{error:'Not found'}});
    });
    await page.goto(origin);
    await page.locator('#account-name').filter({hasText:'Remote Fixture'}).waitFor();
    await page.locator('#account-button').click();
    await page.locator('#connect-provider').click();
    await page.locator('#official-login-button').click();
    await waitVisible(page,'#remote-image');
    await page.waitForFunction(()=>{const img=document.querySelector('#remote-image');return img.complete&&img.naturalWidth>0;});
    await page.locator('#remote-image').scrollIntoViewIfNeeded();
    const rect=await page.locator('#remote-image').boundingBox();
    await page.locator('#remote-image').click({position:{x:rect.width/2,y:rect.height/2}});
    await page.locator('#remote-text').fill('synthetic fixture text');
    await page.locator('#remote-text-form button').click();
    assert.equal(await page.locator('#remote-text').inputValue(),'');
    await page.waitForFunction(()=>document.querySelector('#remote-text').value==='');
    await assertNoOverflow(page);
    await page.locator('#remote-close').click();
    await page.waitForTimeout(100);
    assert.equal(inputs[0].type,'click');
    // Browser pointer coordinates round to rendered pixels; allow one such pixel
    // after scaling back to the remote browser's larger viewport.
    assert.ok(Math.abs(inputs[0].x-640)<=Math.ceil(1280/rect.width),JSON.stringify({click:inputs[0],rect}));
    assert.ok(Math.abs(inputs[0].y-450)<=Math.ceil(900/rect.height),JSON.stringify({click:inputs[0],rect}));
    assert.equal(inputs[1].text,'synthetic fixture text');
    assert.equal(cancelled,true);
  }finally{await context.close();}
});
