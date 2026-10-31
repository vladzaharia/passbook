import { signPass } from '../src/sign.ts';
import { templates } from '../src/templates/index.ts';
import { personalize,validateInputs } from '../src/personalize.ts';
import { unzipSync } from 'fflate';
export default {async test(_controller:unknown, env:{IDENTITY:string;ARTWORK:string}) {
 const template=templates.henrys;
 const input=validateInputs(template,{memberName:'Runtime Test',memberId:'00012345',membership:'Membership'});
 const pass=personalize(template,input);pass.serialNumber='runtime-test';
 const assets=Object.fromEntries(Object.entries(JSON.parse(env.ARTWORK) as Record<string,string>).map(([k,v])=>[k,Uint8Array.from(atob(v),c=>c.charCodeAt(0))]));
 const signed=await signPass(pass,assets,JSON.parse(env.IDENTITY));
 const files=unzipSync(signed);
 const parsed=JSON.parse(new TextDecoder().decode(files['pass.json']));
 if(parsed.barcodes[0].format!=='PKBarcodeFormatCode39' || parsed.barcodes[0].message!=='00012345' || !files.signature)throw new Error('Invalid runtime pass');
 const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
 for(const [name,hash]of Object.entries(manifest)) {
  const bytes=await crypto.subtle.digest('SHA-1',Uint8Array.from(files[name]));
  if(Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('')!==hash)throw new Error('Invalid manifest: '+name);
 }
 console.log('Native Workers signing, detached CMS verification, all PNGs, manifest and Code 39 passed.');
}};
