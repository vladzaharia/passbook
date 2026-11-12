import type { EventRow } from '../events/repo.ts';
import type { ScanRow } from './repo-scan-map.ts';
import { type ObjectValue, object } from './scan-event-proof-envelope.ts';

type RecordedEventScan = Omit<
  ScanRow,
  'requestHash' | 'actionId' | 'overrideOf' | 'approvedBy' | 'undoneBy'
> & {
  pinnedTemplateVersion: string;
  walletVersion: number;
  walletTemplateVersion: string | null;
  direction: 'in' | 'out' | null;
  presenceScope: string | null;
};

function recordedGateValid(row: EventRow, scan: RecordedEventScan, data: ObjectValue): boolean {
  if (!object(data.authority)) return false;
  const gate = data.authority.gate;
  if (scan.outcome === 'ok' && scan.actionKind !== 'check_in') return false;
  if (scan.outcome !== 'ok')
    return (
      gate === undefined ||
      (object(gate) && typeof gate.scope === 'string' && typeof gate.exists === 'boolean')
    );
  return (
    object(gate) &&
    gate.exists === true &&
    typeof gate.scope === 'string' &&
    gate.scanId === scan.id &&
    gate.orgId === row.org_id &&
    gate.mode === row.mode &&
    gate.templateId === scan.templateId &&
    gate.kind === scan.actionKind &&
    gate.state === (scan.direction ?? 'in') &&
    gate.scanState === 'done' &&
    gate.undoneBy === null &&
    Number.isSafeInteger(gate.count) &&
    Number(gate.count) > 0 &&
    Number.isSafeInteger(gate.firstAt) &&
    Number.isSafeInteger(gate.lastAt) &&
    Object.hasOwn(gate, 'prevState') &&
    (gate.prevState === null || typeof gate.prevState === 'string') &&
    Object.hasOwn(gate, 'prevLastAt') &&
    (gate.prevLastAt === null || Number.isSafeInteger(gate.prevLastAt)) &&
    Object.hasOwn(gate, 'prevScanId') &&
    (gate.prevScanId === null || typeof gate.prevScanId === 'string')
  );
}

const HASH = /^[0-9a-f]{64}$/;
const ROLES = new Set(['door', 'desk', 'manager']);
const hashOrNull = (value: unknown) =>
  value === null || (typeof value === 'string' && HASH.test(value));

/**
 * The projection has an entry for the event's recorded role. Without one (the writer's minimal
 * `roles: {}`) no reader shows the event's pass: the console finds no role entry, the feed asks this.
 */
export function recordedRoleProjected(authority: unknown): boolean {
  if (!object(authority)) return false;
  const projection = authority.eventProjection;
  const recorded = authority.role;
  return (
    object(projection) &&
    object(projection.roles) &&
    typeof recorded === 'string' &&
    ROLES.has(recorded) &&
    Object.hasOwn(projection.roles, recorded)
  );
}

/**
 * The role projection is what every reader redacts by: `{v: 1, roles}`, each entry well-formed, with
 * an entry for the recorded role. `roles: {}` is the writer's minimal form (no policy was
 * evaluated, as for a refusal without a usable pass). Without it the event proves nothing about its pass.
 */
function recordedProjectionValid(scan: RecordedEventScan, authority: ObjectValue): boolean {
  const projection = authority.eventProjection;
  if (!object(projection) || projection.v !== 1 || !object(projection.roles)) return false;
  const roles = projection.roles;
  if (Object.keys(roles).length > 0 && !recordedRoleProjected(authority)) return false;
  return Object.entries(roles).every(([role, entry]) => {
    if (!ROLES.has(role) || !object(entry)) return false;
    const keys = Object.keys(entry).sort().join();
    if (keys !== 'action,scannerNameHash,titleHash') return false;
    const action = entry.action;
    return (
      (action === null ||
        (object(action) &&
          Object.keys(action).sort().join() === 'kind,labelHash' &&
          action.kind === scan.actionKind &&
          hashOrNull(action.labelHash))) &&
      hashOrNull(entry.scannerNameHash) &&
      hashOrNull(entry.titleHash)
    );
  });
}

export function recordedEventValid(
  row: EventRow,
  scan: RecordedEventScan,
  data: ObjectValue,
  actionIdRef: string | null,
): boolean {
  if (!object(data.authority)) return false;
  const actorKey =
    row.actor_type === 'scanner'
      ? `s:${row.actor_id}`
      : row.actor_type === 'user'
        ? scan.scannerId
          ? `u:${row.actor_id}:${scan.scannerId}`
          : `u:${row.actor_id}`
        : null;
  const eventKind =
    scan.outcome === 'ok'
      ? scan.direction === 'out'
        ? 'scan.checked_out'
        : 'scan.checked_in'
      : scan.outcome === 'heads_up'
        ? 'scan.heads_up'
        : scan.outcome === 'refused'
          ? 'scan.rejected'
          : null;
  return (
    scan.state === 'done' &&
    scan.passId !== null &&
    row.org_id === scan.orgId &&
    row.pass_id === scan.passId &&
    row.mode === scan.mode &&
    row.kind === eventKind &&
    !!row.actor_id &&
    actorKey === scan.actorKey &&
    data.scanId === scan.id &&
    data.actionIdRef === actionIdRef &&
    data.actionKind === scan.actionKind &&
    data.outcome === scan.outcome &&
    data.reason === scan.reason &&
    data.version === scan.passVersion &&
    (data.direction ?? null) === scan.direction &&
    data.method === scan.method &&
    data.scannerId === scan.scannerId &&
    data.staffId === scan.staffId &&
    data.eventId === scan.eventId &&
    data.authority.templateId === scan.templateId &&
    data.authority.pinnedTemplateVersion === scan.pinnedTemplateVersion &&
    data.authority.walletTemplateVersion === scan.walletTemplateVersion &&
    data.authority.walletVersion === scan.walletVersion &&
    Number.isSafeInteger(scan.walletVersion) &&
    scan.walletVersion > 0 &&
    scan.passVersion !== null &&
    scan.walletVersion <= scan.passVersion &&
    data.authority.scanAt === scan.at &&
    data.authority.presenceScope === scan.presenceScope &&
    data.authority.nonQuarantined === true &&
    recordedProjectionValid(scan, data.authority) &&
    recordedGateValid(row, scan, data)
  );
}
