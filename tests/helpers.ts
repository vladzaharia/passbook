import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Env, Job, EmailPayload, SigningIdentity } from '../src/types.ts';

// Executes the actual migration and SQL in SQLite, with D1-style transaction boundaries.
export class Database {
  sqlite=new DatabaseSync(':memory:');
  constructor(){this.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8'));}
  prepare(sql:string){return new Statement(this,sql,[]);}
  async batch(statements:Statement[]){this.sqlite.exec('BEGIN');try{const result=statements.map(s=>s.execute());this.sqlite.exec('COMMIT');return result;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
class Statement {
  owner:Database;sql:string;args:any[];
  constructor(owner:Database,sql:string,args:any[]){this.owner=owner;this.sql=sql;this.args=args;}
  bind(...args:any[]){return new Statement(this.owner,this.sql,args);}
  execute(){const before=Number(this.owner.sqlite.prepare('SELECT total_changes() n').get()!.n);const results=this.owner.sqlite.prepare(this.sql).all(...this.args);return {success:true,results,meta:{changes:Number(this.owner.sqlite.prepare('SELECT total_changes() n').get()!.n)-before}};}
  async first<T>(column?:string):Promise<T|null>{const row=this.execute().results[0];return (row?(column?row[column]:row):null) as T|null;}
  async all(){return this.execute();}
  async run(){return this.execute();}
}
export class Bucket {
  objects=new Map<string,Uint8Array>(); fail=false;
  async put(key:string,bytes:Uint8Array){if(this.fail)throw new Error('R2 unavailable');this.objects.set(key,Uint8Array.from(bytes));}
  async get(key:string){const bytes=this.objects.get(key);return bytes?{body:Uint8Array.from(bytes),arrayBuffer:async()=>Uint8Array.from(bytes).buffer}:null;}
  async delete(key:string){this.objects.delete(key);}
  async head(key:string){return this.objects.has(key)?{key}:null;}
  async list(){return {objects:Array.from(this.objects.keys(),key=>({key}))};}
}
export function testIdentity(){
  const dir=mkdtempSync(join(tmpdir(),'wallet-certs-'));
  const run=(args:string[])=>execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca-key.pem','-out','ca.pem','-subj','/CN=Wallet Test CA','-days','2']);
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout','key.pem','-out','req.pem','-subj','/UID=pass.com.henrysgymnasium.member/OU=48H7CLBV8Y/CN=Wallet Test']);
  run(['x509','-req','-in','req.pem','-CA','ca.pem','-CAkey','ca-key.pem','-CAcreateserial','-out','cert.pem','-days','1']);
  return {identity:{certificate:readFileSync(join(dir,'cert.pem'),'utf8'),privateKey:readFileSync(join(dir,'key.pem'),'utf8'),intermediate:readFileSync(join(dir,'ca.pem'),'utf8')},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
export function fixture(identity:SigningIdentity){
 const db=new Database(),bucket=new Bucket(),jobs:Job[]=[],emails:EmailPayload[]=[],pending:Promise<unknown>[]=[];
 const env={DB:db,BUCKET:bucket,JOBS:{send:async(job:Job)=>{jobs.push(job);}},ASSETS:{fetch:async(request:Request)=>new Response(readFileSync('public'+new URL(request.url).pathname))},EMAIL:{send:async(payload:EmailPayload)=>{emails.push(payload);return {messageId:'test-message'};}},ADMIN_TOKEN:'a'.repeat(64),SIGNER_HENRYS_CERTIFICATE:identity.certificate,SIGNER_HENRYS_PRIVATE_KEY:identity.privateKey,SIGNER_HENRYS_INTERMEDIATE:identity.intermediate,PUBLIC_BASE_URL:'https://wallet.example.com',EMAIL_FROM:'passes@wallet.example.com'} as unknown as Env;
 const ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as unknown as ExecutionContext;
 return {env,db,bucket,jobs,emails,ctx,async close(){await Promise.all(pending);db.sqlite.close();}};
}
export const input={memberName:'Alex Morgan',memberId:'001234567',membership:'All-Inclusive Wellness'};
