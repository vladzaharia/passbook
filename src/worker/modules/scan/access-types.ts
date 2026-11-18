import type { AccessDecision } from '../../../passkit/template/access/index.ts';
import type { ZoneLink } from './repo-access.ts';
import type { ScanGateSnapshot } from './repo-scan-effect.ts';

/** The access verdict for a found pass (AX 3.4 steps 10a-10e), read once with the preflight. */
export interface FoundAccess {
  decision: AccessDecision;
  /** The deciding zone and the zones above it, as read: they must still be so at commit. */
  chain: ZoneLink[];
  /** The deciding zone: it must still be live and linked to the session at commit. */
  zoneId: string | null;
  sessionId: string | null;
  /** A guest's visit limit, else null. */
  limit: number | null;
  /** A visit lasts this long from its start. */
  gapMs: number;
  /** A grant within this long of the last is held; null: off. */
  waitMs: number | null;
  /** The visit gate as the preflight read it, and when its visit began. */
  gateBefore: ScanGateSnapshot | null;
  visitAt: number | null;
}
