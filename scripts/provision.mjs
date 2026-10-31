import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { cloudflare } from './cloudflare.mjs';
import { missingDNS, normalizeDNS as normalize } from './dns-records.mjs';

async function main() {
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  const identities=JSON.parse(await readFile('.secrets/identities.json','utf8'));
  const identity=identities.henrys;
  if(!identity) throw new Error('Import the Henry’s p12 with npm run credentials first.');
  const leaf=new X509Certificate(identity.certificate);
  if(Date.parse(leaf.validTo)<Date.now()+7*86400_000) throw new Error('Renew the pass certificate before provisioning.');
  if(!leaf.checkPrivateKey(createPrivateKey(identity.privateKey)) || !leaf.verify(new X509Certificate(identity.intermediate).publicKey)) throw new Error('Invalid signing material.');
  const api=cloudflare();
  const host=new URL(config.vars.PUBLIC_BASE_URL).hostname,zoneName='plrs.im';
  if(host!=='wallet.plrs.im') throw new Error('This provisioning plan targets wallet.plrs.im. Edit the plan explicitly to use another hostname.');
  const zones=await api.result('/zones?name='+encodeURIComponent(zoneName));
  if(zones.length!==1) throw new Error('Exactly one accessible plrs.im zone is required.');
  const zone=zones[0],account=zone.account.id;
  if(config.account_id && config.account_id!==account) throw new Error('Configured account does not own plrs.im.');
  config.account_id=account;
  const accountPath=`/accounts/${account}`,zonePath=`/zones/${zone.id}`;

  // Never take an existing hostname away from another application.
  const domains=await api.result(`${accountPath}/workers/domains`);
  const current=domains.find(d=>d.hostname===host);
  if(current && current.service!==config.name) throw new Error(`${host} belongs to another Worker.`);
  // DNS conflicts are checked by the Workers domains changeset during deployment.
  // Wrangler OAuth can manage its custom domains without general Zone DNS access.

  const dbConfig=config.d1_databases.find(b=>b.binding==='DB');
  const databases=await api.list(`${accountPath}/d1/database`);
  const database=databases.find(d=>d.name===dbConfig.database_name) ?? await api.result(`${accountPath}/d1/database`,'POST',{name:dbConfig.database_name});
  dbConfig.database_id=database.uuid;
  console.log('D1 database ready.');

  const bucket=config.r2_buckets.find(b=>b.binding==='BUCKET').bucket_name;
  try { await api.result(`${accountPath}/r2/buckets/${bucket}`); }
  catch(error) { if(error.status!==404) throw error; await api.result(`${accountPath}/r2/buckets`,'POST',{name:bucket}); }
  console.log('Private R2 bucket ready.');

  const queues=await api.list(`${accountPath}/queues`);
  for(const name of ['wallet-jobs-dlq','wallet-jobs']) {
    if(!queues.some(q=>q.queue_name===name)) await api.result(`${accountPath}/queues`,'POST',{queue_name:name});
  }
  console.log('Delivery and dead-letter queues ready.');

  const certName='wallet-henrys-'+leaf.fingerprint256.replaceAll(':','').slice(0,16).toLowerCase();
  const certificates=await api.list(`${accountPath}/mtls_certificates`);
  const certificate=certificates.find(c=>c.name===certName) ?? await api.result(`${accountPath}/mtls_certificates`,'POST',{
    name:certName,ca:false,certificates:identity.certificate+'\n'+identity.intermediate,private_key:identity.privateKey
  });
  config.mtls_certificates=[{binding:'APNS',certificate_id:certificate.id}];
  console.log(`APNs mTLS identity ready; expires ${leaf.validTo}.`);
  // Persist IDs before optional provider onboarding so rerunning resumes safely.
  await writeFile('wrangler.jsonc',JSON.stringify(config,null,2)+'\n');

  const sendingPath=`${zonePath}/email/sending/subdomains`;
  const senderDomain=config.vars.EMAIL_FROM.split('@')[1];
  const sendingDomains=await api.result(sendingPath);
  const sending=sendingDomains.find(d=>d.name===senderDomain && d.enabled) ?? await api.result(sendingPath,'POST',{name:senderDomain});
  if(!sending.enabled) throw new Error('Cloudflare Email Sending is not enabled. Complete onboarding in the dashboard.');
  const records=await api.result(`${sendingPath}/${sending.tag}/dns`);
  if(!records?.length) throw new Error('Cloudflare returned no Email Sending DNS records.');
  const missing=await missingDNS(records);
  for(const record of missing) {
    const name=normalize(record.name).toLowerCase();
    if(!(name===senderDomain || name.endsWith('.'+senderDomain)) || !['TXT','CNAME','MX'].includes(record.type)) throw new Error('Unexpected email DNS record scope; review the provider onboarding.');
    let existing;
    try { existing=await api.result(`${zonePath}/dns_records?name=${encodeURIComponent(name)}`); }
    catch(error) {
      if(error.status!==403) throw error;
      await mkdir('artifacts',{recursive:true});
      await writeFile('artifacts/required-email-dns.json',JSON.stringify(missing,null,2)+'\n');
      throw new Error(`Email DNS for ${senderDomain} is incomplete and this credential lacks Zone DNS access. Onboard that domain in Cloudflare Email Sending, or use a token with DNS:Edit for ${zoneName}. Required records: artifacts/required-email-dns.json. Existing resources were preserved.`);
    }
    if(existing.some(r=>r.type===record.type && normalize(r.content)===normalize(record.content) && (r.priority??0)===(record.priority??0))) continue;
    const matchesExpected=r=>records.some(expected=>normalize(expected.name).toLowerCase()===name && expected.type===r.type && normalize(expected.content)===normalize(r.content));
    if(existing.some(r=>!matchesExpected(r) && (r.type===record.type || r.type==='CNAME' || record.type==='CNAME'))) throw new Error(`Email DNS conflict at ${name}; existing records were preserved.`);
    await api.result(`${zonePath}/dns_records`,'POST',{type:record.type,name,content:record.content,ttl:record.ttl||1,...(record.priority===undefined?{}:{priority:record.priority}),...(record.type==='CNAME'?{proxied:false}:{})});
  }
  await mkdir('.secrets',{recursive:true,mode:0o700});
  await writeFile('.secrets/provisioned.json',JSON.stringify({account,zone:zone.id,sendingSubdomain:sending.tag,senderDomain,hostname:host,checkedAt:new Date().toISOString()},null,2),{mode:0o600});
  console.log(`Email Sending configured for ${config.vars.EMAIL_FROM}. Run npm run deploy to migrate, publish, and check the custom domain.`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
