import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Local-only smoke check in the same Windows task/session that hosts the app.
export async function checkHostBrowser(config) {
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,...(config.browserExecutablePath?{executablePath:config.browserExecutablePath}:{channel:config.browserChannel||'msedge'})});
  try{
    const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
    await Promise.all(contexts.map(async(context,index)=>{
      await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Local server check</title><p>Ready</p>'}));
      await context.addCookies([{name:'isolation-check',value:String(index),domain:'court-scheduler.invalid',path:'/',secure:true,httpOnly:true}]);
      const page=await context.newPage();
      await page.goto('https://court-scheduler.invalid/',{waitUntil:'domcontentloaded'});
      assert.equal(await page.title(),'Local server check');
      const cookies=await context.cookies();
      assert.equal(cookies.find(cookie=>cookie.name==='isolation-check')?.value,String(index));
    }));
    return {sandbox:true,isolatedContexts:contexts.length};
  }finally{await browser.close();}
}
