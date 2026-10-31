import type {Env} from './types.ts';
import {templates} from './templates/index.ts';
import {sources} from './sources/index.ts';
import {getSigningIdentity} from './signing-identities.ts';
import {certificateStatus} from './sign.ts';
import {loadAsset} from './assets.ts';

type State='healthy'|'warning'|'error'|'configured'|'unconfigured';
type Component={id:string;name:string;state:State;detail:string;latencyMs?:number};
export async function serviceStatus(env:Env){
 const components:Component[]=[{id:'worker',name:'Workers API',state:'healthy',detail:'API responding.'}];
 let metrics={passes:0,devices:0,pending:0,failed:0};
 let deliveries:{kind:string;state:string;attempts:number;error:string|null;provider_id:string|null}[]=[];
 const started=Date.now();
 try{
  const counts=await env.DB.prepare(`SELECT (SELECT count(*) FROM passes) passes,(SELECT count(DISTINCT device) FROM registrations) devices,(SELECT count(*) FROM outbox WHERE state IN ('pending','processing')) pending,(SELECT count(*) FROM outbox WHERE state='failed') failed`).first<typeof metrics>();
  metrics=counts!;
  deliveries=(await env.DB.prepare('SELECT kind,state,attempts,error,provider_id FROM outbox ORDER BY rowid DESC LIMIT 50').all<typeof deliveries[number]>()).results;
  components.push({id:'database',name:'D1 database',state:'healthy',detail:'Database query passed.',latencyMs:Date.now()-started});
 }catch{components.push({id:'database',name:'D1 database',state:'error',detail:'Database query failed.'});}
 const template=Object.values(templates)[0];
 await Promise.all([
  (async()=>{const start=Date.now();try{
   const row=await env.DB.prepare('SELECT object_key FROM passes ORDER BY serial LIMIT 1').first<{object_key:string}>();
   if(row){if(!await env.BUCKET.head(row.object_key))throw new Error('missing');}
   else await env.BUCKET.list({limit:1});
   components.push({id:'storage',name:'R2 pass storage',state:'healthy',detail:row?'Published pass found.':'Bucket accessible. No passes yet.',latencyMs:Date.now()-start});
  }catch{components.push({id:'storage',name:'R2 pass storage',state:'error',detail:'Storage check failed or a published pass is missing.'});}})(),
  (async()=>{const start=Date.now();try{
   await loadAsset(env,template.assets['icon@2x.png']);
   components.push({id:'artwork',name:'Template artwork',state:'healthy',detail:`${Object.keys(templates).length} templates. Artwork loaded.`,latencyMs:Date.now()-start});
  }catch{components.push({id:'artwork',name:'Template artwork',state:'error',detail:'Template asset could not be loaded.'});}})()
 ]);
 for(const id of new Set(Object.values(templates).map(t=>t.signingIdentity))){
  try{
   const cert=certificateStatus(getSigningIdentity(env,id));
   components.push({id:'signer-'+id,name:`Signing certificate · ${id}`,state:cert.daysRemaining<0?'error':cert.daysRemaining<30?'warning':'healthy',detail:`Expires ${cert.expiresAt.slice(0,10)} · ${cert.daysRemaining} days remaining.`});
  }catch{components.push({id:'signer-'+id,name:`Signing certificate · ${id}`,state:'error',detail:'Signing identity is missing or invalid.'});}
 }
 const email=deliveries.find(d=>d.kind==='email');
 components.push({id:'email',name:'Cloudflare Email Sending',state:!env.EMAIL||!env.EMAIL_FROM?'unconfigured':email?.error?'warning':email?.state==='sent'&&email.provider_id?'healthy':'configured',detail:!env.EMAIL||!env.EMAIL_FROM?'Sender binding is not configured.':email?.error?`Last attempt: ${email.error}.`:email?.state==='sent'&&email.provider_id?`Latest email accepted by Cloudflare. Sender: ${env.EMAIL_FROM}. Inbox receipt is not measured.`:`Sender ${env.EMAIL_FROM} configured; no accepted delivery recorded.`});
 const push=deliveries.find(d=>d.kind==='push'&&d.error);
 components.push({id:'apns',name:'Apple Wallet push / APNs',state:Object.values(templates).some(t=>!env[t.apnsBinding])?'unconfigured':push?'warning':'configured',detail:push?`Recent push attempt failed: ${push.error}. Check delivery activity.`:'Certificate configured. Device receipt is not measured.'});
 components.push({id:'queue',name:'Queues & scheduled delivery',state:!env.JOBS?'unconfigured':metrics.failed?'error':metrics.pending?'warning':'configured',detail:`${metrics.pending} pending · ${metrics.failed} failed.`});
 for(const source of Object.values(sources)){
  const configured=source.id==='membership-api'?!!env.MEMBERSHIP_API_BASE_URL&&!!env.MEMBERSHIP_API_TOKEN:true;
  let failed=false;try{failed=!!await env.DB.prepare('SELECT serial FROM passes WHERE source_id=? AND sync_error IS NOT NULL LIMIT 1').bind(source.id).first();}catch{failed=true;}
  components.push({id:'source-'+source.id,name:`Update source · ${source.id}`,state:!configured?'unconfigured':failed?'warning':'configured',detail:!configured?'API URL and credentials missing.':failed?'A linked pass failed its last sync.':`Polls every ${source.intervalSeconds/60} minutes. API not probed by this check.`});
 }
 components.sort((a,b)=>a.id.localeCompare(b.id));
 return {checkedAt:new Date().toISOString(),state:components.some(c=>c.state==='error')?'error':components.some(c=>c.state==='warning')?'warning':'healthy',metrics,components};
}
