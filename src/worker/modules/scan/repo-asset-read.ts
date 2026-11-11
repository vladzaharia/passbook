import { first, type SqlValue, stmt } from '../../platform/db.ts';
import type { AssetGrantGuardParts } from './repo-asset-lineage.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';

/** Asset choice is read in the same batch as the original candidate. */
export interface ScannerAssetResource {
  branding: string;
  r2_key: string | null;
  sha1: string | null;
}

export function scannerAssetResourceStmt(
  db: D1Database,
  orgId: string,
  passId: string,
  name: string,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT o.branding, a.r2_key, a.sha1
    FROM passes p JOIN orgs o ON o.id=p.org_id AND o.status='active'
    LEFT JOIN pass_assets a ON a.pass_id=p.id AND a.name=?
    WHERE p.org_id=? AND p.id=?`,
    [name, orgId, passId],
  );
}

export function scannerAssetResourceFromResult(
  result: D1Result | undefined,
): ScannerAssetResource | null {
  return result?.success === true
    ? ((result.results?.[0] as ScannerAssetResource | undefined) ?? null)
    : null;
}

/** Split oversized scalar fences into one atomic D1 batch, never packing secrets. */
export async function assetGrantPredicatesCurrent(
  db: D1Database,
  guard: AssetGrantGuardParts,
  template?: { sql: string; params: readonly SqlValue[] },
): Promise<boolean> {
  const boundedTemplate = template ? boundOutputPredicate(template) : undefined;
  if (boundedTemplate?.sql === '0') return false;
  const templateParams = boundedTemplate?.params ?? [];
  const authoritySql = `FROM passes p ${boundedTemplate ? 'JOIN passes scope ON scope.id=p.id' : ''}
    WHERE (${guard.authority.sql}) AND (${boundedTemplate?.sql ?? '1'})`;
  const authorityParams = [...guard.authority.params, ...templateParams];
  if (templateParams.length >= 100) return false;
  if (authorityParams.length + guard.csrf.params.length < 100)
    return (
      (await first(db, `SELECT 1 ${authoritySql} AND (${guard.csrf.sql}) LIMIT 1`, [
        ...authorityParams,
        ...guard.csrf.params,
      ])) !== null
    );
  if (guard.checks.some((check) => check.params.length >= 100)) return false;
  const statements = guard.checks.map((check) =>
    stmt(db, `SELECT 1 AS authorized WHERE (${check.sql})`, check.params),
  );
  if (boundedTemplate)
    statements.push(
      stmt(
        db,
        `SELECT 1 AS authorized FROM passes scope WHERE (${boundedTemplate.sql}) LIMIT 1`,
        templateParams,
      ),
    );
  const results = await db.batch<{ authorized: number }>(statements);
  if (results.length !== statements.length) return false;
  for (let index = 0; index < statements.length; index++) {
    const result = results[index];
    if (result?.success !== true || result.results?.[0]?.authorized !== 1) return false;
  }
  return true;
}
