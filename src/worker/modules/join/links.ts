import type { Mode } from '../../../shared/contracts/common.ts';
import {
  JOIN_LIMIT_DEFAULT,
  JOIN_TEST_LIMIT_MAX,
  type JoinLinkDto,
  type JoinLinkState,
  type JoinLinkUpdate,
  type JoinReadinessIssue,
} from '../../../shared/contracts/join.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { JOIN_COPY } from '../../../shared/copy/join.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { Grant } from '../../platform/authority.ts';
import { issueToken, revealToken } from '../../platform/capability-token.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getCreateTemplate } from '../passes/repo-read-issuance.ts';
import { assertNotBlueprint } from '../templates/blueprint-guard.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { templateVisibleToOrg } from '../templates/repo-list.ts';
import { defaultNameInput, type JoinReadiness, joinReadiness } from './readiness.ts';
import {
  createLinkGrant,
  getLink,
  issuedToday,
  type JoinLinkRow,
  type LinkChange,
  rotateLinkGrant,
  type SessionAuthority,
  updateLinkGrant,
} from './repo-links.ts';

const notFound = () => new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
const askAdmin = (code = 'FORBIDDEN') => new ForbiddenError(JOIN_COPY.card.askAdmin, code);
const changed = () => new ConflictError(JOIN_COPY.errors.JOIN_LINK_CHANGED, 'JOIN_LINK_CHANGED');
const notReady = () =>
  new ConflictError('This template is not ready for a join link.', 'JOIN_NOT_READY');

interface Scope {
  orgId: string;
  mode: Mode;
  templateId: string;
  archived: boolean;
  /** The template belongs to the platform, not to the org. */
  platform: boolean;
  capabilities: ReadonlySet<OrgCapability>;
}

/**
 * The org, mode and template an admin call is about. An org template names its org; a platform
 * template needs `orgId`. Another org's template, and an org the caller cannot read, are both not found.
 */
async function scopeOf(
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
  if (template.orgId === null && !(await templateVisibleToOrg(db, templateId, orgId)))
    throw notFound();
  await assertNotBlueprint(db, templateId);
  return {
    orgId,
    mode: auth.mode,
    templateId,
    archived: template.status === 'archived',
    platform: template.orgId === null,
    capabilities: new Set(access.capabilities),
  };
}

interface Inspection {
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

async function stateOf(ctx: ServiceContext, s: Scope): Promise<JoinLinkState> {
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

/** A unique clash is a link made meanwhile; the rest is the grant's own mapping. */
async function commit(g: Grant): Promise<void> {
  try {
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique') throw changed();
    throw error;
  }
}

async function operateAuthority(
  ctx: ServiceContext,
  auth: SessionAuth,
  s: Scope,
): Promise<SessionAuthority> {
  if (!s.capabilities.has('passes:operate')) throw askAdmin();
  const authority = await tenantAuthorityOf(
    ctx,
    { ...auth, mode: s.mode },
    s.orgId,
    'passes:operate',
  );
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

function checkLimit(mode: Mode, dailyLimit: number): void {
  if (mode === 'test' && dailyLimit > JOIN_TEST_LIMIT_MAX)
    throw new ValidationError(`A test link holds at most ${JOIN_TEST_LIMIT_MAX} cards a day.`, [
      { path: 'dailyLimit', message: `At most ${JOIN_TEST_LIMIT_MAX}.` },
    ]);
}

function checkNameInput(readiness: JoinReadiness | null, nameInput: string | null): void {
  if (nameInput === null || readiness?.nameInputs.some((i) => i.key === nameInput)) return;
  throw new ValidationError('Choose another input for the name.', [
    { path: 'nameInput', message: 'Choose another input.' },
  ]);
}

async function createLink(
  ctx: ServiceContext,
  auth: SessionAuth,
  s: Scope,
  input: JoinLinkUpdate,
): Promise<void> {
  if (!s.capabilities.has('templates:publish')) throw askAdmin();
  const authority = await operateAuthority(ctx, auth, s);
  if (await getLink(ctx.env.DB, s.orgId, s.mode, s.templateId)) throw changed();
  const seen = await inspect(ctx, s, input.nameInput ?? null);
  const nameInput =
    input.nameInput === undefined ? await nameDefault(ctx, s, seen) : input.nameInput;
  checkNameInput(seen.readiness, nameInput);
  const dailyLimit =
    input.dailyLimit ?? (s.mode === 'test' ? JOIN_TEST_LIMIT_MAX : JOIN_LIMIT_DEFAULT);
  checkLimit(s.mode, dailyLimit);
  const enabled = input.enabled === true;
  if (enabled && seen.issues.length > 0) throw notReady();
  const id = ctx.ids.id();
  const issued = await issueToken(ctx.env, 'join', id, s.orgId, ctx.ids.token(16));
  await commit(
    createLinkGrant(
      ctx,
      authority,
      s.mode,
      {
        id,
        templateId: s.templateId,
        mac: issued.mac,
        seal: issued.seal,
        enabled,
        nameInput,
        askEmail: input.askEmail === true,
        dailyLimit,
      },
      seen.release?.id,
      s.platform,
    ),
  );
}

/** The Holder-group (else first) eligible input of the active release. */
async function nameDefault(
  ctx: ServiceContext,
  s: Scope,
  seen: Inspection,
): Promise<string | null> {
  if (!seen.release) return null;
  const template = await resolveTemplate(ctx, s.orgId, s.templateId, seen.release.version);
  return defaultNameInput(template.manifest);
}

async function updateLink(
  ctx: ServiceContext,
  auth: SessionAuth,
  s: Scope,
  link: JoinLinkRow,
  input: JoinLinkUpdate,
): Promise<void> {
  if (input.revision !== link.revision) throw changed();
  const authority = await operateAuthority(ctx, auth, s);
  const seen = await inspect(
    ctx,
    s,
    input.nameInput === undefined ? link.nameInput : input.nameInput,
  );
  const change: LinkChange = {};
  if (input.enabled !== undefined && input.enabled !== link.enabled) change.enabled = input.enabled;
  if (input.askEmail !== undefined && input.askEmail !== link.askEmail)
    change.askEmail = input.askEmail;
  if (input.nameInput !== undefined && input.nameInput !== link.nameInput) {
    checkNameInput(seen.readiness, input.nameInput);
    change.nameInput = input.nameInput;
  }
  if (input.dailyLimit !== undefined && input.dailyLimit !== link.dailyLimit) {
    checkLimit(link.mode, input.dailyLimit);
    change.dailyLimit = input.dailyLimit;
  }
  const turnsOn = change.enabled === true;
  if (turnsOn && seen.issues.length > 0) throw notReady();
  // Turning on settles the name the form will ask for, if the link has none yet.
  if (turnsOn && link.nameInput === null && change.nameInput === undefined) {
    const name = await nameDefault(ctx, s, seen);
    if (name !== null) change.nameInput = name;
  }
  if (Object.keys(change).length === 0) return;
  const publish =
    turnsOn ||
    change.nameInput !== undefined ||
    change.askEmail !== undefined ||
    (change.dailyLimit !== undefined && change.dailyLimit > link.dailyLimit);
  if (publish && !s.capabilities.has('templates:publish')) throw askAdmin();
  await commit(
    updateLinkGrant(
      ctx,
      authority,
      link,
      change,
      publish,
      turnsOn ? seen.release?.id : undefined,
      s.platform,
    ),
  );
}

/** Create (revision 0) or change a link. Without a change nothing is written. */
export async function saveJoinLink(
  ctx: ServiceContext,
  auth: SessionAuth,
  templateId: string,
  orgId: string | undefined,
  input: JoinLinkUpdate,
): Promise<JoinLinkState> {
  const s = await scopeOf(ctx, auth, templateId, orgId);
  const link = await getLink(ctx.env.DB, s.orgId, s.mode, s.templateId);
  if (input.revision === 0) await createLink(ctx, auth, s, input);
  else if (!link) throw changed();
  else await updateLink(ctx, auth, s, link, input);
  return stateOf(ctx, s);
}

/** A new token for the same link: the old one stops working at once. */
export async function rotateJoinLink(
  ctx: ServiceContext,
  auth: SessionAuth,
  templateId: string,
  orgId: string | undefined,
): Promise<JoinLinkState> {
  const s = await scopeOf(ctx, auth, templateId, orgId);
  if (!s.capabilities.has('templates:publish')) throw askAdmin();
  const authority = await operateAuthority(ctx, auth, s);
  const link = await getLink(ctx.env.DB, s.orgId, s.mode, s.templateId);
  if (!link) throw new NotFoundError('Join link not found.', 'JOIN_LINK_NOT_FOUND');
  const issued = await issueToken(ctx.env, 'join', link.id, s.orgId, ctx.ids.token(16));
  await commit(rotateLinkGrant(ctx, authority, link, issued, s.platform));
  return stateOf(ctx, s);
}
