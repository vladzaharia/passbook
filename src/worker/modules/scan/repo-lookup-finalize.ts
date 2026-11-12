import type { Candidate } from './repo-lookup.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

export function deniedLookupPredicate(): OutputPredicate {
  return { sql: '0', params: [] };
}

export function lookupPhotoSnapshotPredicate(source: Candidate): OutputPredicate {
  const originalPhoto = source.assetPhoto;
  return originalPhoto
    ? {
        sql: `p.image_generation=? AND EXISTS (SELECT 1 FROM member_photos m
        WHERE m.org_id=p.org_id AND m.pass_id=p.id AND m.version IS ?
          AND m.r2_key IS ?/* scan-ephemeral-asset-photo-key */ AND m.sha1 IS ? AND m.include_in_pass IS ?)`,
        params: [
          source.pass.imageGeneration,
          originalPhoto.version,
          originalPhoto.key,
          originalPhoto.sha1,
          originalPhoto.includeInPass,
        ],
      }
    : deniedLookupPredicate();
}

export function andLookupPredicates(
  left: OutputPredicate,
  right: OutputPredicate,
): OutputPredicate {
  return { sql: `(${left.sql}) AND (${right.sql})`, params: [...left.params, ...right.params] };
}
