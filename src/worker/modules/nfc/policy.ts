import type { TagType } from '../../../shared/contracts/nfc-tag-admin.ts';
import type { TagUse } from '../../../shared/contracts/nfc-tags.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { ConflictError, FeatureNotIncludedError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type Candidate, candidateById } from '../scan/repo-lookup.ts';
import { levelAllows } from '../scan/tag-assurance.ts';
import { resolveCandidateReadTemplates } from '../scan/template-read-snapshot.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { guestEnd } from './guest-end.ts';
import { lapsedOnHolder } from './repo-tag-bindings.ts';
import { activeTypesOfSystem, getTagType, passTypeCount } from './repo-tag-types.ts';
import type { TagRow } from './repo-tags.ts';
import { assuranceOfSystem } from './systems/registry.ts';
import type { TagSystemId } from './systems/types.ts';

/**
 * Third-party NFC tags work when the platform switch `nfc.tagsEnabled` and the org switch `nfc.tags`
 * are both on (both default on) and the org's plan includes NFC (`nfc` at least Basic). Apple NFC
 * (`nfc.enabled`) is a separate switch.
 */
export async function tagsEnabled(ctx: ServiceContext, orgId: string): Promise<boolean> {
  return (await tagsRefusal(ctx, orgId)) === null;
}

/** Why tags do not work for the org, as the error a write answers with; null when they do. */
export async function tagsRefusal(
  ctx: ServiceContext,
  orgId: string,
): Promise<FeatureNotIncludedError | ConflictError | null> {
  const [platform, org, entitlements] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, orgId),
    entitlementsOf(ctx, orgId),
  ]);
  if (!isEntitled(entitlements, 'nfc', 'basic'))
    return new FeatureNotIncludedError('nfc', featureNotIncluded('nfc'));
  return platform['nfc.tagsEnabled'] && org['nfc.tags'].enabled
    ? null
    : new ConflictError('Turn on tags in settings first.', 'TAGS_OFF');
}

export type Confirm = TagType['confirm'];
const CONFIRM_RANK: Record<Confirm, number> = { none: 0, staff: 1, manager: 2 };

/** A tag with no type is Standard: it counts as a `member` tag and asks nothing more. */
const STANDARD_USE: TagUse = 'member';

/** The strictest of two second factors. */
export const strongerConfirm = (a: Confirm, b: Confirm): Confirm =>
  CONFIRM_RANK[a] >= CONFIRM_RANK[b] ? a : b;

/** What a door reads of a tag's type, and keeps on the scan's authority. */
export interface TagTypeFacts {
  id: string;
  name: string;
  use: TagUse;
  confirm: Confirm;
  /** Empty: any template. */
  templateIds: readonly string[];
}

export const typeFacts = (t: TagType): TagTypeFacts => ({
  id: t.id,
  name: t.name,
  use: t.use,
  confirm: t.confirm,
  templateIds: t.templateIds,
});

/** A session's `tags.types`: absent takes every type; a list takes those named (`standard`: no type). */
export const sessionTakesType = (
  types: readonly string[] | undefined,
  type: Pick<TagTypeFacts, 'id'> | null,
): boolean => types === undefined || types.includes(type?.id ?? 'standard');

export type TypeFit = 'ok' | 'template' | 'use';

/** Whether a pass of this template (its release naming these uses) takes the type's tags. */
export function typeFit(
  type: TagTypeFacts | null,
  templateId: string,
  uses: readonly TagUse[] | undefined,
): TypeFit {
  if (type && type.templateIds.length > 0 && !type.templateIds.includes(templateId))
    return 'template';
  if (uses && !uses.includes(type?.use ?? STANDARD_USE)) return 'use';
  return 'ok';
}

/** `typeFit` for a candidate by its active release. A release that cannot be read fails closed. */
export function candidateTypeFit(c: Candidate, type: TagTypeFacts | null): TypeFit {
  const manifest = resolveCandidateReadTemplates(c)?.active.manifest;
  return manifest ? typeFit(type, c.pass.templateId, manifest.scan?.tags?.uses) : 'use';
}

/** The second factor a tag needs at this door: its type's, and a session's `confirmBasic` for a Basic tag. */
export const doorConfirm = (
  type: Pick<TagTypeFacts, 'confirm'> | null,
  system: TagSystemId,
  confirmBasic: Confirm | undefined,
): Confirm =>
  strongerConfirm(
    type?.confirm ?? 'none',
    assuranceOfSystem(system) === 'basic' ? (confirmBasic ?? 'none') : 'none',
  );

/** A session at a level that takes no tag of this system refuses to bind one: it would never open this door. */
export function assertSessionLevel(
  level: 'off' | 'basic' | 'secure' | undefined,
  system: TagSystemId,
): void {
  if (levelAllows(level, assuranceOfSystem(system))) return;
  throw level === 'off'
    ? new ConflictError('Tags are off at this site.', 'TAGS_OFF')
    : new ConflictError('This site takes secure tags only.', 'TAG_SECURE_REQUIRED');
}

export interface BindPolicyInput {
  orgId: string;
  passId: string;
  candidate?: Candidate | null | undefined;
  scope: 'pass' | 'user';
  system: TagSystemId;
  /** The tag as stored; null for one not seen before. */
  tag: TagRow | null;
  /** The type asked for. A tag that exists keeps its own. */
  typeId?: string | undefined;
  /** The binding this one ends (a replace or a move), which does not count against the limit. */
  ending: string | null;
  /** An admin typed the ID instead of tapping the tag. */
  typed?: boolean;
}

export interface BindPolicy {
  /** The tag's type; null is Standard. */
  type: TagType | null;
  /** The binding ends this many days after it is made. */
  expiryDays: number | null;
  /** Bindings of this holder that already lapsed: the bind ends them with its own. */
  lapsed: string[];
  /** A loaner on a guest-plan pass ends when the visit does (ms); null: no such end. */
  endsAt: number | null;
}

/** The type a bind uses: the tag's own, the one asked for, or the one that fits best. */
async function bindType(
  ctx: ServiceContext,
  i: BindPolicyInput,
  templateId: string,
  uses: readonly TagUse[] | undefined,
): Promise<TagType | null> {
  const db = ctx.env.DB;
  if (i.tag) {
    if (i.typeId && i.typeId !== i.tag.typeId)
      throw new ConflictError(
        'This tag already has a type. An admin can change it.',
        'TAG_TYPE_SET',
      );
    if (!i.tag.typeId) return null;
    const own = await getTagType(db, i.orgId, i.tag.typeId);
    if (!own) throw new NotFoundError('Tag type not found.', 'TAG_TYPE_NOT_FOUND');
    return own;
  }
  if (i.typeId) {
    const asked = await getTagType(db, i.orgId, i.typeId);
    if (!asked) throw new NotFoundError('Tag type not found.', 'TAG_TYPE_NOT_FOUND');
    if (asked.archivedAt !== null)
      throw new ConflictError('This tag type is archived.', 'TAG_TYPE_ARCHIVED');
    if (asked.system !== i.system)
      throw new ConflictError(
        'This tag type is for another kind of tag. Choose another type.',
        'TAG_TYPE_SYSTEM',
      );
    return asked;
  }
  // Types of the system that fit the pass and can take this very bind: its scope, a typed ID, room on the pass.
  const fits: TagType[] = [];
  for (const t of await activeTypesOfSystem(db, i.orgId, i.system)) {
    if (typeFit(typeFacts(t), templateId, uses) !== 'ok') continue;
    if (t.scopes !== 'both' && t.scopes !== i.scope) continue;
    if (i.typed && !t.typed) continue;
    if (
      i.scope === 'pass' &&
      (await passTypeCount(db, i.passId, t.id, i.ending, ctx.clock.now())) >= t.perPass
    )
      continue;
    fits.push(t);
  }
  if (fits.length === 1) return fits[0] ?? null;
  if (fits.length === 0) return null;
  const preferred = (await getOrgSettings(ctx, i.orgId))['nfc.tags'].defaultType;
  const chosen = fits.find((t) => t.id === preferred);
  if (!chosen) throw new ConflictError('Pick a tag type.', 'TAG_TYPE_CHOOSE');
  return chosen;
}

/**
 * The rules a tag's type puts on a new binding (design 2.1, 2.3): the type fits the pass's template and use, the
 * assignment is one the type takes, the pass has room for another tag of it, and typing the ID is allowed. A
 * new tag gets the type asked for, else the only active type of its system that fits the pass, else the org's
 * default if that fits, else Standard. The binding triggers enforce the same limits at commit.
 */
export async function bindPolicy(ctx: ServiceContext, i: BindPolicyInput): Promise<BindPolicy> {
  const candidate = i.candidate ?? (await candidateById(ctx.env.DB, i.orgId, i.passId));
  const manifest = candidate && resolveCandidateReadTemplates(candidate)?.active.manifest;
  if (!candidate || !manifest) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const uses = manifest.scan?.tags?.uses;
  const type = await bindType(ctx, i, candidate.pass.templateId, uses);
  const now = ctx.clock.now();
  const lapsed = await lapsedOnHolder(
    ctx.env.DB,
    { passId: i.passId, userId: candidate.pass.ownerUserId },
    now,
  );
  const fit = typeFit(type ? typeFacts(type) : null, candidate.pass.templateId, uses);
  if (fit === 'template')
    throw new ConflictError("This tag type can't go on this pass.", 'TAG_TYPE_MISMATCH');
  if (fit === 'use')
    throw new ConflictError(
      `This pass doesn't take ${type?.use ?? STANDARD_USE} tags.`,
      'TAG_USE_MISMATCH',
    );
  if (!type) return { type, expiryDays: null, lapsed, endsAt: null };
  if (type.scopes !== 'both' && type.scopes !== i.scope)
    throw new ConflictError(
      "This tag type can't be assigned that way. Choose another type.",
      'TAG_TYPE_SCOPE',
    );
  if (type.use === 'visitor' && i.scope !== 'pass')
    throw new ConflictError(
      "This tag type can't be assigned that way. Choose another type.",
      'TAG_TYPE_SCOPE',
    );
  if (i.typed && !type.typed)
    throw new ConflictError(
      'This tag type takes tapped tags only. Tap the tag on a scanner.',
      'TAG_TYPED_OFF',
    );
  if (
    i.scope === 'pass' &&
    (await passTypeCount(ctx.env.DB, i.passId, type.id, i.ending, now)) >= type.perPass
  )
    throw new ConflictError(`This pass has its ${type.name} already.`, 'TAG_TYPE_LIMIT');
  const endsAt = type.use === 'visitor' ? await guestEnd(ctx, i.orgId, candidate) : null;
  if (endsAt !== null && endsAt <= now)
    throw new ConflictError("Can't assign a tag to a expired pass.", 'TAG_PASS_EXPIRED');
  return { type, expiryDays: type.bindingDays, lapsed, endsAt };
}
