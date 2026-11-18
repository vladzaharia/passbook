import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ScanTag } from '../../../shared/contracts/nfc-tags.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { type Candidate, candidatesByScopes } from './repo-lookup.ts';
import { ownerPassIds } from './repo-tags-bind.ts';
import { accepts } from './resolve-candidates.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

type Assurance = ScanTag['assurance'];

const RANK: Record<Assurance, number> = { basic: 0, secure: 1 };
const MAX_SKIPPED = 8;

/** Only Basic (UID) tags exist today; Secure (SUN) tags come with their own read path. */
export const TAG_ASSURANCE: Assurance = 'basic';

/** The weakest tag a template accepts: `basic` unless it asks for more. */
const templateMinAssurance = (manifest: TemplateManifest): Assurance =>
  manifest.scan?.tags?.min ?? 'basic';

const meetsAssurance = (tag: Assurance, min: Assurance): boolean => RANK[tag] >= RANK[min];

/** Whether a tag may admit on, or bind to, the candidate by its active release. An unreadable snapshot fails closed. */
export function tagFit(
  ctx: ServiceContext,
  c: Candidate,
  tag: Assurance = TAG_ASSURANCE,
): 'ok' | 'low' | 'unreadable' {
  const templates = resolveCandidateReadTemplates(c);
  if (!templates) {
    ctx.log.warn('scan.tag_refused', { orgId: c.pass.orgId, code: 'TAG_TEMPLATE_UNREADABLE' });
    return 'unreadable';
  }
  return meetsAssurance(tag, templateMinAssurance(templates.active.manifest)) ? 'ok' : 'low';
}

export const candidateTakesTag = (ctx: ServiceContext, c: Candidate): boolean =>
  tagFit(ctx, c) === 'ok';

/** Titles of the owner's live passes this scanner takes and a Basic tag will not open, for the user-fob preview. */
export async function skippedTitles(
  ctx: ServiceContext,
  actor: ScanActor,
  orgId: string,
  mode: 'live' | 'test',
  ownerUserId: string,
): Promise<string[]> {
  const ids = await ownerPassIds(ctx.env.DB, orgId, mode, ownerUserId);
  const found = await candidatesByScopes(
    ctx.env.DB,
    ids.map((passId) => ({ orgId, mode, passId })),
  );
  return found
    .filter((c) => accepts(actor, c.pass) && tagFit(ctx, c) === 'low')
    .map(
      (c) =>
        c.pass.displayTitle ?? resolveCandidateReadTemplates(c)?.active.manifest.name ?? 'Pass',
    )
    .slice(0, MAX_SKIPPED);
}
