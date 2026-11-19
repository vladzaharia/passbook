/** pkcs12Base64 is capped at 100,000 characters server-side: 75,000 bytes. */
export const MAX_P12_BYTES = 75_000;

export type UploadMode = 'pem' | 'p12';

export interface UploadDraft {
  mode: UploadMode;
  label: string;
  certificatePem: string;
  privateKeyPem: string;
  p12: File | undefined;
  p12Password: string;
}

export const EMPTY_DRAFT: UploadDraft = {
  mode: 'p12',
  label: '',
  certificatePem: '',
  privateKeyPem: '',
  p12: undefined,
  p12Password: '',
};

/** Something typed or chosen: closing the dialog asks first. The PEM / .p12 switch alone is not. */
export const draftDirty = (d: UploadDraft) =>
  Boolean(d.label.trim() || d.certificatePem || d.privateKeyPem || d.p12 || d.p12Password);

export function validateUpload(d: UploadDraft, needLabel = true): Record<string, string> {
  const errors: Record<string, string> = {};
  if (needLabel && !d.label.trim()) errors.label = 'Required.';
  if (d.mode === 'pem') {
    const cert = d.certificatePem.trim();
    const key = d.privateKeyPem.trim();
    if (!cert) errors.certificatePem = 'Required.';
    else if (!cert.includes('-----BEGIN CERTIFICATE-----'))
      errors.certificatePem = 'Not a PEM certificate. Expected a BEGIN CERTIFICATE block.';
    if (!key) errors.privateKeyPem = 'Required.';
    else if (key.includes('ENCRYPTED PRIVATE KEY') || /Proc-Type:\s*4,ENCRYPTED/.test(key))
      errors.privateKeyPem = 'Encrypted key. Decrypt it first or upload the .p12.';
    else if (!/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(key))
      errors.privateKeyPem = 'Not a PEM private key. Expected a BEGIN PRIVATE KEY block.';
  } else if (!d.p12) {
    errors.p12 = 'Choose a .p12 file.';
  } else if (d.p12.size > MAX_P12_BYTES) {
    errors.p12 = 'File is too large (75 KB max).';
  } else if (d.p12.size === 0) {
    errors.p12 = 'File is empty.';
  }
  return errors;
}

export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function buildUploadBody(d: UploadDraft, orgId: string | null, nfcEnabled: boolean) {
  const base = { label: d.label.trim(), orgId, nfcEnabled };
  if (d.mode === 'pem') {
    return {
      ...base,
      certificatePem: d.certificatePem.trim(),
      privateKeyPem: d.privateKeyPem.trim(),
    };
  }
  return {
    ...base,
    pkcs12Base64: await toBase64(d.p12 as File),
    pkcs12Password: d.p12Password,
  };
}

/** Body for POST /identities/{id}/rotate: the same material, no label. */
export async function buildRotateBody(d: UploadDraft) {
  const {
    label: _label,
    orgId: _orgId,
    nfcEnabled: _nfc,
    ...material
  } = await buildUploadBody(d, null, false);
  return material;
}
