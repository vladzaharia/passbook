import type { Mode } from '../../../shared/contracts/common.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { cleanCode, codeKeyOf } from '../scan/codes.ts';
import { credentialTombstoneRef } from './credential-tombstones.ts';

export type CredentialReferenceKind = 'scan_code' | 'barcode' | 'lookup' | 'serial';
export interface CredentialReference {
  kind: CredentialReferenceKind;
  ref: string;
}
export interface CredentialReferenceValues {
  scanCode?: string | null;
  serial?: string | null;
  barcodeHash?: string | null;
  barcodeMessage?: string | null;
  lookupHash?: string | null;
  lookupValue?: string | null;
}

/** References include every representation accepted by the scanner, without retaining raw values. */
export async function credentialReferences(
  env: object,
  orgId: string,
  mode: Mode,
  values: CredentialReferenceValues,
): Promise<CredentialReference[]> {
  const entries: CredentialReference[] = [];
  const addValue = async (kind: CredentialReferenceKind, value: string | null | undefined) => {
    if (!value) return;
    const clean = cleanCode(value);
    if (!clean) return;
    const code = codeKeyOf(clean);
    const normalized = normalizeLookup(clean);
    for (const representation of new Set([
      clean,
      ...(code ? [code] : []),
      ...(normalized ? [normalized] : []),
    ])) {
      const digest = await sha256Hex(representation);
      entries.push({ kind, ref: await credentialTombstoneRef(env, orgId, mode, digest) });
    }
  };
  const addDigest = async (kind: CredentialReferenceKind, digest: string | null | undefined) => {
    if (digest) {
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid scanner credential digest.');
      entries.push({ kind, ref: await credentialTombstoneRef(env, orgId, mode, digest) });
    }
  };
  await addValue('scan_code', values.scanCode);
  await addValue('serial', values.serial);
  await addValue('barcode', values.barcodeMessage);
  await addDigest('barcode', values.barcodeHash);
  await addValue('lookup', values.lookupValue);
  await addDigest('lookup', values.lookupHash);
  return [...new Map(entries.map((entry) => [`${entry.kind}:${entry.ref}`, entry])).values()];
}
