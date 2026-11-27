/** Codes for invariant breaks and internal races. Callers see INTERNAL with a requestId, and the API catalog omits them. */
const INTERNAL_CODE =
  /^(?:GRANT_[A-Z_]+|WALLET_OP_[A-Z_]+|SQL_SIZE_BUDGET|SQL_ACTOR_REUSE|SCAN_EPOCHS_MISSING|STALE_CONTEXT)$/;

export const isInternalCode = (code: string): boolean => INTERNAL_CODE.test(code);
