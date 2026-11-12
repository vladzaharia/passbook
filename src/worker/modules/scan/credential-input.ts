import type { ScanInput } from '../../../shared/contracts/scan.ts';
import type { AppEnv } from '../../platform/env.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import { barcodeHashOfCode, cleanCode, codeKeyOf, lookupHashOf } from './codes.ts';
import {
  credentialTombstonesClear,
  validCredentialKeysetCommitment,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';

type Mode = 'live' | 'test';

/** Keyed refs are transient input authority, never ledger or response fields. */
export interface CredentialTombstoneSnapshot {
  credentialKeysetCommitment: string;
  credentialTombstoneRefs: readonly string[];
  otherModeCredentialTombstoneRefs: readonly string[];
}

/** Freeze only keyed commitments and references, never raw credential input. */
export function captureCredentialTombstoneSnapshot(
  snapshot: CredentialTombstoneSnapshot,
): CredentialTombstoneSnapshot {
  return Object.freeze({
    credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
    credentialTombstoneRefs: Array.isArray(snapshot.credentialTombstoneRefs)
      ? Object.freeze([...snapshot.credentialTombstoneRefs])
      : snapshot.credentialTombstoneRefs,
    otherModeCredentialTombstoneRefs: Array.isArray(snapshot.otherModeCredentialTombstoneRefs)
      ? Object.freeze([...snapshot.otherModeCredentialTombstoneRefs])
      : snapshot.otherModeCredentialTombstoneRefs,
  });
}

/** Capture the keyring before asynchronous authority work can observe a different environment. */
export function snapshotCredentialEnv<T extends object>(
  env: T,
  capturedKeyEnv: Readonly<Record<string, string>> = captureCredentialKeyEnv(env),
): T {
  const snapshot = { ...env } as Record<string, unknown>;
  for (const key of Object.keys(snapshot)) if (/^KEK_V\d+$/.test(key)) delete snapshot[key];
  for (const [key, value] of Object.entries(capturedKeyEnv))
    if (/^KEK_V\d+$/.test(key) && typeof value === 'string') snapshot[key] = value;
  return Object.freeze(snapshot) as unknown as T;
}

export async function scanCredentialKeys(
  env: AppEnv,
  orgId: string,
  mode: Mode,
  raw: string,
  includeOtherMode = true,
  observed?: CredentialTombstoneSnapshot,
  keysetCommitment?: string,
  capturedKeyEnv?: Readonly<Record<string, string>>,
): Promise<
  CredentialTombstoneSnapshot & {
    clean: string;
    scanCode: string | null;
    barcodeHash: string;
    lookupHash: string;
  }
> {
  if (observed) observed = captureCredentialTombstoneSnapshot(observed);
  const credentialEnv = snapshotCredentialEnv(env, capturedKeyEnv);
  const clean = cleanCode(raw);
  const scanCode = codeKeyOf(clean);
  const [barcodeHash, lookupHash] = await Promise.all([
    barcodeHashOfCode(clean),
    lookupHashOf(clean),
  ]);
  if (observed)
    return {
      credentialKeysetCommitment: observed.credentialKeysetCommitment,
      clean,
      scanCode,
      barcodeHash,
      lookupHash,
      credentialTombstoneRefs: observed.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: observed.otherModeCredentialTombstoneRefs,
    };
  const derivedCommitment = await credentialRefKeysetCommitment(credentialEnv);
  const credentialKeysetCommitment = keysetCommitment ?? derivedCommitment;
  if (keysetCommitment !== undefined && derivedCommitment !== keysetCommitment)
    throw new UnavailableError(
      'Credential lookup is unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  const scanHash = scanCode ? await sha256Hex(scanCode) : null;
  const digests = [...new Set([barcodeHash, lookupHash, ...(scanHash ? [scanHash] : [])])];
  const otherMode = mode === 'live' ? 'test' : 'live';
  const [credentialTombstoneRefs, otherModeCredentialTombstoneRefs] = await Promise.all([
    Promise.all(
      digests.map((digest) => credentialTombstoneRef(credentialEnv, orgId, mode, digest)),
    ),
    includeOtherMode
      ? Promise.all(
          digests.map((digest) => credentialTombstoneRef(credentialEnv, orgId, otherMode, digest)),
        )
      : Promise.resolve([]),
  ]);
  return {
    clean,
    scanCode,
    barcodeHash,
    lookupHash,
    credentialKeysetCommitment,
    credentialTombstoneRefs,
    otherModeCredentialTombstoneRefs,
  };
}

export async function credentialTombstoneRefsForInput(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  input: ScanInput,
  includeOtherMode = true,
  keysetPolicy: 'require' | 'defer' = 'defer',
): Promise<CredentialTombstoneSnapshot> {
  const code = 'passId' in input ? null : input.code;
  const credentialEnv = snapshotCredentialEnv(ctx.env);
  const credentialKeysetCommitment = await (keysetPolicy === 'require'
    ? requireCredentialRefKeyset(credentialEnv.DB, credentialEnv)
    : credentialRefKeysetCommitment(credentialEnv));
  if (code === null)
    return {
      credentialKeysetCommitment,
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    };
  const { credentialTombstoneRefs, otherModeCredentialTombstoneRefs } = await scanCredentialKeys(
    credentialEnv,
    orgId,
    mode,
    code,
    includeOtherMode,
    undefined,
    credentialKeysetCommitment,
  );
  return { credentialKeysetCommitment, credentialTombstoneRefs, otherModeCredentialTombstoneRefs };
}

/** A code must carry both mode-specific ref sets; only an explicit passId uses empty sets. */
export function credentialInputValid(
  input: ScanInput,
  observed: CredentialTombstoneSnapshot,
): boolean {
  if (!observed || typeof observed !== 'object') return false;
  const own = observed.credentialTombstoneRefs;
  const other = observed.otherModeCredentialTombstoneRefs;
  if (!validCredentialKeysetCommitment(observed.credentialKeysetCommitment)) return false;
  if (!validCredentialTombstoneRefs(own) || !validCredentialTombstoneRefs(other)) return false;
  return 'passId' in input
    ? own.length === 0 && other.length === 0
    : own.length > 0 && other.length > 0;
}

export async function credentialInputAllowed(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  input: ScanInput,
  observed: CredentialTombstoneSnapshot,
): Promise<boolean> {
  return (
    credentialInputValid(input, observed) &&
    credentialTombstonesClear(
      ctx.env.DB,
      orgId,
      mode,
      observed.credentialTombstoneRefs,
      observed.credentialKeysetCommitment,
    )
  );
}
