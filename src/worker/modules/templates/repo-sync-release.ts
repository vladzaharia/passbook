import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';

export interface BakedSystemRelease {
  id: string;
  templateId: string;
  orgId: string | null;
  mode: Mode;
  version: string;
  contentHash: string;
  candidateHash: string;
  adapterRevision: number;
  adapterCapabilities: readonly string[];
  audiencePolicyRevision: number;
  replaceExistingHead: boolean;
  allowLegacyBackfill: boolean;
  createdAt: number;
}

/** The newest release of a baked template's scope (the platform scope has no org). */
export interface BakedHead {
  id: string;
  generation: number;
  system: boolean;
  version: string;
  contentHash: string;
  adapterRevision: number;
  adapterCapabilities: string;
  audiencePolicyRevision: number;
}

export async function bakedHeadOf(
  db: D1Database,
  templateId: string,
  orgId: string | null,
  mode: Mode,
): Promise<BakedHead | null> {
  const row = await first<Omit<BakedHead, 'system'> & { source: string; action: string }>(
    db,
    `SELECT id, generation, source, action, version, content_hash AS contentHash,
       adapter_revision AS adapterRevision, adapter_capabilities AS adapterCapabilities,
       audience_policy_revision AS audiencePolicyRevision
     FROM template_releases
     WHERE template_id = ? AND org_id IS ? AND mode = ? AND provider = 'apple'
     ORDER BY generation DESC LIMIT 1`,
    [templateId, orgId, mode],
  );
  if (!row) return null;
  const { source, action, ...rest } = row;
  return { ...rest, system: source === 'system' && action === 'system' };
}

/**
 * Whether the sync appends a system release: the head is replaced (or absent), or backfilled when it is
 * this version's system release; and never when an identical system release is already the head.
 */
export function wantsBakedRelease(head: BakedHead | null, r: BakedSystemRelease): boolean {
  const capabilities = JSON.stringify(r.adapterCapabilities);
  const sameVersion = head?.system === true && head.version === r.version;
  const identical =
    sameVersion &&
    head?.contentHash === r.contentHash &&
    head.adapterRevision === r.adapterRevision &&
    head.audiencePolicyRevision === r.audiencePolicyRevision &&
    JSON.stringify(JSON.parse(head.adapterCapabilities)) === capabilities;
  if (identical) return false;
  return r.replaceExistingHead || head === null || (r.allowLegacyBackfill && sameVersion);
}

// A platform grant owns no tenant column, so the release names its org and mode itself.
const BAKED_COLUMNS = [
  'id',
  'template_id',
  'org_id',
  'mode',
  'provider',
  'generation',
  'version',
  'content_hash',
  'candidate_hash',
  'adapter_revision',
  'adapter_capabilities',
  'audience_policy_revision',
  'source',
  'action',
  'candidate_id',
  'approval_id',
  'previous_release_id',
  'rollback_of_release_id',
  'created_by',
  'created_at',
];

function bakedValues(
  r: BakedSystemRelease,
  generation: number,
  head: BakedHead | null,
): SqlValue[] {
  return [
    r.id,
    r.templateId,
    r.orgId,
    r.mode,
    'apple',
    generation,
    r.version,
    r.contentHash,
    r.candidateHash,
    r.adapterRevision,
    JSON.stringify(r.adapterCapabilities),
    r.audiencePolicyRevision,
    'system',
    'system',
    null,
    null,
    head?.id ?? null,
    null,
    null,
    r.createdAt,
  ];
}

/** Appends the release and its audit row to the sync's platform grant. The head check guards the race. */
export function addBakedRelease(
  g: Grant,
  ctx: ServiceContext,
  r: BakedSystemRelease,
  head: BakedHead | null,
): void {
  const generation = (head?.generation ?? 0) + 1;
  g.insertSelect('template_releases', BAKED_COLUMNS, bakedValues(r, generation, head), {
    returning: ['id'],
  });
  g.add(
    grantedAudit(
      g,
      ctx,
      {
        orgId: r.orgId,
        actorType: 'system',
        actorId: null,
        action: 'template.release',
        targetType: 'template',
        targetId: r.templateId,
        detail: { releaseId: r.id, generation, source: 'system', mode: r.mode, provider: 'apple' },
      },
      [exists('template_releases', { id: r.id })],
    ),
  );
}
