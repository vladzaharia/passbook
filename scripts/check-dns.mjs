import dns from 'node:dns';
import {isIP} from 'node:net';

// Deployment checks can outlive a resolver's negative cache after a new domain is created.
// Resolve only the configured hostname via public DNS; HTTPS still verifies its certificate.
export async function checkDNS(origin){
 const hostname=new URL(origin).hostname;
 try{await dns.promises.lookup(hostname);return;}catch(error){
  if(!['ENOTFOUND','EAI_AGAIN'].includes(error.code))throw error;
 }
 const response=await fetch('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(hostname)+'&type=A',{
  headers:{Accept:'application/dns-json'},signal:AbortSignal.timeout(10_000),redirect:'error'
 });
 if(!response.ok)throw new Error('Public DNS check failed for '+hostname);
 const data=await response.json();
 const addresses=(data.Answer??[]).filter(r=>r.type===1&&r.name.replace(/\.$/,'')===hostname&&isIP(r.data)===4).map(r=>({address:r.data,family:4}));
 if(data.Status!==0||!addresses.length)throw new Error('DNS for '+hostname+' is not published yet. Rerun npm run deploy:check after propagation.');
 const original=dns.lookup;
 dns.lookup=function(host,options,callback){
  if(host!==hostname)return original.apply(this,arguments);
  if(typeof options==='function'){callback=options;options={};}
  queueMicrotask(()=>options?.all?callback(null,addresses):callback(null,addresses[0].address,4));
 };
 console.log(`Local DNS has no answer for ${hostname}; checking its published address with hostname/TLS validation intact.`);
}
