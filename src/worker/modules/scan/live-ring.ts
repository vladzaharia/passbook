import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanCustomerView } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { ScanActor } from './actor.ts';

export const LIVE_ROW_TTL_MS = 15 * 60_000;

/**
 * One entry of the hub's ring, written when the scan commits. The row is what the source screen
 * disclosed; everything else is a plain fact a recipient's render re-checks against D1 (the scan
 * and the pass generations, the effective release, the credential's tombstones). Nothing in it is a
 * credential or a proof. The holder title and the Wallet expiry are frozen at publish, and sit in
 * plaintext in Durable Object storage for at most `LIVE_ROW_TTL_MS`: an entry whose pass stops being
 * visible is scrubbed to its redacted shape at the next publish or alarm (`scrubbedEntry`). The
 * event id (`row.id`) only selects an entry; it is not a capability and every read re-checks.
 * `gen` is null for a row without pass detail (a refusal, an unknown code, or a pass that could not
 * be evaluated): such a row renders as its redacted shape.
 */
export interface LiveRingRow {
  row: ScanLiveRow;
  scanId: string | null;
  templateId: string | null;
  gen: { credential: number; lifecycle: number; image: number } | null;
  /** The release the pass was used under (`effectiveReleaseIdSql`); null for none. */
  release: string | null;
  /** The Wallet expiry the scan saw; the row stops showing the holder after it. */
  validUntil: number | null;
  sourceRole: ScanRole | null;
  /** The source's signed-in staff and its `auth_epoch`: a staffless monitor borrowing `sourceRole` needs it still valid. */
  sourceStaff: { id: string; authEpoch: number } | null;
  /** Leading hex of the refs of the credential the scan presented (none for a pass-id scan). */
  refPrefixes: string[];
  /** Roles whose own title for the holder equals the source's (a viewer sees the name only then). */
  holderRoles: ScanRole[];
  /** Roles the source's policy shows a photo to; empty when the pass has none. */
  photoRoles: ScanRole[];
  /** Where the scan happened, for watches by session, event and zone. Not identity. */
  sessionId?: string | null;
  eventId?: string | null;
  /** The checked zones and their ancestors. */
  zoneIds?: string[];
  /**
   * The doc-named part of a customer body (chips, panel, lines, milestone), rendered at publish.
   * It names the holder's pass, so it is dropped with the identity.
   */
  customer?: Pick<ScanCustomerView, 'chips' | 'panel' | 'lines' | 'milestone'> | null;
  /** What a committed value scan says on a customer screen (Paid $12.00). It names the value, so it is dropped with the identity. */
  receipt?: { headline: string; sub: string | null } | null;
  /** A refusal or hold a desk may let in (SA 20.9). */
  overridable?: boolean;
}

/** The entry with every identity field removed: what is kept once its pass is no longer visible. */
export function scrubbedEntry(e: LiveRingRow): LiveRingRow {
  return {
    row: redactedRow(e.row, false),
    scanId: e.scanId,
    templateId: null,
    gen: null,
    release: null,
    validUntil: null,
    sourceRole: null,
    sourceStaff: null,
    refPrefixes: [],
    holderRoles: [],
    photoRoles: [],
    sessionId: e.sessionId ?? null,
    eventId: e.eventId ?? null,
    zoneIds: e.zoneIds ?? [],
    customer: null,
    receipt: null,
  };
}

/** A ring entry written before plain rows carried a sealed source proof: it renders redacted until its TTL. */
export function ringRowOf(raw: unknown): LiveRingRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if ('row' in entry && entry.row && typeof entry.row === 'object')
    return { sourceStaff: null, refPrefixes: [], ...entry } as unknown as LiveRingRow;
  const old = entry as unknown as ScanLiveRow;
  if (typeof old.id !== 'string' || typeof old.at !== 'number') return null;
  return {
    row: {
      id: old.id,
      at: old.at,
      scannerId: old.scannerId,
      scannerName: old.scannerName,
      passId: null,
      holder: null,
      photoUrl: null,
      kind: old.kind,
      direction: old.direction,
      label: old.label,
      presented: old.presented,
    },
    scanId: null,
    templateId: null,
    gen: null,
    release: null,
    validUntil: null,
    sourceRole: null,
    sourceStaff: null,
    refPrefixes: [],
    holderRoles: [],
    photoRoles: [],
  };
}

/** The public shape with no identity: never copies the stored holder, photo or pass. */
export function redactedRow(row: ScanLiveRow, customer: boolean): ScanLiveRow {
  return {
    id: row.id,
    at: row.at,
    scannerId: row.scannerId,
    scannerName: customer ? '' : row.scannerName,
    passId: null,
    holder: null,
    photoUrl: null,
    kind: row.kind,
    direction: row.direction,
    label:
      row.kind === 'ok'
        ? row.direction === 'out'
          ? 'Checked out'
          : 'Checked in'
        : row.kind === 'ready'
          ? customer
            ? 'Please wait'
            : 'Choose an action'
          : customer
            ? 'Please see the desk'
            : row.kind === 'undo'
              ? 'Undone'
              : row.kind === 'heads_up'
                ? 'Check required'
                : 'Not accepted',
    presented: row.presented,
  };
}

export function livePhotoUrl(actor: ScanActor, passId: string, event: string): string {
  const params = new URLSearchParams({ event });
  if (actor.principal === 'admin' && actor.scanner) {
    params.set('orgId', actor.orgId);
    params.set('setupId', actor.scanner.id);
    params.set('timeZone', actor.timeZone);
  }
  return `/api/v1/scan/live/passes/${passId}/assets/member.png?${params}`;
}
