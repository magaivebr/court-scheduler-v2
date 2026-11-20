const ORIGIN='https://usc.kuleuven.cloud';
const fail=(message,status=409)=>Object.assign(new Error(message),{status});

// Fill the official UI in the account's existing isolated context. No API replay,
// token extraction or credentials are sent to a caller-provided destination.
export async function signInOfficial(page,{email,password}){
  const url=new URL(page.url());
  if(url.origin!==ORIGIN||url.pathname!=='/pages/login')throw fail('Open a new account connection before signing in.');
  const emailField=page.locator('input[type="email"]:visible, input[placeholder="E-mail"]:visible');
  const passwordField=page.locator('input[type="password"]:visible');
  await emailField.waitFor({state:'visible',timeout:15000}).catch(()=>{});
  if(await emailField.count()!==1||await passwordField.count()!==1)throw fail('Use the official sign-in screen for this account.');
  const submit=page.getByRole('button',{name:/^(?:log\s?in|sign in|inloggen).*e-?mail.*(?:password|wachtwoord)$/i});
  if(await submit.count()!==1)throw fail('Use the official sign-in screen for this account.');
  try{
    // Check origin and fill both visible fields in one browser task so a redirect
    // between separate fill calls cannot receive the password.
    await page.evaluate(({email,password,origin})=>{
      if(location.origin!==origin||location.pathname!=='/pages/login')throw Error('Login destination changed.');
      const visible=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
      const emails=[...document.querySelectorAll('input[type="email"], input[placeholder="E-mail"]')].filter(visible);
      const passwords=[...document.querySelectorAll('input[type="password"]')].filter(visible);
      if(emails.length!==1||passwords.length!==1)throw Error('Login fields changed.');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(emails[0],email);setter.call(passwords[0],password);
      for(const field of [emails[0],passwords[0]]){field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
    },{email,password,origin:ORIGIN});
    if(!await submit.isEnabled())throw fail('Check your email address and password.');
    // Recheck after filling. A redirect must never receive a credential submission.
    const current=new URL(page.url());
    if(current.origin!==ORIGIN||current.pathname!=='/pages/login')throw fail('The login page changed. Start a new connection.');
    await submit.click({timeout:5000});
    await page.waitForURL(u=>u.origin!==ORIGIN||u.pathname!=='/pages/login',{timeout:12000}).catch(()=>{});
    const next=new URL(page.url());
    if(next.origin===ORIGIN&&next.pathname==='/pages/login')return {status:'credentials_required',message:'Sign-in was not completed. Check your email and password, or use university sign-in.'};
    if(next.origin!==ORIGIN)return {status:'attention_required',message:'Complete the additional verification on the official sign-in screen.'};
    return {status:'signed_in'};
  }finally{
    password='';
    // Clear a rejected password from the remote form too. Never log page errors.
    if(!page.isClosed()&&new URL(page.url()).origin===ORIGIN&&new URL(page.url()).pathname==='/pages/login')await passwordField.fill('').catch(()=>{});
  }
}
