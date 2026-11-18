import type { Mode } from '../../../shared/contracts/common.ts';
import {
  JOIN_LIMIT_DEFAULT,
  JOIN_TEST_LIMIT_MAX,
  type JoinLinkState,
  type JoinLinkUpdate,
} from '../../../shared/contracts/join.ts';
import { JOIN_COPY } from '../../../shared/copy/join.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { Grant } from '../../platform/authority.ts';
import { issueToken } from '../../platform/capability-token.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import {
  type Inspection,
  inspect,
  nameDefault,
  type Scope,
  scopeOf,
  stateOf,
} from './links-state.ts';
import type { JoinReadiness } from './readiness.ts';
import {
  createLinkGrant,
  getLink,
  type JoinLinkRow,
  type LinkChange,
  rotateLinkGrant,
  type SessionAuthority,
  updateLinkGrant,
} from './repo-links.ts';

export { getJoinLinkState } from './links-state.ts';

const askAdmin = (code = 'FORBIDDEN') => new ForbiddenError(JOIN_COPY.card.askAdmin, code);
const changed = () => new ConflictError(JOIN_COPY.errors.JOIN_LINK_CHANGED, 'JOIN_LINK_CHANGED');
const notReady = () =>
  new ConflictError('This template is not ready for a join link.', 'JOIN_NOT_READY');

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
