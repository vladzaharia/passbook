// The credential-reference keyset commitment for a KEK, as the Worker derives it
// (src/worker/modules/passes/credential-keyset.ts): HMAC over a fixed message under the HKDF key for
// the tombstone label. Computed here so the e2e database starts with the keyset dev and prod hold.
const encoder = new TextEncoder();

export async function e2eKeysetCommitment(kekBase64: string): Promise<string> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    Buffer.from(kekBase64, 'base64'),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('passbook.derived-hmac.v1'),
      info: encoder.encode('pass-credential-tombstone-v1'),
    },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode('pass-credential-ref-keyset-v1'),
  );
  return Buffer.from(mac).toString('hex');
}
