/**
 * F8 pass disclosure (authority-epochs.md): a pass may be shown or served only while it is live,
 * its credential and lifecycle generations are the ones the read saw, and no transfer is pending.
 * Content-only changes (version, revision, personalization, release content) are not authority.
 * `alias` is a trusted alias of a `passes` row; the generations are SQL expressions (`?` or a
 * column), so a read binds two values (credential first, then lifecycle, then link) and a batched read binds none per row. `link` adds the link
 * generation where a link is disclosed.
 */
export function passVisibleSql(
  alias: string,
  gen: { credential: string; lifecycle: string; link?: string },
): string {
  return `(${alias}.deleted_at IS NULL AND ${alias}.removed_at IS NULL AND ${alias}.status = 'active'
    AND ${alias}.test_data_quarantined = 0
    AND ${alias}.credential_generation = ${gen.credential}
    AND ${alias}.lifecycle_generation = ${gen.lifecycle}
    ${gen.link ? `AND ${alias}.link_generation = ${gen.link}` : ''}
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pv_t
      WHERE pv_t.pass_id = ${alias}.id AND pv_t.state = 'pending'))`;
}
