import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingProvider } from '../../src/provider.mjs';

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="topMenu"><button aria-haspopup="true">Fixture Participant</button></div>
<span id="provider-identity" data-account-id="fixture-account-1">Fixture account identity</span>
<span data-test-id="rent-selected-tag-description">Beach volleyball (indoor)</span>
<input type="date" data-test-id="native-date-picker-input" value="2027-01-05">
<button data-test-id="day-selector-2" aria-selected="true"><span data-test-id="day-button" data-test-id-day-button-number="2">Tu 5-01</span></button>
<div id="slots"></div><div id="cards"></div><div id="modal"></div>
<script>
window.fixturePrice='€ 0.00';window.fixtureResult='confirmed';
for(const h of [11,12]){
 const n=document.createElement('div');n.dataset.testId='selectable-slot';
 n.innerHTML='<button aria-pressed="false"><span data-test-id="selectable-slot-start-time">'+h+':00</span><span data-test-id="selectable-slot-duration">60 min</span></button>';
 n.querySelector('button').onclick=()=>{document.querySelectorAll('[aria-pressed]').forEach(b=>b.setAttribute('aria-pressed','false'));n.querySelector('button').setAttribute('aria-pressed','true');showCourts(h);};document.querySelector('#slots').append(n);
}
function showCourts(h){
 const root=document.querySelector('#cards');root.replaceChildren();
 for(const c of [1,2,3]){const n=document.createElement('div');n.dataset.testId='rental-bookable-option';n.innerHTML='<span data-test-id="rental-slot-resource-description">B&amp;FH Indoor Beachvolley '+c+'</span><span data-test-id="rental-start-and-end-time">'+h+':00 - '+(h+1)+':00</span><button data-test-id="book-rental-slot">Book</button>';n.querySelector('button').onclick=()=>showModal(h,c);root.append(n);}
}
function showModal(h,c){
 const root=document.querySelector('#modal');root.innerHTML='<button data-test-id="button-close-modal">Close</button><span data-test-id="details-product-description">B&amp;FH Indoor Beachvolley '+c+'</span><span data-test-id="details-booking-start-date">2027-01-05</span><span data-test-id="details-booking-start-and-end-time">'+h+':00 - '+(h+1)+':00</span><span data-test-id="details-booking-minutes-duration">60</span><span data-test-id="details-partial-cart-items-total-price">'+window.fixturePrice+'</span><button data-test-id="details-book-button">Book</button>';
 root.querySelector('[data-test-id="button-close-modal"]').onclick=()=>root.replaceChildren();
 root.querySelector('[data-test-id="details-book-button"]').onclick=()=>{window.__fixtureSubmit({hour:h,court:c});if(window.fixtureResult==='confirmed')root.insertAdjacentHTML('beforeend','<span data-test-id="booking-success">Booked</span>');else if(window.fixtureResult==='waiting')root.insertAdjacentHTML('beforeend','<span data-test-id="booking-success">Received</span><span data-test-id="waiting-for-approval">Waiting</span>');};
}
</script></body></html>`;

class FixtureProvider extends BookingProvider {
  constructor(extra={}) {
    super({mode:'live',liveEnabled:true,headless:true,browserChannel:process.env.TEST_BROWSER_CHANNEL??(process.platform==='win32'?'msedge':undefined),providerIdentitySelector:'#provider-identity',providerIdentityAttribute:'data-account-id',bookingUrl:'https://usc.kuleuven.cloud/bookings/rent?tags=132',...extra});
    this.clicks=[];this.fixture=FIXTURE;
  }
  async createContext(state){
    const c=await super.createContext(state);
    await c.exposeBinding('__fixtureSubmit',(_source,data)=>{this.clicks.push(data);});
    // Every browser request is fulfilled locally. No request reaches KU Leuven or any other host.
    await c.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:this.fixture}));
    return c;
  }
  async connection(){
    const context=await this.createContext();
    try{const page=await this.officialPage(context);return {status:'connected',accountLabel:'Fixture Participant',identity:await this.readIdentity(page)};}finally{await context.close();}
  }
}
const job={id:'fixture-job',date:'2027-01-05',start:11,durationHours:1,courts:[1,2,3],allowSwitch:true};
const state={cookies:[],origins:[]};

test('browser fixture validates one hourly dialog without final clicks, then executes exactly one authorized hour',async()=>{
  const p=new FixtureProvider();let prepared;
  try{
    const connection=await p.connection();
    const result=await p.test(job,connection,state);assert.equal(result.tested.length,1);assert.equal(p.clicks.length,0);
    prepared=await p.prepare(job,connection,state);
    assert.equal(prepared.pages.length,1);assert.equal(p.clicks.length,0);
    await p.readyCandidate(prepared,job,0,1);let grants=0;
    const out=await p.submit(prepared,job,0,1,async()=>{grants++;});
    assert.equal(grants,1);assert.deepEqual(out,{status:'confirmed',evidence:'official_booking_success'});
    assert.deepEqual(p.clicks,[{hour:11,court:1}]);
  }finally{await p.closePrepared(prepared);await p.close();}
});

test('read-only browser checks use only the selected hour with other courts as fallback',async()=>{
  for(const scenario of [
    {courts:'(h===11?[1,2]:[2,3])',price:'window.fixturePrice',expected:[1]},
    {courts:'[1,2,3]',price:"(h===11&&c===1?'€ 5.00':window.fixturePrice)",expected:[2]},
    {courts:'(h===11?[1]:[3])',price:'window.fixturePrice',expected:[1]},
  ]){
    const p=new FixtureProvider();
    p.fixture=FIXTURE.replace('for(const c of [1,2,3])',`for(const c of ${scenario.courts})`).replace("'+window.fixturePrice+'",`'+${scenario.price}+'`);
    try{
      const result=await p.test(job,await p.connection(),state);
      assert.deepEqual(result.tested.map(r=>r.court),scenario.expected);assert.equal(p.clicks.length,0);
    }finally{await p.close();}
  }
});

test('browser fixture refuses changed account identity and nonzero prices before click',async()=>{
  const p=new FixtureProvider();let prepared;
  try{
    const connection=await p.connection();prepared=await p.prepare(job,connection,state);
    await prepared.pages[0].evaluate(()=>document.querySelector('#provider-identity').setAttribute('data-account-id','another-account'));
    await assert.rejects(p.readyCandidate(prepared,job,0,1),/identity changed/);
    await prepared.pages[0].evaluate(()=>{document.querySelector('#provider-identity').setAttribute('data-account-id','fixture-account-1');window.fixturePrice='€ 5.00';});
    await assert.rejects(p.readyCandidate(prepared,job,0,1),/verified.*0.00/);
    await assert.rejects(p.submit(prepared,job,1,1),/only its selected hour/);
    assert.equal(p.clicks.length,0);
  }finally{await p.closePrepared(prepared);await p.close();}
});

test('browser fixture maps waitlist to unknown and respects final lease guard',async()=>{
  const p=new FixtureProvider();let prepared;
  try{
    const connection=await p.connection();prepared=await p.prepare(job,connection,state);
    await p.readyCandidate(prepared,job,0,1);
    await assert.rejects(p.submit(prepared,job,0,1,async()=>{throw Error('Lease lost');}),/Lease lost/);
    assert.equal(p.clicks.length,0);
    await prepared.pages[0].evaluate(()=>window.fixtureResult='waiting');
    const result=await p.submit(prepared,job,0,1,async()=>{});assert.equal(result.status,'unknown');assert.equal(p.clicks.length,1);
  }finally{await p.closePrepared(prepared);await p.close();}
});

test('real browser contexts isolate cookies between two users and a new login',async()=>{
  const p=new FixtureProvider();
  try{
    const a=await p.createContext(),b=await p.createContext(),login=await p.createContext();
    await a.addCookies([{name:'fixture-session',value:'account-a',domain:'usc.kuleuven.cloud',path:'/'}]);
    await b.addCookies([{name:'fixture-session',value:'account-b',domain:'usc.kuleuven.cloud',path:'/'}]);
    assert.equal((await a.cookies())[0].value,'account-a');assert.equal((await b.cookies())[0].value,'account-b');assert.deepEqual(await login.cookies(),[]);
    await a.close();assert.equal((await b.cookies())[0].value,'account-b');
  }finally{await p.close();}
});

test('profile Person id is freshly verified without navigating booking pages or accepting a name match',async()=>{
  const p=new FixtureProvider({providerIdentitySource:'profile-person-id'});
  let personId='10001';
  try{
    const context=await p.createContext();
    await context.route('https://usc.kuleuven.cloud/members/profile/myprofile',r=>r.fulfill({status:200,contentType:'text/html',body:`<label>Person id<input data-test-id="id-field" disabled value="${personId}"></label>`}));
    const page=await p.officialPage(context),bookingUrl=page.url();
    const [a,b]=await Promise.all([p.readIdentity(page),p.readIdentity(page)]);
    assert.deepEqual(a,b);assert.equal(a.verified,true);assert.equal(a.source,'profile_person_id');
    assert.notEqual(a.id,personId);assert.equal(context.pages().length,1);assert.equal(page.url(),bookingUrl);
    personId='10002';
    await assert.rejects(p.assertAccount(page,'Fixture Participant',a),/identity changed/);
    assert.equal(context.pages().length,1);assert.equal(p.clicks.length,0);
  }finally{await p.close();}
});
