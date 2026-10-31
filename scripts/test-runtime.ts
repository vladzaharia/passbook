import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { testIdentity } from '../tests/helpers.ts';
import assets from '../src/generated/henrys-assets.ts';
const dir=await mkdtemp(join(tmpdir(),'wallet-runtime-')), fixture=testIdentity();
try {
 await build({entryPoints:['tests/runtime-worker.ts'],outfile:join(dir,'worker.mjs'),bundle:true,platform:'browser',format:'esm',conditions:['workerd','worker','browser']});
 const artwork=Object.fromEntries(await Promise.all(Object.entries(assets).map(async([name,path])=>[name,await readFile('public'+path,{encoding:'base64'})])));
 await writeFile(join(dir,'identity.json'),JSON.stringify(fixture.identity),{mode:0o600});
 await writeFile(join(dir,'artwork.json'),JSON.stringify(artwork));
 await writeFile(join(dir,'config.capnp'),`using Workerd = import "/workerd.capnp";\nconst config :Workerd.Config = (services = [(name = "wallet", worker = (modules = [(name = "main", esModule = embed "worker.mjs")], compatibilityDate = "2026-07-30", compatibilityFlags = ["nodejs_compat"], bindings = [(name = "IDENTITY", text = embed "identity.json"), (name = "ARTWORK", text = embed "artwork.json")]))]);`);
 execFileSync(resolve('node_modules/.bin/workerd'),['test','-I',resolve('node_modules/workerd'),join(dir,'config.capnp')],{stdio:'inherit'});
} finally {fixture.cleanup();await rm(dir,{recursive:true,force:true});}
