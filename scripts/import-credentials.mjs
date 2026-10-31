import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { X509Certificate, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { identityBindings } from '../src/identity-names.ts';
const p12=process.argv[2];
if(!p12) throw new Error('Usage: npm run credentials -- /path/to/HenrysPass.p12 [identity-name]');
const name=process.argv[3]||'henrys';
if(!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Identity names must be lowercase letters, digits, or hyphens.');
const openssl=process.env.OPENSSL||'openssl';
const run=(args,input)=>execFileSync(openssl,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
// Password is passed through stdin, never an argument or log. -legacy supports macOS Keychain exports.
const extract=flag=>run(['pkcs12','-legacy','-in',p12,'-passin','stdin',...flag],(process.env.P12_PASSWORD||'')+'\n');
const cert=extract(['-clcerts','-nokeys']).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]+'\n';
const key=run(['pkcs8','-topk8','-nocrypt'],extract(['-nocerts','-nodes']));
const intermediate=await readFile('certificates/AppleWWDRCAG4.pem','utf8');
const x=new X509Certificate(cert), ca=new X509Certificate(intermediate);
if(!x.verify(ca.publicKey)) throw new Error('WWDR does not verify the pass certificate');
if(!createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}).equals(x.publicKey.export({type:'spki',format:'der'}))) throw new Error('Certificate/key mismatch');
if(new Date(x.validTo)<new Date() || new Date(x.validFrom)>new Date()) throw new Error('Certificate not valid now');
await mkdir('.secrets',{recursive:true,mode:0o700});
await chmod('.secrets',0o700);
let identities={};
try { identities=JSON.parse(await readFile('.secrets/identities.json','utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
identities[name]={certificate:cert,privateKey:key,intermediate};
const out=async(path,value)=>{ await writeFile(path,value,{mode:0o600}); await chmod(path,0o600); };
await out('.secrets/identities.json',JSON.stringify(identities));
await out(`.secrets/${name}-certificate.pem`,cert+intermediate);
await out(`.secrets/${name}-key.pem`,key);
let admin; try { admin=(await readFile('.secrets/admin-token','utf8')).trim(); } catch { admin=randomBytes(32).toString('hex'); }
await out('.secrets/admin-token',admin);
let vars='';
const bindings={ADMIN_TOKEN:admin};
for(const [id,identity] of Object.entries(identities)) {const names=identityBindings(id);bindings[names.certificate]=identity.certificate;bindings[names.privateKey]=identity.privateKey;}
try { vars=(await readFile('.dev.vars','utf8')).split('\n').filter(line=>{const key=line.split('=')[0].trim();return key!=='SIGNING_IDENTITIES' && !Object.hasOwn(bindings,key);}).join('\n').trim(); } catch(error) { if(error.code!=='ENOENT') throw error; }
await out('.dev.vars',`${vars?vars+'\n':''}${Object.entries(bindings).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')}\n`);
console.log(`Prepared identity ${name}; ${x.subject.replaceAll('\n','; ')}; expires ${x.validTo}. Secrets written with mode 0600, never printed.`);
