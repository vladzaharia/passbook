import type { Grant } from '../../platform/authority.ts';
import { notExists } from '../../platform/authority-cond.ts';
import { first } from '../../platform/db.ts';

/** An upstream version a fork version incorporates. */
export interface ForkBase {
  upstreamVersion: string;
  contentHash: string | null;
  via: 'fork' | 'edit';
  parentVersion: string | null;
}

/** What a version commit records about the fork it belongs to. `create` writes the fork row too. */
export interface ForkLineage {
  upstreamId: string;
  create: boolean;
  bases: ForkBase[];
}

/** Fork row and base rows of a version, after the version insert in the same grant batch. */
export function writeLineage(
  writer: Grant,
  o: {
    templateId: string;
    version: string;
    orgId: string | null;
    platform: boolean;
    lineage: ForkLineage;
    now: number;
  },
): void {
  const { lineage } = o;
  if (lineage.create)
    writer.insertSelect(
      'template_forks',
      [...(o.platform ? ['org_id'] : []), 'template_id', 'upstream_id', 'created_at', 'updated_at'],
      [...(o.platform ? [o.orgId] : []), o.templateId, lineage.upstreamId, o.now, o.now],
    );
  for (const base of lineage.bases)
    writer.insertJoined('template_version_bases', {
      parents: { template_id: o.templateId },
      columns: [
        'version',
        'upstream_id',
        'upstream_version',
        'upstream_content_hash',
        'via',
        'parent_version',
        'created_at',
      ],
      values: [
        o.version,
        lineage.upstreamId,
        base.upstreamVersion,
        base.contentHash,
        base.via,
        base.parentVersion,
        o.now,
      ],
      when: [
        notExists('template_version_bases', {
          template_id: o.templateId,
          version: o.version,
          upstream_version: base.upstreamVersion,
        }),
      ],
    });
}

export async function getFork(
  db: D1Database,
  templateId: string,
): Promise<{ upstreamId: string; tracking: 'on' | 'paused' } | null> {
  return first<{ upstreamId: string; tracking: 'on' | 'paused' }>(
    db,
    'SELECT upstream_id AS upstreamId, tracking FROM template_forks WHERE template_id = ?',
    [templateId],
  );
}

/** The newest upstream version a fork version incorporates: ordered by the upstream version's age. */
export async function effectiveBase(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<{ upstreamVersion: string; contentHash: string | null } | null> {
  return first<{ upstreamVersion: string; contentHash: string | null }>(
    db,
    `SELECT b.upstream_version AS upstreamVersion, b.upstream_content_hash AS contentHash
     FROM template_version_bases b
     JOIN template_versions u ON u.template_id = b.upstream_id AND u.version = b.upstream_version
     WHERE b.template_id = ? AND b.version = ?
     ORDER BY u.created_at DESC, u.version DESC LIMIT 1`,
    [templateId, version],
  );
}
