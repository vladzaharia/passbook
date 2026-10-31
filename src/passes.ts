import { HTTPException } from 'hono/http-exception';
import type { Env, PassRow, Personalization } from './types.ts';
import { getTemplate } from './templates/index.ts';
import { personalize, validateInputs } from './personalize.ts';
import { signPass } from './sign.ts';
import { getSigningIdentity } from './signing-identities.ts';
import { loadAssets } from './assets.ts';
import { baseURL, canonical, randomToken, mime } from './util.ts';

export async function findPass(env: Env, serial: string): Promise<PassRow> {
  const row=await env.DB.prepare('SELECT * FROM passes WHERE serial=?').bind(serial).first<PassRow>();
  if(!row) throw new HTTPException(404,{message:'Pass not found'});
  return row;
}
export function passLinks(env: Env, row: PassRow) {
  const base=baseURL(env.PUBLIC_BASE_URL);
  return {serial:row.serial,version:row.version,revision:row.revision,downloadURL:`${base}/p/${row.download_token}/pass.pkpass`,walletURL:`${base}/p/${row.download_token}`};
}
async function build(env: Env, templateId: string, serial: string, token: string, input: Personalization) {
  const template=getTemplate(templateId), pass=personalize(template,input);
  Object.assign(pass,{serialNumber:serial,authenticationToken:token,webServiceURL:baseURL(env.PUBLIC_BASE_URL)+'/wallet'});
  const bytes=await signPass(pass,await loadAssets(env,template),getSigningIdentity(env,template.signingIdentity));
  const key=`passes/${serial}/${crypto.randomUUID()}.pkpass`;
  await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:mime}});
  return key;
}

export async function createPass(env: Env, options: {serial: string; templateId: string; input: unknown; source?: {id: string; reference: string}; recipient?: string}) {
  const template=getTemplate(options.templateId), input=validateInputs(template,options.input);
  if(await env.DB.prepare('SELECT serial FROM passes WHERE serial=?').bind(options.serial).first()) throw new HTTPException(409,{message:'Serial already exists; update the existing pass'});
  const token=randomToken(), download=randomToken();
  const key=await build(env,template.id,options.serial,token,input);
  try {
    const statements=[env.DB.prepare(`INSERT INTO passes (serial,template_id,template_version,pass_type,personalization,authentication_token,download_token,object_key,modified,source_id,source_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(options.serial,template.id,template.version,template.pass.passTypeIdentifier,canonical(input),token,download,key,Math.floor(Date.now()/1000),options.source?.id??null,options.source?.reference??null)];
    if(options.recipient) statements.push(env.DB.prepare('INSERT INTO outbox (id,kind,serial,payload) VALUES (?,?,?,?)').bind(crypto.randomUUID(),'email',options.serial,JSON.stringify({to:options.recipient})));
    await env.DB.batch(statements);
  } catch(error) {
    const published=await env.DB.prepare('SELECT object_key FROM passes WHERE serial=?').bind(options.serial).first<{object_key:string}>();
    // A connection error can occur after the database committed. Preserve that published object.
    if(published?.object_key===key) return findPass(env,options.serial);
    await env.BUCKET.delete(key);
    if(published) throw new HTTPException(409,{message:'Serial already exists'});
    throw error;
  }
  return findPass(env,options.serial);
}

export async function updatePass(env: Env, current: PassRow, patch: Record<string,unknown>): Promise<{pass: PassRow; changed: boolean}> {
  const template=getTemplate(current.template_id);
  for(const key of Object.keys(patch)) if(!Object.hasOwn(template.inputs,key)) throw new HTTPException(400,{message:`Unknown personalization field: ${key}`});
  // null removes an optional input, allowing expiry dates to be cleared without arbitrary pass.json writes.
  const merged={...JSON.parse(current.personalization),...patch};
  for(const [key,value] of Object.entries(merged)) if(value===null) delete merged[key];
  const input=validateInputs(template,merged), json=canonical(input);
  if(json===current.personalization && template.version===current.template_version) return {pass:current,changed:false};
  const key=await build(env,template.id,current.serial,current.authentication_token,input);
  const modified=Math.floor(Date.now()/1000);
  // D1 meta.changes includes trigger writes. RETURNING identifies the actual winning row.
  // On an ambiguous database error, retain the uploaded object: the commit may have succeeded.
  const published=await env.DB.prepare(`UPDATE passes SET personalization=?,object_key=?,version=version+1,template_version=?,modified=?,modified_collision=? WHERE serial=? AND version=? AND source_version=? RETURNING serial`).bind(json,key,template.version,modified,modified===current.modified?1:0,current.serial,current.version,current.source_version).first<{serial:string}>();
  if(!published) {
    await env.BUCKET.delete(key);
    throw new HTTPException(409,{message:'Pass changed concurrently; fetch its current version and retry'});
  }
  return {pass:await findPass(env,current.serial),changed:true};
}

export async function passResponse(env: Env, row: PassRow, request?: Request): Promise<Response> {
  const headers=new Headers({'Content-Type':mime,'Content-Disposition':`attachment; filename="${row.serial}.pkpass"`,'Cache-Control':'private, no-cache','ETag':`"${row.version}"`,'Last-Modified':new Date(row.modified*1000).toUTCString(),'X-Content-Type-Options':'nosniff'});
  const etag=request?.headers.get('If-None-Match');
  const since=request?.headers.get('If-Modified-Since');
  // A one-second HTTP timestamp cannot distinguish two changes within that second. Prefer ETag;
  // conservatively return bytes for an ambiguous timestamp rather than hiding a Wallet update.
  if(etag ? etag===headers.get('ETag') : since && !row.modified_collision && Date.parse(since)===row.modified*1000) return new Response(null,{status:304,headers});
  const file=await env.BUCKET.get(row.object_key);
  if(!file) throw new Error('Signed pass is missing from storage');
  return new Response(file.body,{headers});
}
