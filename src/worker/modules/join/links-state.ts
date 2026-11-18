import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  JoinLinkDto,
  JoinLinkState,
  JoinReadinessIssue,
} from '../../../shared/contracts/join.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { getCreateTemplate } from '../passes/repo-read-issuance.ts';
import { assertNotBlueprint } from '../templates/blueprint-guard.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { defaultNameInput, type JoinReadiness, joinReadiness } from './readiness.ts';
import { getLink, issuedToday, type JoinLinkRow } from './repo-links.ts';
import { type PlatformOffer, platformOffer } from './repo-template-offer.ts';

const notFound = () => new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');

/** Reads for the admin routes: the scope a call is about, and the link's state with its readiness. */

export interface Scope {
  orgId: string;
  mode: Mode;
  templateId: string;
  archived: boolean;
  /** An org template is false; a platform one is offered to every org (`open`) or only to orgs that released it. */
  platform: PlatformOffer;
  capabilities: ReadonlySet<OrgCapability>;
}

/**
 * The org, mode and template an admin call is about. An org template names its org; a platform
 * template needs `orgId`. Another org's template, and an org the caller cannot read, are both not found.
 */
export async function scopeOf(
  ctx: ServiceContext,
  auth: SessionAuth,
  templateId: string,
  orgIdQuery: string | undefined,
): Promise<Scope> {
  const db = ctx.env.DB;
  const template = await getCreateTemplate(db, templateId);
  if (!template || template.status === 'deleted') throw notFound();
  const orgId = orgIdQuery ?? template.orgId;
  if (orgId === null)
    throw new ValidationError('Choose an organization.', [
      { path: 'orgId', message: 'Choose an organization.' },
    ]);
  if (template.orgId !== null && template.orgId !== orgId) throw notFound();
  const access = await getOrgAccess(ctx, auth.userId, orgId);
  if (!access?.capabilities.includes('passes:read')) throw notFound();
  // The grant repeats this in SQL (the same offer, so an un-offer racing a create is refused too).
  const offer = template.orgId === null ? await platformOffer(db, templateId, orgId) : false;
  if (offer === null) throw notFound();
  await assertNotBlueprint(db, templateId);
  return {
    orgId,
    mode: auth.mode,
    templateId,
    archived: template.status === 'archived',
    platform: offer,
    capabilities: new Set(access.capabilities),
  };
}

export interface Inspection {
  release: TemplateRelease | null;
  readiness: JoinReadiness | null;
  issues: JoinReadinessIssue[];
}

/** The active release's manifest, read against the link's name choice: what the form would ask and whether it may open. */
export async function inspect(
  ctx: ServiceContext,
  s: Pick<Scope, 'orgId' | 'mode' | 'templateId' | 'archived'>,
  nameInput: string | null,
): Promise<Inspection> {
  // An archived template issues nothing, whatever it released.
  if (s.archived) return { release: null, readiness: null, issues: [{ code: 'archived' }] };
  const release = await activeRelease(ctx, s.templateId, s.orgId, s.mode, 'apple');
  const issues: JoinReadinessIssue[] = [];
  let readiness: JoinReadiness | null = null;
  if (!release) issues.push({ code: 'no_release' });
  else {
    const template = await resolveTemplate(ctx, s.orgId, s.templateId, release.version).catch(
      (error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      },
    );
    if (!template) issues.push({ code: 'no_release' });
    else readiness = joinReadiness(template.manifest, nameInput);
  }
  if (readiness) issues.push(...readiness.issues);
  return { release, readiness, issues };
}

async function linkOf(
  ctx: ServiceContext,
  row: JoinLinkRow,
  canOperate: boolean,
): Promise<string | null> {
  if (!canOperate) return null;
  try {
    return `${baseUrl(ctx.env)}/j/${await revealToken(ctx.env, 'join', row.id, row.orgId, row.token)}`;
  } catch (error) {
    // A copy that cannot be shown is logged by the reveal: the admin makes a new link.
    if (error instanceof AppError && error.code.startsWith('TOKEN_SEAL_')) return null;
    throw error;
  }
}

export async function stateOf(ctx: ServiceContext, s: Scope): Promise<JoinLinkState> {
  const row = await getLink(ctx.env.DB, s.orgId, s.mode, s.templateId);
  const seen = await inspect(ctx, s, row?.nameInput ?? null);
  const ready = seen.issues.length === 0;
  if (!row) return { link: null, ready, issues: seen.issues };
  const issued = await issuedToday(ctx.env.DB, row, ctx.clock.now());
  const link: JoinLinkDto = {
    id: row.id,
    templateId: row.templateId,
    mode: row.mode,
    enabled: row.enabled,
    nameInput: seen.readiness?.nameInput ?? null,
    nameInputs: seen.readiness?.nameInputs ?? [],
    askEmail: row.askEmail,
    generated: seen.readiness?.generated ?? [],
    dailyLimit: row.dailyLimit,
    issuedToday: issued,
    limitReached: issued >= row.dailyLimit,
    url: await linkOf(ctx, row, s.capabilities.has('passes:operate')),
    ready,
    issues: seen.issues,
    revision: row.revision,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
  return { link, ready, issues: seen.issues };
}

export async function getJoinLinkState(
  ctx: ServiceContext,
  auth: SessionAuth,
  templateId: string,
  orgId: string | undefined,
): Promise<JoinLinkState> {
  return stateOf(ctx, await scopeOf(ctx, auth, templateId, orgId));
}

/** The Holder-group (else first) eligible input of the active release. */
export async function nameDefault(
  ctx: ServiceContext,
  s: Scope,
  seen: Inspection,
): Promise<string | null> {
  if (!seen.release) return null;
  const template = await resolveTemplate(ctx, s.orgId, s.templateId, seen.release.version);
  return defaultNameInput(template.manifest);
}
