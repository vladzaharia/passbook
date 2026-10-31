import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import { zipSync } from 'fflate';
import type { Json, SigningIdentity } from './types.ts';

const dataOID='1.2.840.113549.1.7.1';
function der(pem: string): ArrayBuffer {
  const bytes=Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));
  return bytes.buffer;
}
function certificate(pem: string): pki.Certificate {
  const parsed=asn1.fromBER(der(pem));
  if(parsed.offset===-1) throw new Error('Invalid signing certificate');
  return new pki.Certificate({ schema: parsed.result });
}
function subject(cert: pki.Certificate, oid: string): string | undefined {
  return cert.subject.typesAndValues.find(v=>v.type===oid)?.value.valueBlock.value;
}

export function certificateStatus(identity:SigningIdentity){
  const leaf=certificate(identity.certificate),issuer=certificate(identity.intermediate);
  if(!leaf.issuer.isEqual(issuer.subject)||leaf.notBefore.value>new Date()||issuer.notAfter.value<new Date())throw new Error('Invalid certificate chain');
  return {expiresAt:leaf.notAfter.value.toISOString(),daysRemaining:Math.floor((leaf.notAfter.value.getTime()-Date.now())/86400000)};
}

/** PKI.js builds CMS; Workers Web Crypto performs RSA signing. No subprocess or private-key JS arithmetic. */
export async function signPass(pass: Record<string, Json>, assets: Record<string, Uint8Array>, identity: SigningIdentity): Promise<Uint8Array> {
  if(pass.featuredActions!==undefined) {
    if(!Array.isArray(pass.featuredActions) || pass.featuredActions.length>2) throw new Error('Wallet supports at most two featured actions');
    const ids=new Set<string>();
    for(const action of pass.featuredActions) {
      if(!action || Array.isArray(action) || typeof action!=='object' || typeof action.identifier!=='string' || !action.identifier || ids.has(action.identifier)) throw new Error('Featured actions require unique identifiers');
      ids.add(action.identifier);
      if(action.type==='place') {
        if(typeof action.placeIdentifier!=='string' || !/^I[0-9A-Fa-f]{1,16}$/.test(action.placeIdentifier)) throw new Error('Location actions require an Apple Maps place identifier');
      } else if(typeof action.url!=='string' || !/^(https:|tel:)/.test(action.url)) throw new Error('Featured action requires a destination URL');
    }
  }
  const signer=certificate(identity.certificate), intermediate=certificate(identity.intermediate);
  const now=new Date();
  if(signer.notBefore.value>now || signer.notAfter.value<now) throw new Error('Pass signing certificate is not currently valid');
  if(intermediate.notBefore.value>now || intermediate.notAfter.value<now || !signer.issuer.isEqual(intermediate.subject)) throw new Error('Incorrect or expired WWDR intermediate');
  if(subject(signer,'0.9.2342.19200300.100.1.1')!==pass.passTypeIdentifier || subject(signer,'2.5.4.11')!==pass.teamIdentifier) throw new Error('Pass identity does not match signing certificate');
  // Workers adds timingSafeEqual to the global SubtleCrypto interface; PKI.js only needs standard Web Crypto.
  const engine=new pki.CryptoEngine({name:'WebCrypto',crypto,subtle:crypto.subtle}) as unknown as pki.ICryptoEngine;
  if(!await signer.verify(intermediate,engine)) throw new Error('Invalid certificate chain');
  const files: Record<string, Uint8Array>={};
  for(const [name,bytes] of Object.entries(assets)) {
    if(!/^(?:[A-Za-z0-9_-]+\.lproj\/)?[A-Za-z0-9_@.-]+\.(png|strings)$/.test(name) || name.includes('..')) throw new Error('Unsafe asset path');
    files[name]=bytes;
  }
  if(!Object.keys(files).some(k=>/^icon(?:@2x|@3x)?\.png$/.test(k))) throw new Error('Missing pass icon');
  files['pass.json']=new TextEncoder().encode(JSON.stringify(pass));
  const manifest: Record<string,string>={};
  for(const name of Object.keys(files).sort()) {
    const digest=await crypto.subtle.digest('SHA-1',Uint8Array.from(files[name]));
    manifest[name]=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
  const manifestBytes=new TextEncoder().encode(JSON.stringify(manifest));
  files['manifest.json']=manifestBytes;
  const digest=await crypto.subtle.digest('SHA-256',manifestBytes);
  const cms=new pki.SignedData({
    version:1,
    encapContentInfo:new pki.EncapsulatedContentInfo({eContentType:dataOID}),
    certificates:[signer,intermediate],
    signerInfos:[new pki.SignerInfo({
      version:1,
      sid:new pki.IssuerAndSerialNumber({issuer:signer.issuer,serialNumber:signer.serialNumber}),
      signedAttrs:new pki.SignedAndUnsignedAttributes({type:0,attributes:[
        new pki.Attribute({type:'1.2.840.113549.1.9.3',values:[new asn1.ObjectIdentifier({value:dataOID})]}),
        new pki.Attribute({type:'1.2.840.113549.1.9.5',values:[new asn1.UTCTime({valueDate:now})]}),
        new pki.Attribute({type:'1.2.840.113549.1.9.4',values:[new asn1.OctetString({valueHex:digest})]})
      ]})
    })]
  });
  const key=await crypto.subtle.importKey('pkcs8',der(identity.privateKey),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  await cms.sign(key,0,'SHA-256',manifestBytes.buffer as ArrayBuffer,engine);
  const signedDER=cms.toSchema(true).toBER(false);
  const signed=new pki.SignedData({schema:asn1.fromBER(signedDER).result});
  // Catch an accidentally paired certificate and key before distributing an unusable pass.
  if(!await signed.verify({signer:0,data:manifestBytes.buffer as ArrayBuffer,checkChain:false},engine)) throw new Error('Signing key does not match certificate');
  files.signature=new Uint8Array(new pki.ContentInfo({contentType:'1.2.840.113549.1.7.2',content:signed.toSchema(true)}).toSchema().toBER(false));
  return zipSync(files,{level:0}); // PNGs are already compressed; avoid spending Worker CPU recompressing.
}
