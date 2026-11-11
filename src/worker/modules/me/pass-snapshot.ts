import type { MyPassRow } from './repo.ts';

/** An owner may receive only the exact incarnation captured before asynchronous reads. */
export function sameSnapshot(row: MyPassRow, current: MyPassRow | undefined | null): boolean {
  return (
    !!current &&
    current.org_id === row.org_id &&
    current.identity_id === row.identity_id &&
    current.template_id === row.template_id &&
    current.template_version === row.template_version &&
    current.release_id === row.release_id &&
    current.mode === row.mode &&
    current.holder_email === row.holder_email &&
    current.credential_generation === row.credential_generation &&
    current.lifecycle_generation === row.lifecycle_generation &&
    current.link_generation === row.link_generation &&
    current.download_token === row.download_token &&
    current.version === row.version &&
    current.revision === row.revision &&
    current.status === row.status &&
    current.removed_at === row.removed_at &&
    current.deleted_at === row.deleted_at &&
    current.org_status === row.org_status &&
    current.pass_json === row.pass_json
  );
}
