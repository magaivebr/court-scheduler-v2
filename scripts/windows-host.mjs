import { writeFileSync, renameSync, mkdirSync, appendFileSync, statSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import path from 'node:path';
import { startService } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { checkHostBrowser } from './check-host-browser.mjs';

const root=path.resolve(import.meta.dirname,'..');
process.chdir(root);
const config=loadConfig();
const statusPath=path.join(config.dataDir,'host-status.json');
const logPath=path.join(config.dataDir,'host.log');
const controlPath=path.join(config.dataDir,'host-control.json');
mkdirSync(config.dataDir,{recursive:true});
function log(message){
  if(existsSync(logPath)&&statSync(logPath).size>1_000_000){
    try{renameSync(logPath,path.join(config.dataDir,'host.previous.log'));}catch{}
  }
  appendFileSync(logPath,`${new Date().toISOString()} ${message}\n`);
}
function status(state){
  const data={state,pid:process.pid,updatedAt:new Date().toISOString(),origin:config.origin,mode:config.mode,liveEnabled:config.liveEnabled};
  const tmp=`${statusPath}.${process.pid}.tmp`;
  writeFileSync(tmp,JSON.stringify(data,null,2));renameSync(tmp,statusPath);
}
let service,timer,stopping=false;
async function stop(exitCode=0){
  if(stopping)return;stopping=true;clearInterval(timer);
  log('Server stopping.');status('stopping');
  const deadline=setTimeout(()=>process.exit(exitCode||1),15000);deadline.unref();
  await service?.close();status('stopped');process.exit(exitCode);
}
try{
  status('checking-browser');
  await checkHostBrowser(config);log('Sandboxed browser check passed; isolated contexts verified.');
  const startDeadline=Date.now()+45000;
  while(!service){
    try{service=await startService(config);}
    catch(error){
      if(error.status!==503||Date.now()>=startDeadline)throw error;
      status('waiting-for-lease');await pause(2000);
    }
  }
  log(`Server ready (${config.mode}).`);status('running');
  let lastStatus=Date.now();
  timer=setInterval(()=>{
    if(stopping)return;
    if(existsSync(controlPath)){
      try{
        const request=JSON.parse(readFileSync(controlPath,'utf8'));unlinkSync(controlPath);
        if(request.action==='stop'&&request.pid===process.pid&&Math.abs(Date.now()-request.at)<30000){void stop();return;}
      }catch{}
    }
    if(service.runner.running===false){log('Scheduler lease lost; restarting through Windows Task Scheduler.');void stop(1);}
    else if(Date.now()-lastStatus>=15000){status('running');lastStatus=Date.now();}
  },1000);
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  process.on('message',message=>{if(message==='shutdown')void stop();});
}catch{
  log('Server startup failed. Check configuration, local database, port and scheduler lease.');
  status('failed');process.exitCode=1;
}
