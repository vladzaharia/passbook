import type { MemberPhotoRow } from '../passes/repo-member-photo.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

export function livePhotoDeliveryPredicate(
  guard: OutputPredicate,
  photo: MemberPhotoRow,
): OutputPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE (${guard.sql})
          AND EXISTS (SELECT 1 FROM member_photos photo WHERE photo.pass_id=p.id AND photo.org_id=p.org_id
            AND photo.version=? AND photo.r2_key=?/* scan-ephemeral-photo-key */ AND photo.sha1=?
            AND photo.size=? AND photo.crc32=? AND photo.include_in_pass=?))`,
    params: [
      ...guard.params,
      photo.version,
      photo.r2_key,
      photo.sha1,
      photo.size,
      photo.crc32,
      photo.include_in_pass,
    ],
  };
}
