import type { ScanActor } from './actor.ts';
import { historyProjectable, historyReadable } from './repo-scan-history.ts';
import { ROLE_RANK } from './rules.ts';
import { captureObservedScanningSession } from './scanning-workspace-observation.ts';
import { sessionWindow } from './session-hours.ts';

/**
 * A pass is in the actor's reach when its template is in the scope the actor was admitted with. A
 * scanner with no scope reads passes only when it accepts every template; a console actor has no
 * scope of its own. Anything else answers as a missing pass.
 */
export function passInScope(actor: ScanActor, templateId: string): boolean {
  if (actor.templateIds.length > 0) return actor.templateIds.includes(templateId);
  return !actor.scanner || actor.settings.acceptAllTemplates === true;
}

const atLeast = (actor: ScanActor, role: 'desk' | 'manager') =>
  actor.role !== null && ROLE_RANK[actor.role] >= ROLE_RANK[role];

/**
 * Holder data is read only while the session is live: active, inside its hours, and under a strict
 * scope. A Manager or above reads receipts through a pause or a close (they sign in to reopen).
 */
export function readsAllowed(actor: ScanActor, now: number): boolean {
  if (!historyReadable(actor)) return false;
  if (atLeast(actor, 'manager')) return true;
  if (!historyProjectable(actor)) return false;
  if (!actor.scanningSession) return true;
  const parent = captureObservedScanningSession(actor)?.parent;
  return parent !== undefined && sessionWindow(parent, now).open;
}

/** Staff notes are read by Desk and above on a live session, never by a terminal, customer screen or monitor. */
export const mayReadNotes = (actor: ScanActor, now: number): boolean =>
  atLeast(actor, 'desk') && !actor.terminal && readsAllowed(actor, now);

/**
 * Adding is a paired scan device. Editing and deleting add the console: the note's author, or a
 * Manager and above (who may touch any note).
 */
export const mayWriteNotes = (actor: ScanActor, now: number, change: boolean): boolean =>
  mayReadNotes(actor, now) &&
  ((actor.principal === 'scanner' && actor.scanner !== null) ||
    (change && actor.principal === 'admin' && atLeast(actor, 'manager')));

export const isManager = (actor: ScanActor): boolean => atLeast(actor, 'manager');
