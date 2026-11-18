/**
 * The assign loop's state, events and commands. They live beside the frozen `types.ts` the way
 * the access events do: `MachineState` carries the optional fields, `MachineEvent` the union, and
 * the runner knows the commands.
 */

import type { BindResult, InspectResult, TagEnrollment, TagRead } from '../assign/types.ts';
import type { PinNote } from './fail.ts';
import type { Cmd, ScanOutcome } from './types.ts';

/** The reason of a tag read made without a connection. The result card words it (`assign/tag-lines.ts`). */
export const TAG_OFFLINE = 'tag_offline' as unknown as NonNullable<ScanOutcome['reason']>;

export const ASSIGN_TIMING = {
  /** Any input extends it (UX 7). */
  IDLE: 120_000,
  /** The card keeps the banner "That's a pass" this long. */
  NOTE: 4_000,
  /** The amber last 20 s of a request. */
  WARN: 20_000,
  /** The strip after a cancel or a time-out stays this long. */
  STRIP: 6_000,
} as const;

export type AssignSource = 'menu' | 'card' | 'unknown_tag' | 'request';
export type AssignStep = 'tag' | 'pass' | 'confirm' | 'done' | 'error';
export type AssignBusy = 'inspect' | 'preview' | 'bind' | 'undo' | 'complete' | null;

/** The pass the tag is for: a possession credential, or a lookup row (Manager PIN on the server). */
export type CardRef =
  | { code: string; method: 'camera' | 'wedge' | 'nfc' | 'manual' }
  | { passId: string; method: 'manual' };

/** Why the card on the pass step shows a red banner. The camera keeps reading. */
export type AssignBanner =
  | 'not_found'
  | 'voided'
  | 'removed'
  | 'expired'
  | 'not_accepted'
  | 'ambiguous';
/** The amber lines that do not change the step. */
export type AssignNote = 'is_pass' | 'is_tag';

export type AssignErrorKind =
  | 'lost'
  | 'secure_needed'
  | 'failed_check'
  | 'unreadable'
  | 'random_id'
  | 'not_assigned'
  | 'too_many'
  | 'went_wrong'
  | 'needs_connection'
  | 'no_account'
  | 'limit'
  | 'off'
  | 'already_here';

export interface AssignError {
  kind: AssignErrorKind;
  seconds?: number;
  requestId?: string;
  /** A tag read from the web that has no ID or record. */
  web?: boolean;
  /** `already_here`: when and by whom. */
  at?: number | null;
  by?: string | null;
}

export interface AssignState {
  source: AssignSource;
  step: AssignStep;
  busy: AssignBusy;
  /** The idempotency key of the request in flight; answers for other keys are dropped. */
  key: string | null;
  tag: { read: TagRead; sig: string } | null;
  inspected: InspectResult | null;
  card: CardRef | null;
  preview: BindResult | null;
  scope: 'pass' | 'user';
  label: string;
  banner: AssignBanner | null;
  note: { kind: AssignNote; until: number } | null;
  error: AssignError | null;
  result: BindResult | null;
  /** A request from an admin: the pass is known and nothing is confirmed on the scanner. */
  request: TagEnrollment | null;
  /** The tag opens another holder's pass and the console decides. */
  waiting: boolean;
  /** The Manager PIN sheet: open, and what the last PIN got. */
  pin: { open: boolean; note?: PinNote; move: boolean } | null;
  /** Reaches the 2 minute time-out; every input pushes it. */
  idleAt: number;
  /** The bind key and body the last Try again resends. */
  retry: AssignCmd | null;
}

/** Why an assign card closed, for the strip. */
export type AssignStripKind =
  | 'cancelled'
  | 'timedOut'
  | 'assigned'
  | 'undone'
  | 'requestCancelled'
  | 'adminCancelled'
  | 'requestTimedOut';
export interface AssignStrip {
  kind: AssignStripKind;
  at: number;
  name?: string;
  /** Undo on this device until then. */
  bindingId?: string;
  undoUntil?: number | null;
  /** The key of an undo in flight from the strip. */
  undoKey?: string;
}

/** An admin's request on this scanner. `opened` once the card has shown it. */
export interface PendingRequest {
  request: TagEnrollment;
  opened: boolean;
  /** Later: the chip waits until the person opens it. */
  later?: boolean;
}

export type AssignOpen =
  | { from: 'menu' }
  | { from: 'card'; card: CardRef }
  | { from: 'unknown_tag'; tag: TagRead; sig: string };

export type AssignEvent =
  | ({ type: 'assign.open' } & AssignOpen)
  | { type: 'assign.cancel' }
  | { type: 'assign.back' }
  /** Done on the assigned card; Assign another goes back to the tag step. */
  | { type: 'assign.done' }
  | { type: 'assign.again'; keepPass: boolean }
  | { type: 'assign.scope'; scope: 'pass' | 'user' }
  | { type: 'assign.label'; label: string }
  | { type: 'assign.bind'; move?: boolean }
  | { type: 'assign.pin'; open: boolean; move?: boolean }
  | { type: 'assign.approve'; staffId?: string; pin: string }
  | { type: 'assign.retry' }
  | { type: 'assign.undo' }
  | { type: 'assign.inspected'; key: string; result: InspectResult }
  | { type: 'assign.previewed'; key: string; result: BindResult }
  | { type: 'assign.bound'; key: string; result: BindResult }
  | { type: 'assign.undone'; key: string }
  | {
      type: 'assign.failed';
      key: string;
      /** The server's stable code, or null for a network failure. */
      code: string | null;
      status: number;
      network: boolean;
      retryAfterMs?: number;
      requestId?: string;
      triesLeft?: number;
      locked?: boolean;
    }
  /** The device socket or the pending fetch brought a request. */
  | { type: 'enroll.arrive'; request: TagEnrollment }
  /** The admin cancelled it, or the fetch after a reconnect found none. */
  | { type: 'enroll.cancelled'; id: string }
  | { type: 'enroll.open' }
  | { type: 'enroll.later' }
  | { type: 'enroll.decline' };

export type AssignCmd =
  | { c: 'assign.inspect'; key: string; tag: TagRead }
  | { c: 'assign.bind'; key: string; body: BindBodyIn }
  | { c: 'assign.undo'; key: string; bindingId: string }
  | { c: 'enroll.complete'; key: string; id: string; tag: TagRead; request: TagEnrollment }
  | { c: 'enroll.decline'; id: string };

/** What the bind command carries: the whole request but its idempotency key, which is `key`. */
export interface BindBodyIn {
  tag: TagRead;
  card: CardRef;
  preview: boolean;
  binding: 'pass' | 'user';
  move?: boolean;
  label?: string;
  approval?: { staffId?: string; pin: string };
}

export const asCmd = (cmd: AssignCmd): Cmd => cmd as unknown as Cmd;
export const isAssignCmd = (cmd: Cmd): cmd is Cmd & AssignCmd =>
  typeof (cmd as { c: string }).c === 'string' &&
  ((cmd as { c: string }).c.startsWith('assign.') ||
    (cmd as { c: string }).c.startsWith('enroll.'));
export const isAssignEvent = (event: { type: string }): event is AssignEvent =>
  event.type.startsWith('assign.') || event.type.startsWith('enroll.');
