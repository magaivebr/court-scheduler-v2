/* Isolated-world DOM adapter. No tokens, private app state, fetch, or API replay. */
(() => {
  const q=(id,root=document)=>root.querySelector(`[data-test-id="${id}"]`);
  const all=(id,root=document)=>[...root.querySelectorAll(`[data-test-id="${id}"]`)];
  const text=el=>el?.textContent?.replace(/\s+/g,' ').trim()??'';
  const visible=el=>!!el&&!el.hidden&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
  const enabled=el=>visible(el)&&!el.disabled&&!el.classList.contains('disabled')&&el.getAttribute('aria-disabled')!=='true';
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  // Observe before checking so a DOM replacement cannot fall between the check
  // and subscription. Only the deadline uses a timer; background polling adds lag.
  function until(fn,message,timeout=12000,signal) {
    return new Promise((resolve,reject)=>{
      let settled=false,deadline;
      const observer=new MutationObserver(check);
      function finish(error,value){if(settled)return;settled=true;observer.disconnect();clearTimeout(deadline);signal?.removeEventListener('abort',abort);window.removeEventListener('pagehide',abort);error?reject(error):resolve(value);}
      function abort(){finish(Error('Booking wait cancelled; the page or task is no longer active.'));}
      function check(){if(settled)return;try{const value=fn();if(value)finish(null,value);}catch(error){finish(error);}}
      observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
      signal?.addEventListener('abort',abort,{once:true});window.addEventListener('pagehide',abort,{once:true});
      deadline=setTimeout(()=>{const reason=typeof message==='function'?message():message;finish(reason instanceof Error?reason:Error(reason));},timeout);
      if(signal?.aborted)abort();else check();
    });
  }
  const hour=h=>`${String(h).padStart(2,'0')}:00`;
  const courtOf=s=>Number(s.match(/^B&FH Indoor Beachvolley ([123])$/)?.[1])||null;
  function account() {
    const menu=document.querySelector('#topMenu');
    return [...(menu?.querySelectorAll('[aria-haspopup],.dropdown-toggle')??[])].map(text).filter(t=>t&&!/shopping|cart|winkel|mand|login|log in|aanmeld/i.test(t)).at(-1)??'';
  }
  function selectedDate() {
    const input=q('native-date-picker-input');
    const selected=document.querySelector('[data-test-id^="day-selector-"][aria-selected="true"]');
    if(!selected) return null;
    const day=q('day-button',selected);
    if(day?.getAttribute('data-test-id-day-button-number')==='0') return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const m=text(selected).match(/\b(\d{1,2})[-.](\d{1,2})\b/);
    if(!m||!input?.value) return null;
    const anchor=Date.parse(input.value+'T12:00:00Z'), y=Number(input.value.slice(0,4));
    const candidates=[y-1,y,y+1].map(year=>`${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`).filter(s=>!isNaN(Date.parse(s))&&Math.abs(Date.parse(s+'T12:00:00Z')-anchor)<40*86400000);
    return candidates.length===1?candidates[0]:null;
  }
  function snapshot() {
    const slots=all('selectable-slot').map(el=>({hour:Number(text(q('selectable-slot-start-time',el)).split(':')[0]),duration:parseInt(text(q('selectable-slot-duration',el))),selected:el.querySelector('button')?.getAttribute('aria-pressed')==='true'}));
    return {url:location.href,category:text(q('rent-selected-tag-description')),date:selectedDate(),hours:slots.filter(s=>s.duration===60).map(s=>s.hour),selectedHour:slots.find(s=>s.selected)?.hour??null,accountLabel:account(),courts:cards().map(c=>c.court),capturedAt:new Date().toISOString()};
  }
  function cards() {return all('rental-bookable-option').map(el=>({el,court:courtOf(text(q('rental-slot-resource-description',el))),time:text(q('rental-start-and-end-time',el)),button:q('book-rental-slot',el),already:visible(q('going-to-rental-slot',el))})).filter(c=>c.court);}
  async function closeModal() {const b=q('button-close-modal');if(visible(b)){b.click();await until(()=>!visible(q('button-close-modal')),'Booking dialog did not close.');}}
  function categoryOK(){return /beach.*volley.*\(indoor\)/i.test(text(q('rent-selected-tag-description')));}
  async function selectDate(date) {
    await until(()=>q('native-date-picker-input'),'The official booking page is not ready. Sign in and open Indoor Beach volleyball.');
    if(!categoryOK()) throw Error('Select Beach volleyball (indoor) on the official site.');
    await closeModal();
    if(selectedDate()===date) return;
    const input=q('native-date-picker-input');
    if((input.min&&date<input.min)||(input.max&&date>input.max)) throw Error('The date is outside the website’s selectable range.');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,date);
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>selectedDate()===date,'Could not verify the selected date.');
    await delay(250);
  }
  async function selectHour(date,start,{timeout=12000}={}) {
    if(selectedDate()!==date) throw Error('Selected day changed. Execution stopped.');
    // The date label can render before the time controls. Wait for an enabled
    // control instead of permanently dropping a worker on the first empty render.
    const button=await until(()=>{
      if(selectedDate()!==date)throw Error('Selected day changed. Execution stopped.');
      const slot=all('selectable-slot').find(el=>text(q('selectable-slot-start-time',el))===hour(start)&&parseInt(text(q('selectable-slot-duration',el)))===60);
      const candidate=slot?.querySelector('button');
      return enabled(candidate)?candidate:false;
    },`No selectable 60-minute session at ${hour(start)}.`,timeout);
    if(button.getAttribute('aria-pressed')!=='true') button.click();
    await until(()=>cards().some(c=>c.time===`${hour(start)} - ${hour(start+1)}`),`No courts shown for ${hour(start)}.`);
    return cards().filter(c=>c.time===`${hour(start)} - ${hour(start+1)}`&&!c.already&&enabled(c.button)).map(c=>c.court);
  }
  function parseDate(s) {
    const clean=s.replace(/,/g,' ').replace(/\s+/g,' ').trim();
    let m=clean.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
    m=clean.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/);if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    const months={jan:1,januari:1,january:1,feb:2,februari:2,february:2,mar:3,mrt:3,maart:3,march:3,apr:4,april:4,may:5,mei:5,jun:6,juni:6,june:6,jul:7,juli:7,july:7,aug:8,augustus:8,august:8,sep:9,sept:9,september:9,oct:10,okt:10,oktober:10,october:10,nov:11,november:11,dec:12,december:12};
    const tokens=clean.toLowerCase().replace(/\./g,'').split(' '), index=tokens.findIndex(t=>months[t]);
    const year=tokens.find(t=>/^20\d{2}$/.test(t));
    const day=/^\d{1,2}$/.test(tokens[index-1]??'')?tokens[index-1]:tokens[index+1];
    return index>=0&&year&&/^\d{1,2}$/.test(day??'')?`${year}-${String(months[tokens[index]]).padStart(2,'0')}-${day.padStart(2,'0')}`:null;
  }
  function details() {
    const money=text(q('details-partial-cart-items-total-price'));
    return {date:parseDate(text(q('details-booking-start-date'))),time:text(q('details-booking-start-and-end-time')),court:courtOf(text(q('details-product-description'))),duration:Number(text(q('details-booking-minutes-duration'))),free:/^(?:€\s*0[.,]00|0[.,]00\s*€)$/.test(money),bookable:enabled(q('details-book-button')),already:visible(q('bookable-slot-book-button-going')),success:visible(q('booking-success')),waiting:visible(q('waiting-for-approval'))||visible(q('user-in-waiting-list-text')),error:text(document.querySelector('.modal-footer .alert-danger'))};
  }
  function verify(d,date,start,court) {if(d.date!==date||d.time!==`${hour(start)} - ${hour(start+1)}`||d.court!==court||d.duration!==60)throw Error('Booking details differ from the plan. Nothing submitted.');if(!d.free)throw Error('Only a verified €0.00 booking is supported.');}
  async function open(date,start,court) {
    await closeModal();await selectHour(date,start);
    const card=cards().find(c=>c.court===court&&c.time===`${hour(start)} - ${hour(start+1)}`);
    if(!card||card.already||!enabled(card.button))throw Error('Court is no longer available.');
    card.button.click();
    await until(()=>q('details-booking-minutes-duration')&&q('details-partial-cart-items-total-price')&&(q('details-book-button')||q('bookable-slot-book-button-going')||q('details-add-to-cart'))&&!visible(q('loading-partial-calculation-total'))&&![...document.querySelectorAll('.modal-body .spinner-border')].some(visible),()=>Object.assign(Error('Booking details failed to finish loading. Sign in and check membership.'),{retryablePreSubmit:true}));
    const d=details();verify(d,date,start,court);return d;
  }
  async function waitBookable(date,start,court,{timeout=12000,signal,retryReleaseWarning=false}={}) {
    return until(()=>{
      if(!visible(q('button-close-modal')))throw Error('Booking dialog was closed. Nothing submitted.');
      const d=details();verify(d,date,start,court);
      if(d.already||d.success||d.waiting)throw Error('This session already has a booking or pending result. Check My bookings.');
      if(d.error)throw Error(d.error);
      if(retryReleaseWarning&&!d.bookable&&visible(q('minutes-ahead-warning-text')))throw Object.assign(Error(text(q('minutes-ahead-warning-text'))),{retryablePreSubmit:true});
      return d.bookable?d:false;
    },()=>text(q('minutes-ahead-warning-text'))||'Book remained disabled. Check release time, membership and quota on the official site.',timeout,signal);
  }
  async function scan(job) {
    await selectDate(job.date);
    const availability=[];
    for(let i=0;i<2;i++){await closeModal();availability.push((await selectHour(job.date,job.start+i)).filter(c=>job.courts[i].includes(c)));}
    return availability;
  }
  async function outcome() {
    await until(()=>details().success||details().error,'Submission outcome is unknown. Check My bookings before retrying.',20000);
    const d=details();
    if(d.success&&!d.waiting)return {kind:'confirmed'};
    if(d.waiting)return {kind:'unknown',message:'The site shows a waitlist or approval request, not a confirmed court.'};
    return {kind:'rejected',message:d.error||'The booking was rejected.'};
  }
  globalThis.CourtAdapter={snapshot,scan,selectDate,selectHour,open,waitBookable,details,verify,closeModal,account,outcome,parseDate,
    submit(date,start,court){const d=details();verify(d,date,start,court);if(!d.bookable||d.already||d.success)throw Error('Final booking control is not ready.');q('details-book-button').click();}};
})();
