import { randomUUID } from 'node:crypto';
import { signInOfficial } from './login-form.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), {status,statusCode:status});
const KEYS = new Set(['Tab','Shift+Tab','Enter','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Control+A']);
const BUSY = new Set(['armed','preparing','running']);

export class RemoteLoginManager {
  constructor({provider,repository,config,assertIdle=()=>{},now=()=>Date.now()}) {
    this.provider=provider; this.repo=repository; this.config=config; this.assertIdle=assertIdle; this.now=now;
    this.sessions=new Map(); this.starting=new Set(); this.generations=new Map(); this.closed=false;
    this.signInAttempts=new Map();
    this.ttl=Math.min(config.loginTtlMs ?? 10*60*1000, 15*60*1000);
    this.timer=setInterval(()=>this.expire().catch(()=>{}),30000); this.timer.unref?.();
  }
  async start(userId) {
    if (this.config.mode !== 'live') throw fail('Use Connect rehearsal account while this host is in rehearsal mode.');
    if(this.closed)throw fail('The login service is stopping.',503);
    await this.expire();
    if (this.starting.has(userId) || [...this.sessions.values()].some(s=>s.userId===userId)) throw fail('An account connection is already open. Finish or close it first.');
    if (this.sessions.size+this.starting.size>=3) throw fail('Three people are connecting accounts. Try again shortly.',429);
    this.starting.add(userId);
    const generation=this.generations.get(userId)??0;
    let context;
    try {
      await this.assertIdle(userId);
      const jobs=await this.repo.listJobs(userId);
      if(jobs.some(j=>BUSY.has(j.status))) throw fail('Stop active schedules before reconnecting this account.');
      context=await this.provider.createContext();
      const page=await context.newPage();
      const session={id:randomUUID(),userId,context,page,createdAt:this.now(),lastUsed:this.now(),busy:false};
      context.on('page',p=>{session.page=p;});
      page.on('close',()=>{session.page=context.pages().filter(p=>!p.isClosed()).at(-1)??page;});
      await page.goto(this.config.bookingUrl,{waitUntil:'domcontentloaded',timeout:45000});
      if(this.closed||(this.generations.get(userId)??0)!==generation)throw fail('Account connection was cancelled.',410);
      this.sessions.set(session.id,session);
      return {id:session.id,expiresAt:new Date(session.createdAt+this.ttl).toISOString()};
    } catch(error) { await context?.close().catch(()=>{}); if(error.status)throw error;throw fail('Could not open the isolated login browser. Check host browser setup and permitted identity-provider domains.',503); }
    finally {this.starting.delete(userId);}
  }
  get(userId,id) {
    const s=this.sessions.get(id);
    if(!s||s.userId!==userId)throw fail('Connection session not found.',404);
    if(this.now()-s.createdAt>=this.ttl) {this.cancel(userId,id).catch(()=>{});throw fail('Connection expired. Start again.',410);}
    if(s.page.isClosed()) {
      const replacement=s.context.pages().filter(p=>!p.isClosed()).at(-1);
      if(!replacement)throw fail('The login browser closed. Start again.'); s.page=replacement;
    }
    return s;
  }
  async withSession(userId,id,fn) {
    const s=this.get(userId,id);
    if(s.busy)throw fail('The login browser is processing another action.',429);
    s.busy=true;s.lastUsed=this.now();
    try{return await fn(s);}finally{s.busy=false;}
  }
  async frame(userId,id) {
    return this.withSession(userId,id,async s=>{
      const raw=await s.page.screenshot({type:'jpeg',quality:65,timeout:10000});
      if(this.sessions.get(id)!==s)throw fail('Connection session was closed.',410);
      const u=new URL(s.page.url());
      const size=s.page.viewportSize()??{width:1100,height:820};
      const authenticated=u.origin===new URL(this.config.bookingUrl).origin&&u.pathname==='/bookings/rent'&&await s.page.evaluate(()=>!!document.querySelector('[data-test-id="native-date-picker-input"]')&&!!globalThis.CourtAdapter?.account()).catch(()=>false);
      return {image:`data:image/jpeg;base64,${raw.toString('base64')}`,url:u.origin+u.pathname,...size,status:'connecting',authenticated};
    });
  }
  async credentials(userId,id,input){
    try{
      if(!input||Object.keys(input).some(k=>!['email','password'].includes(k))||typeof input.email!=='string'||!/^\S+@\S+\.\S+$/.test(input.email)||input.email.length>254||typeof input.password!=='string'||!input.password||input.password.length>256||/[\x00\r\n]/.test(input.password))throw fail('Enter your booking email and password.',400);
      const result=await this.withSession(userId,id,async s=>{
        const now=this.now();
        for(const [key,item] of this.signInAttempts)if(now-item.at>15*60000)this.signInAttempts.delete(key);
        const attempts=this.signInAttempts.get(userId)??{at:now,count:0};
        if(attempts.count>=5)throw fail('Too many sign-in attempts. Wait 15 minutes before trying again.',429);
        attempts.count++;this.signInAttempts.set(userId,attempts);
        try{return await signInOfficial(s.page,{email:input.email.trim(),password:input.password});}
        catch(error){if(error.status)throw error;throw fail('The official sign-in could not be completed. Try again or use the official sign-in screen.');}
      });
      if(result.status!=='signed_in')return result;
      return {status:'connected',connection:await this.finish(userId,id)};
    }finally{if(input&&typeof input==='object')input.password='';}
  }
  async input(userId,id,input) {
    if(!input||typeof input!=='object')throw fail('Invalid input.',400);
    return this.withSession(userId,id,async s=>{
      const size=s.page.viewportSize()??{width:1100,height:820};
      if(input.type==='click'){
        if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.y<0||input.x>=size.width||input.y>=size.height)throw fail('Click is outside the login view.',400);
        await s.page.mouse.click(input.x,input.y);
      }else if(input.type==='text'){
        if(typeof input.text!=='string'||input.text.length>2048||/[\x00\r\n]/.test(input.text))throw fail('Invalid text input.',400);
        await s.page.keyboard.insertText(input.text);
      }else if(input.type==='key'){
        if(!KEYS.has(input.key))throw fail('Key is not permitted.',400);
        await s.page.keyboard.press(input.key);
      }else if(input.type==='scroll'){
        if(!Number.isFinite(input.deltaY)||Math.abs(input.deltaY)>1000)throw fail('Invalid scroll.',400);
        await s.page.mouse.wheel(0,input.deltaY);
      }else throw fail('Unsupported input.',400);
      return {ok:true};
    });
  }
  async finish(userId,id) {
    return this.withSession(userId,id,async s=>{
      await this.assertIdle(userId);
      const jobs=await this.repo.listJobs(userId);
      if(jobs.some(j=>BUSY.has(j.status)))throw fail('Stop active schedules before changing the connected account.');
      if(new URL(s.page.url()).origin!==new URL(this.config.bookingUrl).origin)throw fail('Complete sign-in on the official site before finishing.');
      await s.page.goto(this.config.bookingUrl,{waitUntil:'domcontentloaded',timeout:30000});
      await this.provider.assertOfficial(s.page);
      const accountLabel=await s.page.evaluate(()=>CourtAdapter.account());
      if(!accountLabel||accountLabel.length>160)throw fail('A signed-in booking account could not be read. Complete sign-in first.');
      const state=await s.context.storageState({indexedDB:true});
      const identity=await this.provider.readIdentity(s.page);
      if(this.sessions.get(id)!==s)throw fail('Connection session was closed.',410);
      await this.assertIdle(userId);
      if((await this.repo.listJobs(userId)).some(j=>BUSY.has(j.status)))throw fail('A schedule became active during account connection. Stop it before finishing.');
      if(this.sessions.get(id)!==s)throw fail('Connection session was closed.',410);
      await this.repo.saveConnection(userId,{status:'connected',accountLabel,state,identity});
      this.sessions.delete(id);
      await s.context.close().catch(()=>{});
      return this.repo.getConnection(userId);
    });
  }
  async cancel(userId,id) {
    const s=this.sessions.get(id);
    if(!s||s.userId!==userId)throw fail('Connection session not found.',404);
    this.sessions.delete(id);await s.context.close().catch(()=>{});return {ok:true};
  }
  async cancelUser(userId) {this.generations.set(userId,(this.generations.get(userId)??0)+1);await Promise.allSettled([...this.sessions.values()].filter(s=>s.userId===userId).map(s=>this.cancel(userId,s.id)));}
  async expire() {await Promise.allSettled([...this.sessions.values()].filter(s=>this.now()-s.createdAt>=this.ttl).map(s=>this.cancel(s.userId,s.id)));}
  async close(){this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.sessions.values()].map(s=>this.cancel(s.userId,s.id)));}
}
