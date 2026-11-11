import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import type { EventRow } from '../events/repo.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { type ScanEventReference, verifyScanEventProvenance } from './scan-event-proof.ts';
import {
  proofSchema,
  retainedEffect,
  type ScanRetentionProofRow,
  type ScanRetentionSnapshot,
  snapshotSchema,
  sourceSchema,
} from './scan-retention-proof-data.ts';

export type { ScanRetentionProofRow, ScanRetentionSnapshot };

const encoder = new TextEncoder();

/** Snapshot only the configured key ring, never live D1 or service bindings. */
function retentionKeyEnv(env: object): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (/^KEK_V\d+$/.test(name) && typeof value === 'string') keys[name] = value;
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

function signedProof(proof: Omit<ScanRetentionProofRow, 'mac' | 'excluded' | 'invalidated'>) {
  return { v: 1, ...proof, nonQuarantined: true };
}

/** Verify the original signed action before creating its detached evidence. Undo rows carry no proof. */
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
    matches(env, 'scan-retention-proof.v1', signedProof(fields), mac),
    matches(env, 'scan-retention-snapshot.v1', scan.data, proof.data.scanDigest),
  ]);
  return validMac && validSnapshot;
}
