// The one kind of caller statement that may run in a grant's batch: a retention receipt. Only
// `modules/retention/receipt-service.ts` mints one (tools/check-sizes.ts enforces the import boundary), so a
// caller cannot pre-seed what the grant's checks read.
import { AuthorityError } from './authority-error.ts';

declare const brand: unique symbol;
export type ReceiptStatement = D1PreparedStatement & { readonly [brand]: true };

const minted = new WeakSet<object>();

export function receiptStatement(stmt: D1PreparedStatement): ReceiptStatement {
  minted.add(stmt);
  return stmt as ReceiptStatement;
}

export const isReceiptStatement = (s: object): boolean => minted.has(s);

/** Only a retention receipt may run first in a grant batch. */
export function assertReceipt(receipt: object): void {
  if (!isReceiptStatement(receipt))
    throw new AuthorityError(
      'GRANT_FOREIGN_STATEMENT',
      'Only a retention receipt may run first in a grant batch.',
    );
}
