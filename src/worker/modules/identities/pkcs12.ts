import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import { fromBase64 } from '../../platform/ids.ts';
import { invalid, pemFromDer } from './cert.ts';

const KEY_BAG = '1.2.840.113549.1.12.10.1.2';
const CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const X509_CERT = '1.2.840.113549.1.9.22.1';

// pbeWithSHAAnd3-KeyTripleDES-CBC, RC2 and RC4 variants: 1.2.840.113549.1.12.1.{1..6}
const LEGACY_PBE_PREFIX = [0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01];

const engine = new pki.CryptoEngine({
  name: 'WebCrypto',
  crypto,
  subtle: crypto.subtle,
}) as unknown as pki.ICryptoEngine;

export const LEGACY_P12_MESSAGE =
  'This PKCS#12 uses legacy 3DES/RC2 encryption. Convert it with npm run credentials, or export PEM files.';

function usesLegacyPbe(bytes: Uint8Array): boolean {
  for (let i = 0; i + LEGACY_PBE_PREFIX.length < bytes.length; i++) {
    let match = true;
    for (let j = 0; j < LEGACY_PBE_PREFIX.length; j++) {
      if (bytes[i + j] !== LEGACY_PBE_PREFIX[j]) {
        match = false;
        break;
      }
    }
    const last = bytes[i + LEGACY_PBE_PREFIX.length];
    if (match && last !== undefined && last >= 1 && last <= 6) return true;
  }
  return false;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** UTF-8 password as the ArrayBuffer pkijs expects. */
function passwordBuffer(password: string): ArrayBuffer {
  return toBuffer(new TextEncoder().encode(password));
}

export interface Pkcs12Material {
  certificates: string[];
  privateKeyPem: string;
}

/** Modern (PBES2/AES) PKCS#12 only. Legacy 3DES/RC2 files get a pointer to `npm run credentials`. */
export async function readPkcs12(base64: string, password: string): Promise<Pkcs12Material> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(base64.replace(/\s/g, ''));
  } catch {
    throw invalid('The PKCS#12 file is not valid base64.', 'P12_INVALID');
  }
  if (usesLegacyPbe(bytes)) throw invalid(LEGACY_P12_MESSAGE, 'P12_LEGACY');
  try {
    return await extract(bytes, password);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw invalid('Cannot read the PKCS#12 file. Check the file and password.', 'P12_UNREADABLE');
  }
}

async function extract(bytes: Uint8Array, password: string): Promise<Pkcs12Material> {
  const parsed = asn1.fromBER(toBuffer(bytes));
  if (parsed.offset === -1) throw invalid('The file is not a PKCS#12 archive.', 'P12_INVALID');
  const pfx = new pki.PFX({ schema: parsed.result });
  const pw = passwordBuffer(password);
  await pfx.parseInternalValues({ checkIntegrity: true, password: pw }, engine);
  const authSafe = pfx.parsedValue?.authenticatedSafe;
  if (!authSafe) throw invalid('The PKCS#12 archive is empty.', 'P12_INVALID');
  await authSafe.parseInternalValues(
    { safeContents: authSafe.safeContents.map(() => ({ password: pw })) },
    engine,
  );

  const certificates: string[] = [];
  let privateKeyPem: string | null = null;
  for (const content of authSafe.parsedValue.safeContents as { value: pki.SafeContents }[]) {
    for (const bag of content.value.safeBags) {
      if (bag.bagId === CERT_BAG) {
        const cert = bag.bagValue as pki.CertBag;
        if (cert.certId === X509_CERT && cert.parsedValue instanceof pki.Certificate)
          certificates.push(pemFromDer('CERTIFICATE', cert.parsedValue.toSchema().toBER(false)));
      } else if (bag.bagId === KEY_BAG) {
        const keyBag = bag.bagValue as pki.PKCS8ShroudedKeyBag;
        await (
          keyBag as unknown as {
            parseInternalValues(p: { password: ArrayBuffer }, c: pki.ICryptoEngine): Promise<void>;
          }
        ).parseInternalValues({ password: pw }, engine);
        if (keyBag.parsedValue)
          privateKeyPem = pemFromDer('PRIVATE KEY', keyBag.parsedValue.toSchema().toBER(false));
      }
    }
  }
  if (!privateKeyPem) throw invalid('The PKCS#12 file has no private key.', 'P12_NO_KEY');
  if (certificates.length === 0)
    throw invalid('The PKCS#12 file has no certificate.', 'P12_NO_CERT');
  return { certificates, privateKeyPem };
}
