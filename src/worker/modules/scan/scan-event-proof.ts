import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import type { EventRow } from '../events/repo.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { ScanRow } from './repo-scans.ts';
import { scanActionIdRef } from './scan-action-ref.ts';
import { type Direction, object, payload, releaseClass } from './scan-event-proof-envelope.ts';
import { recordedEventValid } from './scan-event-proof-recorded.ts';
import { personalizationFingerprint } from './scan-personalization-proof.ts';

/** Immutable scan fields selected alongside an original pass event, without further database reads. */
export type ScanEventReference = Pick<
  ScanRow,
  | 'id'
  | 'orgId'
  | 'mode'
  | 'passId'
  | 'templateId'
  | 'scannerId'
  | 'eventId'
  | 'actorKey'
  | 'staffId'
  | 'actionId'
  | 'actionKind'
  | 'outcome'
  | 'reason'
  | 'passVersion'
  | 'method'
  | 'at'
  | 'state'
> & {
  pinnedTemplateVersion: string;
  walletVersion: number;
  walletTemplateVersion: string | null;
  direction: 'in' | 'out' | null;
  presenceScope: string | null;
};

/** Reuse only within one request and environment; keys include the exact event and scan. */
export type ScanEventProofCache = Map<string, Promise<boolean>>;

/** Record the evaluated decision: validate its shape and add the plain release class. No proof material. */
export async function sealScanEvent(
  _env: object,
  row: EventRow,
  gateScope: string | null,
  scanAt: number,
  direction: Direction,
  presenceScope: string | null,
): Promise<EventRow> {
  const data: unknown = JSON.parse(row.data);
  if (!object(data) || !object(data.authority)) throw new Error('Invalid scan event authority');
  const kind = releaseClass(data.authority);
  if (!kind || !payload(row, data, gateScope, scanAt, direction, presenceScope, kind))
    throw new Error('Invalid scan event input');
  return {
    ...row,
    data: JSON.stringify({ ...data, authority: { ...data.authority, releaseClass: kind } }),
  };
}

/** Check a recorded decision against its scan row using only the event's own plain facts. */
async function verifyScanEventUncached(
  env: object,
  row: EventRow,
  scan: ScanEventReference,
): Promise<boolean> {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    return false;
  }
  if (!object(data) || !object(data.authority)) return false;
  if (
    scan.actionId !== null &&
    (typeof scan.actionId !== 'string' ||
      !scan.actionId ||
      typeof scan.orgId !== 'string' ||
      !scan.orgId ||
      (scan.mode !== 'live' && scan.mode !== 'test') ||
      typeof scan.templateId !== 'string' ||
      !scan.templateId)
  )
    return false;
  const actionIdRef =
    scan.actionId === null
      ? null
      : scan.templateId
        ? await scanActionIdRef(env, {
            orgId: scan.orgId,
            mode: scan.mode,
            templateId: scan.templateId,
            actionId: scan.actionId,
          })
        : null;
  if (scan.actionId !== null && actionIdRef === null) return false;
  const kind = releaseClass(data.authority);
  if (!kind || !recordedEventValid(row, scan, data, actionIdRef)) return false;
  const gate = data.authority.gate;
  if (gate !== undefined && !object(gate)) return false;
  return !!payload(
    row,
    data,
    object(gate) && typeof gate.scope === 'string' ? gate.scope : null,
    scan.at,
    scan.direction,
    scan.presenceScope,
    kind,
  );
}

export function verifyScanEventProvenance(
  env: object,
  row: EventRow,
  scan: ScanEventReference,
  cache?: ScanEventProofCache,
): Promise<boolean> {
  const keys = captureCredentialKeyEnv(env);
  const event: EventRow = {
    id: row.id,
    org_id: row.org_id,
    pass_id: row.pass_id,
    mode: row.mode,
    kind: row.kind,
    device: row.device,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    data: row.data,
    at: row.at,
  };
  const snapshot: ScanEventReference = { ...scan };
  if (!cache) return verifyScanEventUncached(keys, event, snapshot);
  return (async () => {
    const key = await sha256Hex(canonicalJson([event, snapshot]));
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const result = verifyScanEventUncached(keys, event, snapshot);
    cache.set(key, result);
    return result;
  })();
}

/** Select only authenticated event-time values without consulting Wallet or R2. */
export async function verifiedScanPersonalizationSource(
  env: object,
  row: EventRow,
  scan: ScanEventReference,
  currentRaw: string | null,
  versionRaw: string | null,
  cache?: ScanEventProofCache,
): Promise<'current' | 'version' | null> {
  const keys = captureCredentialKeyEnv(env);
  const event = { ...row };
  const snapshot = { ...scan };
  if (snapshot.passId === null || !(await verifyScanEventProvenance(keys, event, snapshot, cache)))
    return null;
  const data: unknown = JSON.parse(event.data);
  if (
    !object(data) ||
    !object(data.authority) ||
    typeof data.authority.evaluatedPersonalizationHash !== 'string'
  )
    return null;
  const validObject = (raw: string): boolean => {
    try {
      return object(JSON.parse(raw));
    } catch {
      return false;
    }
  };
  if (currentRaw !== null && validObject(currentRaw)) {
    const current = await personalizationFingerprint(
      keys,
      snapshot.orgId,
      snapshot.passId,
      snapshot.walletVersion,
      currentRaw,
    );
    if (current !== null && (await safeEqual(current, data.authority.evaluatedPersonalizationHash)))
      return 'current';
  }
  if (
    versionRaw !== null &&
    versionRaw !== currentRaw &&
    validObject(versionRaw) &&
    typeof data.authority.personalizationHash === 'string'
  ) {
    const recorded = await personalizationFingerprint(
      keys,
      snapshot.orgId,
      snapshot.passId,
      snapshot.walletVersion,
      versionRaw,
    );
    if (
      recorded !== null &&
      (await safeEqual(recorded, data.authority.evaluatedPersonalizationHash)) &&
      (await safeEqual(recorded, data.authority.personalizationHash))
    )
      return 'version';
  }
  return null;
}
