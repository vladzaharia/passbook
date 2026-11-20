import type { Mode } from '../../../shared/contracts/common.ts';
import { eventRowOf } from '../events/record.ts';
import { insertEventStmt } from '../events/repo.ts';
import type { WalletProvider } from './instance-types.ts';

/**
 * A provider's own report that the holder saved or removed the pass, as one statement for the
 * batch that stores the receipt: it inserts only if that receipt exists (and `also` holds), so a
 * failure between receipt and event cannot lose it and a redelivery cannot repeat it. The row is
 * the events module's own; the receipt id is the event id. It never proves installation.
 */
export function walletHolderEventStmt(
  db: D1Database,
  input: {
    orgId: string;
    passId: string;
    mode: Mode;
    receiptTable: 'wallet_google_callback_receipts' | 'wallet_samsung_callback_receipts';
    receiptId: string;
    provider: WalletProvider;
    event: 'saved' | 'removed';
    at: number;
    also?: { sql: string; params: (string | number)[] };
  },
): D1PreparedStatement {
  const row = eventRowOf(
    {
      orgId: input.orgId,
      passId: input.passId,
      mode: input.mode,
      kind: input.event === 'saved' ? 'wallet.saved' : 'wallet.removed',
      actor: { type: 'system', id: null },
      data: { provider: input.provider },
      at: input.at,
    },
    input.receiptId,
    null,
  );
  return insertEventStmt(db, row, {
    sql: `EXISTS (SELECT 1 FROM ${input.receiptTable} WHERE id = ?)${input.also ? ` AND ${input.also.sql}` : ''}`,
    params: [input.receiptId, ...(input.also?.params ?? [])],
  });
}

/** Samsung's report, shown only while its ref still belongs to the pass's current holder. */
export function samsungHolderEventStmt(
  db: D1Database,
  pass: { orgId: string; passId: string; mode: Mode },
  referenceId: string,
  receiptId: string,
  event: 'saved' | 'removed',
  at: number,
): D1PreparedStatement {
  return walletHolderEventStmt(db, {
    ...pass,
    receiptTable: 'wallet_samsung_callback_receipts',
    receiptId,
    provider: 'samsung',
    event,
    at,
    also: {
      sql: 'EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs live WHERE live.id = ? AND live.retired_at IS NULL)',
      params: [referenceId],
    },
  });
}
