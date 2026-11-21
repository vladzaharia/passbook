import * as asn1 from 'asn1js';
import * as pki from 'pkijs';
import { describe, expect, it } from 'vitest';
import { engine } from './cert.ts';
import { certPubkeySha256, generateCsr, spkiSha256 } from './csr.ts';

const PTI = 'pass.mobile.passbook.acme';

function parse(der: Uint8Array): pki.CertificationRequest {
  const parsed = asn1.fromBER(
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
  );
  expect(parsed.offset).not.toBe(-1);
  return new pki.CertificationRequest({ schema: parsed.result });
}

describe('generateCsr', () => {
  it('builds a PKCS#10 with the pass type as the only subject field and a valid signature', async () => {
    const out = await generateCsr(PTI);
    const request = parse(out.csrDer);
    expect(request.subject.typesAndValues).toHaveLength(1);
    expect(request.subject.typesAndValues[0]?.type).toBe('2.5.4.3');
    expect(request.subject.typesAndValues[0]?.value.valueBlock.value).toBe(PTI);
    expect(await request.verify(engine)).toBe(true);
  });

  it('uses RSA-2048 and returns the public-key hash and a PKCS#8 key for the same pair', async () => {
    const out = await generateCsr(PTI);
    const request = parse(out.csrDer);
    const key = await request.getPublicKey(undefined, engine);
    const algorithm = key.algorithm as { name: string; modulusLength: number };
    expect(algorithm.name).toBe('RSASSA-PKCS1-v1_5');
    expect(algorithm.modulusLength).toBe(2048);
    expect(out.pubkeySha256).toBe(await spkiSha256(request.subjectPublicKeyInfo));
    expect(out.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const imported = await crypto.subtle.importKey(
      'pkcs8',
      Uint8Array.from(atob(out.privateKeyPem.replace(/-----[^-]+-----|\s/g, '')), (c) =>
        c.charCodeAt(0),
      ),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(imported.type).toBe('private');
  });

  it('makes a new key each time', async () => {
    const a = await generateCsr(PTI);
    const b = await generateCsr(PTI);
    expect(a.pubkeySha256).not.toBe(b.pubkeySha256);
  });
});

describe('certPubkeySha256', () => {
  it('is null for bytes that are not a certificate', async () => {
    expect(await certPubkeySha256(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
