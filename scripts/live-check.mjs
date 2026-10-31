import assert from 'node:assert/strict';
import dns from 'node:dns';
import {isIP} from 'node:net';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {unzipSync} from 'fflate';

const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
const origin=config.vars.PUBLIC_BASE_URL;
const address=process.env.WALLET_TEST_ADDRESS;
if(address){
 assert.ok(isIP(address),'WALLET_TEST_ADDRESS must be a published IP address');
 const original=dns.lookup;
 dns.lookup=function(host,options,callback){
  if(host!==new URL(origin).hostname)return original.apply(this,arguments);
  if(typeof options==='function'){callback=options;options={};}
  const record={address,family:isIP(address)};
  queueMicrotask(()=>options?.all?callback(null,[record]):callback(null,address,record.family));
 };
}
const admin=(await readFile('.secrets/admin-token','utf8')).trim();
const links=JSON.parse(await readFile('.secrets/live-test.json','utf8'));
const request=(path,options={})=>fetch(origin+path,{...options,redirect:'error',signal:AbortSignal.timeout(30_000)});
const authorized=(path,options={})=>request(path,{...options,headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json',...options.headers}});
const detail=async()=>{
 const response=await authorized('/api/passes/'+links.serial);assert.equal(response.status,200);
 return response.json();
};
const decode=bytes=>JSON.parse(new TextDecoder().decode(bytes));
async function verify(bytes){
 const files=unzipSync(bytes),manifest=decode(files['manifest.json']);
 assert.deepEqual(Object.keys(files).filter(n=>!['manifest.json','signature'].includes(n)).sort(),Object.keys(manifest).sort());
 for(const[name,hash]of Object.entries(manifest))assert.equal(createHash('sha1').update(files[name]).digest('hex'),hash,name);
 const dir=await mkdtemp(join(tmpdir(),'wallet-live-'));
 try{
  await writeFile(join(dir,'manifest.json'),files['manifest.json'],{mode:0o600});
  await writeFile(join(dir,'signature'),files.signature,{mode:0o600});
  execFileSync('openssl',['cms','-verify','-binary','-inform','DER','-in',join(dir,'signature'),'-content',join(dir,'manifest.json'),'-CAfile',resolve('certificates/AppleWWDRCAG4.pem'),'-partial_chain','-purpose','any','-out',join(dir,'verified')],{stdio:'pipe'});
 }finally{await rm(dir,{recursive:true,force:true});}
 const pass=decode(files['pass.json']);
 assert.equal(pass.webServiceURL,origin+'/wallet');
 assert.equal(pass.serialNumber,links.serial);
 assert.equal(pass.barcodes[0].format,'PKBarcodeFormatCode39');
 assert.equal(pass.barcodes[0].message,'DEMO0001');
 assert.ok(pass.featuredActions.some(a=>a.type==='place'&&a.placeIdentifier==='I23C636C7300F20FD'));
 console.log(`Signed download verified: ${Object.keys(manifest).length} manifest entries, trusted WWDR G4 CMS chain, Code 39, home-gym action, live update URL.`);
 return pass;
}

const initial=await detail();
assert.equal(new URL(links.downloadURL).origin,origin);
const response=await request(new URL(links.downloadURL).pathname);assert.equal(response.status,200);
const pass=await verify(new Uint8Array(await response.arrayBuffer()));
const email=initial.deliveries.find(d=>d.kind==='email');
assert.equal(email?.state,'sent','Email provider has not accepted the test message');
assert.ok(email.provider_id);
console.log('Cloudflare Email Sending accepted the test email with its signed attachment and private link.');

if(process.argv.includes('--updates')){
 assert.equal(initial.personalization.memberName,'Wallet Setup Test','Only the designated test pass may be changed');
 const device='live-check-'+randomUUID();
 const root='/wallet/v1/devices/'+device+'/registrations/'+pass.passTypeIdentifier;
 const registration=root+'/'+links.serial;
 const headers={Authorization:'ApplePass '+pass.authenticationToken,'Content-Type':'application/json'};
 try{
  assert.equal((await request(registration,{method:'POST',headers,body:JSON.stringify({pushToken:'00'.repeat(32)})})).status,201);
  const before=await(await request(root)).json();
  assert.ok(before.serialNumbers.includes(links.serial));
  assert.equal((await request(root+'?passesUpdatedSince='+before.lastUpdated)).status,204);
  const changed=await authorized('/api/passes/'+links.serial,{method:'PATCH',headers:{'If-Match':`"${initial.version}"`},body:JSON.stringify({personalization:{message:'Live updates verified '+new Date().toISOString()}})});
  assert.equal(changed.status,200);const update=await changed.json();assert.equal(update.changed,true);
  const after=await(await request(root+'?passesUpdatedSince='+before.lastUpdated)).json();
  assert.ok(after.serialNumbers.includes(links.serial));assert.ok(Number(after.lastUpdated)>Number(before.lastUpdated));
  const updated=await request('/wallet/v1/passes/'+pass.passTypeIdentifier+'/'+links.serial,{headers});
  assert.equal(updated.status,200);const etag=updated.headers.get('etag');assert.ok(etag);
  const bytes=new Uint8Array(await updated.arrayBuffer());const updatedPass=await verify(bytes);
  assert.equal(updatedPass.authenticationToken,pass.authenticationToken);
  await writeFile('.secrets/live-test.pkpass',bytes,{mode:0o600});
  assert.equal((await request('/wallet/v1/passes/'+pass.passTypeIdentifier+'/'+links.serial,{headers:{...headers,'If-None-Match':etag}})).status,304);
  console.log('Live Wallet registration, change cursor, version update, stable authentication, signed refetch and conditional HTTP 304 passed.');
  let job;
  for(let attempt=0;attempt<12;attempt++){
   job=(await detail()).deliveries.find(d=>d.kind==='push');
   if(job?.state==='sent'||job?.state==='failed')break;
   await new Promise(resolve=>setTimeout(resolve,5000));
  }
  console.log('APNs test job:',JSON.stringify(job));
  assert.equal(job?.state,'sent','APNs transport check did not complete');
  assert.equal((await request(root)).status,204,'APNs should reject and remove the deliberately invalid test token');
  console.log('APNs production mTLS transport verified: Apple rejected the invalid token and its test registration was removed. Physical-device delivery still requires an installed pass.');
 }finally{
  assert.equal((await request(registration,{method:'DELETE',headers})).status,200);
 }
}
