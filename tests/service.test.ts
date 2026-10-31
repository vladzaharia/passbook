import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fixture,input,testIdentity } from './helpers.ts';
import type { Env } from '../src/types.ts';
let api:any, identity:ReturnType<typeof testIdentity>;
before(async()=>{
 identity=testIdentity();await mkdir('artifacts',{recursive:true});
 await build({stdin:{contents:`export {app} from './src/index.ts'; export {processOutbox,pushPass,syncPass,dispatch} from './src/jobs.ts'; export {templates} from './src/templates/index.ts'; export {validateInputs,personalize} from './src/personalize.ts'; export {signPass} from './src/sign.ts'; export {updatePass,findPass} from './src/passes.ts';`,resolveDir:process.cwd()},outfile:'artifacts/test-module.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
 api=await import('../artifacts/test-module.mjs' as string);
});
after(()=>identity.cleanup());
function requester(f:ReturnType<typeof fixture>){return (method:string,path:string,body?:unknown,headers:Record<string,string>={})=>api.app.fetch(new Request('https://wallet.example.com'+path,{method,headers:{Authorization:'Bearer '+f.env.ADMIN_TOKEN,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined}),f.env,f.ctx) as Promise<Response>;}
async function issue(req:ReturnType<typeof requester>,serial='test-pass',extra={}){const r=await req('POST','/api/passes',{serial,templateId:'henrys',personalization:input,...extra});assert.equal(r.status,201,await r.clone().text());return r.json() as Promise<any>;}

test('authentication, validation, and prototype keys fail closed',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 assert.equal((await r('GET','/api/templates',undefined,{Authorization:'Bearer wrong'})).status,401);
 assert.equal((await r('POST','/api/passes',{templateId:'__proto__',personalization:input})).status,404);
 assert.equal((await r('POST','/api/passes',{templateId:'henrys',personalization:{...input,memberId:'*123*'}})).status,400);
 assert.equal((await r('POST','/api/passes',{templateId:'henrys',personalization:{...input,unexpected:'x'}})).status,400);
 assert.equal((await r('GET','/templates/henrys/pass.json')).status,404);
}finally{await f.close();}});

test('pass search covers all pages, combines filters, and treats SQL wildcards literally',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r);
 for(let n=0;n<55;n++){
  const serial='member-'+String(n).padStart(3,'0');
  const data={...input,memberName:n===54?'Beyond First Page':'Member '+n,memberId:String(n),status:n===54?'Suspended':'Active',homeClub:'Queen Anne',voided:n===53};
  f.db.sqlite.prepare(`INSERT INTO passes (serial,template_id,template_version,pass_type,personalization,authentication_token,download_token,object_key,modified) SELECT ?,template_id,template_version,pass_type,?,authentication_token,?,object_key,modified FROM passes WHERE serial='test-pass'`).run(serial,JSON.stringify(data),'download-'+serial);
 }
 const first=await(await r('GET','/api/passes')).json() as any;assert.equal(first.total,56);assert.equal(first.passes.length,50);assert.ok(first.next);
 const second=await(await r('GET','/api/passes?after='+first.next)).json() as any;assert.equal(second.passes.length,6);assert.equal(second.next,null);
 const search=await(await r('GET','/api/passes?q=Beyond&template=henrys&status=Suspended')).json() as any;assert.equal(search.total,1);assert.equal(search.passes[0].serial,'member-054');assert.equal(search.passes[0].homeClub,'Queen Anne');
 const literal=await(await r('GET','/api/passes?q='+encodeURIComponent('%_'))).json() as any;assert.equal(literal.total,0);
 const voided=await(await r('GET','/api/passes?status=Voided')).json() as any;assert.equal(voided.total,1);assert.equal(voided.passes[0].status,'Voided');
 assert.equal((await r('GET','/api/passes?template=unknown')).status,404);
}finally{await f.close();}});

test('issue, sign, download and independently verify every manifest digest and CMS signature',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 const result=await issue(r);const response=await r('GET',new URL(result.downloadURL).pathname);
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/vnd.apple.pkpass');
 const archive=unzipSync(new Uint8Array(await response.arrayBuffer()));const manifest=JSON.parse(new TextDecoder().decode(archive['manifest.json']));
 for(const [name,hash]of Object.entries(manifest))assert.equal(createHash('sha1').update(archive[name]).digest('hex'),hash,name);
 assert.equal(Object.keys(manifest).length,16);assert.ok(!archive['tooling.json']);
 const pass=JSON.parse(new TextDecoder().decode(archive['pass.json']));assert.equal(pass.barcodes[0].format,'PKBarcodeFormatCode39');assert.equal(pass.barcodes[1].format,'PKBarcodeFormatCode128');assert.equal(pass.barcodes[0].message,'001234567');assert.equal(pass.generic.primaryFields[0].value,'Alex Morgan');assert.equal(pass.posterGeneric.primaryFields[0].value,'Alex Morgan');assert.equal(pass.locations.length,1);assert.equal(pass.webServiceURL,'https://wallet.example.com/wallet');
 assert.deepEqual(Buffer.from(archive['background@3x.png']),await readFile('templates/henrys.pkpasstemplate/background@3x.png'));
 await writeFile('artifacts/test-manifest.json',archive['manifest.json']);await writeFile('artifacts/test-signature',archive.signature);
 execFileSync('openssl',['cms','-verify','-binary','-inform','DER','-in','artifacts/test-signature','-content','artifacts/test-manifest.json','-noverify','-out','/dev/null'],{stdio:'pipe'});
 await writeFile('artifacts/test-manifest.json','tampered');assert.throws(()=>execFileSync('openssl',['cms','-verify','-binary','-inform','DER','-in','artifacts/test-signature','-content','artifacts/test-manifest.json','-noverify','-out','/dev/null'],{stdio:'pipe'}));
 assert.equal((await r('POST','/api/passes',{serial:'test-pass',templateId:'henrys',personalization:input})).status,409);
}finally{await f.close();}});

test('Wallet registration, token rotation, update cursor, conditional fetch and unregister',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r);const row=await api.findPass(f.env,'test-pass'),type=row.pass_type;
 const reg='/wallet/v1/devices/device-1/registrations/'+type+'/test-pass';const list='/wallet/v1/devices/device-1/registrations/'+type;const fetch='/wallet/v1/passes/'+type+'/test-pass';const auth={Authorization:'ApplePass '+row.authentication_token};
 assert.equal((await r('POST',reg,{pushToken:'ab'.repeat(32)})).status,401);
 assert.equal((await r('POST',reg,{pushToken:'ab'.repeat(32)},auth)).status,201);
 assert.equal((await r('POST',reg,{pushToken:'cd'.repeat(32)},auth)).status,200);
 assert.equal(f.db.sqlite.prepare('SELECT push_token FROM registrations').get()!.push_token,'cd'.repeat(32));
 const first=await (await r('GET',list)).json() as any;assert.deepEqual(first.serialNumbers,['test-pass']);
 assert.equal((await r('GET',list+'?passesUpdatedSince='+first.lastUpdated)).status,204);
 assert.equal((await r('GET',fetch,undefined,auth)).status,200);
 assert.equal((await r('GET',fetch,undefined,{...auth,'If-None-Match':'"1"'})).status,304);
 assert.equal((await r('PATCH','/api/passes/test-pass',{personalization:{status:'Suspended'}})).status,428);
 assert.equal((await r('PATCH','/api/passes/test-pass',{personalization:{status:'Suspended',voided:true}},{'If-Match':'"1"'})).status,200);
 const updated=await api.findPass(f.env,'test-pass');assert.equal(updated.authentication_token,row.authentication_token);assert.equal(updated.download_token,row.download_token);assert.ok(updated.revision>row.revision);
 assert.equal((await r('PATCH','/api/passes/test-pass',{personalization:{status:'Active'}},{'If-Match':'"1"'})).status,412);
 assert.equal((await r('GET',list+'?passesUpdatedSince='+first.lastUpdated)).status,200);
 assert.equal((await r('GET',fetch,undefined,{...auth,'If-None-Match':'"1"'})).status,200);
 assert.equal((await r('DELETE',reg,undefined,auth)).status,200);assert.equal((await r('GET',list)).status,204);
 assert.equal((await r('POST','/wallet/v1/log',{logs:['test']})).status,200);
}finally{await f.close();}});

test('no-op updates do not sign or notify; concurrent writers cannot overwrite each other',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r);const row=await api.findPass(f.env,'test-pass');const unchanged=await api.updatePass(f.env,row,{memberName:'Alex Morgan'});assert.equal(unchanged.changed,false);assert.equal(f.bucket.objects.size,1);
 const results=await Promise.allSettled([api.updatePass(f.env,row,{memberName:'First'}),api.updatePass(f.env,row,{memberName:'Second'})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.bucket.objects.size,2);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM outbox').get()!.n,1);
}finally{await f.close();}});

test('R2 failure leaves the previous pass downloadable and creates no notification',async()=>{const f=fixture(identity.identity),r=requester(f);try{const result=await issue(r);f.bucket.fail=true;const row=await api.findPass(f.env,'test-pass');await assert.rejects(api.updatePass(f.env,row,{memberName:'Change'}));assert.equal((await api.findPass(f.env,'test-pass')).version,1);assert.equal((await r('GET',new URL(result.downloadURL).pathname)).status,200);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM outbox').get()!.n,0);}finally{await f.close();}});

test('email contains a signed attachment and private link; retries and duplicate jobs are tracked',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 const links=await issue(r,'test-pass',{email:'member@example.com'});const job=f.db.sqlite.prepare("SELECT * FROM outbox WHERE kind='email'").get()!;
 await api.processOutbox(f.env,job.id);await api.processOutbox(f.env,job.id);assert.equal(f.emails.length,1);assert.equal(f.emails[0].to,'member@example.com');assert.match(f.emails[0].html,/Add to Apple Wallet/);assert.equal(f.emails[0].attachments[0].type,'application/vnd.apple.pkpass');assert.ok(unzipSync(Buffer.from(f.emails[0].attachments[0].content,'base64')).signature);
 assert.ok(f.emails[0].html.includes(`href="${links.downloadURL}"`));assert.ok(f.emails[0].html.includes(`href="${links.walletURL}"`));assert.match(f.emails[0].html,/Manage Pass/);assert.match(f.emails[0].html,/src="https:\/\/wallet.example.com\/apple\/add-to-apple-wallet.png"/);assert.match(f.emails[0].html,/src="https:\/\/wallet.example.com\/brand\/henrys\/logo@2x.png"/);assert.ok(!f.emails[0].html.includes('cid:'));assert.equal((await r('GET','/apple/add-to-apple-wallet.png')).status,200);assert.equal((await r('GET','/brand/henrys/logo@2x.png')).status,200);
 assert.equal((await r('POST','/api/passes/test-pass/email',{to:'member@example.com'},{'Idempotency-Key':'resend-1'})).status,202);
 assert.equal((await r('POST','/api/passes/test-pass/email',{to:'other@example.com'},{'Idempotency-Key':'resend-1'})).status,409);
 f.env.EMAIL={send:async()=>{throw Object.assign(new Error('temporarily unavailable'),{code:'E_RATE_LIMIT_EXCEEDED'});}};
 await api.processOutbox(f.env,'email:test-pass:resend-1');const failed=f.db.sqlite.prepare("SELECT * FROM outbox WHERE id='email:test-pass:resend-1'").get()!;assert.equal(failed.state,'pending');assert.equal(failed.attempts,1);assert.ok(Number(failed.available_at)>Date.now());
}finally{await f.close();}});

test('status requires authentication and reports missing storage without exposing credentials',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 assert.equal((await r('GET','/api/status',undefined,{Authorization:''})).status,401);
 await issue(r);
 const first=await(await r('GET','/api/status')).json() as any;
 assert.equal(first.metrics.passes,1);assert.equal(first.components.find((c:any)=>c.id==='storage').state,'healthy');
 assert.equal(first.components.find((c:any)=>c.id==='source-membership-api').state,'unconfigured');
 const text=JSON.stringify(first);assert.ok(!text.includes(f.env.ADMIN_TOKEN));assert.ok(!text.includes('BEGIN PRIVATE KEY'));
 f.bucket.objects.clear();const second=await(await r('GET','/api/status')).json() as any;
 assert.equal(second.components.find((c:any)=>c.id==='storage').state,'error');assert.equal(second.state,'error');
 const redirect=await api.app.fetch(new Request('http://wallet.example.com/studio'),f.env,f.ctx);
 assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'https://wallet.example.com/studio');
}finally{await f.close();}});

test('APNs uses production mTLS binding, topic and empty payload; invalid tokens are removed',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r);const row=await api.findPass(f.env,'test-pass');f.db.sqlite.prepare('INSERT INTO registrations (device,serial,push_token) VALUES (?,?,?)').run('device',row.serial,'abcd');let seen=false;
 f.env.APNS={fetch:async(url:string,init:any)=>{seen=true;assert.equal(url,'https://api.push.apple.com/3/device/abcd');assert.equal(init.body,'{}');assert.equal(init.headers['apns-topic'],row.pass_type);return Response.json({reason:'Unregistered'},{status:410});}} as unknown as Fetcher;
 await api.pushPass(f.env,row);assert.ok(seen);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM registrations').get()!.n,0);
}finally{await f.close();}});

test('source adapter maps API data, preserves unchanged values and fails without corrupting the pass',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r,'test-pass',{source:{id:'membership-api',reference:'member/123'}});f.env.MEMBERSHIP_API_BASE_URL='https://api.example.com/v1/';f.env.MEMBERSHIP_API_TOKEN='upstream-secret';
 const fetcher=async(request:Request)=>{assert.equal(request.url,'https://api.example.com/v1/members/member%2F123');assert.equal(request.headers.get('Authorization'),'Bearer upstream-secret');return Response.json({name:'Alex Morgan',membership:'All-Inclusive Wellness',active:false});};
 const result=await api.syncPass(f.env,'test-pass',fetcher);assert.equal(result.changed,true);assert.equal(JSON.parse(result.pass.personalization).voided,true);
 assert.equal((await api.syncPass(f.env,'test-pass',fetcher)).changed,false);
 await assert.rejects(api.syncPass(f.env,'test-pass',async()=>Response.json({name:'Bad',active:'false'})));assert.equal((await api.findPass(f.env,'test-pass')).version,2);
}finally{await f.close();}});

test('both themes keep the requested layout, full image sets, Code39 and leading zeroes',()=>{for(const id of ['henrys','henrys-blue']){const template=api.templates[id];const data=api.validateInputs(template,input);const pass=api.personalize(template,data);assert.equal(pass.posterGeneric.primaryFields.length,2);assert.equal(pass.posterGeneric.footerFields[0].value,input.membership);assert.equal(pass.posterGeneric.headerFields[0].value,input.memberId);assert.equal(pass.barcodes[0].message,'001234567');assert.equal(Object.keys(template.assets).length,15);assert.equal(pass.locations.length,1);const all=api.personalize(template,{...data,access:'All clubs'});assert.equal(all.locations.length,2);}});

test('native directions action follows the home gym, including all-club access and updates',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 const result=await issue(r,'test-pass',{personalization:{...input,homeClub:'Queen Anne',access:'All clubs'}});
 const decode=async()=>{const response=await r('GET',new URL(result.downloadURL).pathname);return JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await response.arrayBuffer()))['pass.json']));};
 let pass=await decode();assert.equal(pass.locations.length,2);assert.equal(pass.featuredActions.length,2);assert.deepEqual(pass.featuredActions[1],{identifier:'home-gym-directions',type:'place',placeIdentifier:'I1F4F79088B704BE'});
 assert.equal((await r('PATCH','/api/passes/test-pass',{personalization:{homeClub:'Capitol Hill'}},{'If-Match':'"1"'})).status,200);
 pass=await decode();assert.equal(pass.featuredActions[1].placeIdentifier,'I23C636C7300F20FD');assert.equal(pass.posterGeneric.primaryFields[1].value,'Capitol Hill');
 assert.equal((await r('PATCH','/api/passes/test-pass',{personalization:{unknown:null}},{'If-Match':'"2"'})).status,400);
 const landing=await (await r('GET',new URL(result.walletURL).pathname)).text();assert.match(landing,/Directions to Capitol Hill/);assert.match(landing,/destination-place-id=I23C636C7300F20FD/);
}finally{await f.close();}});

test('changing update sources fences out refreshes from the previous source',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r);assert.equal((await r('PUT','/api/passes/test-pass/source',{source:{id:'membership-api',reference:'abc'}})).status,200);
 const before=await api.findPass(f.env,'test-pass');assert.equal(before.source_id,'membership-api');
 assert.equal((await r('PUT','/api/passes/test-pass/source',{source:null})).status,200);
 await assert.rejects(api.updatePass(f.env,before,{memberName:'Stale source result'}));
 const after=await api.findPass(f.env,'test-pass');assert.equal(after.source_id,null);assert.equal(after.version,1);assert.equal(f.bucket.objects.size,1);
}finally{await f.close();}});

test('an old APNs invalidation does not remove a freshly registered device',async()=>{const f=fixture(identity.identity),r=requester(f);try{
 await issue(r);const row=await api.findPass(f.env,'test-pass'),now=Date.now();
 f.db.sqlite.prepare('INSERT INTO registrations(device,serial,push_token,registered_at) VALUES (?,?,?,?)').run('device',row.serial,'abcd',now);
 f.env.APNS={fetch:async()=>Response.json({reason:'Unregistered',timestamp:now-1000},{status:410})} as unknown as Fetcher;
 await api.pushPass(f.env,row);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM registrations').get()!.n,1);
}finally{await f.close();}});
