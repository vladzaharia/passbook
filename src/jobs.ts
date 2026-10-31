import type { Env, Job, OutboxRow, PassRow, Personalization } from './types.ts';
import { findPass, updatePass } from './passes.ts';
import { getSource } from './sources/index.ts';
import { passEmail } from './email.ts';
import { getTemplate } from './templates/index.ts';

export async function pushPass(env: Env, row: PassRow) {
  const registrations=await env.DB.prepare('SELECT DISTINCT push_token FROM registrations WHERE serial=?').bind(row.serial).all<{push_token:string}>();
  if(!registrations.results.length) return;
  const apns=env[getTemplate(row.template_id).apnsBinding] as Fetcher|undefined;
  if(!apns) throw new Error('APNs mTLS binding is not configured');
  for(const {push_token} of registrations.results) {
    const response=await apns.fetch(`https://api.push.apple.com/3/device/${encodeURIComponent(push_token)}`,{
      method:'POST',headers:{'content-type':'application/json','apns-topic':row.pass_type,'apns-priority':'5','apns-push-type':'background','apns-expiration':'0'},body:'{}',signal:AbortSignal.timeout(15_000),redirect:'manual'
    }).catch(error=>{
      const message=String(error?.message??'Connection failed').replace(/https?:\/\/\S+/g,'[endpoint]').replace(/[a-fA-F0-9]{32,}/g,'[redacted]').slice(0,250);
      console.error('apns_transport_failed',{name:error?.name,message});
      throw Object.assign(new Error('APNs transport failed'),{code:'APNS_TRANSPORT_FAILED'});
    });
    if(response.ok) continue;
    const result=await response.json().catch(()=>({})) as {reason?:string;timestamp?:number};
    if(response.status===410 && result.reason==='Unregistered' || response.status===400 && result.reason==='BadDeviceToken') {
      // Do not remove a new registration made after APNs invalidated an earlier registration.
      const before=response.status===410 && Number.isFinite(result.timestamp)?result.timestamp!:Date.now();
      await env.DB.prepare('DELETE FROM registrations WHERE push_token=? AND registered_at<=? AND serial IN (SELECT serial FROM passes WHERE pass_type=?)').bind(push_token,before,row.pass_type).run();
      continue;
    }
    throw Object.assign(new Error('APNs rejected update'),{code:`APNS_HTTP_${response.status}`});
  }
}

export async function processOutbox(env: Env, id: string): Promise<void> {
  const now=Date.now(), lease=crypto.randomUUID();
  const item=await env.DB.prepare(`UPDATE outbox SET state='processing',lease=?,available_at=?,attempts=attempts+1 WHERE id=? AND state IN ('pending','processing') AND available_at<=? RETURNING *`).bind(lease,now+120_000,id,now).first<OutboxRow>();
  if(!item) return;
  try {
    const pass=await findPass(env,item.serial);
    let providerId: string|null=null;
    if(item.kind==='push') await pushPass(env,pass);
    else {
      if(!env.EMAIL) throw new Error('Email Sending binding is not configured');
      const result=await env.EMAIL.send(await passEmail(env,pass,JSON.parse(item.payload).to));
      providerId=result.messageId;
    }
    await env.DB.prepare(`UPDATE outbox SET state='sent',provider_id=?,lease=NULL,error=NULL WHERE id=? AND lease=?`).bind(providerId,id,lease).run();
  } catch(error) {
    const code=(error as {code?:string}).code;
    const permanent=code && ['E_RECIPIENT_SUPPRESSED','E_VALIDATION_ERROR','E_RECIPIENT_NOT_ALLOWED'].includes(code);
    const failed=permanent || item.attempts>=8;
    // Store bounded diagnostic codes, never provider error text that might contain recipient data.
    await env.DB.prepare('UPDATE outbox SET state=?,available_at=?,lease=NULL,error=? WHERE id=? AND lease=?').bind(failed?'failed':'pending',now+Math.min(3600,2**item.attempts*15)*1000,code??'DELIVERY_FAILED',id,lease).run();
    console.error('delivery_failed',{id,kind:item.kind,code:code??'DELIVERY_FAILED',attempt:item.attempts});
  }
}

export async function syncPass(env: Env, serial: string, fetcher: typeof fetch=fetch) {
  const pass=await findPass(env,serial);
  if(!pass.source_id || !pass.source_reference) throw new Error('Pass has no update source');
  const source=getSource(pass.source_id);
  try {
    const patch=await source.refresh({env,reference:pass.source_reference,current:JSON.parse(pass.personalization) as Personalization,fetch:fetcher});
    const result=await updatePass(env,pass,patch);
    await env.DB.prepare('UPDATE passes SET sync_error=NULL,next_sync=? WHERE serial=? AND source_version=?').bind(Date.now()+source.intervalSeconds*1000,serial,pass.source_version).run();
    return result;
  } catch(error) {
    await env.DB.prepare('UPDATE passes SET sync_error=?,next_sync=? WHERE serial=? AND source_version=?').bind('SOURCE_REFRESH_FAILED',Date.now()+300_000,serial,pass.source_version).run();
    throw error;
  }
}

export async function dispatch(env: Env) {
  const now=Date.now();
  const pending=await env.DB.prepare("SELECT id FROM outbox WHERE state IN ('pending','processing') AND available_at<=? LIMIT 100").bind(now).all<{id:string}>();
  for(const row of pending.results) await env.JOBS.send({kind:'outbox',id:row.id});
  const due=await env.DB.prepare('SELECT serial,next_sync FROM passes WHERE source_id IS NOT NULL AND next_sync<=? ORDER BY next_sync LIMIT 100').bind(now).all<{serial:string;next_sync:number}>();
  for(const row of due.results) {
    const result=await env.DB.prepare('UPDATE passes SET next_sync=? WHERE serial=? AND next_sync=?').bind(now+120_000,row.serial,row.next_sync).run();
    if(result.meta.changes===1) {
      try { await env.JOBS.send({kind:'sync',serial:row.serial}); }
      catch(error) { await env.DB.prepare('UPDATE passes SET next_sync=? WHERE serial=? AND next_sync=?').bind(row.next_sync,row.serial,now+120_000).run(); throw error; }
    }
  }
}
export async function consume(batch: MessageBatch<Job>, env: Env) {
  for(const message of batch.messages) {
    try {
      if(message.body.kind==='outbox') await processOutbox(env,message.body.id);
      else await syncPass(env,message.body.serial);
      message.ack();
    } catch { message.retry({delaySeconds:60}); }
  }
}
