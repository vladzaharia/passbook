import type { Grant } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';

/**
 * The part's pass-id comparison: `pass_id = {pass}` for a holder grant, otherwise the pass as one of the
 * grant's tenant (org and mode), which is the tie the part lint requires of a pass-bearing row.
 */
export function passIs(g: Grant, passId: string, column = 'pass_id') {
  return g.principal.kind === 'holder'
    ? { sql: `${column} = {pass}`, params: [] as string[] }
    : {
        sql: `${column} IN (SELECT p.id FROM passes p WHERE p.id = ? AND p.org_id = {org} AND p.mode = {mode})`,
        params: [passId],
      };
}

/** The connector payload rows, tied to the transfer of the pass (the form a holder grant requires). */
export function payloadPart(
  g: Grant,
  passId: string,
  op: 'delete' | 'insert',
  transferId: string,
  env?: { kekVersion: number; iv: unknown; wrappedDek: unknown; ciphertext: unknown },
) {
  const at = passIs(g, passId, 'pt.pass_id');
  if (op === 'delete')
    return writePart(
      `DELETE FROM pass_credential_transfer_payloads WHERE EXISTS (SELECT 1 FROM pass_credential_transfers pt
        WHERE pt.id = pass_credential_transfer_payloads.transfer_id AND pt.id = ? AND ${at.sql}) AND {grant}`,
      [transferId, ...at.params],
    );
  return writePart(
    `INSERT INTO pass_credential_transfer_payloads (transfer_id,kek_version,iv,wrapped_dek,ciphertext)
      SELECT pt.id, ?, ?, ?, ? FROM pass_credential_transfers pt
      WHERE pt.id = ? AND ${at.sql} AND {grant}`,
    [
      env?.kekVersion as never,
      env?.iv as never,
      env?.wrappedDek as never,
      env?.ciphertext as never,
      transferId,
      ...at.params,
    ],
  );
}
