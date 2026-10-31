import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

// Read-only production acceptance. Write workflows run against isolated fixtures in test-admin.mjs.
if(process.argv.some(arg=>['--issue-test','--send-test'].includes(arg)))throw new Error('This check is read-only. Use the admin panel to issue or email a pass.');
const config=JSON.parse(await readFile('wrangler.jsonc','utf8')),origin=config.vars.PUBLIC_BASE_URL;
const admin=(await readFile('.secrets/admin-token','utf8')).trim();
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const address=process.env.WALLET_TEST_ADDRESS;
const browser=await chromium.launch({headless:true,args:address?[`--host-resolver-rules=MAP ${new URL(origin).hostname} ${address}`]:[]});
await mkdir('artifacts',{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 if(process.argv.includes('--legacy-uuid'))await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.locator('#token').fill(admin);await page.locator('#auth-form button').click();
 await page.waitForFunction(()=>document.getElementById('count-passes').textContent!=='—');await page.waitForLoadState('networkidle');
 await page.screenshot({path:'artifacts/admin-desktop.png',fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'artifacts/admin-mobile.png',fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:1440,height:1000});
 if(await page.locator('.member-link').count()){
  await page.locator('.member-link').first().click();await page.locator('#field-memberName').waitFor();
  await page.screenshot({path:'artifacts/admin-editor.png',fullPage:true,animations:'disabled'});
  await page.locator('#field-memberName').fill('Unsaved browser check');await page.locator('#tab-delivery').click();await page.locator('#refresh-deliveries').click();
  await page.waitForFunction(()=>!document.getElementById('refresh-deliveries').disabled);await page.locator('#tab-details').click();
  assert.equal(await page.locator('#field-memberName').inputValue(),'Unsaved browser check');
  page.once('dialog',d=>d.accept());await page.locator('#close-editor').click();
 }
 await page.locator('[data-view=status]').click();await page.waitForFunction(()=>document.querySelectorAll('.component').length>0&&!document.getElementById('refresh-health').disabled);
 await page.screenshot({path:'artifacts/admin-status.png',fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'artifacts/admin-status-mobile.png',fullPage:true,animations:'disabled'});
 await page.locator('[data-view=templates]').click();assert.ok(await page.locator('#template-cards article').count()>=2);
 assert.deepEqual(errors,[]);
 console.log('Live admin checks passed: authentication, directory, edit panel, draft preservation, status, templates and mobile layout. No passes changed or emails sent.');
}finally{await browser.close();}
