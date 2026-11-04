import type { ValidationReport } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';

/** Undeleted passes of one mode per template version. */
export async function countPassesByVersion(
  db: D1Database,
  templateId: string,
  mode: Mode = 'live',
): Promise<Map<string, number>> {
  const rows = await all<{ template_version: string; n: number }>(
    db,
    `SELECT template_version, COUNT(*) AS n FROM passes
     WHERE template_id = ? AND deleted_at IS NULL AND mode = ? GROUP BY template_version`,
    [templateId, mode],
  );
  return new Map(rows.map((r) => [r.template_version, r.n]));
}

export interface RecentImport {
  uploadId: string;
  name: string | null;
  status: 'queued' | 'running' | 'complete' | 'errored' | 'terminated';
  templateId: string | null;
  version: string | null;
  error: string | null;
  issues: number;
  createdAt: number;
}

/** Newest imports first; `orgId` limits to that org's uploads plus platform uploads. */
export async function listRecentImports(
  db: D1Database,
  filter: { orgId?: string; limit: number },
): Promise<RecentImport[]> {
  const rows = await all<{
    upload_id: string;
    name: string | null;
    template_name: string | null;
    template_id: string | null;
    version: string | null;
    report: string | null;
    error: string | null;
    created_at: number;
    wf_status: RecentImport['status'] | null;
  }>(
    db,
    `SELECT i.upload_id, i.name, t.name AS template_name, i.template_id, i.version, i.report,
            i.error, i.created_at, w.status AS wf_status
     FROM template_imports i
     LEFT JOIN workflow_runs w ON w.instance_id = i.upload_id
     LEFT JOIN templates t ON t.id = i.template_id
     WHERE (? IS NULL OR i.org_id = ? OR i.org_id IS NULL)
     ORDER BY i.created_at DESC, i.upload_id DESC LIMIT ?`,
    [filter.orgId ?? null, filter.orgId ?? null, filter.limit],
  );
  return rows.map((r) => {
    const report = r.report ? (JSON.parse(r.report) as ValidationReport) : null;
    return {
      uploadId: r.upload_id,
      name: r.name ?? r.template_name,
      status: r.wf_status ?? (r.error ? 'errored' : 'queued'),
      templateId: r.template_id,
      version: r.version,
      error: r.error,
      issues: report?.issues.length ?? 0,
      createdAt: r.created_at,
    };
  });
}
