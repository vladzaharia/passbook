import { stmt } from '../../platform/db.ts';
import type { WalletProvider } from './instance-types.ts';

/**
 * A provider's own report that the holder saved or removed the pass, as one statement for the
 * batch that stores the receipt: it inserts only if that receipt exists (and `also` holds), so a
 * failure between receipt and event cannot lose it and a redelivery cannot repeat it. The ledger
 * shows it; it never proves installation. The receipt id is the event id.
 */
export function walletHolderEventStmt(
  db: D1Database,
  input: {
    receiptTable: 'wallet_google_callback_receipts' | 'wallet_samsung_callback_receipts';
    receiptId: string;
    instanceId: string;
    provider: WalletProvider;
    event: 'saved' | 'removed';
    at: number;
    also?: { sql: string; params: (string | number)[] };
  },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
     SELECT ?, i.org_id, i.pass_id, i.mode, ?, NULL, 'system', NULL, ?, ?
     FROM wallet_provider_instances i
     WHERE i.id = ? AND EXISTS (SELECT 1 FROM ${input.receiptTable} WHERE id = ?)
       ${input.also ? `AND ${input.also.sql}` : ''}`,
    [
      input.receiptId,
      input.event === 'saved' ? 'wallet.saved' : 'wallet.removed',
      JSON.stringify({ provider: input.provider }),
      input.at,
      input.instanceId,
      input.receiptId,
      ...(input.also?.params ?? []),
    ],
  );
}
