import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if(process.platform!=='win32')throw Error('This setup is for Windows.');
const root=path.resolve(import.meta.dirname,'..');
const data=path.join(root,'.data'),envFile=path.join(root,'.env');
if(!existsSync(envFile))throw Error('Configure the public origin first.');
function command(exe,args){
  const result=spawnSync(exe,args,{encoding:'utf8',windowsHide:true});
  if(result.error||result.status!==0)throw Error(`${exe}: ${result.stderr||result.stdout||result.error?.message}`);
  return result.stdout;
}
const sid=command('whoami.exe',['/user','/fo','csv','/nh']).match(/S-1-5-\d+(?:-\d+)+/)?.[0];
if(!sid)throw Error('Could not identify the host Windows account.');
mkdirSync(data,{recursive:true});
for(const [target,inheritance] of [[data,'(OI)(CI)'],[envFile,'']]){
  command('icacls.exe',[target,'/inheritance:r','/grant:r',`*${sid}:${inheritance}F`,`*S-1-5-18:${inheritance}F`,`*S-1-5-32-544:${inheritance}F`]);
}
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const taskFile=path.join(data,'windows-task.xml');
const args=`--env-file="${envFile}" "${path.join(root,'scripts','windows-host.mjs')}"`;
writeFileSync(taskFile,`\uFEFF<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Invitation-only Court Scheduler. Starts after the owner signs in. Tailscale provides HTTPS.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="HostOwner"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
  <Actions Context="HostOwner"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>`,{encoding:'utf16le'});
command('schtasks.exe',['/Create','/TN','Court Scheduler v2','/XML',taskFile,'/F']);
writeFileSync(path.join(data,'windows-task.json'),JSON.stringify({registeredAt:new Date().toISOString(),taskName:'Court Scheduler v2',logonType:'InteractiveToken',runLevel:'LeastPrivilege',requiresWindowsSignInAfterReboot:true},null,2));
command('schtasks.exe',['/Run','/TN','Court Scheduler v2']);
console.log('Court Scheduler registered as a limited per-user task and started. Windows sign-in is required after a reboot.');
