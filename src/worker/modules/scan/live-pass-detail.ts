import { parseIsoDate } from '../../../passkit/schema/util.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { usedRelease } from './effective-release.ts';
import { sourceActor } from './event-safe-projection-policy.ts';
import type { LiveRingRow } from './live-ring.ts';
import { photoPolicyForResolved, scannerCandidateAllowed } from './member-photo.ts';
import { scanIdentity } from './projection-privacy.ts';
import type { Candidate } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';

const ROLES: readonly ScanRole[] = ['door', 'desk', 'manager'];

/**
 * The pass facts a live row discloses, taken from the candidate the scan evaluated: the holder name
 * (as the source screen showed it), the roles that would read the same name, the roles a photo is
 * shown to, and the generations and release a render re-checks. Null when the pass cannot be
 * evaluated for the source (the row is then published as a redacted row).
 */
export async function passDetail(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
  keyset: string,
): Promise<
  | (Pick<
      LiveRingRow,
      'templateId' | 'gen' | 'release' | 'validUntil' | 'holderRoles' | 'photoRoles'
    > & { holder: string | null; actions: readonly ResolvedScanAction[] })
  | null
> {
  const { pass } = candidate;
  const release = usedRelease(candidate.templateSnapshot?.raw);
  const found = release === false ? null : await foundOf(ctx, candidate);
  const now = ctx.clock.now();
  if (
    !found ||
    release === false ||
    candidate.credentialKeysetCommitment !== keyset ||
    pass.orgId !== actor.orgId ||
    pass.mode !== actor.mode ||
    !scannerCandidateAllowed(actor, candidate, found.passJson, now)
  )
    return null;
  const title = scanIdentity(found, actor).title;
  const holderRoles = title
    ? ROLES.filter((r) => scanIdentity(found, sourceActor(actor, r)).title === title)
    : [];
  const photoRoles = ROLES.filter((r) =>
    photoPolicyForResolved(
      sourceActor(actor, r),
      candidate,
      found.template,
      found.activePolicy,
      now,
    ),
  );
  return {
    templateId: pass.templateId,
    gen: {
      credential: pass.credentialGeneration,
      lifecycle: pass.lifecycleGeneration,
      image: pass.imageGeneration,
    },
    release: release === null ? null : release[0],
    validUntil: parseIsoDate(found.passJson.expirationDate) ?? null,
    holder: title ? title.slice(0, 40) : null,
    holderRoles,
    photoRoles,
    actions: found.scan.actions,
  };
}
