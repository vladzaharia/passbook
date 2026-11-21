import type { Mode } from '../../../shared/contracts/common.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { scannerSlot } from './repo-scanners.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import type { ZoneRow } from './repo-zones.ts';

/**
 * What statement builders share when several objects commit in one batch: the one authority the
 * grant is built from, and the objects the batch creates, which later builders may point at before
 * any of them exists in the database. A builder that adds an object registers it here.
 */
export interface SetupCapture {
  readonly userId: string;
  readonly authority: TenantPassWrite;
  readonly orgId: string;
  readonly mode: Mode;
  readonly origin: string;
  readonly zones: Map<string, ZoneRow>;
  /** Event id to the templates it admits. */
  readonly events: Map<string, string[]>;
  readonly sessions: Map<string, ScanningSessionRow>;
  /** Devices this batch adds, in total and per session: the slot limit and the 64 a session takes. */
  newScanners: number;
  readonly devicesBySession: Map<string, number>;
}

export const newCapture = (
  base: Pick<SetupCapture, 'userId' | 'authority' | 'orgId' | 'mode'> & { origin?: string },
): SetupCapture => ({
  ...base,
  origin: base.origin ?? '',
  zones: new Map(),
  events: new Map(),
  sessions: new Map(),
  newScanners: 0,
  devicesBySession: new Map(),
});

/** One `scanning.devices` slot check for every scanner the batch adds. Put it first in the grant's checks. */
export const slotChecks = (capture: SetupCapture) =>
  capture.newScanners > 0 ? [scannerSlot(capture.newScanners)] : [];
