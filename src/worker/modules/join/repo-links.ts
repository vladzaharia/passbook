import type { Mode } from '../../../shared/contracts/common.ts';
import { type Grant, grant } from '../../platform/authority.ts';
import { releaseHead } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { SealRow } from '../../platform/capability-token.ts';
import { sealPart } from '../../platform/capability-token.ts';
import { first } from '../../platform/db.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import {
  capabilityChecks,
  membershipCapability,
  tenantPrincipal,
} from '../passes/repo-authority.ts';
import { type PlatformOffer, TEMPLATE_OWNER } from './template-offer.ts';

const DAY = 24 * 60 * 60 * 1000;

export type SessionAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

export interface JoinLinkRow {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  token: string;
  generation: number;
  enabled: boolean;
  nameInput: string | null;
  askEmail: boolean;
  dailyLimit: number;
  revision: number;
  createdAt: number;
  rotatedAt: number | null;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  template_id: string;
  token: string;
  generation: number;
  enabled: number;
  name_input: string | null;
  ask_email: number;
  daily_limit: number;
  revision: number;
  created_at: number;
  rotated_at: number | null;
}

const toRow = (r: Raw): JoinLinkRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  templateId: r.template_id,
  token: r.token,
  generation: r.generation,
  enabled: r.enabled === 1,
  nameInput: r.name_input,
  askEmail: r.ask_email === 1,
  dailyLimit: r.daily_limit,
  revision: r.revision,
  createdAt: r.created_at,
  rotatedAt: r.rotated_at,
});

const SELECT = `SELECT id, org_id, mode, template_id, token, generation, enabled, name_input, ask_email,
  daily_limit, revision, created_at, rotated_at FROM join_links`;

/** The one link of (org, mode, template). */
export async function getLink(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<JoinLinkRow | null> {
  const row = await first<Raw>(db, `${SELECT} WHERE org_id = ? AND mode = ? AND template_id = ?`, [
    orgId,
    mode,
    templateId,
  ]);
  return row ? toRow(row) : null;
}

/** Cards the link made in the last rolling 24 hours (the count the grant caps against). */
export async function issuedToday(
  db: D1Database,
  link: Pick<JoinLinkRow, 'id' | 'orgId' | 'mode'>,
  now: number,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM join_issues WHERE link_id = ? AND org_id = ? AND mode = ? AND created_at > ?`,
    [link.id, link.orgId, link.mode, now - DAY],
  );
  return row?.n ?? 0;
}

/** A lost lineage or a taken (org, mode, template) is a link someone else changed. */
const CODES: DenialOptions['codes'] = {
  lineage: 'JOIN_LINK_CHANGED',
  release: 'JOIN_LINK_CHANGED',
};

interface WriteInput {
  authority: SessionAuthority;
  action: 'create' | 'enable' | 'disable' | 'update' | 'rotate';
  linkId: string;
  templateId: string;
  mode: Mode;
  /** Turning on or changing what the link asks needs `templates:publish` beside `passes:operate`. */
  publish: boolean;
  /** The template is the platform's (no org of its own); else it is the link's org's. */
  platform: PlatformOffer;
  /** The release head the link opens on (turning on or creating enabled). */
  releaseId?: string;
  detail: Record<string, unknown>;
}

/** The membership's own roles hold the capabilities; the template is the org's or offered to it. */
function manageGrant(ctx: ServiceContext, o: WriteInput): Grant {
  const g = grant(ctx, {
    purpose: 'org_mode.join_link.manage',
    principal: tenantPrincipal(o.authority),
    target: o.linkId,
    codes: CODES,
    tables: ['join_links', 'join_link_seals'],
    checks: [
      ...capabilityChecks(o.authority),
      ...(o.publish ? [membershipCapability(o.authority.membershipId, 'templates:publish')] : []),
      // A platform template is offered by the service's visibility read; an org template is the link's.
      tenantCheck(
        'lineage',
        `EXISTS (SELECT 1 FROM templates t WHERE t.id = ? AND t.blueprint = 0
          AND t.status ${o.releaseId ? "= 'active'" : "!= 'deleted'"}
          AND ${TEMPLATE_OWNER[String(o.platform) as 'false' | 'open' | 'worked']})`,
        [o.templateId],
      ),
      ...(o.releaseId ? [releaseHead(o.templateId, o.mode, 'apple', o.releaseId)] : []),
    ],
  });
  return g;
}

function audit(g: Grant, ctx: ServiceContext, o: WriteInput): void {
  g.add(
    grantedAudit(g, ctx, {
      orgId: o.authority.orgId,
      actorType: 'user',
      actorId: o.authority.userId,
      action: `join_link.${o.action}`,
      targetType: 'join_link',
      targetId: o.linkId,
      detail: { templateId: o.templateId, ...o.detail },
    }),
  );
}

export interface NewLink {
  id: string;
  templateId: string;
  /** The token column value: the lookup MAC. */
  mac: string;
  seal: SealRow;
  enabled: boolean;
  nameInput: string | null;
  askEmail: boolean;
  dailyLimit: number;
}

/** The link, its sealed token and its audit row in one batch. */
export function createLinkGrant(
  ctx: ServiceContext,
  authority: SessionAuthority,
  mode: Mode,
  l: NewLink,
  releaseId: string | undefined,
  platform: PlatformOffer,
): Grant {
  const o: WriteInput = {
    authority,
    action: 'create',
    linkId: l.id,
    templateId: l.templateId,
    mode,
    publish: true,
    platform,
    ...(l.enabled && releaseId ? { releaseId } : {}),
    detail: { enabled: l.enabled, askEmail: l.askEmail, dailyLimit: l.dailyLimit },
  };
  const g = manageGrant(ctx, o);
  const now = ctx.clock.now();
  g.insertSelect(
    'join_links',
    [
      'id',
      'template_id',
      'token',
      'enabled',
      'name_input',
      'ask_email',
      'daily_limit',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
    ],
    [
      l.id,
      l.templateId,
      l.mac,
      l.enabled ? 1 : 0,
      l.nameInput,
      l.askEmail ? 1 : 0,
      l.dailyLimit,
      now,
      now,
      authority.userId,
      authority.userId,
    ],
  );
  g.include(sealPart('join', l.id, l.mac, l.seal));
  audit(g, ctx, o);
  return g;
}

export interface LinkChange {
  enabled?: boolean;
  nameInput?: string | null;
  askEmail?: boolean;
  dailyLimit?: number;
}

/** A compare-and-set on the revision the caller read. */
export function updateLinkGrant(
  ctx: ServiceContext,
  authority: SessionAuthority,
  link: JoinLinkRow,
  change: LinkChange,
  publish: boolean,
  releaseId: string | undefined,
  platform: PlatformOffer,
): Grant {
  const turnedOn = change.enabled === true && !link.enabled;
  const turnedOff = change.enabled === false && link.enabled;
  const o: WriteInput = {
    authority,
    action: turnedOn ? 'enable' : turnedOff ? 'disable' : 'update',
    linkId: link.id,
    templateId: link.templateId,
    mode: link.mode,
    publish,
    platform,
    ...(turnedOn && releaseId ? { releaseId } : {}),
    detail: { ...change },
  };
  const g = manageGrant(ctx, o);
  audit(g, ctx, o);
  const set: Record<string, string | number | null> = {
    updated_at: ctx.clock.now(),
    updated_by: authority.userId,
  };
  if (change.enabled !== undefined) set.enabled = change.enabled ? 1 : 0;
  if (change.nameInput !== undefined) set.name_input = change.nameInput;
  if (change.askEmail !== undefined) set.ask_email = change.askEmail ? 1 : 0;
  if (change.dailyLimit !== undefined) set.daily_limit = change.dailyLimit;
  g.update('join_links', {
    set,
    inc: ['revision'],
    where: { id: link.id, revision: link.revision },
    require: 'one',
  });
  return g;
}

/** A new token and sealed copy for the same link; the trigger raises the generation. */
export function rotateLinkGrant(
  ctx: ServiceContext,
  authority: SessionAuthority,
  link: JoinLinkRow,
  token: { mac: string; seal: SealRow },
  platform: PlatformOffer,
): Grant {
  const o: WriteInput = {
    authority,
    action: 'rotate',
    linkId: link.id,
    templateId: link.templateId,
    mode: link.mode,
    publish: true,
    platform,
    detail: {},
  };
  const g = manageGrant(ctx, o);
  audit(g, ctx, o);
  const now = ctx.clock.now();
  g.update('join_links', {
    set: { token: token.mac, rotated_at: now, updated_at: now, updated_by: authority.userId },
    inc: ['revision'],
    where: { id: link.id },
    require: 'one',
  });
  g.include(sealPart('join', link.id, token.mac, token.seal));
  return g;
}
