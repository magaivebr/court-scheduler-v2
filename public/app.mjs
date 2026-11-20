const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ZONE = 'Europe/Brussels';
const hour = h => `${String(h).padStart(2, '0')}:00`;
const localDay = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(v => [v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const shiftDay = (date, amount) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+amount); return d.toISOString().slice(0,10); };
const dateLabel = (date, options={weekday:'long',day:'numeric',month:'long'}) => new Intl.DateTimeFormat('en-GB',{...options,timeZone:ZONE}).format(new Date(`${date}T12:00:00Z`));
const timeLabel = value => {
  const d = new Date(value);
  return Number.isFinite(d.valueOf()) ? new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(d) : 'Not available';
};
const state = {config:null,backendUrl:'',user:null,csrf:null,connection:{status:'disconnected'},jobs:[],date:shiftDay(localDay(),2),start:11,courts:[1,2,3],allowSwitch:true,view:'facilities',register:false,pendingPlan:null,bookingBusy:false,remote:null,remoteTimer:null,remoteWidth:1280,remoteHeight:900,toastTimer:null};
const connected = () => ['connected','simulated','ready'].includes(state.connection?.status);
const rehearsal = () => state.config?.mode === 'rehearsal';
const liveReady = () => rehearsal() || state.config?.liveEnabled === true;

async function request(path, {method='GET',body,timeout=30000}={}) {
  const headers = {'Accept':'application/json'};
  if(body !== undefined) headers['Content-Type']='application/json';
  if(state.csrf && method !== 'GET') headers['X-CSRF-Token']=state.csrf;
  let response;
  try { response = await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(timeout)}); }
  catch(error) { throw new Error(error.name==='TimeoutError'?'The request timed out. Check your schedules before trying again.':'The booking service could not be reached. Your saved schedules remain on the server.'); }
  const contentType=response.headers.get('content-type')||'';
  if(!contentType.includes('application/json')) throw new Error('The booking service returned an unexpected response.');
  const data=await response.json();
  if(!response.ok){
    if(response.status===401 && !path.startsWith('/api/auth/')) { state.user=null; state.csrf=null; state.jobs=[]; state.connection={status:'disconnected'}; renderAccount(); }
    const message=typeof data.error==='string'?data.error:(data.error?.message||data.message||`Request failed (${response.status}).`);
    throw new Error(message);
  }
  return data;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>{$('toast').hidden=true;},5500);}
function setError(id,error){$(id).textContent=error?.message||error||'';}
function openDialog(id){const d=$(id);if(!d.open)d.showModal();}
function closeDialog(id){$(id).close();}
function setView(view){state.view=view;$('facilities-view').hidden=view!=='facilities';$('schedules-view').hidden=view!=='schedules';if(view==='schedules'){renderJobs();refreshJobs().catch(error=>setError('jobs-error',error));}window.scrollTo({top:0,behavior:'instant'});}
function validBackend(value){try{const url=new URL(value);if(url.protocol==='https:'||(['localhost','127.0.0.1'].includes(url.hostname)&&url.protocol==='http:'))return url.href; }catch{}return '';}
function connectEntry(){
  if(!state.config){
    if(state.backendUrl) location.assign(state.backendUrl);
    else toast('The shared booking service has not been connected yet. No account details are collected on this page.');
    return;
  }
  if(!state.user){setAuthMode(false);setError('auth-error','');openDialog('auth-dialog');return;}
  renderAccount();setError('account-error','');openDialog('account-dialog');
}
function renderNotice(){
  const notice=$('service-notice');notice.className='service-notice';
  if(!state.config){
    notice.innerHTML=state.backendUrl?'<strong>Your private scheduler is a click away.</strong><p>This public page shows the court planner. Select Connect account to open the secure booking service.</p>':'<strong>Booking service not connected yet.</strong><p>Explore the court planner below. Scheduling and account connection become available when the private service is online. No reservations can be submitted from this page.</p>';
  } else if(rehearsal()){
    notice.classList.add('rehearsal');notice.innerHTML='<strong>Rehearsal mode · no real bookings</strong><p>Try the complete scheduling flow with an isolated rehearsal account. Results are simulated and do not reserve a court.</p>';
  } else if(!state.config.liveEnabled){
    notice.innerHTML='<strong>Booking service setup in progress.</strong><p>Account connection and read-only checks may be available. Automatic booking remains disabled until the live integration is verified.</p>';
  } else if(state.user && connected()){
    notice.classList.add('connected');notice.innerHTML='<strong>Your booking account is connected.</strong><p>Choose your sessions and select Schedule booking. Once accepted by the server, your device can be closed.</p>';
  } else {
    notice.innerHTML='<strong>Plan here. Let the server handle booking time.</strong><p>Connect your private account, choose two sessions and confirm a schedule. Nothing needs to be installed.</p>';
  }
}
function renderSelection(){
  $('playing-date').min=shiftDay(localDay(),1);$('playing-date').max=shiftDay(localDay(),31);$('playing-date').value=state.date;
  const days=Array.from({length:7},(_,i)=>shiftDay(localDay(),i+1));
  if(!days.includes(state.date))days[6]=state.date;
  $('date-strip').innerHTML=days.map(date=>`<button type="button" class="day-tab${date===state.date?' active':''}" role="tab" aria-selected="${date===state.date}" data-date="${date}">${escapeHTML(dateLabel(date,{weekday:'short',day:'2-digit',month:'2-digit'}))}</button>`).join('');
  $('time-slots').innerHTML=Array.from({length:14},(_,i)=>i+8).map(h=>`<button type="button" class="slot${h===state.start?' active':''}" aria-pressed="${h===state.start}" data-hour="${h}"><strong>${hour(h)}</strong><span>60 minutes</span></button>`).join('');
  $('selected-period').textContent=`${dateLabel(state.date,{weekday:'short',day:'numeric',month:'short'})} · ${hour(state.start)}–${hour(state.start+2)}`;
  $('booking-hours').textContent=`${hour(state.start)}–${hour(state.start+1)} and ${hour(state.start+1)}–${hour(state.start+2)}`;
  if(!state.bookingBusy){setError('booking-error','');$('booking-progress').textContent='';}
  updateBookingButton();
  $('release-line').textContent=`Booking opens ${dateLabel(shiftDay(state.date,-1),{weekday:'long',day:'numeric',month:'long'})} at 09:00 Brussels time.`;
}
function renderAccount(){
  $('account-name').textContent=state.user?.name||'Connect account';
  $('job-count').textContent=state.jobs.filter(j=>['armed','scheduled','preparing','running'].includes(j.status)).length;
  $('signed-in-as').textContent=state.user?`Signed in as ${state.user.name}.`:'';
  const label=state.connection?.accountLabel;
  const status=state.connection?.status||'disconnected';
  $('connection-card').innerHTML=`<strong>${status==='simulated'?'Rehearsal account connected':connected()?'Booking account connected':status==='needs_login'?'Reconnect required':'No booking account connected'}</strong><span>${label?escapeHTML(label):'Your official booking session stays separate from every other account.'}</span>`;
  $('connect-provider').textContent=connected()?'Reconnect booking account':'Connect booking account';
  $('connect-provider').hidden=rehearsal();
  $('rehearsal-connect').hidden=!rehearsal();
  $('rehearsal-connect').disabled=status==='simulated';
  $('disconnect-provider').hidden=!connected();
  renderNotice();updateBookingButton();
}
const statusLabels={draft:'Draft',tested:'Test passed',checked:'Test passed',armed:'Scheduled',scheduled:'Scheduled',preparing:'Preparing',running:'Booking in progress',confirmed:'Both hours booked',partial:'Partially booked',failed:'Unsuccessful',rejected:'Rejected',cancelled:'Stopped',stopped:'Stopped',unknown:'Needs review',needs_attention:'Needs review',needs_login:'Reconnect required',blocked:'Blocked',testing:'Testing'};
function renderJobs(){
  if(!state.user){$('jobs-list').innerHTML='<div class="empty-state"><h2>Your schedules, on every device</h2><p>Connect to the private booking service to save and manage your schedules. Account details are not collected on the public page.</p><button class="primary-button" data-action="connect" type="button">Connect account</button></div>';return;}
  if(!state.jobs.length){$('jobs-list').innerHTML='<div class="empty-state"><h2>No schedules yet</h2><p>Choose your playing date and two consecutive hours. Court selection and booking checks are automatic.</p><button class="primary-button" data-action="new" type="button">Choose sessions</button></div>';return;}
  $('jobs-list').innerHTML=[...state.jobs].sort((a,b)=>String(b.createdAt||b.id).localeCompare(String(a.createdAt||a.id))).map(job=>{
    const statuses=Array.isArray(job.results)?job.results:[];
    const stop=['draft','tested','checked','armed','scheduled','preparing'].includes(job.status);
    const choose=['draft','tested','checked'].includes(job.status);
    return `<article class="job-card" data-job="${escapeHTML(job.id)}"><div class="job-top"><h2>${escapeHTML(dateLabel(job.date))} · ${hour(job.start)}–${hour(job.start+2)}</h2><span class="job-badge ${escapeHTML(job.status)}">${escapeHTML(statusLabels[job.status]||job.status)}</span></div><div class="job-meta">Courts: ${escapeHTML((job.courts||[]).map(c=>`Court ${c}`).join(', '))}<br>${job.allowSwitch?'Same court first · Different courts as a backup':'Same court required by this previously saved plan'}<br>Booking release: ${escapeHTML(timeLabel(job.releaseAt))} · Brussels</div><div class="job-sessions">${[0,1].map(i=>{const result=statuses.find(r=>r.hour===job.start+i)||statuses[i];return `<div class="job-session"><strong>${hour(job.start+i)}–${hour(job.start+i+1)}</strong><span>${result?`${result.court?`Court ${escapeHTML(result.court)} · `:''}${escapeHTML(result.status==='confirmed'?'Confirmed':result.status||'Awaiting result')}`:'No confirmed reservation'}</span></div>`;}).join('')}</div>${job.mode==='rehearsal'?'<p class="mode-note">Rehearsal result only. No real court reservation.</p>':''}${job.status==='unknown'?'<p class="job-meta">The outcome is uncertain. Check My bookings on the official site before making another attempt.</p>':''}<div class="job-actions">${choose?`<button class="primary-button" data-action="choose" data-id="${escapeHTML(job.id)}" type="button">Choose these sessions</button>`:''}${stop?`<button class="secondary-button" data-action="stop" data-id="${escapeHTML(job.id)}" type="button">Stop schedule</button>`:''}<a class="text-button" href="https://usc.kuleuven.cloud/bookings/rent?tags=132" target="_blank" rel="noopener noreferrer">Open official booking site</a></div>${job.events?.length?`<details class="job-events"><summary>Activity · ${job.events.length} events</summary><ol>${job.events.map(e=>`<li><time>${escapeHTML(timeLabel(e.at))}</time>${escapeHTML(e.message)}</li>`).join('')}</ol></details>`:''}</article>`;
  }).join('');
}
async function refreshMe(){
  if(!state.config)return;
  const data=await request('/api/me');state.user=data.user;state.csrf=data.csrf;state.connection=data.connection||{status:'disconnected'};state.jobs=data.jobs||state.jobs;renderAccount();renderJobs();
}
async function refreshJobs(){
  if(!state.config||!state.user)return;
  const data=await request('/api/jobs');state.jobs=data.jobs||[];renderAccount();renderJobs();setError('jobs-error','');
}
function setAuthMode(register){
  state.register=register;$('auth-title').textContent=register?'Join Court Scheduler':'Sign in to Court Scheduler';$('auth-submit').textContent=register?'Create account':'Sign in';
  $('name-field').hidden=!register;$('invite-field').hidden=!register;$('auth-name').required=register;$('auth-invite').required=register;
  $('auth-password').autocomplete=register?'new-password':'current-password';$('auth-password').minLength=register?12:1;$('auth-password').maxLength=128;$('auth-username').maxLength=50;$('auth-username').pattern='[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,49}';
  $('signin-tab').classList.toggle('active',!register);$('signin-tab').setAttribute('aria-selected',String(!register));$('register-tab').classList.toggle('active',register);$('register-tab').setAttribute('aria-selected',String(register));setError('auth-error','');
}
function updateBookingButton(){
  const button=$('schedule-button');
  button.textContent=state.bookingBusy?'Checking and scheduling…':!state.config&&state.backendUrl?'Open booking service':rehearsal()?'Schedule rehearsal':'Schedule booking';
  button.disabled=state.bookingBusy||(!state.config&&!state.backendUrl)||Boolean(state.config&&!liveReady());
  $('booking-card').setAttribute('aria-busy',String(state.bookingBusy));
  document.querySelectorAll('#date-strip button, #time-slots button, #playing-date, #reset-selection').forEach(el=>{el.disabled=state.bookingBusy;});
}
async function schedulePlan(){
  if(state.bookingBusy)return;
  if(!state.config||!state.user||!connected()){connectEntry();return;}
  if(!liveReady())return;
  if(!$('playing-date').reportValidity())return;
  const selection={userId:state.user.id,date:state.date,start:state.start};
  if(!state.pendingPlan||Object.keys(selection).some(k=>state.pendingPlan[k]!==selection[k]))state.pendingPlan={...selection,key:crypto.randomUUID()};
  const pending=state.pendingPlan;
  state.bookingBusy=true;setError('booking-error','');updateBookingButton();
  $('booking-progress').textContent='Checking your two sessions…';
  let submitting=false;
  try{
    // Reuse the same request identifier after a lost response or retry.
    let {job}=await request('/api/jobs',{method:'POST',body:{date:pending.date,start:pending.start,authorization:false,idempotencyKey:pending.key}});
    if(!job.authorization){
      const checked=await request('/api/jobs/'+encodeURIComponent(job.id)+'/test',{method:'POST',body:{},timeout:90000});
      job=checked.job;
      if(!job.checkedAt)throw new Error('The booking checks did not pass. Nothing has been scheduled.');
      $('booking-progress').textContent='Checks passed. Scheduling your sessions…';
      submitting=true;
      // The labelled scheduling click authorizes the exact selection frozen above.
      ({job}=await request('/api/jobs/'+encodeURIComponent(job.id)+'/arm',{method:'POST',body:{authorization:true}}));
    }
    if(!job.authorization||!['armed','scheduled','preparing','running','confirmed','partial','unknown','failed','blocked'].includes(job.status))throw new Error('The server did not confirm this schedule. Check My schedules.');
    state.jobs=[job,...state.jobs.filter(j=>j.id!==job.id)];renderJobs();renderAccount();
    $('booking-progress').textContent='Schedule accepted by the server.';
    setView('schedules');
    toast(rehearsal()?'Rehearsal scheduled. No real booking will be made.':'Schedule accepted. You can close this device.');
  }catch(error){
    setError('booking-error',error);
    $('booking-progress').textContent=submitting?'The schedule could not be confirmed here. Check My schedules before retrying.':'Nothing has been scheduled by this request. You can retry when the issue is resolved.';
  }finally{state.bookingBusy=false;updateBookingButton();}
}
async function stopJob(id,button){
  if(button)button.disabled=true;
  try{await request(`/api/jobs/${encodeURIComponent(id)}/stop`,{method:'POST',body:{}});await refreshJobs();toast('Future execution stopped. Existing reservations were not cancelled.');}
  catch(error){setError('jobs-error',error);if(button)button.disabled=false;}
}
async function startRemote(){
  $('connect-provider').disabled=true;setError('account-error','');
  try{
    const {id}=await request('/api/connection/start',{method:'POST',body:{},timeout:60000});state.remote=id;state.remoteAutoSave=true;closeDialog('account-dialog');$('remote-image').hidden=true;$('remote-image').removeAttribute('src');$('remote-loading').hidden=false;$('remote-text').value='';$('booking-password').value='';setError('remote-error','');setError('booking-login-error','');openDialog('remote-dialog');showBookingForm();
  }catch(error){setError('account-error',error);}finally{$('connect-provider').disabled=false;}
}
function showBookingForm(){
  clearTimeout(state.remoteTimer);$('booking-password').type='password';$('booking-password-toggle').textContent='Show password';$('booking-login-form').hidden=false;$('official-login-view').hidden=true;$('remote-finish').hidden=true;$('remote-dialog').classList.add('simple-login');
}
function showOfficialLogin(){
  $('booking-password').value='';$('booking-login-form').hidden=true;$('official-login-view').hidden=false;$('remote-finish').hidden=false;$('remote-dialog').classList.remove('simple-login');state.remoteAutoSave=true;pollRemote();
}
async function submitBookingLogin(event){
  event.preventDefault();if(!state.remote)return;
  const id=state.remote,body={email:$('booking-email').value.trim(),password:$('booking-password').value};
  $('booking-password').value='';$('booking-connect').disabled=true;$('booking-connect').textContent='Connecting…';$('official-login-button').disabled=true;setError('booking-login-error','');
  try{
    const result=await request(`/api/connection/${encodeURIComponent(id)}/credentials`,{method:'POST',body,timeout:90000});
    if(state.remote!==id)return;
    if(result.status==='connected'){await closeRemote(false);await refreshMe();toast('Booking account connected. You are ready to check your sessions.');}
    else if(result.status==='attention_required'){showOfficialLogin();setError('remote-error',result.message);}
    else setError('booking-login-error',result.message||'Sign-in was not completed. Please try again.');
  }catch(error){if(state.remote===id)setError('booking-login-error',error);}
  finally{body.password='';$('booking-connect').disabled=false;$('booking-connect').textContent='Connect account';$('official-login-button').disabled=false;}
}
async function pollRemote(){
  clearTimeout(state.remoteTimer);const id=state.remote;if(!id||!$('remote-dialog').open)return;
  try{
    const frame=await request(`/api/connection/${encodeURIComponent(id)}/frame`);
    if(state.remote!==id)return;
    if(frame.authenticated&&state.remoteAutoSave){state.remoteAutoSave=false;await finishRemote();return;}
    $('remote-url').textContent=frame.url||'Official booking website';
    state.remoteWidth=frame.width||1280;state.remoteHeight=frame.height||900;
    if(typeof frame.image==='string'&&/^data:image\/(jpeg|png);base64,/.test(frame.image)){$('remote-image').src=frame.image;$('remote-image').hidden=false;$('remote-loading').hidden=true;}
    if(['expired','closed'].includes(frame.status)){state.remote=null;setError('remote-error','This connection session has ended. Close this window and connect again.');return;}
  }catch(error){if(state.remote===id)setError('remote-error',error);}
  if(state.remote===id)state.remoteTimer=setTimeout(pollRemote,1000);
}
async function remoteInput(input){
  if(!state.remote)return;setError('remote-error','');
  try{await request(`/api/connection/${encodeURIComponent(state.remote)}/input`,{method:'POST',body:input});}
  catch(error){setError('remote-error',error);}
}
async function closeRemote(cancel=true){
  const id=state.remote;state.remote=null;clearTimeout(state.remoteTimer);$('remote-text').value='';$('booking-password').value='';$('remote-image').removeAttribute('src');$('remote-image').hidden=true;closeDialog('remote-dialog');
  if(cancel&&id)await request(`/api/connection/${encodeURIComponent(id)}`,{method:'DELETE'}).catch(()=>{});
}
async function finishRemote(){
  if(!state.remote)return;$('remote-finish').disabled=true;setError('remote-error','');
  try{await request(`/api/connection/${encodeURIComponent(state.remote)}/finish`,{method:'POST',body:{},timeout:60000});await closeRemote(false);await refreshMe();toast('Booking session saved for your account.');}
  catch(error){setError('remote-error',error);}finally{$('remote-finish').disabled=false;}
}

$('facilities-tab').addEventListener('click',()=>setView('facilities'));
$('new-schedule').addEventListener('click',()=>setView('facilities'));
$('schedules-tab').addEventListener('click',()=>setView('schedules'));
$('account-button').addEventListener('click',connectEntry);
$('date-strip').addEventListener('click',event=>{const b=event.target.closest('[data-date]');if(b){state.date=b.dataset.date;renderSelection();}});
$('date-strip').addEventListener('keydown',event=>{
  if(state.bookingBusy||!['ArrowLeft','ArrowRight'].includes(event.key))return;const tabs=[...$('date-strip').querySelectorAll('button')],index=tabs.indexOf(document.activeElement);if(index<0)return;
  event.preventDefault();const next=tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];state.date=next.dataset.date;renderSelection();$('date-strip').querySelector(`[data-date="${state.date}"]`).focus();
});
$('playing-date').addEventListener('change',event=>{if(event.target.validity.valid&&event.target.value){state.date=event.target.value;renderSelection();}});
$('time-slots').addEventListener('click',event=>{const b=event.target.closest('[data-hour]');if(b){state.start=Number(b.dataset.hour);renderSelection();}});
$('reset-selection').addEventListener('click',()=>{state.date=shiftDay(localDay(),2);state.start=11;state.courts=[1,2,3];state.allowSwitch=true;renderSelection();});
$('schedule-button').addEventListener('click',schedulePlan);
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>closeDialog(button.dataset.close)));
$('signin-tab').addEventListener('click',()=>setAuthMode(false));$('register-tab').addEventListener('click',()=>setAuthMode(true));
$('auth-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!state.config)return;$('auth-submit').disabled=true;setError('auth-error','');
  const body={username:$('auth-username').value.trim().toLowerCase(),password:$('auth-password').value};
  if(state.register){body.name=$('auth-name').value.trim();body.invite=$('auth-invite').value.trim();}
  try{const data=await request(`/api/auth/${state.register?'register':'login'}`,{method:'POST',body});state.csrf=data.csrf;state.user=data.user;$('auth-password').value='';$('auth-invite').value='';closeDialog('auth-dialog');await refreshMe();connectEntry();toast('Signed in to your private scheduler.');}
  catch(error){setError('auth-error',error);}finally{$('auth-submit').disabled=false;body.password='';}
});
$('auth-dialog').addEventListener('close',()=>{$('auth-password').value='';$('auth-invite').value='';});
$('signout-button').addEventListener('click',async()=>{
  $('signout-button').disabled=true;setError('account-error','');
  try{await request('/api/auth/logout',{method:'POST',body:{}});state.user=null;state.csrf=null;state.jobs=[];state.connection={status:'disconnected'};closeDialog('account-dialog');renderAccount();renderJobs();toast('Signed out. Accepted schedules continue on the server.');}
  catch(error){setError('account-error',error);}finally{$('signout-button').disabled=false;}
});
$('rehearsal-connect').addEventListener('click',async()=>{
  $('rehearsal-connect').disabled=true;setError('account-error','');
  try{await request('/api/rehearsal/connect',{method:'POST',body:{}});await refreshMe();toast('Private rehearsal account connected. No real booking account is used.');}
  catch(error){setError('account-error',error);$('rehearsal-connect').disabled=false;}
});
$('disconnect-provider').addEventListener('click',async()=>{
  $('disconnect-provider').disabled=true;setError('account-error','');
  try{await request('/api/connection',{method:'DELETE'});await refreshMe();toast('Booking connection removed. Check affected schedules before reconnecting.');}
  catch(error){setError('account-error',error);}finally{$('disconnect-provider').disabled=false;}
});
$('jobs-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  if(button.dataset.action==='connect')connectEntry();
  if(button.dataset.action==='new')setView('facilities');
  if(button.dataset.action==='choose'&&!state.bookingBusy){const job=state.jobs.find(j=>j.id===button.dataset.id);if(job){state.date=job.date;state.start=job.start;renderSelection();setView('facilities');}}
  if(button.dataset.action==='stop')stopJob(button.dataset.id,button);
});
$('connect-provider').addEventListener('click',startRemote);$('remote-close').addEventListener('click',()=>closeRemote());$('remote-finish').addEventListener('click',finishRemote);
$('booking-login-form').addEventListener('submit',submitBookingLogin);
$('official-login-button').addEventListener('click',showOfficialLogin);
$('booking-password-toggle').addEventListener('click',()=>{const field=$('booking-password');field.type=field.type==='password'?'text':'password';$('booking-password-toggle').textContent=field.type==='password'?'Show password':'Hide password';});
$('back-to-booking-form').addEventListener('click',showBookingForm);
$('remote-dialog').addEventListener('cancel',event=>{event.preventDefault();closeRemote();});
$('remote-image').addEventListener('click',event=>{const rect=event.currentTarget.getBoundingClientRect();remoteInput({type:'click',x:Math.round((event.clientX-rect.left)*state.remoteWidth/rect.width),y:Math.round((event.clientY-rect.top)*state.remoteHeight/rect.height)});});
$('remote-text-form').addEventListener('submit',event=>{event.preventDefault();const text=$('remote-text').value;$('remote-text').value='';if(text)remoteInput({type:'text',text});});
document.querySelectorAll('[data-key]').forEach(button=>button.addEventListener('click',()=>remoteInput({type:'key',key:button.dataset.key})));
document.querySelectorAll('[data-scroll]').forEach(button=>button.addEventListener('click',()=>remoteInput({type:'scroll',deltaY:Number(button.dataset.scroll)})));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.user)refreshJobs().catch(()=>{});});

async function initialize(){
  renderSelection();renderJobs();
  try{
    const response=await fetch('config.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(response.ok&&response.headers.get('content-type')?.includes('json')){const data=await response.json();state.backendUrl=validBackend(data.backendUrl);}
  }catch{}
  try{
    const config=await request('/api/config',{timeout:8000});
    if(!['preview','rehearsal','live'].includes(config.mode))throw new Error('Invalid service configuration.');
    state.config=config;
    await refreshMe().catch(()=>{});
  }catch{state.config=null;}
  renderAccount();renderJobs();
  setInterval(()=>{if(state.user&&!document.hidden)refreshJobs().catch(error=>{if(state.view==='schedules')setError('jobs-error',error);});},5000);
}
initialize();
