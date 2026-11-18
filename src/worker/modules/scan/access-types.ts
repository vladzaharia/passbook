import type { AccessDecision } from '../../../passkit/template/access/index.ts';

/** The access verdict for a found pass (AX 3.4 steps 10a-10e), read once with the preflight. */
export interface FoundAccess {
  decision: AccessDecision;
  /** The deciding zone: it must still be live and linked to the session at commit. */
  zoneId: string | null;
  sessionId: string | null;
  /** A guest's visit limit, else null. */
  limit: number | null;
  /** Grants within this long of the last are one visit. */
  gapMs: number;
  /** A grant within this long of the last is held; null: off. */
  waitMs: number | null;
}
