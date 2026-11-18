import { z } from 'zod';
import type { EventRow } from '../events/repo.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1);
const scanId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nullableId = id.nullable();
const mode = z.enum(['live', 'test']);
const direction = z.enum(['in', 'out']).nullable();
const integer = z.number().int().safe().nonnegative();

/** Exactly the scan fields authenticated for detached verification; never persisted as a document. */
export const snapshotSchema = z
  .object({
    id,
    orgId: id,
    mode,
    templateId: id,
    scannerId: nullableId,
    eventId: nullableId,
    actorType: z.enum(['scanner', 'user', 'system']),
    actorId: id,
    actorKey: id,
    staffId: nullableId,
    approvedBy: nullableId,
    method: z.enum(['camera', 'wedge', 'nfc', 'manual', 'auto']),
    state: z.literal('done'),
    outcome: z.enum(['ok', 'heads_up', 'refused']),
    reason: z.string().nullable(),
    actionId: z.string().nullable(),
    actionKind: z.string().nullable(),
    direction,
    passVersion: integer.nullable(),
    presenceScope: z.string().nullable(),
    at: integer,
    undoes: nullableId,
    override: z.boolean(),
    // Only in the snapshots of system and desk exits: older proofs were signed without it.
    outCause: z.enum(['stay', 'clear', 'desk', 'forced', 'zone']).optional(),
  })
  .strict();
export type ScanRetentionSnapshot = z.infer<typeof snapshotSchema>;

/** What a proof attests beyond a normal scan; the MAC input is versioned by it. */
export type ProofKind = 'auto_exit' | 'mark_out' | 'undo';

/** The kind follows from the signed scan facts, so a proof cannot be checked as another kind. */
export function proofKind(
  s: Pick<ScanRetentionSnapshot, 'actorType' | 'undoes' | 'outCause'>,
): ProofKind | null {
  if (s.actorType === 'system') return 'auto_exit';
  if (s.undoes !== null) return 'undo';
  return s.outCause === 'desk' ? 'mark_out' : null;
}

/** A stored row's cause belongs in the snapshot only for these kinds. */
export function retainedOutCause(
  actorType: string,
  outCause: string | null,
): ScanRetentionSnapshot['outCause'] {
  if (outCause === null || (actorType !== 'system' && outCause !== 'desk')) return undefined;
  return outCause as ScanRetentionSnapshot['outCause'];
}

/** The plain authority a ledger row carries when no scanner, action or resolved pass decided it. */
const authoritySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('system'),
    job: z.literal('scan.occupancy'),
    cause: z.enum(['stay', 'clear', 'zone']),
  }),
  z.object({ kind: z.literal('console'), purpose: z.literal('org_mode.scan.check_in') }),
  z.object({
    kind: z.literal('undo'),
    purpose: z.literal('org_mode.scan.undo'),
    undoes: scanId,
  }),
]);
type ProofAuthority = z.infer<typeof authoritySchema>;

export const KIND_OF_AUTHORITY: Record<ProofAuthority['kind'], ProofKind> = {
  system: 'auto_exit',
  console: 'mark_out',
  undo: 'undo',
};

export const systemSourceSchema = z.object({
  scanId: id,
  outcome: z.literal('ok'),
  method: z.string(),
  eventId: nullableId,
  scannerId: nullableId,
  staffId: nullableId,
  approvedBy: nullableId.optional(),
  undoes: scanId.optional(),
  outCause: z.enum(['stay', 'clear', 'zone']).optional(),
  authority: authoritySchema,
});

export const sourceSchema = z.object({
  scanId: id,
  actionIdRef: hash.nullable(),
  actionKind: z.string().nullable(),
  outcome: z.enum(['ok', 'heads_up', 'refused']),
  reason: z.string().nullable(),
  method: z.string(),
  version: integer,
  eventId: nullableId,
  scannerId: nullableId,
  staffId: nullableId,
  approvedBy: nullableId,
  override: z.boolean(),
  direction: direction.optional(),
  authority: z.object({
    templateId: id,
    pinnedTemplateVersion: id,
    walletVersion: integer.positive(),
    walletTemplateVersion: z.string().nullable(),
    scanAt: integer,
    presenceScope: z.string().nullable(),
    nonQuarantined: z.literal(true),
  }),
});

// The retained aggregate uses only these event-scope facts. The signed event still
// carries the complete transition; raw pass IDs and action IDs are never copied.
const gateSchema = z.object({
  passId: id,
  orgId: id,
  mode,
  templateId: id,
  actionIdRef: hash,
  scope: z.string(),
  kind: z.literal('check_in'),
  state: z.enum(['in', 'out', 'used', 'undone']),
  count: integer,
  firstAt: integer,
  lastAt: integer,
  lastScanId: scanId,
  prevState: z.enum(['in', 'out', 'used', 'undone']).nullable(),
  prevLastAt: integer.nullable(),
  prevScanId: scanId.nullable(),
});
const presenceSchema = z.object({
  passId: id,
  orgId: id,
  scope: z.string(),
  state: z.enum(['in', 'out']),
  tracking: z.union([z.literal(0), z.literal(1)]),
  enteredAt: integer.nullable(),
  firstAt: integer,
  lastEntryAt: integer,
  lastScanId: scanId,
  prevState: direction,
  prevTracking: z.union([z.literal(0), z.literal(1)]).nullable(),
  prevEnteredAt: integer.nullable(),
  prevFirstAt: integer.nullable(),
  prevLastEntryAt: integer.nullable(),
  prevScanId: scanId.nullable(),
});

export function retainedEffect(
  raw: unknown,
  event: EventRow,
  scan: ScanRetentionSnapshot,
): {
  gateSnapshot: string | null;
  presenceSnapshot: string | null;
} {
  const none = { gateSnapshot: null, presenceSnapshot: null };
  if (
    !scan.eventId ||
    scan.eventId === event.pass_id ||
    !scanId.safeParse(scan.eventId).success ||
    scan.outcome !== 'ok'
  )
    return none;
  const envelope = z
    .object({
      authority: z.object({
        postUndoGate: z.unknown().optional(),
        postUndoPresence: z.unknown().optional(),
        effect: z.object({ gateAfter: z.unknown(), presenceAfter: z.unknown() }).optional(),
      }),
    })
    .safeParse(raw);
  if (!envelope.success) return none;
  const a = envelope.data.authority;
  const gate = gateSchema.safeParse(
    event.kind === 'scan.undone' ? a.postUndoGate : a.effect?.gateAfter,
  );
  const eventScope = `event:${scan.eventId}`;
  if (
    !gate.success ||
    gate.data.passId !== event.pass_id ||
    gate.data.orgId !== scan.orgId ||
    gate.data.mode !== scan.mode ||
    gate.data.templateId !== scan.templateId ||
    (gate.data.scope !== eventScope &&
      gate.data.scope !== '' &&
      !/^day:\d{4}-\d{2}-\d{2}$/.test(gate.data.scope)) ||
    gate.data.lastScanId !== scan.id ||
    gate.data.prevScanId === event.pass_id
  )
    return none;
  const present = event.kind === 'scan.undone' ? a.postUndoPresence : a.effect?.presenceAfter;
  if (present === undefined) return none;
  if (present === null && gate.data.scope !== eventScope) return none;
  const presence = present === null ? null : presenceSchema.safeParse(present);
  if (
    presence !== null &&
    (!presence.success ||
      presence.data.passId !== event.pass_id ||
      presence.data.orgId !== scan.orgId ||
      presence.data.scope !== eventScope ||
      presence.data.lastScanId === event.pass_id ||
      presence.data.prevScanId === event.pass_id)
  )
    return none;
  const {
    passId: _passId,
    orgId: _orgId,
    mode: _mode,
    templateId: _templateId,
    ...safeGate
  } = gate.data;
  let safePresence: Omit<z.infer<typeof presenceSchema>, 'passId' | 'orgId'> | null = null;
  if (presence?.success) {
    const { passId: _passId, orgId: _orgId, ...rest } = presence.data;
    safePresence = rest;
  }
  return {
    gateSnapshot: JSON.stringify(safeGate),
    presenceSnapshot: safePresence === null ? null : JSON.stringify(safePresence),
  };
}

export const proofSchema = z
  .object({
    scanId: id,
    orgId: id,
    mode,
    ledgerEventId: id,
    passRef: hash,
    eventDigest: hash,
    scanDigest: hash,
    gateSnapshot: z.string().nullable(),
    presenceSnapshot: z.string().nullable(),
    mac: hash,
    excluded: z.literal(0),
    invalidated: z.literal(0),
  })
  .strict();
export type ScanRetentionProofRow = z.infer<typeof proofSchema>;
