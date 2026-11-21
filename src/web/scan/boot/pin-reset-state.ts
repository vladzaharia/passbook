import type { ScanSession } from '../../../shared/contracts/scan-session.ts';

/**
 * New PINs the server has set and the person has not typed back yet. A session poll clears the
 * flag at once, so without this the PIN would vanish before it was read. Memory only, dropped on confirm.
 */
export const issuedPins = new Map<string, string>();

/** The signed-in person has a new PIN to take in: flagged, or issued and not yet confirmed. */
export const needsPinReset = (session: ScanSession): boolean =>
  Boolean(session.staff && (session.staff.pinResetRequired || issuedPins.has(session.staff.id)));
