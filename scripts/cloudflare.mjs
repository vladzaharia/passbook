import { execFileSync } from 'node:child_process';

export const wrangler = 'node_modules/wrangler/bin/wrangler.js';
export function runWrangler(args) {
  execFileSync(process.execPath,[wrangler,...args],{stdio:'inherit',env:{...process.env,WRANGLER_LOG_PATH:process.env.WRANGLER_LOG_PATH||'.wrangler/logs',WRANGLER_SEND_METRICS:'false'}});
}

export function cloudflare() {
  let auth;
  if(process.env.CLOUDFLARE_API_TOKEN) auth={token:process.env.CLOUDFLARE_API_TOKEN};
  else {
    try {
      // Capture credentials in memory only. Never echo auth stdout or a failed process object.
      auth=JSON.parse(execFileSync(process.execPath,[wrangler,'auth','token','--json'],{
        encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'},timeout:30_000
      }));
    } catch { throw new Error('Cloudflare authentication unavailable. Run npx wrangler login or set CLOUDFLARE_API_TOKEN.'); }
  }
  const headers=auth.token?{Authorization:`Bearer ${auth.token}`}:{'X-Auth-Key':auth.key,'X-Auth-Email':auth.email};
  async function request(path,method='GET',body) {
    let response;
    try {
      response=await fetch('https://api.cloudflare.com/client/v4'+path,{
        method,headers:{...headers,'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000),redirect:'error'
      });
    } catch { throw new Error('Cannot reach the Cloudflare API. This command requires outbound network access.'); }
    const data=await response.json();
    if(!response.ok || data.success===false) {
      // Error payloads can echo request bodies containing private keys; print codes only.
      throw Object.assign(new Error(`Cloudflare ${method} ${path.split('?')[0]} failed: HTTP ${response.status}; codes ${(data.errors||[]).map(e=>e.code).join(',')}. Check account access and product entitlement.`),{status:response.status});
    }
    return data;
  }
  async function result(path,method='GET',body) { return (await request(path,method,body)).result; }
  async function list(path) {
    const all=[];
    for(let page=1;page<=100;page++) {
      const response=await request(path+(path.includes('?')?'&':'?')+`page=${page}&per_page=100`);
      if(!Array.isArray(response.result)) throw new Error('Unexpected Cloudflare list response');
      all.push(...response.result);
      if(response.result_info?.total_pages ? page>=response.result_info.total_pages : response.result.length<100) return all;
    }
    throw new Error('Cloudflare list exceeded 100 pages');
  }
  return {request,result,list};
}
