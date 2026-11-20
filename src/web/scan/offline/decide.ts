/**
 * The door's verdict for a read with no connection (O8), from the list alone. Pure: the controller
 * hashes the code, looks it up and queues what this returns. Nothing here knows a holder; the list has none.
 */
import type { OfflineMode } from '../../../shared/scan-offline.ts';
import { localOutcome } from '../machine/outcome.ts';
import type { Counts, ScanOutcome } from '../machine/types.ts';
import type { QueueRow } from './queue-store.ts';
import type { RosterEntry } from './roster.ts';

export interface DecideInput {
  mode: Exclude<OfflineMode, 'stop'>;
  /** Staff tapped Let in on a Staff decide prompt. */
  unverified: boolean;
  /** The list entry for the code, if it is on it. */
  entry: RosterEntry | null;
  /** When the list was cut, or null when there is none or it has expired. */
  listAt: number | null;
  counts: Counts | null;
  now: number;
}

export interface Decision {
  outcome: ScanOutcome;
  /** How to queue the read; null when it needs no record. */
  door: QueueRow['door'] | null;
  /** Mark the hash in, so a second read is a repeat. */
  markIn: boolean;
}

const CHECK_IN = { id: 'check_in', label: 'Checked in', kind: 'check_in' } as const;
const LET_IN = { id: 'check_in', label: 'Let in', kind: 'check_in' } as const;

const refuse = (
  reason: 'not_found' | 'voided' | 'removed' | 'not_listed',
  i: DecideInput,
): Decision => ({
  outcome: localOutcome('refused', reason, i.counts, { at: i.listAt }),
  door: 'refused',
  markIn: false,
});

export function decide(i: DecideInput): Decision {
  if (i.mode === 'decide') {
    if (!i.unverified)
      return {
        outcome: localOutcome('heads_up', 'offline_decide', i.counts, { action: LET_IN }),
        door: null,
        markIn: false,
      };
    return {
      outcome: localOutcome('queued', 'saved_offline', i.counts, { at: i.now, action: CHECK_IN }),
      door: 'unverified',
      markIn: false,
    };
  }
  if (i.listAt === null)
    return { outcome: localOutcome('system', 'network', i.counts), door: null, markIn: false };
  if (!i.entry) return refuse('not_listed', i);
  if (i.entry.status !== 'active')
    return refuse(i.entry.status === 'voided' ? 'voided' : 'removed', i);
  if (i.entry.state === 'in')
    return {
      outcome: localOutcome('heads_up', 'already_done', i.counts, { action: CHECK_IN }),
      door: 'refused',
      markIn: false,
    };
  return {
    outcome: localOutcome('queued', 'saved_offline', i.counts, { at: i.now, action: CHECK_IN }),
    door: 'listed',
    markIn: true,
  };
}
