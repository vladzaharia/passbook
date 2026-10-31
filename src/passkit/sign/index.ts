import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import type { Json, SigningMaterial } from '../types.ts';

const DATA_OID = '1.2.840.113549.1.7.1';
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2';
const UID_OID = '0.9.2342.19200300.100.1.1';
const OU_OID = '2.5.4.11';
const CN_OID = '2.5.4.3';

export interface SignedPass {
  /** Every file that goes into the .pkpass: assets, pass.json, manifest.json, signature. */
  files: Record<string, Uint8Array>;
  /** name -> SHA-1 hex, as written to manifest.json. */
  manifest: Record<string, string>;
}

export interface CertificateInfo {
  passTypeIdentifier: string | undefined;
  teamIdentifier: string | undefined;
  commonName: string | undefined;
  notBefore: Date;
  notAfter: Date;
  sha256: string;
}

const encoder = new TextEncoder();

function derFromPem(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----|\s/g, '');
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

function certificateFromPem(pem: string): pki.Certificate {
  const parsed = asn1.fromBER(derFromPem(pem));
  if (parsed.offset === -1) throw new Error('Invalid signing certificate');
  return new pki.Certificate({ schema: parsed.result });
}

function subjectValue(cert: pki.Certificate, oid: string): string | undefined {
  const value = cert.subject.typesAndValues.find((v) => v.type === oid)?.value.valueBlock.value;
  return typeof value === 'string' ? value : undefined;
}

function hex(buffer: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buffer instanceof Uint8Array ? buffer : buffer), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export async function certificateInfo(pem: string): Promise<CertificateInfo> {
  const cert = certificateFromPem(pem);
  return {
    passTypeIdentifier: subjectValue(cert, UID_OID),
    teamIdentifier: subjectValue(cert, OU_OID),
    commonName: subjectValue(cert, CN_OID),
    notBefore: cert.notBefore.value,
    notAfter: cert.notAfter.value,
    sha256: hex(await crypto.subtle.digest('SHA-256', derFromPem(pem))),
  };
}

function webCrypto(): pki.ICryptoEngine {
  return new pki.CryptoEngine({
    name: 'WebCrypto',
    crypto,
    subtle: crypto.subtle,
  }) as unknown as pki.ICryptoEngine;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

/** Non-extractable key import, cached per isolate by certificate fingerprint. */
async function importSigningKey(material: SigningMaterial): Promise<CryptoKey> {
  const fingerprint = hex(
    await crypto.subtle.digest('SHA-256', encoder.encode(material.privateKey)),
  );
  let key = signingKeys.get(fingerprint);
  if (!key) {
    key = crypto.subtle.importKey(
      'pkcs8',
      derFromPem(material.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    signingKeys.set(fingerprint, key);
    key.catch(() => signingKeys.delete(fingerprint));
  }
  return key;
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
}

/** manifest.json for the given files. `precomputed` skips hashing for entries whose SHA-1 is known. */
export async function buildManifest(
  files: Record<string, Uint8Array>,
  precomputed: Record<string, string> = {},
): Promise<{ manifest: Record<string, string>; bytes: Uint8Array }> {
  const manifest: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) {
    const bytes = files[name];
    if (!bytes) continue;
    manifest[name] = precomputed[name] ?? (await sha1Hex(bytes));
  }
  return { manifest, bytes: encoder.encode(JSON.stringify(manifest)) };
}

/** Detached CMS signature (SHA-256 digest, signingTime, signer + WWDR chain) over manifest.json. */
export async function signManifest(
  manifestBytes: Uint8Array,
  material: SigningMaterial,
  options: {
    now?: Date;
    expectedIdentity?: { passTypeIdentifier: string; teamIdentifier: string };
  } = {},
): Promise<Uint8Array> {
  const now = options.now ?? new Date();
  const signer = certificateFromPem(material.certificate);
  const intermediate = certificateFromPem(material.intermediate);
  if (signer.notBefore.value > now || signer.notAfter.value < now) {
    throw new Error('Pass signing certificate is not currently valid');
  }
  if (
    intermediate.notBefore.value > now ||
    intermediate.notAfter.value < now ||
    !signer.issuer.isEqual(intermediate.subject)
  ) {
    throw new Error('Incorrect or expired WWDR intermediate');
  }
  const expected = options.expectedIdentity;
  if (
    expected &&
    (subjectValue(signer, UID_OID) !== expected.passTypeIdentifier ||
      subjectValue(signer, OU_OID) !== expected.teamIdentifier)
  ) {
    throw new Error('Pass identity does not match signing certificate');
  }
  const engine = webCrypto();
  if (!(await signer.verify(intermediate, engine))) throw new Error('Invalid certificate chain');

  const data = manifestBytes.buffer.slice(
    manifestBytes.byteOffset,
    manifestBytes.byteOffset + manifestBytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', data);
  const cms = new pki.SignedData({
    version: 1,
    encapContentInfo: new pki.EncapsulatedContentInfo({ eContentType: DATA_OID }),
    certificates: [signer, intermediate],
    signerInfos: [
      new pki.SignerInfo({
        version: 1,
        sid: new pki.IssuerAndSerialNumber({
          issuer: signer.issuer,
          serialNumber: signer.serialNumber,
        }),
        signedAttrs: new pki.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pki.Attribute({
              type: '1.2.840.113549.1.9.3',
              values: [new asn1.ObjectIdentifier({ value: DATA_OID })],
            }),
            new pki.Attribute({
              type: '1.2.840.113549.1.9.5',
              values: [new asn1.UTCTime({ valueDate: now })],
            }),
            new pki.Attribute({
              type: '1.2.840.113549.1.9.4',
              values: [new asn1.OctetString({ valueHex: digest })],
            }),
          ],
        }),
      }),
    ],
  });
  await cms.sign(await importSigningKey(material), 0, 'SHA-256', data, engine);
  const reparsed = new pki.SignedData({
    schema: asn1.fromBER(cms.toSchema(true).toBER(false)).result,
  });
  // Catches a certificate paired with the wrong key before an unusable pass is distributed.
  if (!(await reparsed.verify({ signer: 0, data, checkChain: false }, engine))) {
    throw new Error('Signing key does not match certificate');
  }
  return new Uint8Array(
    new pki.ContentInfo({ contentType: SIGNED_DATA_OID, content: reparsed.toSchema(true) })
      .toSchema()
      .toBER(false),
  );
}

const SAFE_NAME = /^(?:[A-Za-z0-9_-]+\.lproj\/)?[A-Za-z0-9_@.-]+\.(?:png|strings|json)$/;

/**
 * Produces every file of a signed .pkpass. `pass` must already be validated (see validatePass).
 * `precomputedSha1` carries known asset hashes so large images are not re-hashed.
 */
export async function signPass(
  pass: Record<string, unknown>,
  assets: Record<string, Uint8Array>,
  material: SigningMaterial,
  options: { now?: Date; precomputedSha1?: Record<string, string> } = {},
): Promise<SignedPass> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(assets)) {
    if (!SAFE_NAME.test(name) || name.includes('..') || name === 'pass.json')
      throw new Error(`Unsafe asset path: ${name}`);
    files[name] = bytes;
  }
  files['pass.json'] = encoder.encode(JSON.stringify(pass as Json));
  const { manifest, bytes } = await buildManifest(files, options.precomputedSha1);
  const passTypeIdentifier =
    typeof pass.passTypeIdentifier === 'string' ? pass.passTypeIdentifier : '';
  const teamIdentifier = typeof pass.teamIdentifier === 'string' ? pass.teamIdentifier : '';
  const signature = await signManifest(bytes, material, {
    now: options.now,
    expectedIdentity: { passTypeIdentifier, teamIdentifier },
  });
  files['manifest.json'] = bytes;
  files.signature = signature;
  return { files, manifest };
}
