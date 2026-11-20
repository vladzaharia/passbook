import { derivedHmacKey, isKeyEnvName } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import type { EventRow } from '../events/repo.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { type ScanEventReference, verifyScanEventProvenance } from './scan-event-proof.ts';
import {
  KIND_OF_AUTHORITY,
  type ProofKind,
  proofKind,
  proofSchema,
  retainedEffect,
  retainedExitEffect,
  type ScanRetentionProofRow,
  type ScanRetentionSnapshot,
  snapshotSchema,
  sourceSchema,
  systemSourceSchema,
} from './scan-retention-proof-data.ts';

export type { ScanRetentionProofRow, ScanRetentionSnapshot };

const encoder = new TextEncoder();

/** Snapshot only the configured key ring, never live D1 or service bindings. */
function retentionKeyEnv(env: object): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (isKeyEnvName(name) && typeof value === 'string') keys[name] = value;
  return keys;
}

export interface PreparedScanRetentionDelete {
  orgId: string;
  mode: 'live' | 'test';
  passRef: string;
}

/** The pass identity is consumed only in memory; the prepared deletion carries its opaque reference. */
export async function prepareScanRetentionDelete(
  env: object,
  pass: { id: string; orgId: string; mode: 'live' | 'test' },
): Promise<PreparedScanRetentionDelete> {
  const { id: passId, orgId, mode } = pass;
  const keys = retentionKeyEnv(env);
  return Object.freeze({
    orgId,
    mode,
    passRef: await sign(keys, 'scan-retention-pass-ref.v1', [orgId, mode, passId]),
  });
}

/** Contains transient source data for the guarded insert. Persist only the opaque proof fields. */
export interface PreparedScanRetentionProof {
  proof: ScanRetentionProofRow;
  scan: ScanRetentionSnapshot;
  event: EventRow;
}

export class InvalidScanRetentionProof extends Error {
  constructor() {
    super('Invalid scan retention proof input');
  }
}

export type RetentionSource = { actionId: string | null };

async function sign(env: object, purpose: string, value: unknown): Promise<string> {
  const key = await derivedHmacKey(env, purpose);
  return toHex(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalJson(value)))),
  );
}

async function matches(
  env: object,
  purpose: string,
  value: unknown,
  mac: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  const signature = Uint8Array.from(mac.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = await derivedHmacKey(env, purpose);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(canonicalJson(value)));
}

/** Scan proofs are v1; the rows of a system, desk or undo path are v2 and bound to their kind. */
function signedProof(
  proof: Omit<ScanRetentionProofRow, 'mac' | 'excluded' | 'invalidated'>,
  kind: ProofKind | null = null,
) {
  return kind === null
    ? { v: 1, ...proof, nonQuarantined: true }
    : { v: 2, kind, ...proof, nonQuarantined: true };
}

/** Verify the original signed action before creating its detached evidence. */
export async function prepareScanRetentionProof(
  env: object,
  event: EventRow,
  actorKey: string,
  source: RetentionSource,
): Promise<PreparedScanRetentionProof> {
  event = structuredClone(event);
  source = structuredClone(source);
  env = retentionKeyEnv(env);
  let raw: unknown;
  try {
    raw = JSON.parse(event.data);
  } catch {
    throw new InvalidScanRetentionProof();
  }
  // Reject duplicate-key or noncanonical envelopes: SQLite and JSON.parse must see the same event.
  if (
    JSON.stringify(raw) !== event.data ||
    !event.id ||
    !event.org_id ||
    !event.pass_id ||
    (event.mode !== 'live' && event.mode !== 'test') ||
    !actorKey ||
    (event.actor_type !== 'scanner' && event.actor_type !== 'user') ||
    !event.actor_id
  )
    throw new InvalidScanRetentionProof();

  const parsed = sourceSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidScanRetentionProof();
  const data = parsed.data;
  const authority = data.authority;
  const reference: ScanEventReference = {
    id: data.scanId,
    orgId: event.org_id,
    mode: event.mode,
    passId: event.pass_id,
    templateId: authority.templateId,
    scannerId: data.scannerId,
    eventId: data.eventId,
    actorKey,
    staffId: data.staffId,
    actionId: source.actionId,
    actionKind: data.actionKind,
    outcome: data.outcome,
    reason: data.reason,
    passVersion: data.version,
    method: data.method,
    at: authority.scanAt,
    state: 'done',
    pinnedTemplateVersion: authority.pinnedTemplateVersion,
    walletVersion: authority.walletVersion,
    walletTemplateVersion: authority.walletTemplateVersion,
    direction: data.direction ?? null,
    presenceScope: authority.presenceScope,
  };
  if (!(await verifyScanEventProvenance(env, event, reference)))
    throw new InvalidScanRetentionProof();
  const scan = snapshotSchema.safeParse({
    id: reference.id,
    orgId: reference.orgId,
    mode: reference.mode,
    templateId: reference.templateId,
    scannerId: reference.scannerId,
    eventId: reference.eventId,
    actorType: event.actor_type,
    actorId: event.actor_id,
    actorKey,
    staffId: reference.staffId,
    approvedBy: data.approvedBy,
    method: reference.method,
    state: reference.state,
    outcome: reference.outcome,
    reason: reference.reason,
    actionId: reference.actionId,
    actionKind: reference.actionKind,
    direction: reference.direction,
    passVersion: reference.passVersion,
    presenceScope: reference.presenceScope,
    at: reference.at,
    undoes: null,
    override: data.override,
  });
  if (!scan.success) throw new InvalidScanRetentionProof();
  const snapshot: ScanRetentionSnapshot = scan.data;

  const [passRef, eventDigest, scanDigest] = await Promise.all([
    sign(env, 'scan-retention-pass-ref.v1', [event.org_id, event.mode, event.pass_id]),
    sign(env, 'scan-retention-event-digest.v1', event),
    sign(env, 'scan-retention-snapshot.v1', snapshot),
  ]);
  const fields = {
    scanId: snapshot.id,
    orgId: snapshot.orgId,
    mode: snapshot.mode,
    ledgerEventId: event.id,
    passRef,
    eventDigest,
    scanDigest,
    ...retainedEffect(raw, event, snapshot),
  };
  const mac = await sign(env, 'scan-retention-proof.v1', signedProof(fields));
  return Object.freeze({
    proof: Object.freeze({ ...fields, mac, excluded: 0, invalidated: 0 }),
    scan: Object.freeze(snapshot),
    event: Object.freeze(event),
  });
}

/**
 * A proof for an exit or undo no scanner action decided: auto exit, desk mark-out, undo. Its source is the
 * ledger row's plain authority, cross-checked against the scan facts both rows are written with; there is
 * no event-time authority to verify. A mark-out or auto exit at an event place, and an undo of an event check-in, retain a gate and presence.
 */
export async function prepareSystemScanRetentionProof(
  env: object,
  event: EventRow,
  scanFacts: ScanRetentionSnapshot,
): Promise<PreparedScanRetentionProof> {
  event = structuredClone(event);
  env = retentionKeyEnv(env);
  let raw: unknown;
  try {
    raw = JSON.parse(event.data);
  } catch {
    throw new InvalidScanRetentionProof();
  }
  const parsed = systemSourceSchema.safeParse(raw);
  const scan = snapshotSchema.safeParse(scanFacts);
  if (
    JSON.stringify(raw) !== event.data ||
    !parsed.success ||
    !scan.success ||
    !event.id ||
    !event.pass_id ||
    event.org_id !== scan.data.orgId ||
    event.mode !== scan.data.mode ||
    event.actor_type !== scan.data.actorType ||
    event.actor_id !== scan.data.actorId
  )
    throw new InvalidScanRetentionProof();
  const { data } = parsed;
  const snapshot: ScanRetentionSnapshot = scan.data;
  const kind = proofKind(snapshot);
  const exit = kind === 'auto_exit' || kind === 'mark_out';
  if (
    kind === null ||
    KIND_OF_AUTHORITY[data.authority.kind] !== kind ||
    data.scanId !== snapshot.id ||
    data.method !== snapshot.method ||
    data.eventId !== snapshot.eventId ||
    data.scannerId !== snapshot.scannerId ||
    data.staffId !== snapshot.staffId ||
    (data.approvedBy ?? null) !== snapshot.approvedBy ||
    event.kind !== (exit ? 'scan.checked_out' : 'scan.undone') ||
    (exit && (snapshot.direction !== 'out' || snapshot.actionKind === 'undo')) ||
    (data.authority.kind === 'system' &&
      (data.authority.cause !== snapshot.outCause || data.outCause !== snapshot.outCause)) ||
    (data.authority.kind === 'undo' &&
      (data.authority.undoes !== snapshot.undoes || data.undoes !== snapshot.undoes))
  )
    throw new InvalidScanRetentionProof();
  const [passRef, eventDigest, scanDigest] = await Promise.all([
    sign(env, 'scan-retention-pass-ref.v1', [event.org_id, event.mode, event.pass_id]),
    sign(env, 'scan-retention-event-digest.v1', event),
    sign(env, 'scan-retention-snapshot.v1', snapshot),
  ]);
  const fields = {
    scanId: snapshot.id,
    orgId: snapshot.orgId,
    mode: snapshot.mode,
    ledgerEventId: event.id,
    passRef,
    eventDigest,
    scanDigest,
    ...(kind === 'undo'
      ? retainedEffect(
          {
            authority: {
              postUndoGate: (raw as Record<string, unknown>).postUndoGate,
              postUndoPresence: (raw as Record<string, unknown>).postUndoPresence,
            },
          },
          event,
          snapshot,
        )
      : retainedExitEffect(raw, event, snapshot)),
  };
  const mac = await sign(env, 'scan-retention-proof.v1', signedProof(fields, kind));
  return Object.freeze({
    proof: Object.freeze({ ...fields, mac, excluded: 0, invalidated: 0 }),
    scan: Object.freeze(snapshot),
    event: Object.freeze(event),
  });
}

/** Authenticate only detached data; it never recovers or returns a deleted pass identity. */
export async function verifyScanRetentionProof(
  env: object,
  value: unknown,
  currentScan: unknown,
): Promise<boolean> {
  const proof = proofSchema.safeParse(value);
  const scan = snapshotSchema.safeParse(currentScan);
  if (
    !proof.success ||
    !scan.success ||
    proof.data.scanId !== scan.data.id ||
    proof.data.orgId !== scan.data.orgId ||
    proof.data.mode !== scan.data.mode
  )
    return false;
  const { mac, excluded: _excluded, invalidated: _invalidated, ...fields } = proof.data;
  const [validMac, validSnapshot] = await Promise.all([
    matches(env, 'scan-retention-proof.v1', signedProof(fields, proofKind(scan.data)), mac),
    matches(env, 'scan-retention-snapshot.v1', scan.data, proof.data.scanDigest),
  ]);
  return validMac && validSnapshot;
}
