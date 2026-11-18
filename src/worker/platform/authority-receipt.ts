// The one kind of caller statement that may run in a grant's batch: a retention receipt. Only
// `modules/retention/receipt-service.ts` mints one (tools/check-sizes.ts enforces the import boundary), so a
// caller cannot pre-seed what the grant's checks read.
declare const brand: unique symbol;
export type ReceiptStatement = D1PreparedStatement & { readonly [brand]: true };

const minted = new WeakSet<object>();

export function receiptStatement(stmt: D1PreparedStatement): ReceiptStatement {
  minted.add(stmt);
  return stmt as ReceiptStatement;
}

export const isReceiptStatement = (s: object): boolean => minted.has(s);
