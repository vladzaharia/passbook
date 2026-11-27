import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import type { PassIdentity, SigningMaterial } from '../types.ts';

export const FIXTURE_IDENTITY: PassIdentity = {
  passTypeIdentifier: 'pass.im.plrs.wallet',
  teamIdentifier: '48H7CLBV8Y',
};

const engine = new pki.CryptoEngine({
  name: 'WebCrypto',
  crypto,
  subtle: crypto.subtle,
}) as unknown as pki.ICryptoEngine;
pki.setEngine('fixture', engine);

function pem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)?.join('\n')}\n-----END ${label}-----\n`;
}

function name(entries: [string, string][]): pki.RelativeDistinguishedNames {
  return new pki.RelativeDistinguishedNames({
    typesAndValues: entries.map(
      ([type, value]) =>
        new pki.AttributeTypeAndValue({ type, value: new asn1.Utf8String({ value }) }),
    ),
  });
}

async function makeCertificate(options: {
  subject: [string, string][];
  issuer: pki.RelativeDistinguishedNames;
  serial: number;
  publicKey: CryptoKey;
  signingKey: CryptoKey;
  days: number;
  now: Date;
}): Promise<pki.Certificate> {
  const cert = new pki.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1.Integer({ value: options.serial });
  cert.subject = name(options.subject);
  cert.issuer = options.issuer;
  cert.notBefore.value = new Date(options.now.getTime() - 3600_000);
  cert.notAfter.value = new Date(options.now.getTime() + options.days * 86400_000);
  await cert.subjectPublicKeyInfo.importKey(options.publicKey, engine);
  await cert.sign(options.signingKey, 'SHA-256', engine);
  return cert;
}

/** A pass certificate and its key, signed by a fixture CA. */
async function makeLeaf(
  identity: PassIdentity,
  ca: pki.Certificate,
  caKey: CryptoKey,
  options: { now: Date; days?: number },
): Promise<{ identity: PassIdentity; certificate: string; privateKey: string }> {
  const keys = (await crypto.subtle.generateKey(ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const leaf = await makeCertificate({
    subject: [
      ['0.9.2342.19200300.100.1.1', identity.passTypeIdentifier],
      ['2.5.4.11', identity.teamIdentifier],
      ['2.5.4.3', `Pass Type ID: ${identity.passTypeIdentifier}`],
    ],
    issuer: ca.subject,
    serial: 2,
    publicKey: keys.publicKey,
    signingKey: caKey,
    days: options.days ?? 2,
    now: options.now,
  });
  return {
    identity,
    certificate: pem('CERTIFICATE', leaf.toSchema(true).toBER(false)),
    privateKey: pem(
      'PRIVATE KEY',
      (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer,
    ),
  };
}

const ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

/**
 * Generates a throwaway CA ("WWDR") and a pass certificate with Apple's subject layout
 * (UID = pass type id, OU = team id). Works in Node and in Workers; no OpenSSL needed.
 * `siblings` are more pass types under the same CA, as Apple issues them: one intermediate verifies all.
 */
export async function createFixtureIdentity(
  identity: PassIdentity = FIXTURE_IDENTITY,
  options: { now?: Date; days?: number; caDays?: number; siblings?: PassIdentity[] } = {},
): Promise<
  SigningMaterial & {
    identity: PassIdentity;
    siblings: { identity: PassIdentity; certificate: string; privateKey: string }[];
  }
> {
  const now = options.now ?? new Date();
  const caKeys = (await crypto.subtle.generateKey(ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const ca = await makeCertificate({
    subject: [['2.5.4.3', 'Wallet Test WWDR']],
    issuer: name([['2.5.4.3', 'Wallet Test WWDR']]),
    serial: 1,
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    days: options.caDays ?? 3,
    now,
  });
  const leaf = await makeLeaf(identity, ca, caKeys.privateKey, { now, days: options.days });
  const siblings = await Promise.all(
    (options.siblings ?? []).map((other) =>
      makeLeaf(other, ca, caKeys.privateKey, { now, days: options.days }),
    ),
  );
  return {
    identity,
    certificate: leaf.certificate,
    intermediate: pem('CERTIFICATE', ca.toSchema(true).toBER(false)),
    privateKey: leaf.privateKey,
    siblings,
  };
}
