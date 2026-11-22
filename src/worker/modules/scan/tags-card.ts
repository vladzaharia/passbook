import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { knownPhotoUrl, photoGrantUrl } from './member-photo.ts';
import type { Candidate } from './repo-lookup.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

/**
 * What a tag opens when the desk does not choose: a person's other passes belong with a staff badge
 * (a site's staff and visitors come and go through one door), a member's tag opens that one pass.
 */
export function opensDefault(candidate: Candidate): 'pass' | 'user' {
  const uses = resolveCandidateReadTemplates(candidate)?.active.manifest.scan?.tags?.uses;
  return uses?.includes('staff') ? 'user' : 'pass';
}

/** The holder's photo for the confirm card, under the same policy as a lookup row; null when not shown. */
export async function tagCardPhoto(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
): Promise<string | null> {
  const prepared = await knownPhotoUrl(ctx, actor, candidate);
  return prepared ? photoGrantUrl(actor, candidate.pass.id, prepared.grant) : null;
}
