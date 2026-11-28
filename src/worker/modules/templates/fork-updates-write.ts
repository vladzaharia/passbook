import type { Mode } from '../../../shared/contracts/common.ts';
import { templateMergeGrant } from '../../jobs/template-merge.ts';
import type { Grant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists, notExists } from '../../platform/authority-cond.ts';
import type { SetValue } from '../../platform/authority-expr.ts';
import { writePart } from '../../platform/authority-include.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { RACE_TEMPLATE_CANDIDATE_INSERT, RACE_TEMPLATE_VERSION_INSERT } from '../scan/race-tags.ts';
import type { ResolvedBase } from './fork-base.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
  candidateHash,
} from './release-content.ts';
import { snapshot } from './releases-candidate.ts';
import { type NewVersion, versionStatementSql } from './repo.ts';
import {
  FORK_STALE,
  type ForkState,
  forkUnchanged,
  upstreamActive,
} from './repo-fork-update-checks.ts';
import { type ForkBase, writeLineage } from './repo-forks.ts';
import { CANDIDATE_COLUMNS, candidateValues } from './repo-release-columns.ts';
import type { CandidateRow } from './repo-releases.ts';
import { type VersionHashes, versionHashesSql } from './repo-version-hashes.ts';

/** The author of every candidate a merge writes: the grant's own principal label. */
export const MERGE_AUTHOR = 'system:template-merge';
/** Failed offers are retried this many times, each at least `RETRY_AFTER_MS` after the last. */
export const MAX_ATTEMPTS = 5;
export const RETRY_AFTER_MS = 10 * 60_000;

/** An offer as the job read it. */
export interface UpdateKey {
  id: string;
  orgId: string;
  templateId: string;
  upstreamId: string;
  upstreamVersion: string;
  oursVersion: string;
}

/** A refused fence, or an org that is no longer active (the grant's own check): the job read a world that moved. */
export const isStale = (error: unknown) =>
  (error instanceof ConflictError && error.code === FORK_STALE) || error instanceof ForbiddenError;

/** A refusal is a moved fork or org; anything else is not ours to swallow. */
async function commit(g: Grant): Promise<'ok' | 'stale'> {
  try {
    await g.commit();
    return 'ok';
  } catch (error) {
    if (isStale(error)) return 'stale';
    throw error;
  }
}

/** Fork, its upstream and the offer are where the job read them. */
export function fences(u: UpdateKey, state: ForkState): Check[] {
  return [
    rowIs('templates', u.templateId, { status: 'active' }),
    exactlyOne('template_forks', {
      template_id: u.templateId,
      upstream_id: u.upstreamId,
      tracking: 'on',
    }),
    upstreamActive(u.upstreamId, u.upstreamVersion),
    forkUnchanged(u.templateId, state),
  ];
}

function auditFor(g: Grant, ctx: ServiceContext, u: UpdateKey, action: string, detail: object) {
  grantedAudit(
    g,
    ctx,
    {
      orgId: u.orgId,
      actorType: 'system',
      action,
      targetType: 'template',
      targetId: u.templateId,
      detail: { updateId: u.id, upstreamVersion: u.upstreamVersion, ...detail },
    },
    [exists('template_fork_updates', { id: u.id })],
  );
}

/** Moves the pending offer to its result. Refused unless it is still pending. */
function settle(
  g: Grant,
  ctx: ServiceContext,
  u: UpdateKey,
  set: Record<string, SetValue>,
  detail: object,
) {
  g.update('template_fork_updates', {
    set: { ...set, updated_at: ctx.clock.now() },
    where: { id: u.id, status: 'pending' },
    require: 'one',
    returning: ['id'],
  });
  auditFor(g, ctx, u, 'template.fork_update', { status: set.status, ...detail });
}

function baseRow(base: ResolvedBase, parentVersion: string | null): ForkBase {
  return {
    upstreamVersion: base.upstreamVersion,
    contentHash: base.contentHash,
    via: 'backfill',
    parentVersion,
    inferred: true,
  };
}

function bases(g: Grant, ctx: ServiceContext, u: UpdateKey, version: string, list: ForkBase[]) {
  if (list.length === 0) return;
  writeLineage(g, {
    templateId: u.templateId,
    version,
    lineage: { upstreamId: u.upstreamId, create: false, bases: list },
    now: ctx.clock.now(),
  });
}

export type Outcome =
  | { status: 'conflicted' | 'invalid'; conflicts: unknown[]; summary: object }
  | { status: 'noop'; summary: object };

/**
 * Records a result that makes no version: conflicted, invalid or no change. An inferred base is
 * written with it. A no-change result also records that ours incorporates the upstream version.
 */
export async function settleOffer(
  ctx: ServiceContext,
  u: UpdateKey,
  state: ForkState,
  outcome: Outcome,
  inferred: ResolvedBase | null,
): Promise<'ok' | 'stale'> {
  const g = templateMergeGrant(ctx, u.orgId, { checks: fences(u, state), target: u.id });
  const list: ForkBase[] = [];
  if (inferred) list.push(baseRow(inferred, null));
  if (outcome.status === 'noop' && inferred?.upstreamVersion !== u.upstreamVersion)
    list.push({
      upstreamVersion: u.upstreamVersion,
      contentHash: null,
      via: 'noop',
      parentVersion: null,
    });
  bases(g, ctx, u, u.oursVersion, list);
  const set: Record<string, SetValue> = {
    status: outcome.status,
    summary: JSON.stringify(outcome.summary),
    ...(outcome.status === 'noop'
      ? { merged_version: u.oursVersion }
      : { conflicts: JSON.stringify(outcome.conflicts) }),
  };
  settle(g, ctx, u, set, {
    mergedVersion: outcome.status === 'noop' ? u.oursVersion : null,
    conflicts: outcome.status === 'noop' ? 0 : outcome.conflicts.length,
  });
  return commit(g);
}

/** The offer's upstream or fork moved on: it is failed for good, and the planner opens a new one. */
export async function failOffer(
  ctx: ServiceContext,
  u: UpdateKey,
  code: string,
): Promise<'ok' | 'stale'> {
  const g = templateMergeGrant(ctx, u.orgId, { checks: [], target: u.id });
  settle(g, ctx, u, { status: 'failed', summary: JSON.stringify({ code }) }, { code });
  return commit(g);
}

export interface CleanMerge {
  version: NewVersion;
  hashes: VersionHashes;
  modes: Mode[];
  summary: object;
  inferred: ResolvedBase | null;
}

/** The Apple candidates of a merge version, one per mode the fork has a release in. */
async function candidates(
  ctx: ServiceContext,
  u: UpdateKey,
  m: CleanMerge,
): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];
  for (const mode of m.modes) {
    const row: CandidateRow = {
      id: ctx.ids.id(),
      templateId: u.templateId,
      orgId: u.orgId,
      mode,
      provider: 'apple',
      version: m.version.version,
      contentHash: m.hashes.contentHash,
      candidateHash: '',
      adapterRevision: APPLE_ADAPTER_REVISION,
      adapterCapabilities: [...APPLE_ADAPTER_CAPABILITIES],
      audiencePolicyRevision: AUDIENCE_POLICY_REVISION,
      authorId: MERGE_AUTHOR,
      versionAuthorId: m.version.createdBy,
      createdAt: ctx.clock.now(),
    };
    row.candidateHash = await candidateHash(snapshot(row));
    out.push(row);
  }
  return out;
}

/**
 * The merged version, its base, its candidates and the offer's result, in one batch fenced on the
 * fork being where the job read it. The version id is a content hash and every insert is guarded, so
 * a retry writes nothing twice.
 */
export async function commitMerge(
  ctx: ServiceContext,
  u: UpdateKey,
  state: ForkState,
  m: CleanMerge,
): Promise<'ok' | 'stale'> {
  const g = templateMergeGrant(ctx, u.orgId, { checks: fences(u, state), target: u.id });
  const now = ctx.clock.now();
  const [insert] = versionStatementSql(m.version);
  g.include(writePart(`${insert.sql} AND {grant}`, insert.params, RACE_TEMPLATE_VERSION_INSERT));
  const h = versionHashesSql(u.templateId, m.version.version, m.hashes, now);
  g.include(writePart(`${h.sql} AND {grant}`, h.params));
  bases(g, ctx, u, m.version.version, [
    {
      upstreamVersion: u.upstreamVersion,
      contentHash: null,
      via: 'merge',
      parentVersion: u.oursVersion,
    },
  ]);
  if (m.inferred) bases(g, ctx, u, u.oursVersion, [baseRow(m.inferred, null)]);
  for (const c of await candidates(ctx, u, m)) {
    const absent = notExists('template_candidates', {
      template_id: u.templateId,
      version: c.version,
      mode: c.mode,
      author_id: MERGE_AUTHOR,
    });
    g.insertSelect('template_candidates', CANDIDATE_COLUMNS, candidateValues(c), {
      when: [absent],
      tag: RACE_TEMPLATE_CANDIDATE_INSERT,
    });
  }
  settle(
    g,
    ctx,
    u,
    {
      status: 'clean',
      merged_version: m.version.version,
      summary: JSON.stringify(m.summary),
    },
    { mergedVersion: m.version.version, conflicts: 0, modes: m.modes },
  );
  return commit(g);
}
