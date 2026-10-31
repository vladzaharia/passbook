import {build} from 'esbuild';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts',{recursive:true});
await build({stdin:{contents:"export {app} from './src/index.ts';export {fixture,testIdentity} from './tests/helpers.ts';",resolveDir:process.cwd()},outfile:'artifacts/browser-app.mjs',bundle:true,format:'esm',platform:'node',packages:'external'});
const {app,fixture,testIdentity}=await import('../artifacts/browser-app.mjs');
const identity=testIdentity(),f=fixture(identity.identity);
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const headers=new Headers();for(const[name,value]of Object.entries(req.headers))if(value)headers.set(name,Array.isArray(value)?value.join(','):value);
  const request=new Request(f.env.PUBLIC_BASE_URL+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
  const response=await app.fetch(request,f.env,f.ctx);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Test server error');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;f.env.PUBLIC_BASE_URL=origin;
const request=(path,options={})=>fetch(origin+path,{...options,headers:{Authorization:'Bearer '+f.env.ADMIN_TOKEN,'Content-Type':'application/json',...options.headers}});
for(const[n,name,homeClub,status,templateId]of [[1,'Alex Morgan','Capitol Hill','Active','henrys'],[2,'Sam Chen','Queen Anne','Active','henrys-blue'],[3,'Jordan Lee','Capitol Hill','Suspended','henrys'],[4,'Riley Patel','Queen Anne','Active','henrys-blue'],[5,'Casey Reed','Capitol Hill','Expired','henrys']]){
 const r=await request('/api/passes',{method:'POST',body:JSON.stringify({serial:'demo-'+n,templateId,personalization:{memberName:name,memberId:'00'+n,membership:'All-Inclusive',homeClub,status}})});assert.equal(r.status,201);
}
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url);
const {chromium}=require('playwright'),browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
 await page.goto(origin,{waitUntil:'networkidle'});
 await page.locator('#token').fill(f.env.ADMIN_TOKEN);await page.locator('#auth-form button').click();
 await page.waitForFunction(()=>document.getElementById('count-passes').textContent==='5');await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('#pass-list tr').count(),5);
 await page.screenshot({path:'artifacts/admin-overhaul-desktop.png',fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'artifacts/admin-overhaul-mobile.png',fullPage:true,animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
 await page.locator('#filter-status').selectOption('Suspended');await page.waitForFunction(()=>document.getElementById('list-count').textContent==='1 of 1 pass');
 assert.match(await page.locator('#pass-list').innerText(),/Jordan Lee/);
 await page.locator('#filter-status').selectOption('');await page.locator('#search').fill('no-match');await page.locator('#list-empty').waitFor({state:'visible'});
 assert.equal(await page.locator('#empty-title').textContent(),'No matches');await page.locator('#clear-filters').click();
 await page.waitForFunction(()=>document.querySelectorAll('#pass-list tr').length===5);
 await page.getByRole('button',{name:'Edit Alex Morgan',exact:true}).click();await page.locator('#field-memberName').waitFor();
 await page.screenshot({path:'artifacts/admin-overhaul-editor.png',fullPage:true,animations:'disabled'});
 await page.locator('#field-memberName').fill('Alex Updated');await page.locator('#tab-delivery').click();await page.locator('#refresh-deliveries').click();
 await page.waitForFunction(()=>!document.getElementById('refresh-deliveries').disabled);await page.locator('#tab-details').click();
 assert.equal(await page.locator('#field-memberName').inputValue(),'Alex Updated');
 page.once('dialog',d=>d.dismiss());await page.locator('#close-editor').click();assert.equal(await page.locator('#editor').evaluate(d=>d.open),true);
 await page.locator('#save-pass').click();await page.waitForFunction(()=>document.getElementById('editor-notice').textContent==='Saved. Wallet update queued.');
 assert.equal((await(await request('/api/passes/demo-1')).json()).personalization.memberName,'Alex Updated');
 await page.locator('#field-memberName').fill('Keep this draft');
 const latest=await(await request('/api/passes/demo-1')).json();
 assert.equal((await request('/api/passes/demo-1',{method:'PATCH',headers:{'If-Match':JSON.stringify(String(latest.version))},body:JSON.stringify({personalization:{membership:'Changed elsewhere'}})})).status,200);
 await page.locator('#save-pass').click();await page.waitForFunction(()=>document.getElementById('editor-notice').textContent.includes('changed elsewhere'));
 assert.equal(await page.locator('#field-memberName').inputValue(),'Keep this draft');
 page.once('dialog',d=>d.accept());await page.locator('#close-editor').click();
 await page.locator('#new-pass').click();await page.locator('#field-memberName').fill('Browser Test');await page.locator('#field-memberId').fill('DEMO009');await page.locator('#field-membership').fill('Preview');
 const createdResponse=page.waitForResponse(r=>r.url()===origin+'/api/passes'&&r.request().method()==='POST');
 await page.locator('#save-pass').click();const created=await createdResponse;assert.equal(created.status(),201);const createdPass=await created.json();assert.match(createdPass.serial,/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
 await page.waitForFunction(()=>document.getElementById('editor-notice').textContent==='Pass created.');
 await page.locator('#tab-updates').click();await page.locator('#source').selectOption('membership-api');await page.locator('#reference').fill('external-123');await page.locator('#save-source').click();
 await page.waitForFunction(()=>document.getElementById('editor-notice').textContent==='Source saved.');
 assert.equal((await(await request('/api/passes/'+createdPass.serial)).json()).source.reference,'external-123');
 await page.locator('#tab-delivery').click();await page.locator('#resend-to').fill('browser-test@example.com');await page.locator('#resend-form button').click();
 await page.waitForFunction(()=>document.getElementById('editor-notice').textContent==='Email queued.');
 assert.ok((await(await request('/api/passes/'+createdPass.serial)).json()).deliveries.some(d=>d.kind==='email'));
 await page.setViewportSize({width:390,height:844});await page.locator('#tab-details').click();
 assert.equal(await page.locator('#editor').evaluate(d=>d.scrollWidth>d.clientWidth),false);await page.screenshot({path:'artifacts/admin-overhaul-editor-mobile.png',fullPage:true,animations:'disabled'});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#editor').evaluate(d=>d.open),false);
 await page.setViewportSize({width:1440,height:1000});await page.locator('[data-view=status]').click();await page.waitForFunction(()=>document.querySelectorAll('.component').length>0&&!document.getElementById('refresh-health').disabled);
 await page.screenshot({path:'artifacts/admin-overhaul-status.png',fullPage:true,animations:'disabled'});await page.locator('[data-view=templates]').click();assert.equal(await page.locator('#template-cards article').count(),2);
 assert.deepEqual(errors,[]);assert.equal(f.emails.length,0);
 console.log('Admin browser checks passed: responsive directory/editor, filters, create, save, conflict preservation, unsaved changes, delivery refresh, source setup, email queue, UUID fallback and status. No external messages sent.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();identity.cleanup();}
