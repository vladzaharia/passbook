import type { Mode } from '../../../shared/contracts/common.ts';
import { type Grant, type GrantedStatement, grant } from '../../platform/authority.ts';
import { type Check, rowIs, unlimitedActor } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import {
  consumeSun,
  enrolSun,
  type SunSeen,
  sunActiveCheck,
  sunFreshCheck,
  sunKeysetCheck,
} from './repo-sun.ts';
import type { TagSystemId } from './systems/types.ts';

type Session = Extract<TenantPassWrite, { kind: 'session' }>;
type Key = Extract<TenantPassWrite, { kind: 'api_key' }>;

/** A console tag edit: the captured session holds passes:operate. */
export type SessionTagAuthority = Session & { capability: 'passes:operate' };
/** A tag edit a key may also make: a session as above, or a key holding `nfc:write`. */
export type TagAuthority = SessionTagAuthority | (Key & { scope: 'nfc:write' });

/** Who a tag row names as the actor: the user, or `k:<keyId>` for a key (as offboard does). */
export const tagActorOf = (a: TagAuthority): { type: 'user'; id: string } => ({
  type: 'user',
  id: a.kind === 'session' ? a.userId : `k:${a.keyId}`,
});

/** The key of a tag edit made by a key. */
export const tagKeyIdOf = (a: TagAuthority): string | null =>
  a.kind === 'api_key' ? a.keyId : null;

/** The audit actor of a tag edit: the user, or the key by its own id. */
export const tagAuditActorOf = (
  a: TagAuthority,
): { actorType: 'user' | 'api_key'; actorId: string } =>
  a.kind === 'session'
    ? { actorType: 'user', actorId: a.userId }
    : { actorType: 'api_key', actorId: a.keyId };

const DAY_MS = 86_400_000;
const TAG_TABLES = ['nfc_tags', 'tag_bindings', 'nfc_tag_sun'] as const;
/** What an enrollment grant writes: its own row, and the binding it creates. */
export const ENROLL_TABLES = [
  'tag_enrollments',
  'nfc_tags',
  'tag_bindings',
  'nfc_tag_sun',
] as const;
const TAG_CODES = { lineage: 'TAG_HOLDER_CHANGED', stale: 'TAG_HOLDER_CHANGED' } as const;

export type TagPurpose =
  `org_mode.nfc.tag.${'bind' | 'unbind' | 'retire' | 'restore' | 'lost' | 'update' | 'rebind' | 'enroll_request' | 'enroll_cancel'}`;

export function tagGrant(
  ctx: ServiceContext,
  purpose: TagPurpose,
  authority: TagAuthority,
  checks: Check[] = [],
  tables: readonly string[] = TAG_TABLES,
): Grant {
  return grant(ctx, {
    purpose,
    principal: tenantPrincipal(authority),
    checks: [...capabilityChecks(authority), ...checks],
    codes: TAG_CODES,
    tables: [...tables],
  });
}

export interface TagActor {
  type: 'user' | 'staff' | 'scanner';
  id: string;
}

/** The causes an admin or a staff member ends a binding with. */
export type EndCause =
  | 'admin'
  | 'staff'
  | 'undo'
  | 'lost'
  | 'replaced'
  | 'moved'
  | 'tag_retired'
  | 'offboard'
  | 'expired';

/** Ends one active binding. The batch is refused if it already ended. */
export function endBinding(
  g: Grant,
  binding: { id: string },
  cause: EndCause,
  actor: { type: TagActor['type'] | 'system'; id: string },
  now: number,
): GrantedStatement {
  // Through the pass: a key limited to templates reaches a binding only by the pass it opens.
  return g.joined('tag_bindings', {
    via: 'pass_id',
    where: { id: binding.id, ended_at: null },
    set: { ended_at: now, ended_by_type: actor.type, ended_by: actor.id, end_cause: cause },
    require: 'one',
    returning: ['id'],
  });
}

export interface BindPlan {
  tagId: string;
  /** Set when the tag has not been seen: its row is created in the same batch. */
  newTag: {
    ref: string;
    hint: string;
    label: string | null;
    system: TagSystemId;
    /** The tag's type; null is Standard. */
    typeId?: string | null;
  } | null;
  /** A SUN read: a new tag's side row starts at its counter, a known tag's moves up to it (or the batch is refused). */
  sun?: SunSeen | null;
  bindingId: string;
  passId: string;
  scope: 'pass' | 'user';
  userId: string | null;
  /** The active binding this one replaces or takes over. */
  end: { id: string; cause: 'replaced' | 'moved' | 'expired' } | null;
  /** Other bindings of this holder that lapsed: they end in this batch, so they hold up no limit. */
  endLapsed?: readonly string[];
  /** The pass's credential generation and owner read with the plan: pinned at commit, kept on the binding. */
  holderGeneration: number;
  holderOwner: string | null;
  /** The tag is reported lost: this bind (a move or a restore) clears that. */
  clearsLost: boolean;
  /** The binding ends by itself this many days after it is made (the type's `binding_days`). */
  expiryDays?: number | null;
  /** A loaner's guest end (ms): the binding ends then if that is before the type's expiry. */
  endsAt?: number | null;
  /** The lost report this bind clears, kept on the binding so a scanner Undo can restore it. */
  cleared?: { at: number; by: string } | null;
  /** A scanner bind's idempotency key and request hash: a retry replays the result. */
  idempotency?: { key: string; hash: string } | null;
  /** The key that makes this bind, for the audit row: set by a key's route, never read from the actor id. */
  keyId?: string | null;
  /** The caller writes its own audit row (restore). */
  audited?: boolean;
  source: 'scanner' | 'remote' | 'admin';
  actor: TagActor;
  scannerId: string | null;
  orgId: string;
  mode: Mode;
}

/**
 * The pass is live in the tenant, still has the holder the plan read, and a user binding's owner still owns
 * it; and the org's plan still includes NFC (Basic). Ending a binding never needs the plan.
 */
export const bindChecks = (
  p: Pick<BindPlan, 'passId' | 'holderGeneration' | 'holderOwner'> &
    Partial<Pick<BindPlan, 'tagId' | 'newTag' | 'sun' | 'scope'>>,
): Check[] => [
  // A user-scope tag opens the owner's passes of every template: a key limited to templates never makes one.
  ...(p.scope === 'user' ? [unlimitedActor] : []),
  rowIs('passes', p.passId, {
    deleted_at: null,
    credential_generation: p.holderGeneration,
    owner_user_id: p.holderOwner,
  }),
  entitled('nfc', 'basic'),
  ...(p.sun
    ? p.tagId && !p.newTag
      ? sunFreshCheck(p.tagId, p.sun)
      : [sunKeysetCheck(p.sun), sunActiveCheck(p.sun)]
    : []),
];

const bindingExpiry = (now: number, p: Pick<BindPlan, 'expiryDays' | 'endsAt'>): number | null => {
  const byType = p.expiryDays ? now + p.expiryDays * DAY_MS : null;
  return p.endsAt == null ? byType : byType === null ? p.endsAt : Math.min(byType, p.endsAt);
};

/**
 * Adds a bind to a grant: the tag row if new, the end of the binding it takes over, the new binding and
 * its audit row. The insert returns its id, so a lost race on the tag row reads as no row.
 */
export function addBind(g: Grant, ctx: ServiceContext, p: BindPlan): GrantedStatement {
  const now = ctx.clock.now();
  if (p.newTag)
    g.upsert(
      'nfc_tags',
      ['id', 'tag_ref', 'system', 'type_id', 'hint', 'label', 'created_at'],
      [
        p.tagId,
        p.newTag.ref,
        p.newTag.system,
        p.newTag.typeId ?? null,
        p.newTag.hint,
        p.newTag.label,
        now,
      ],
      { doNothing: true },
    );
  if (p.sun && p.newTag) enrolSun(g, p.tagId, p.sun, now);
  else if (p.sun) consumeSun(g, p.tagId, p.sun, now);
  if (p.clearsLost)
    g.update('nfc_tags', { set: { lost_at: null, lost_by: null }, where: { id: p.tagId } });
  for (const id of p.endLapsed ?? [])
    if (id !== p.end?.id)
      g.joined('tag_bindings', {
        via: 'pass_id',
        where: { id, ended_at: null },
        set: { ended_at: now, ended_by_type: 'system', ended_by: 'expiry', end_cause: 'expired' },
      });
  if (p.end)
    endBinding(
      g,
      p.end,
      p.end.cause,
      p.end.cause === 'expired' ? { type: 'system', id: 'expiry' } : p.actor,
      now,
    );
  const insert = g.insertJoined('tag_bindings', {
    parents: { tag_id: p.tagId, pass_id: p.passId },
    columns: [
      'id',
      'scope',
      'user_id',
      'source',
      'bound_at',
      'bound_by_type',
      'bound_by',
      'scanner_id',
      'holder_generation',
      'holder_owner',
      'idempotency_key',
      'request_hash',
      'cleared_lost_at',
      'cleared_lost_by',
      'expires_at',
    ],
    values: [
      p.bindingId,
      p.scope,
      p.userId,
      p.source,
      now,
      p.actor.type,
      p.actor.id,
      p.scannerId,
      p.holderGeneration,
      p.holderOwner,
      p.idempotency?.key ?? null,
      p.idempotency?.hash ?? null,
      p.cleared?.at ?? null,
      p.cleared?.by ?? null,
      bindingExpiry(now, p),
    ],
    returning: ['id'],
  });
  const keyActor = p.keyId ?? null;
  if (!p.audited)
    grantedAudit(
      g,
      ctx,
      {
        orgId: p.orgId,
        // A staff member is not a user row: the scanner is the actor and the staff id rides in the detail.
        // A key's tag actor is `k:<keyId>`: the audit row names the key itself.
        actorType: p.actor.type === 'staff' ? 'scanner' : keyActor ? 'api_key' : p.actor.type,
        actorId: p.actor.type === 'staff' ? (p.scannerId ?? p.actor.id) : (keyActor ?? p.actor.id),
        action: p.end?.cause === 'moved' ? 'tag.move' : 'tag.bind',
        targetType: 'tag',
        targetId: p.tagId,
        detail: {
          scope: p.scope,
          source: p.source,
          passId: p.passId,
          ...(p.end ? { replaced: p.end.cause } : {}),
          ...(p.scannerId ? { scannerId: p.scannerId } : {}),
          ...(p.actor.type === 'staff' ? { staffId: p.actor.id } : {}),
        },
      },
      [exists('tag_bindings', { id: p.bindingId })],
    );
  return insert;
}
