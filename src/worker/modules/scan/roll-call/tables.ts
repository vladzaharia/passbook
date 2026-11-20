/** The roll call's own tables: a grant that writes a mark with an exit or its undo names them. */
export const ROLL_TABLES = ['roll_calls', 'roll_call_marks'];

/** Extra statements a caller adds to the exit's or the undo's own grant, so they commit together. */
export type WithGrant = (
  g: import('../../../platform/authority.ts').Grant,
  scanId: string,
  won: import('../../../platform/authority-cond.ts').GrantCond,
) => void;
