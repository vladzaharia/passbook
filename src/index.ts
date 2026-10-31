import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { Env, PassRow, Job } from './types.ts';
import { templates, getTemplate } from './templates/index.ts';
import { sources, getSource } from './sources/index.ts';
import { assert, baseURL, email, equal, object, text } from './util.ts';
import { createPass, findPass, updatePass, passResponse, passLinks } from './passes.ts';
import { consume, dispatch } from './jobs.ts';
import { landing, studio } from './views.ts';
import { loadAsset } from './assets.ts';
import { serviceStatus } from './status.ts';

const app=new Hono<{Bindings:Env}>();
app.use('*',async(c,next)=>{
  const url=new URL(c.req.url),canonical=new URL(c.env.PUBLIC_BASE_URL);
  if(url.protocol==='http:'&&url.hostname===canonical.hostname&&canonical.protocol==='https:'){
    url.protocol='https:';url.port=canonical.port;return c.redirect(url.href,308);
  }
  await next();
});
app.use('*',bodyLimit({maxSize:32_768,onError:c=>c.json({error:'Request body too large'},413)}));
app.use('*',async(c,next)=>{
  await next();
  c.header('X-Content-Type-Options','nosniff');
  c.header('Referrer-Policy','no-referrer');
  c.header('X-Robots-Tag','noindex, nofollow');
  c.header('X-Frame-Options','DENY');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  c.header('Cache-Control','no-store');
});
app.onError((error,c)=>{
  if(error instanceof HTTPException) return c.json({error:error.message},error.status);
  if(error instanceof SyntaxError) return c.json({error:'Malformed JSON'},400);
  const requestId=crypto.randomUUID();
  console.error('request_failed',{requestId}); // Deliberately omit URLs, pass values, credentials and recipients.
  return c.json({error:'Service request failed',requestId},500);
});
app.get('/health',c=>c.json({status:'ok',service:'wallet'}));
app.get('/',c=>c.html(studio));
app.get('/studio',c=>c.html(studio));
app.get('/status',c=>c.html(studio));
app.get('/admin/:asset',async c=>{
  const name=c.req.param('asset');
  assert(['studio.js','studio.css'].includes(name),'Unknown asset');
  return new Response(Uint8Array.from(await loadAsset(c.env,'/admin/'+name)),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'}});
});
app.get('/apple/:asset',async c=>{
  const name=c.req.param('asset');
  assert(['add-to-apple-wallet.svg','add-to-apple-wallet.png'].includes(name),'Unknown artwork');
  return new Response(Uint8Array.from(await loadAsset(c.env,'/apple/'+name)),{headers:{'Content-Type':name.endsWith('.svg')?'image/svg+xml':'image/png'}});
});
app.get('/brand/:template/:asset',async c=>{
  const template=getTemplate(c.req.param('template'));
  const asset=c.req.param('asset');
  assert(['background@2x.png','logo@2x.png','icon@2x.png'].includes(asset),'Unknown artwork');
  return new Response(Uint8Array.from(await loadAsset(c.env,template.assets[asset])),{headers:{'Content-Type':'image/png'}});
});
app.use('/api/*',async(c,next)=>{
  if(!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length<32) throw new HTTPException(503,{message:'Admin authentication is not configured'});
  if(!await equal(c.req.header('Authorization')??'',`Bearer ${c.env.ADMIN_TOKEN}`)) throw new HTTPException(401,{message:'Unauthorized'});
  await next();
});
app.get('/api/templates',c=>c.json({templates:Object.values(templates).map(({id,version,name,inputs})=>({id,version,name,inputs})),sources:Object.keys(sources)}));
app.get('/api/status',async c=>c.json(await serviceStatus(c.env)));
app.get('/api/passes',async c=>{
  const after=c.req.query('after')??'';
  const query=(c.req.query('q')??'').trim(),template=c.req.query('template')??'',status=c.req.query('status')??'';
  assert(query.length<=100&&after.length<=80&&status.length<=80,'Invalid pass filter');
  const clauses:string[]=[],args:string[]=[];
  if(template){getTemplate(template);clauses.push('template_id=?');args.push(template);}
  if(status){
    if(status==='Voided')clauses.push("json_extract(personalization,'$.voided')=1");
    else{clauses.push("COALESCE(json_extract(personalization,'$.voided'),0)!=1 AND json_extract(personalization,'$.status')=?");args.push(status);}
  }
  if(query){
    clauses.push("(serial LIKE ? ESCAPE '\\' OR json_extract(personalization,'$.memberName') LIKE ? ESCAPE '\\' OR json_extract(personalization,'$.memberId') LIKE ? ESCAPE '\\')");
    const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';args.push(pattern,pattern,pattern);
  }
  const where=clauses.length?clauses.join(' AND '):'1=1';
  const results=await c.env.DB.batch([
    c.env.DB.prepare(`SELECT serial,template_id,version,revision,source_id,sync_error,personalization,modified FROM passes WHERE (${where}) AND serial>? ORDER BY serial LIMIT 51`).bind(...args,after),
    c.env.DB.prepare(`SELECT count(*) total FROM passes WHERE ${where}`).bind(...args)
  ]);
  const found=results[0].results as {serial:string;personalization:string;[key:string]:unknown}[];
  const rows=found.slice(0,50).map(({personalization,...row})=>{const data=JSON.parse(personalization);return {...row,displayName:String(data.memberName??row.serial),memberId:String(data.memberId??''),homeClub:String(data.homeClub??''),status:data.voided?'Voided':String(data.status??'')};});
  return c.json({passes:rows,total:Number((results[1].results[0] as {total:number}).total),next:found.length>50?rows.at(-1)!.serial:null});
});
app.post('/api/passes',async c=>{
  const body=object(await c.req.json());
  const templateId=text(body.templateId,'templateId');
  const serial=body.serial===undefined?crypto.randomUUID():text(body.serial,'serial',80);
  assert(/^[A-Za-z0-9_-]+$/.test(serial),'Serial may contain only letters, numbers, underscores and hyphens');
  let source: {id:string;reference:string}|undefined;
  if(body.source!==undefined) { const s=object(body.source); source={id:text(s.id,'source ID'),reference:text(s.reference,'source reference')}; getSource(source.id); }
  const recipient=body.email===undefined?undefined:email(body.email);
  if(recipient && (!c.env.EMAIL || !c.env.EMAIL_FROM)) throw new HTTPException(503,{message:'Email delivery is not configured'});
  const row=await createPass(c.env,{serial,templateId,input:body.personalization,source,recipient});
  c.executionCtx.waitUntil(dispatch(c.env).catch(()=>console.error('dispatch_deferred')));
  return c.json({...passLinks(c.env,row),emailStatus:recipient?'queued':undefined},201);
});
app.get('/api/passes/:serial',async c=>{
  const row=await findPass(c.env,c.req.param('serial'));
  const jobs=await c.env.DB.prepare('SELECT id,kind,state,attempts,provider_id,error FROM outbox WHERE serial=? ORDER BY rowid DESC LIMIT 20').bind(row.serial).all();
  return c.json({...passLinks(c.env,row),templateId:row.template_id,personalization:JSON.parse(row.personalization),source:row.source_id?{id:row.source_id,reference:row.source_reference,error:row.sync_error}:null,deliveries:jobs.results});
});
app.patch('/api/passes/:serial',async c=>{
  const row=await findPass(c.env,c.req.param('serial'));
  const version=c.req.header('If-Match');
  if(!version) throw new HTTPException(428,{message:'Supply If-Match with the current pass version, e.g. "1"'});
  if(version!==`"${row.version}"`) throw new HTTPException(412,{message:'Version mismatch'});
  const body=object(await c.req.json());
  const result=await updatePass(c.env,row,object(body.personalization));
  c.executionCtx.waitUntil(dispatch(c.env).catch(()=>console.error('dispatch_deferred')));
  return c.json({...passLinks(c.env,result.pass),changed:result.changed});
});
app.post('/api/passes/:serial/sync',async c=>{
  const row=await findPass(c.env,c.req.param('serial'));
  assert(row.source_id,'Pass has no update source');
  await c.env.JOBS.send({kind:'sync',serial:row.serial});
  return c.json({status:'queued'},202);
});
app.put('/api/passes/:serial/source',async c=>{
  const row=await findPass(c.env,c.req.param('serial'));
  const body=object(await c.req.json());
  let id:string|null=null,reference:string|null=null;
  if(body.source!==null) {
    const value=object(body.source);
    id=text(value.id,'source ID'); reference=text(value.reference,'source reference'); getSource(id);
  }
  await c.env.DB.prepare('UPDATE passes SET source_id=?,source_reference=?,source_version=source_version+1,next_sync=0,sync_error=NULL WHERE serial=?').bind(id,reference,row.serial).run();
  c.executionCtx.waitUntil(dispatch(c.env).catch(()=>console.error('dispatch_deferred')));
  return c.json({source:id?{id,reference}:null});
});
app.post('/api/passes/:serial/deliveries/:id/retry',async c=>{
  const row=await findPass(c.env,c.req.param('serial'));
  const result=await c.env.DB.prepare("UPDATE outbox SET state='pending',attempts=0,available_at=0,error=NULL WHERE id=? AND serial=? AND state='failed'").bind(c.req.param('id'),row.serial).run();
  if(!result.meta.changes) throw new HTTPException(409,{message:'Delivery is missing or is not failed'});
  c.executionCtx.waitUntil(dispatch(c.env).catch(()=>console.error('dispatch_deferred')));
  return c.json({status:'queued'},202);
});
app.post('/api/passes/:serial/email',async c=>{
  const row=await findPass(c.env,c.req.param('serial'));
  if(!c.env.EMAIL || !c.env.EMAIL_FROM) throw new HTTPException(503,{message:'Email delivery is not configured'});
  const body=object(await c.req.json()),to=email(body.to);
  const idempotency=text(c.req.header('Idempotency-Key'),'Idempotency-Key',100);
  assert(/^[A-Za-z0-9_-]+$/.test(idempotency),'Invalid Idempotency-Key');
  const id=`email:${row.serial}:${idempotency}`, payload=JSON.stringify({to});
  await c.env.DB.prepare('INSERT INTO outbox(id,kind,serial,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,'email',row.serial,payload).run();
  const job=await c.env.DB.prepare('SELECT state,payload FROM outbox WHERE id=?').bind(id).first<{state:string;payload:string}>();
  if(job!.payload!==payload) throw new HTTPException(409,{message:'Idempotency key was used for a different recipient'});
  c.executionCtx.waitUntil(dispatch(c.env).catch(()=>console.error('dispatch_deferred')));
  return c.json({id,status:job!.state},202);
});

async function downloadRow(env: Env, token: string) {
  if(!/^[a-f0-9]{64}$/.test(token)) throw new HTTPException(404);
  const row=await env.DB.prepare('SELECT * FROM passes WHERE download_token=?').bind(token).first<PassRow>();
  if(!row) throw new HTTPException(404);
  return row;
}
app.get('/p/:token',async c=>c.html(landing(c.env,await downloadRow(c.env,c.req.param('token')))));
app.get('/p/:token/pass.pkpass',async c=>passResponse(c.env,await downloadRow(c.env,c.req.param('token'))));

async function authorizedPass(env: Env, type: string, serial: string, authorization: string|undefined) {
  const row=await env.DB.prepare('SELECT * FROM passes WHERE serial=? AND pass_type=?').bind(serial,type).first<PassRow>();
  if(!row || !await equal(authorization??'',`ApplePass ${row.authentication_token}`)) throw new HTTPException(401,{message:'Unauthorized'});
  return row;
}
const registration='/wallet/v1/devices/:device/registrations/:type/:serial';
app.post(registration,async c=>{
  const row=await authorizedPass(c.env,c.req.param('type'),c.req.param('serial'),c.req.header('Authorization'));
  const device=text(c.req.param('device'),'device',256),body=object(await c.req.json());
  const token=text(body.pushToken,'pushToken',512);
  assert(/^[a-fA-F0-9]+$/.test(token),'Invalid push token');
  const results=await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO registrations(device,serial,push_token) VALUES (?,?,?) ON CONFLICT(device,serial) DO NOTHING').bind(device,row.serial,token),
    c.env.DB.prepare('UPDATE registrations SET push_token=?,registered_at=? WHERE device=? AND serial IN (SELECT serial FROM passes WHERE pass_type=?)').bind(token,Date.now(),device,row.pass_type)
  ]);
  return c.body(null,results[0].meta.changes===1?201:200);
});
app.delete(registration,async c=>{
  const row=await authorizedPass(c.env,c.req.param('type'),c.req.param('serial'),c.req.header('Authorization'));
  await c.env.DB.prepare('DELETE FROM registrations WHERE device=? AND serial=?').bind(c.req.param('device'),row.serial).run();
  return c.body(null,200);
});
app.get('/wallet/v1/devices/:device/registrations/:type',async c=>{
  // Apple deliberately authenticates this endpoint by the opaque device library identifier.
  const since=c.req.query('passesUpdatedSince')??'0';
  assert(/^\d{1,16}$/.test(since) && Number.isSafeInteger(Number(since)),'Invalid update tag');
  const rows=await c.env.DB.prepare(`SELECT p.serial,p.revision FROM passes p JOIN registrations r ON r.serial=p.serial WHERE r.device=? AND p.pass_type=? AND p.revision>? ORDER BY p.revision`).bind(c.req.param('device'),c.req.param('type'),Number(since)).all<{serial:string;revision:number}>();
  if(!rows.results.length) return c.body(null,204);
  return c.json({serialNumbers:rows.results.map(r=>r.serial),lastUpdated:String(rows.results.at(-1)!.revision)});
});
app.get('/wallet/v1/passes/:type/:serial',async c=>{
  const row=await authorizedPass(c.env,c.req.param('type'),c.req.param('serial'),c.req.header('Authorization'));
  return passResponse(c.env,row,c.req.raw);
});
app.post('/wallet/v1/log',async c=>{
  const body=object(await c.req.json());
  assert(Array.isArray(body.logs) && body.logs.length<=50 && body.logs.every(l=>typeof l==='string' && l.length<=2000),'Invalid Wallet logs');
  console.info('wallet_device_log',{count:body.logs.length});
  return c.body(null,200);
});

export default {
  fetch: app.fetch,
  queue: consume,
  scheduled(_controller: ScheduledController,env: Env,ctx: ExecutionContext) { ctx.waitUntil(dispatch(env)); }
} satisfies ExportedHandler<Env,Job>;
export { app };
