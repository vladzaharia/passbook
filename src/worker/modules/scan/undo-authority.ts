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

export const notFound = () => new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
export const superseded = () =>
  new ConflictError('A later scan replaced this one.', 'UNDO_SUPERSEDED');

export interface UndoPlan {
  target: ScanRow & { passId: string; actionId: string };
  gate: UndoGate;
  presence: UndoPresence | null;
  event: ScanEventRow | null;
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
    scan.actionKind !== 'check_in' ||
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
    gate.kind !== 'check_in' ||
    gate.state === 'undone' ||
    gate.count < 1
  )
    throw superseded();
  if (target.presenceScope != null && !presence) throw superseded();
  return { target, gate, presence: target.presenceScope == null ? null : presence, event };
}
