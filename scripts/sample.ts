import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { signPass } from '../src/sign.ts';
import { personalize, validateInputs } from '../src/personalize.ts';
import type { PassTemplate } from '../src/types.ts';
import { build } from 'esbuild';
await mkdir('artifacts',{recursive:true});
await build({entryPoints:['src/templates/index.ts'],outfile:'artifacts/template.mjs',bundle:true,format:'esm',platform:'node'});
const {templates}=await import('../artifacts/template.mjs' as string) as {templates:Record<string,PassTemplate>};
// Standalone sample deliberately has no webServiceURL: do not install an update-enabled pass before deployment.
const identities=JSON.parse(await readFile('.secrets/identities.json','utf8'));
for(const template of Object.values(templates)) {
 const input=validateInputs(template,{memberName:'Alex Morgan',memberId:'DEMO0001',membership:'All-Inclusive Wellness',homeClub:template.id==='henrys-blue'?'Queen Anne':'Capitol Hill'});
 const pass=personalize(template,input);pass.serialNumber=`DEMO-${template.id}`;
 const assets=Object.fromEntries(await Promise.all(Object.entries(template.assets).map(async([name,path])=>[name,new Uint8Array(await readFile('public'+path))])));
 const bytes=await signPass(pass,assets,identities[template.signingIdentity]);
 await writeFile(`artifacts/${template.id}-demo.pkpass`,bytes);
 console.log(`Created artifacts/${template.id}-demo.pkpass using the real Henry’s certificate and sample membership data.`);
}
