import { readFile } from 'node:fs/promises';
import { checkDNS } from './check-dns.mjs';

async function main() {
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  const origin=config.vars.PUBLIC_BASE_URL;
  await checkDNS(origin);
  const admin=(await readFile('.secrets/admin-token','utf8')).trim();
  const get=(path,authorized=false)=>fetch(origin+path,{headers:authorized?{Authorization:`Bearer ${admin}`}:{},redirect:'error',signal:AbortSignal.timeout(15_000)});
  const health=await get('/health');
  if(!health.ok || (await health.json()).service!=='wallet') throw new Error('Public health check failed. DNS or TLS provisioning may still be pending.');
  if((await get('/api/templates')).status!==401) throw new Error('Admin route did not reject an unauthenticated request.');
  const templates=await get('/api/templates',true);
  if(!templates.ok || (await templates.json()).templates.length<2) throw new Error('Authenticated template catalog failed.');
  if(!(await get('/api/passes',true)).ok) throw new Error('D1 pass listing failed.');
  if(!(await get('/brand/henrys/background@2x.png')).ok) throw new Error('Deployed artwork unavailable.');
  if(!(await get('/admin/studio.js')).ok || !(await get('/admin/studio.css')).ok) throw new Error('Admin assets unavailable.');
  if(!(await get('/brand/henrys/logo@2x.png')).ok || !(await get('/apple/add-to-apple-wallet.png')).ok) throw new Error('Email image URLs failed.');
  const status=await get('/api/status',true);
  if(!status.ok || (await status.json()).state==='error') throw new Error('Service status reports a failed component.');
  if((await get('/templates/henrys/pass.json')).status!==404) throw new Error('Raw template path was unexpectedly public.');
  console.log(`Deployment HTTP checks passed at ${origin}. Verify email receipt and Wallet push delivery with a real member device.`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
