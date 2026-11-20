import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');process.chdir(root);
const action=process.argv[2]||'status';
async function stop(){
  if(!existsSync('.data/host-status.json'))throw Error('No server status is available. Check Windows Task Scheduler.');
  const state=JSON.parse(readFileSync('.data/host-status.json','utf8'));
  if(['stopped','failed'].includes(state.state))return;
  if(state.state!=='running'||Date.now()-Date.parse(state.updatedAt)>30000)throw Error('Server is not ready. Check its status before stopping.');
  writeFileSync('.data/host-control.tmp',JSON.stringify({action:'stop',pid:state.pid,at:Date.now()}));
  renameSync('.data/host-control.tmp','.data/host-control.json');
  for(let i=0;i<40;i++){
    await setTimeout(500);
    const current=JSON.parse(readFileSync('.data/host-status.json','utf8'));
    if(current.pid===state.pid&&current.state==='stopped'){console.log('Court Scheduler stopped cleanly.');return;}
  }
  throw Error('Shutdown did not complete. Check the host log and Windows task; the process was not force-killed.');
}
function task(operation){const result=spawnSync('schtasks.exe',[operation,'/TN','Court Scheduler v2',...(operation==='/Query'?['/FO','LIST']:[])],{encoding:'utf8',windowsHide:true});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.error||result.status!==0)throw Error('Windows task command failed.');}
if(action==='status'){task('/Query');if(existsSync('.data/host-status.json'))console.log(readFileSync('.data/host-status.json','utf8'));}
else if(action==='start')task('/Run');
else if(action==='stop')await stop();
else if(action==='restart'){await stop();await setTimeout(2000);task('/Run');}
else if(action==='invite'){
  const result=spawnSync(process.execPath,['--env-file=.env','scripts/admin.mjs','create-invite','--name',process.argv[3]||'Participant','--hours','48'],{stdio:'inherit',windowsHide:true});if(result.error)throw result.error;process.exitCode=result.status??1;
}else throw Error('Use status, start, stop, restart or invite [recipient name].');
