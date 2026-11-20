/** A call left open this long stops holding exits: a forgotten call must not keep people inside for good. */
export const HOLD_HORIZON_MS = 12 * 60 * 60 * 1000;
