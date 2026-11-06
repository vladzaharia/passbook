import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { assetBaseUrl, mintAssetGrant } from './assets.ts';
import type { ScanActor } from './guard.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { ROLE_RANK } from './rules.ts';

function allowed(actor: ScanActor, candidate: Candidate, template: ResolvedTemplate) {
  if (actor.settings.showPhoto === false) return false;
  if (candidate.pass.orgId !== actor.orgId || candidate.pass.mode !== actor.mode) return false;
  if (
    actor.scanner?.deviceRole === 'scan' &&
    !actor.settings.acceptAllTemplates &&
    !actor.templateIds.includes(candidate.pass.templateId)
  )
    return false;
  const minRole = template.manifest.scan?.display?.photo?.minRole ?? 'door';
  return ROLE_RANK[actor.role ?? 'door'] >= ROLE_RANK[minRole];
}

export async function canShowMemberPhoto(ctx: ServiceContext, actor: ScanActor, passId: string) {
  const candidate = await candidateById(ctx.env.DB, actor.orgId, passId);
  if (!candidate) return false;
  const template = await resolveTemplate(
    ctx,
    actor.orgId,
    candidate.pass.templateId,
    candidate.pass.templateVersion,
  );
  return allowed(actor, candidate, template);
}

export async function scanPhotoUrl(ctx: ServiceContext, actor: ScanActor, passId: string) {
  if (actor.settings.showPhoto === false || !(await memberPhoto(ctx.env.DB, actor.orgId, passId)))
    return null;
  if (!(await canShowMemberPhoto(ctx, actor, passId))) return null;
  return urlFor(ctx, actor, passId);
}

export async function knownPhotoUrl(
  ctx: ServiceContext,
  actor: ScanActor,
  candidate: Candidate,
  template: ResolvedTemplate,
) {
  return candidate.hasPhoto && allowed(actor, candidate, template)
    ? urlFor(ctx, actor, candidate.pass.id)
    : null;
}

async function urlFor(ctx: ServiceContext, actor: ScanActor, passId: string) {
  const params = new URLSearchParams({
    g: await mintAssetGrant(ctx.env, actor.actorKey, passId, ctx.clock.now()),
  });
  if (actor.principal === 'admin') {
    params.set('orgId', actor.orgId);
    params.set('timeZone', actor.timeZone);
    if (actor.scanner) params.set('setupId', actor.scanner.id);
  }
  return `${assetBaseUrl(passId)}member.png?${params}`;
}
