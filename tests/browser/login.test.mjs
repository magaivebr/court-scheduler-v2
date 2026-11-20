import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { signInOfficial } from '../../src/login-form.mjs';
import { RemoteLoginManager } from '../../src/remote-login.mjs';

const origin='https://usc.kuleuven.cloud';
const login=`<!doctype html><form><label>E-mail<input type="email" required></label><label>Password<input type="password" required></label><button>Inloggen met e-mail en wachtwoord</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();if(document.querySelector('input[type=password]').value==='fixture-correct')location.href='/bookings/rent';else document.body.insertAdjacentHTML('beforeend','<p>Incorrect password</p>');};</script>`;
async function fixture(){
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  const context=await browser.newContext();
  await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:new URL(r.request().url()).pathname==='/pages/login'?login:'<p>Signed in</p>'}));
  const page=await context.newPage();await page.goto(origin+'/pages/login');
  return {browser,context,page};
}
test('simple sign-in submits the official form and never sends credentials to another origin',async()=>{
  const f=await fixture();try{
    await f.page.goto('https://example.invalid/pages/login');
    await assert.rejects(signInOfficial(f.page,{email:'fixture@example.invalid',password:'fixture-correct'}),/new account connection/);
    await f.page.goto(origin+'/pages/login');
    assert.deepEqual(await signInOfficial(f.page,{email:'fixture@example.invalid',password:'fixture-correct'}),{status:'signed_in'});
    assert.equal(f.page.url(),origin+'/bookings/rent');
  }finally{await f.browser.close();}
});
test('rejected sign-in stays retryable and clears the remote password',async()=>{
  const f=await fixture();try{
    const result=await signInOfficial(f.page,{email:'fixture@example.invalid',password:'fixture-wrong'});
    assert.equal(result.status,'credentials_required');
    assert.equal(await f.page.locator('input[type=password]').inputValue(),'');
  }finally{await f.browser.close();}
});
test('credentials remain owner-scoped, are cleared and save a successful connection automatically',async()=>{
  const f=await fixture();let saves=0;
  const manager=new RemoteLoginManager({config:{bookingUrl:origin+'/bookings/rent',mode:'live'},provider:{},repository:{},assertIdle:()=>{}});
  const id='fixture-session';manager.sessions.set(id,{id,userId:'owner',context:f.context,page:f.page,createdAt:Date.now(),busy:false});
  manager.finish=async(user,session)=>{assert.equal(user,'owner');assert.equal(session,id);saves++;return {status:'connected'};};
  try{
    const other={email:'fixture@example.invalid',password:'fixture-correct'};
    await assert.rejects(manager.credentials('another-user',id,other),e=>e.status===404);assert.equal(other.password,'');assert.equal(saves,0);
    const own={email:'fixture@example.invalid',password:'fixture-correct'};
    const result=await manager.credentials('owner',id,own);assert.equal(result.status,'connected');assert.equal(own.password,'');assert.equal(saves,1);
  }finally{await manager.close();await f.browser.close();}
});
