import type { ScanCodeInput, ScanInput } from '../../../shared/contracts/scan.ts';
import { isKeyEnvName } from '../../platform/crypto.ts';
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
  validCredentialKeysetCommitment,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';

type Mode = 'live' | 'test';
/** A request's input as sent, or as the code and pass-id paths take it. */
type AnyScanInput = ScanInput | ScanCodeInput;

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
  for (const key of Object.keys(snapshot)) if (isKeyEnvName(key)) delete snapshot[key];
  for (const [key, value] of Object.entries(capturedKeyEnv))
    if (isKeyEnvName(key) && typeof value === 'string') snapshot[key] = value;
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
  input: AnyScanInput,
  includeOtherMode = true,
  keysetPolicy: 'require' | 'defer' = 'defer',
): Promise<CredentialTombstoneSnapshot> {
  // A tag read carries no credential refs, like a pass id: the tag is checked on its own rows.
  const code = 'code' in input ? input.code : null;
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

/** A code must carry both mode-specific ref sets; a pass id or a tag read uses empty sets. */
export function credentialInputValid(
  input: AnyScanInput,
  observed: CredentialTombstoneSnapshot,
): boolean {
  if (!observed || typeof observed !== 'object') return false;
  const own = observed.credentialTombstoneRefs;
  const other = observed.otherModeCredentialTombstoneRefs;
  if (!validCredentialKeysetCommitment(observed.credentialKeysetCommitment)) return false;
  if (!validCredentialTombstoneRefs(own) || !validCredentialTombstoneRefs(other)) return false;
  return 'code' in input
    ? own.length > 0 && other.length > 0
    : own.length === 0 && other.length === 0;
}
