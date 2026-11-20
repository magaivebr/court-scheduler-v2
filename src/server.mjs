import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { Repository } from './repository.mjs';
import { validatePlan, validateRegistration } from './domain.mjs';
import { HttpError, RateLimiter, hashPassword, verifyPassword, parseCookies, equalSecret } from './security.mjs';
import { createRunner } from './scheduler.mjs';

const TYPES = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8' };
const SAFE_METHODS = new Set(['GET','HEAD']);
function securityHeaders(res, production) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  if (production) res.setHeader('Strict-Transport-Security','max-age=31536000');
}
function json(res, status, value) {
  const body=JSON.stringify(value);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});
  res.end(body);
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw new HttpError(415,'Use application/json.');
  if(Number(req.headers['content-length']||0)>65536)throw new HttpError(413,'Request is too large.');
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>65536)throw new HttpError(413,'Request is too large.');chunks.push(chunk);}
  let result;
  try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON.');}
  if(!result||typeof result!=='object'||Array.isArray(result))throw new HttpError(400,'A JSON object is required.');
  return result;
}
function requireOrigin(req,config) {
  if(req.headers.origin!==config.origin)throw new HttpError(403,'This action must originate from Court Scheduler.');
  if(req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']))throw new HttpError(403,'Cross-site requests are not permitted.');
}
function cookie(config,raw,maxAge) { return `${config.cookieName}=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies?'; Secure':''}`; }
function assertFields(input, allowed) { if(Object.keys(input).some(key=>!allowed.includes(key)))throw new HttpError(400,'Unknown request field.'); }

/** Same-origin private service. No browser context, password or session state is serialized to clients. */
export function createApp({config,repository,runner}) {
  const limiter=new RateLimiter();
  const userView=session=>({user:session.user,csrf:session.csrf,connection:repository.getConnection(session.user.id),jobs:repository.listJobs(session.user.id)});
  const handler=async(req,res)=>{
    securityHeaders(res,config.production);
    try{
      if(req.headers.host!==new URL(config.origin).host)throw new HttpError(403,'Unexpected host.');
      const url=new URL(req.url,config.origin), method=req.method||'GET';
      if(!['GET','HEAD','POST','DELETE'].includes(method))throw new HttpError(405,'Method not allowed.');
      if(url.search)throw new HttpError(400,'Query parameters are not supported.');
      if(url.pathname==='/healthz'&&SAFE_METHODS.has(method)){
        const ready=runner.running!==false;
        return json(res,ready?200:503,{status:ready?'ok':'degraded',mode:config.mode,schedulerReady:ready});
      }
      if(!url.pathname.startsWith('/api/')){
        if(!SAFE_METHODS.has(method))throw new HttpError(405,'Method not allowed.');
        let route;try{route=decodeURIComponent(url.pathname);}catch{throw new HttpError(400,'Invalid path.');}
        if(route==='/'||route==='/index.html')route='/index.html';
        if(route.includes('\\')||route.split('/').some(part=>part.startsWith('.')))throw new HttpError(404,'Page not found.');
        const file=path.resolve(config.publicDir,'.'+route), root=path.resolve(config.publicDir)+path.sep;
        if(!file.startsWith(root)||!TYPES[path.extname(file)])throw new HttpError(404,'Page not found.');
        let content;try{if(!(await stat(file)).isFile())throw Error();content=await readFile(file);}catch{throw new HttpError(404,'Page not found.');}
        res.writeHead(200,{'Content-Type':TYPES[path.extname(file)],'Content-Length':content.length,'Cache-Control':'no-cache'});return res.end(method==='HEAD'?undefined:content);
      }
      const ip=req.socket.remoteAddress||'unknown';
      limiter.check(`traffic:${ip}`,4000,60000);
      if(!SAFE_METHODS.has(method))requireOrigin(req,config);
      if(url.pathname==='/api/config'&&method==='GET')return json(res,200,{serviceName:'Court Scheduler',mode:config.mode,liveEnabled:config.liveEnabled,serverTime:new Date().toISOString(),bookingUrl:config.bookingUrl,maxAccounts:config.maxAccounts});
      const rawToken=parseCookies(req.headers.cookie)[config.cookieName];
      const session=repository.getSession(rawToken);
      if(url.pathname==='/api/auth/register'&&method==='POST'){
        limiter.check(`auth:${ip}`,60,15*60000);
        const input=validateRegistration(await body(req));
        limiter.check(`register:${input.username}`,5,15*60000);
        const user=repository.register({...input,passwordHash:await hashPassword(input.password)});
        const created=repository.createSession(user.id);
        res.setHeader('Set-Cookie',cookie(config,created.token,Math.floor(config.sessionTtlMs/1000)));
        return json(res,201,userView(repository.getSession(created.token)));
      }
      if(url.pathname==='/api/auth/login'&&method==='POST'){
        limiter.check(`auth:${ip}`,60,15*60000);
        const input=await body(req);assertFields(input,['username','password']);
        const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';
        if(!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)||typeof input.password!=='string'||input.password.length>128)throw new HttpError(400,'Enter your username and password.');
        limiter.check(`login:${username}`,10,15*60000);
        const user=repository.findUser(username);
        // The dummy work avoids a cheap username-existence timing oracle.
        const expected=user?.passwordHash||'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
        if(!await verifyPassword(input.password,expected)||!user)throw new HttpError(401,'Incorrect username or password.');
        if(rawToken)repository.deleteSession(rawToken);
        const created=repository.createSession(user.id);
        res.setHeader('Set-Cookie',cookie(config,created.token,Math.floor(config.sessionTtlMs/1000)));
        return json(res,200,userView(repository.getSession(created.token)));
      }
      if(!session)throw new HttpError(401,'Sign in to Court Scheduler.');
      const userId=session.user.id;
      limiter.check(`user:${userId}`,1000,60000);
      if(!SAFE_METHODS.has(method)&&!equalSecret(req.headers['x-csrf-token'],session.csrf))throw new HttpError(403,'Refresh the page before trying again.');
      if(url.pathname==='/api/me'&&method==='GET')return json(res,200,userView(session));
      if(url.pathname==='/api/auth/logout'&&method==='POST'){
        repository.deleteSession(rawToken);res.setHeader('Set-Cookie',cookie(config,'',0));return json(res,200,{signedOut:true});
      }
      if(url.pathname==='/api/jobs'&&method==='GET')return json(res,200,{jobs:repository.listJobs(userId)});
      if(url.pathname==='/api/jobs'&&method==='POST')return json(res,201,{job:repository.createJob(userId,validatePlan(await body(req)),config.mode)});
      const jobRoute=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/(test|arm|stop)$/);
      if(jobRoute&&method==='POST'){
        const [,id,action]=jobRoute, job=repository.getJob(userId,id);
        if(!job)throw new HttpError(404,'Schedule not found.');
        if(action==='test'){
          limiter.check(`test:${userId}`,10,60000);
          return json(res,200,{job:await runner.testJob(userId,job)});
        }
        if(action==='arm'){
          const input=await body(req);assertFields(input,['authorization']);
          return json(res,200,{job:repository.armJob(userId,id,input)});
        }
        return json(res,200,{job:repository.stopJob(userId,id)});
      }
      if(url.pathname==='/api/rehearsal/connect'&&method==='POST'){
        if(config.mode!=='rehearsal')throw new HttpError(404,'Not available.');
        if(repository.listJobs(userId).some(j=>['armed','preparing','running'].includes(j.status)))throw new HttpError(409,'Stop active schedules before changing account connection.');
        const connection=repository.saveConnection(userId,{status:'simulated',accountLabel:`Rehearsal ${userId.slice(0,8)}`,identity:{kind:'rehearsal',verified:false}});
        return json(res,200,{connection});
      }
      if(url.pathname==='/api/connection/start'&&method==='POST'){
        limiter.check(`connect:${userId}`,5,60000);
        return json(res,201,await runner.connectionStart(userId));
      }
      if(url.pathname==='/api/connection'&&method==='DELETE')return json(res,200,{connection:await runner.disconnect(userId)});
      const connectionRoute=url.pathname.match(/^\/api\/connection\/([0-9a-f-]{36})(?:\/(frame|input|finish))?$/);
      if(connectionRoute){
        const [,id,action]=connectionRoute;
        if(!action&&method==='DELETE')return json(res,200,await runner.cancelConnection(userId,id));
        if(action==='frame'&&method==='GET')return json(res,200,await runner.connectionFrame(userId,id));
        if(action==='input'&&method==='POST')return json(res,200,await runner.connectionInput(userId,id,await body(req)));
        if(action==='finish'&&method==='POST')return json(res,200,{connection:await runner.connectionFinish(userId,id)});
      }
      throw new HttpError(404,'Not found.');
    }catch(error){
      const status=Number.isInteger(error.status)&&error.status>=400&&error.status<500?error.status:500;
      // Browser exceptions can carry private URLs; only deliberate public errors have a status.
      const message=status<500?String(error.message).slice(0,500):'The request could not be completed. Check the service configuration or try again.';
      if(!res.headersSent)json(res,status,{error:message});else res.end();
    }
  };
  const server=http.createServer((req,res)=>{void handler(req,res);});
  server.requestTimeout=60000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  server.maxRequestsPerSocket=1000;
  return {server,handler};
}

export async function startService(config=loadConfig()) {
  const repository=new Repository(config),runner=createRunner({repository,config}),app=createApp({config,repository,runner});
  try{
    await runner.start();
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(config.port,config.host,resolve);});
  }catch(error){await runner.stop().catch(()=>{});repository.close();throw error;}
  let closed=false;
  return {...app,repository,runner,config,async close(){if(closed)return;closed=true;await new Promise(resolve=>app.server.close(resolve));await runner.stop();repository.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  startService().then(service=>{
    console.log(`Court Scheduler: ${service.config.origin} (${service.config.mode}; live ${service.config.liveEnabled?'enabled':'disabled'})`);
    const stop=()=>service.close().then(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }).catch(()=>{console.error('Court Scheduler could not start. Check the configuration, data directory, port and scheduler lease.');process.exitCode=1;});
}
