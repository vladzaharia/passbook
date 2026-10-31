import { readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runWrangler, cloudflare } from './cloudflare.mjs';
import { identityBindings } from '../src/identity-names.ts';

async function main() {
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  if(!config.account_id || config.d1_databases.some(d=>d.database_id.startsWith('00000000')) || !config.mtls_certificates?.length) throw new Error('Cloudflare resources are not provisioned. Run npm run provision first.');
  const provisioned=JSON.parse(await readFile('.secrets/provisioned.json','utf8'));
  if(provisioned.account!==config.account_id || provisioned.hostname!==new URL(config.vars.PUBLIC_BASE_URL).hostname) throw new Error('Provisioning state does not match the deployment.');
  const identities=JSON.parse(await readFile('.secrets/identities.json','utf8'));
  for(const identity of Object.values(identities)) {
    const cert=new X509Certificate(identity.certificate);
    if(Date.parse(cert.validTo)<Date.now()+7*86400_000) throw new Error('Signing certificate expires within seven days; renew first.');
  }
  const admin=(await readFile('.secrets/admin-token','utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(admin)) throw new Error('Invalid admin credential.');
  const secrets={ADMIN_TOKEN:admin};
  for(const [id,identity] of Object.entries(identities)) {
    const names=identityBindings(id);
    secrets[names.certificate]=identity.certificate;
    secrets[names.privateKey]=identity.privateKey;
  }
  for(const name of ['MEMBERSHIP_API_TOKEN','MEMBERSHIP_API_BASE_URL']) if(process.env[name]) secrets[name]=process.env[name];
  for(const [name,value] of Object.entries(secrets)) if(Buffer.byteLength(value)>5120) throw new Error(`Secret binding ${name} exceeds Cloudflare's 5 KiB limit.`);
  execFileSync('npm',['run','check'],{stdio:'inherit'});
  runWrangler(['d1','migrations','apply','DB','--remote']);
  const file='.secrets/deployment.json';
  const deployConfig='.wrangler.deploy.json';
  try {
    await writeFile(file,JSON.stringify(secrets),{mode:0o600}); await chmod(file,0o600);
    // Secrets travel in the same Worker version as the code; no unauthenticated setup window.
    // Wrangler's non-interactive custom-domain flow enables DNS/origin overrides.
    // Publish code separately, then use the domain API with both overrides disabled.
    await writeFile(deployConfig,JSON.stringify({...config,routes:[]},null,2)+'\n');
    runWrangler(['deploy','--config',deployConfig,'--secrets-file',file]);
    const api=cloudflare(),workerPath=`/accounts/${config.account_id}/workers/scripts/${config.name}`;
    const origins=config.routes.filter(r=>r.custom_domain).map(r=>({hostname:r.pattern,zone_id:provisioned.zone}));
    const changes=await api.result(`${workerPath}/domains/changeset?replace_state=true`,'POST',origins);
    if(changes.conflicting?.length || changes.updated?.some(d=>d.modified)) throw new Error('Custom-domain conflict detected; existing origins and DNS were preserved.');
    await api.result(`${workerPath}/domains/records`,'PUT',{origins,override_scope:true,override_existing_origin:false,override_existing_dns_record:false});
    console.log('Custom domain configured without replacing existing DNS or other Workers.');
  } finally { await rm(file,{force:true}); await rm(deployConfig,{force:true}); }
  execFileSync(process.execPath,['scripts/smoke.mjs'],{stdio:'inherit'});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
