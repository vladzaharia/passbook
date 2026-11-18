import {
  authorityDenied,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../platform/errors.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { ScanActor } from './actor.ts';
import type { ScanRow } from './repo-scans.ts';
import type { ScanEventRow } from './repo-scope.ts';
import type { UndoGate, UndoPresence } from './repo-undo.ts';
import type { UndoRead } from './repo-undo-read.ts';

/** Every kind an ok scan can have; an undo row is not one. */
const UNDOABLE = new Set(['check_in', 'add', 'take', 'set', 'use_up']);

export const notFound = () => new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
export const superseded = () =>
  new ConflictError('A later scan replaced this one.', 'UNDO_SUPERSEDED');

export interface UndoPlan {
  target: ScanRow & { passId: string; actionId: string };
  gate: UndoGate;
  presence: UndoPresence | null;
  event: ScanEventRow | null;
  /** A scan at a tracked zone: its rows are undone by group (`addUndo`), not as presence. */
  zone: boolean;
}

/**
 * What the request derives its undo from: the target, the gate and presence it last wrote, and the
 * event. Pass, template, wallet and org revisions are not read: they are not authority. The commit
 * compares the gate, presence and target again inside its grant.
 */
export async function planUndo(actor: ScanActor, read: UndoRead): Promise<UndoPlan> {
  // Membership roles are immutable (Rule 2): the capability is checked once, here.
  const tenant = actor.tenantAuthority;
  if (
    tenant &&
    (tenant.capability !== 'passes:operate' ||
      !rolesGranting('passes:operate').some((role) => tenant.roles.includes(role)))
  )
    throw new ForbiddenError('This scan cannot be undone by this operator.', 'SCAN_UNDO_FORBIDDEN');
  const scan = read.target;
  if (
    !scan ||
    scan.mode !== actor.mode ||
    scan.state !== 'done' ||
    scan.outcome !== 'ok' ||
    !UNDOABLE.has(scan.actionKind ?? '') ||
    !scan.passId ||
    !scan.actionId
  )
    throw notFound();
  const target = { ...scan, passId: scan.passId, actionId: scan.actionId };
  const accepted = actor.templateIds.length
    ? actor.templateIds.includes(target.templateId ?? '')
    : (actor.principal === 'admin' && !actor.scanner) || actor.settings.acceptAllTemplates === true;
  if (!accepted || (actor.event && target.eventId !== actor.event.id)) throw notFound();
  const event = target.eventId
    ? actor.event?.id === target.eventId
      ? actor.event
      : read.event
    : null;
  if (target.eventId && (!event || event.mode !== actor.mode)) throw notFound();
  if (event?.archivedAt != null) throw authorityDenied('config');
  if (target.undoneBy) throw superseded();
  const { gate, presence } = read;
  if (
    !gate ||
    gate.template_id !== target.templateId ||
    gate.kind !== scan.actionKind ||
    gate.state === 'undone' ||
    gate.count < 1
  )
    throw superseded();
  // A scan at a tracked zone wrote its in/out row by group, not as presence.
  const zone = target.presenceScope?.startsWith('zone:') === true;
  if (!zone && target.presenceScope != null && !presence) throw superseded();
  const kept = zone || target.presenceScope == null ? null : presence;
  return { target, gate, presence: kept, event, zone };
}
