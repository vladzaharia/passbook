/**
 * F8 pass disclosure (authority-epochs.md): a pass may be shown or served only while it is live,
 * its credential and lifecycle generations are the ones the read saw, and no transfer is pending and its template is not deleted (an archived template keeps its passes working), and its connection, if any, is enabled.
 * Content-only changes (version, revision, personalization, release content) are not authority.
 * `anyStatus` drops the live-status term for a tap-out only (OC4): a voided pass is still disclosed to its own exit.
 * `alias` is a trusted alias of a `passes` row; the generations are SQL expressions (`?` or a
 * column), so a read binds two values (credential first, then lifecycle, then link) and a batched read binds none per row. `link` adds the link
 * generation where a link is disclosed.
 */
export function passVisibleSql(
  alias: string,
  gen: { credential: string; lifecycle: string; link?: string; anyStatus?: true },
): string {
  return `(${alias}.deleted_at IS NULL AND ${alias}.removed_at IS NULL
    ${gen.anyStatus ? '' : `AND ${alias}.status = 'active'`}
    AND ${alias}.test_data_quarantined = 0
    AND ${alias}.credential_generation = ${gen.credential}
    AND ${alias}.lifecycle_generation = ${gen.lifecycle}
    ${gen.link ? `AND ${alias}.link_generation = ${gen.link}` : ''}
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pv_t
      WHERE pv_t.pass_id = ${alias}.id AND pv_t.state = 'pending')
    AND EXISTS (SELECT 1 FROM templates pv_tp WHERE pv_tp.id = ${alias}.template_id
      AND pv_tp.status != 'deleted' AND (pv_tp.org_id IS NULL OR pv_tp.org_id = ${alias}.org_id))
    AND (${alias}.connection_id IS NULL OR EXISTS (SELECT 1 FROM connections pv_c
      WHERE pv_c.id = ${alias}.connection_id AND pv_c.org_id = ${alias}.org_id AND pv_c.enabled = 1)))`;
}
