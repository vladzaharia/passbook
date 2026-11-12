/**
 * The scan machine's frozen contract (AC 3.1-3.3 with SA 7.5's amendments and the B card layer).
 * One pure reducer `reduce(state, event, { now, id }) -> { state, cmds }` serves both postures.
 * Stream CC implements it; the UI streams build against these shapes and the fixtures.
 */
import type {
  ScanCard,
  ScanCounts,
  ScanOutcome as ServerOutcome,
} from '../../../shared/contracts/scan.ts';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { ScanInput } from '../input/types.ts';

export type { ScanInput };

/** The member card's data: what a `ready` outcome carries. */
export type Card = ScanCard;
export type Counts = ScanCounts;

/** A Manager's PIN approval. */
export interface Approval {
  staffId: string;
  pin: string;
}

export interface Draft {
  actionId: string;
  amount: number | null;
  value?: unknown;
  override?: boolean;
  overrideOf?: string;
  confirmed?: boolean;
  /** A Manager's PIN approval for this one action. The PIN sheet re-sends the draft under a new key. */
  approval?: Approval;
}

export type Loop =
  | { s: 'ready'; since: number; hint: 0 | 1 | 2 | 3 }
  | {
      s: 'checking';
      input: ScanInput;
      key: string;
      since: number;
      slow: boolean;
      next: ScanInput | null;
    }
  | {
      s: 'member';
      input: ScanInput;
      card: Card;
      since: number;
      band: ScanOutcome | null;
      picker: Draft | null;
      held: ScanInput | null;
      locked: boolean;
    }
  | { s: 'reviewing'; input: ScanInput; card: Card; draft: Draft; held: ScanInput | null }
  | {
      s: 'applying';
      input: ScanInput;
      card: Card | null;
      draft: Draft;
      key: string;
      since: number;
      slow: boolean;
      next: ScanInput | null;
    }
  | {
      s: 'verdict';
      input: ScanInput;
      card: Card | null;
      outcome: ScanOutcome;
      since: number;
      /** Auto-dismiss deadline; null holds until a tap. */
      closeAt: number | null;
      /** Desk: when the tint and ring fade and the card stays up untinted. */
      settleAt: number | null;
      /** From here a different code replaces the verdict (T0 + NEXT_SCAN_AFTER_VERDICT). */
      openFrom: number;
      next: ScanInput | null;
    }
  | { s: 'paused'; reason: 'idle' | 'hidden' | 'camera_lost' };

export type CameraStatus =
  | 'off'
  | 'starting'
  | 'live'
  | 'blocked'
  | 'unavailable'
  | 'decoder_failed'
  | 'disabled';

/** The result card layer (BF motion). The reducer only emits `card.rise | card.tuck | card.swap`. */
export interface CardLayer {
  phase: 'rising' | 'up' | 'tucking';
  /** The outcome's scan id, or the panel's input id: the FLIP key. */
  id: string;
  /** `panel` is the desk panel (member, reviewing, applying, approval); no tint. */
  kind: 'result' | 'panel';
}

export interface Ignore {
  sig: string;
  until: number;
  why: 'accepted' | 'refused' | 'shown';
  headline?: string;
}

export interface Unsure {
  key: string;
  sig: string;
  passId?: string;
  draft: Draft;
  at: number;
  state: 'retrying' | 'expired';
}

export interface Recent {
  scanId: string | null;
  at: number;
  outcome: ScanOutcome;
  undoable: boolean;
}

export interface ScanState {
  loop: Loop;
  /** The Start tap happened (audio, wake lock, camera). */
  started: boolean;
  camera: CameraStatus;
  overlay: null | 'lookup' | 'camera' | 'recent' | 'settings' | 'shift';
  /** Full-screen panels. `staff` is the Who's scanning? sheet (STAFF_REQUIRED or a `staff_required` session). */
  block: null | 'revoked' | 'suspended' | 'signed_out' | 'staff';
  posture: 'door' | 'desk';
  layout: 'handheld' | 'stand';
  /** The ready action: the next scans apply it. */
  armed: { actionId: string; amount: number | null; sticky: boolean } | null;
  scope: { key: string | null; direction: 'in' | 'out'; operator: string | null };
  card: CardLayer | null;
  focused: boolean;
  online: boolean;
  unsure: Unsure[];
  queue: { pending: number; oldestAt: number | null; conflicts: number };
  reader: { kind: 'none' | 'barcode' | 'nfc'; lastAt: number | null; badLayout: number };
  undo: { scanId: string; key: string; since: number } | null;
  /** At most 20, pruned on every event. */
  ignore: Ignore[];
  /** At most 20, newest first. */
  recent: Recent[];
  counts: Counts | null;
  prefs: { holdResults: boolean; sound: boolean };
  lastActivity: number;
}

export type FailCode =
  | 'network'
  | 'timeout'
  | 'server'
  | 'rate_limited'
  | 'revoked'
  | 'suspended'
  | 'signed_out'
  | 'forbidden'
  | 'staff_required';

export type ScanEvent =
  | { type: 'start' }
  | { type: 'scope'; scope: Partial<ScanState['scope']> }
  | { type: 'camera'; status: CameraStatus }
  | { type: 'read'; input: ScanInput }
  | { type: 'answer'; key: string; outcome: ScanOutcome; replay?: boolean }
  | { type: 'fail'; key: string; error: FailCode; retryAfterMs?: number; requestId?: string }
  | { type: 'offline'; key: string; outcome: ScanOutcome }
  | { type: 'pick'; actionId: string }
  | { type: 'amount'; value: number | null }
  | { type: 'review' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  /** "Another pass was scanned": Switch or Keep editing. */
  | { type: 'switch' }
  | { type: 'keep' }
  | { type: 'override'; actionId: string }
  /** The Manager PIN sheet's Approve: re-sends the same draft under a new key with `approval`. */
  | { type: 'approve'; staffId: string; pin: string }
  | { type: 'arm'; actionId: string; amount: number | null; sticky: boolean }
  | { type: 'disarm' }
  /** `approval` is a Manager's PIN when the undo policy requires one. */
  | { type: 'undo'; scanId: string; approval?: Approval }
  | { type: 'undone'; key: string; outcome: ScanOutcome }
  | { type: 'dismiss' }
  /** A deadline from `nextDeadline()` passed. */
  | { type: 'tick' }
  | { type: 'visible'; visible: boolean }
  | { type: 'focus'; focused: boolean }
  | { type: 'online'; online: boolean }
  | { type: 'queue'; pending: number; oldestAt: number | null; conflicts: number }
  | { type: 'overlay'; open: ScanState['overlay'] }
  | { type: 'resume' }
  | { type: 'prefs'; prefs: Partial<ScanState['prefs']> }
  | { type: 'counts'; counts: Counts }
  /** The reader setup and its health: the scanner's reader kind, and `badLayout` from the wedge source. */
  | { type: 'reader'; reader: Partial<ScanState['reader']> };

export type Tone = 'ok' | 'reward' | 'heads_up' | 'refused' | 'system' | 'undo' | 'read';

/** The buddy's beats (BM section 8). `cut` stops the current beat at once. */
export type BuddyBeat =
  | 'hop'
  | 'dip'
  | 'fan'
  | 'stash'
  | 'stamp'
  | 'sparkle'
  | 'coins'
  | 'nod'
  | 'punch'
  | 'rewind'
  | 'wrist'
  | 'tilt'
  | 'shake'
  | 'cloud'
  | 'plug'
  | 'wait'
  | 'lock'
  | 'look'
  | 'pair'
  | 'hello'
  | 'tug';

export type Cmd =
  | { c: 'resolve'; key: string; input: ScanInput }
  | { c: 'act'; key: string; input: ScanInput; draft: Draft | 'auto' }
  | { c: 'undo'; key: string; scanId: string; approval?: Approval }
  | { c: 'unsure.keep'; entry: Unsure }
  | { c: 'unsure.drop'; key: string }
  | { c: 'offline.decide'; key: string; input: ScanInput }
  | { c: 'camera'; op: 'start' | 'pause' | 'resume' | 'stop' | 'slow' }
  | { c: 'wake'; op: 'request' | 'release' }
  | { c: 'audio'; op: 'unlock' }
  | { c: 'sound'; tone: Tone }
  | { c: 'beat'; beat: BuddyBeat | 'cut' }
  | { c: 'announce'; text: string; polite: boolean }
  | { c: 'focus'; target: 'done' | 'region' | 'enter-code' | 'card-heading' | 'action' }
  | { c: 'chip'; chip: 'just_now' | 'already_open' | { same: string } }
  | { c: 'celebrate' }
  /** The card layer: the view runs FLIP from the violet pass's live box. Timers stay in useScanMachine. */
  | { c: 'card.rise'; kind: CardLayer['kind']; id: string }
  | { c: 'card.tuck' }
  | { c: 'card.swap'; kind: CardLayer['kind']; id: string };

export type OutcomeKind = ServerOutcome['kind'] | 'system' | 'queued';

/** Client-only reasons. A reason the client does not know renders as a generic refusal. */
export type ClientReason =
  | 'network'
  | 'timeout'
  | 'unconfirmed'
  | 'still_unconfirmed'
  | 'server'
  | 'rate_limited'
  | 'saved_offline'
  | 'add_link';

/** The server's outcome, widened by the client-only kinds `system` and `queued`. */
export interface ScanOutcome extends Omit<ServerOutcome, 'kind' | 'reason'> {
  kind: OutcomeKind;
  reason: ServerOutcome['reason'] | ClientReason | null;
  /** Decided on the device: no request was made. */
  local?: boolean;
  requestId?: string;
  retryAfterMs?: number;
}

/** What `machine/present.ts` derives from (outcome, posture): the one table of presentation rules. */
export interface Presentation {
  /** The result card's tint and ring role. `none` for `ready` (the desk panel has no tint). */
  tint: 'green' | 'amber' | 'red' | 'slate' | 'none';
  /** How long the verdict holds, ms; null holds until a tap, Done or a different code. */
  hold: number | null;
  /** Whether the camera dims behind a desk panel. */
  dim: boolean;
  /** The dock: the verbs under the card. */
  dock: {
    primary: 'done' | 'redeem' | 'approve' | 'retry' | 'commit' | null;
    secondary: 'cancel' | 'back' | 'undo' | null;
    /** Focus moves here when the verdict lands. */
    focus: 'done' | 'action' | null;
  };
  card: { kind: CardLayer['kind']; rise: boolean } | null;
  tone: Tone | null;
  beat: BuddyBeat | null;
  region: 'status' | 'alert';
  announcement: string | null;
}

/** What the buddy view reads (`seat` left the machine: one dock seat). */
export interface BuddyView {
  pose: 'rest' | 'aim' | 'sorry' | 'pair' | 'cover';
  mood: 'neutral' | 'happy' | 'curious' | 'sad' | 'flat';
  beat: BuddyBeat | null;
  /** Re-keyed per verdict so a beat replays. */
  key: string;
  /** The result card is rising or up (`in`) or tucking (`out`). */
  card: 'in' | 'out';
}

export interface ScanMachineDeps {
  now: number;
  id: () => string;
}

export interface ReduceResult {
  state: ScanState;
  cmds: Cmd[];
}

/** A rendered display on an outcome, for the UI streams' convenience. */
export type OutcomeDisplay = ScanDisplay | null;
