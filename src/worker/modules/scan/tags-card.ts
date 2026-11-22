import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { knownPhotoUrl, photoGrantUrl } from './member-photo.ts';
import type { Candidate } from './repo-lookup.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

/**
 * What a tag opens when the desk does not choose: a person's other passes belong with a staff badge
 * (a site's staff and visitors come and go through one door), a member's tag opens that one pass.
 * `allowed` is whether this binder may bind a person at all: the scanner's assignAll rule met by
 * their role, and a tag type that takes person scope. Otherwise the default is the pass, so a Desk
 * is never sent into a Manager PIN or a refusal by the preselected choice.
 */
export function opensDefault(candidate: Candidate, allowed: boolean): 'pass' | 'user' {
  if (!allowed) return 'pass';
  const uses = resolveCandidateReadTemplates(candidate)?.active.manifest.scan?.tags?.uses;
  return uses?.includes('staff') ? 'user' : 'pass';
}

/**
 * The holder's photo for the confirm card, under the same policy and the same verified template
 * snapshot as a lookup row; null when not shown. A photo is a nicety: a failure never fails the assign.
 */
export async function tagCardPhoto(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
): Promise<string | null> {
  const templates = resolveCandidateReadTemplates(candidate);
  if (!templates) return null;
  try {
    const prepared = await knownPhotoUrl(ctx, actor, candidate, templates.pinned, templates.active);
    return prepared ? photoGrantUrl(actor, candidate.pass.id, prepared.grant) : null;
  } catch {
    ctx.log.error('scan.tag.photo_failed', { orgId: actor.orgId, code: 'SCAN_TAG_PHOTO_FAILED' });
    return null;
  }
}
