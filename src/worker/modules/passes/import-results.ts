import { BOM, toCsv } from '../../../shared/csv/write.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { baseUrl } from '../../platform/env.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { TenantPassWrite } from './http.ts';
import { problemsOf } from './import-read.ts';
import { passLinkRows, type ResultRow, resultRows } from './repo-import-results.ts';
import type { ImportRow } from './repo-imports.ts';

const PAGE = 500;
const HEADER = [
  'Row',
  'Result',
  'Pass ID',
  'External ID',
  'Email',
  'Link',
  'Download link',
  'Problem',
];

const resultOf = (r: ResultRow): string => {
  if (r.state === 'failed') return 'failed';
  if (r.state === 'skipped' || r.action === 'error') return 'skipped';
  return r.result ?? (r.action === 'unchanged' ? 'unchanged' : 'not run');
};

/**
 * One line per row of an import that has started: what happened, the pass and its links. The links are
 * built here, per request: they are capabilities, so they are never stored or logged. Rows whose pass is
 * removed have no link. Fields the retention cleared are blank.
 */
export async function resultsCsv(
  ctx: ServiceContext,
  imp: ImportRow,
  authority: TenantPassWrite,
): Promise<string> {
  if (imp.committed_at === null)
    throw new ConflictError('This import has not run yet.', 'IMPORT_STATE');
  const base = baseUrl(ctx.env);
  const lines: string[][] = [];
  let after = 0;
  for (;;) {
    const rows = await resultRows(ctx.env.DB, imp.id, after, PAGE);
    const passes = new Map(
      (
        await passLinkRows(
          ctx.env.DB,
          imp.org_id,
          imp.mode,
          rows.flatMap((r) => (r.pass_id ? [r.pass_id] : [])),
        )
      ).map((p) => [p.id, p]),
    );
    for (const r of rows) {
      const pass = r.pass_id ? passes.get(r.pass_id) : undefined;
      const token =
        pass && pass.removed_at === null
          ? await revealToken(ctx.env, 'pass', pass.id, pass.org_id, pass.download_token)
          : null;
      const problem =
        problemsOf(ctx, imp.id, r.problems)
          .filter((p) => p.severity === 'error')
          .map((p) => p.message)
          .join(' ') ||
        r.code ||
        '';
      lines.push([
        String(r.row_no),
        resultOf(r),
        pass?.id ?? '',
        r.external_id ?? '',
        r.holder_email ?? '',
        token ? `${base}/p/${token}` : '',
        token ? `${base}/p/${token}/pass.pkpass` : '',
        problem,
      ]);
    }
    const last = rows[rows.length - 1];
    if (rows.length < PAGE || !last) break;
    after = last.row_no;
  }
  // Every pass link and email of the import left in one file: no tokens or addresses in the entry.
  await recordAudit(ctx, {
    orgId: imp.org_id,
    actorType: authority.kind === 'session' ? 'user' : 'api_key',
    actorId: authority.kind === 'session' ? authority.userId : authority.keyId,
    action: 'pass_import.results_export',
    targetType: 'pass_import',
    targetId: imp.id,
    detail: { importId: imp.id, rows: lines.length },
  });
  return BOM + toCsv(HEADER, lines);
}
