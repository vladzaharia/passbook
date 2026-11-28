import { guestUntil } from '../../../passkit/template/access/index.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Candidate } from '../scan/repo-lookup.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { resolveCandidateReadTemplates } from '../scan/template-read-snapshot.ts';

/** When the visit of a pass on a guest plan ends (ms); null on any other plan or template. */
export async function guestEnd(
  ctx: ServiceContext,
  orgId: string,
  candidate: Candidate,
): Promise<number | null> {
  const manifest = resolveCandidateReadTemplates(candidate)?.active.manifest;
  const access = manifest?.scan?.access;
  if (!manifest || !access) return null;
  const inputs = applyDefaults(manifest, candidate.pass.personalization);
  const plan = access.plans.find((p) => p.id === inputs[access.input.plan]);
  if (plan?.kind !== 'guest') return null;
  const zone = (await readOrgTimeZone(ctx.env.DB, orgId)) ?? DEFAULT_TIME_ZONE;
  return guestUntil(access, plan, inputs, candidate.pass.createdAt, zone);
}
