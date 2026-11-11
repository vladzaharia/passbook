import { stmt } from '../../platform/db.ts';
import type { PreparedAssetGrant } from './asset-types.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';

const failure = `json_extract('[]','$[scan_asset_authority_failed]')`;

/** An expired or otherwise invalid plan cannot insert or return a token hash. */
function deniedGrantStmt(db: D1Database): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO scan_asset_grant_provenance
    (token_hash, org_id, mode, expires_at, credential_refs)
    SELECT NULL, NULL, NULL, NULL, NULL FROM passes p WHERE 0 RETURNING token_hash`,
  );
}

interface AssetGrantStatementInput {
  db: D1Database;
  capturedPlan: PreparedAssetGrant | null;
  valid: boolean;
  passId: string;
  imageGeneration: number | undefined;
  makeGuard: ((now: number) => { checks: readonly OutputPredicate[] }) | null;
  templateFence: () => OutputPredicate | null;
}

/** Bind the insertion and its ordered transaction-aborting assertions together. */
export function assetGrantStatementBinder({
  db,
  capturedPlan,
  valid,
  passId,
  imageGeneration,
  makeGuard,
  templateFence,
}: AssetGrantStatementInput) {
  return (
    now: number,
    extra: OutputPredicate | readonly OutputPredicate[] | undefined,
    requiredWhen?: OutputPredicate,
  ): D1PreparedStatement[] => {
    const required = requiredWhen ? boundOutputPredicate(requiredWhen) : { sql: '1', params: [] };
    const invalidRequired = !!requiredWhen && required.sql === '0' && requiredWhen.sql !== '0';
    const checks = makeGuard ? makeGuard(now).checks : [{ sql: '0', params: [] }];
    const extraPredicates: readonly OutputPredicate[] =
      extra === undefined ? [] : Array.isArray(extra) ? extra : [extra as OutputPredicate];
    const template = templateFence();
    const outputInputs = template ? [template, ...extraPredicates] : extraPredicates;
    const outputs = outputInputs.length
      ? outputInputs.map(boundOutputPredicate)
      : [{ sql: '1', params: [] }];
    const insert =
      valid &&
      capturedPlan &&
      !invalidRequired &&
      Number.isSafeInteger(now) &&
      capturedPlan.expiresAt > now &&
      9 + required.params.length < 100
        ? stmt(
            db,
            `INSERT OR IGNORE INTO scan_asset_grant_provenance
          (token_hash, org_id, mode, expires_at, credential_refs)
         SELECT ?, ?, ?, ?, ? FROM passes p
         WHERE p.id=?/* scan-ephemeral-pass-id */ AND p.org_id=? AND p.mode=?
           AND p.image_generation=? AND (${required.sql})
         RETURNING token_hash`,
            [
              capturedPlan.tokenHash,
              capturedPlan.orgId,
              capturedPlan.mode,
              capturedPlan.expiresAt,
              capturedPlan.credentialRefsJson,
              passId,
              capturedPlan.orgId,
              capturedPlan.mode,
              imageGeneration,
              ...required.params,
            ],
          )
        : deniedGrantStmt(db);
    const when = requiredWhen
      ? `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */ AND (${required.sql}))`
      : '1';
    const whenParams = requiredWhen ? [passId, ...required.params] : [];
    const firstAssertion =
      !invalidRequired && whenParams.length < 100
        ? stmt(
            db,
            `SELECT CASE WHEN changes()=1 OR NOT (${when})
          THEN 1 ELSE ${failure} END AS authorized, 1 AS asset_grant_step`,
            whenParams,
          )
        : stmt(db, `SELECT ${failure} AS authorized, 1 AS asset_grant_step`);
    const guardAssertions = checks.map((check, index) =>
      check.params.length < 100
        ? stmt(
            db,
            `SELECT CASE WHEN changes()=0 OR (${check.sql})
          THEN 1 ELSE ${failure} END AS authorized, ${index + 2} AS asset_grant_step`,
            check.params,
          )
        : stmt(db, `SELECT ${failure} AS authorized, ${index + 2} AS asset_grant_step`),
    );
    const outputAssertions = outputs.map((output, index) => {
      const outputParams = [passId, ...output.params];
      const finalMarker =
        `, ${checks.length + index + 2} AS asset_grant_step` +
        (index === outputs.length - 1 ? ', 1 AS asset_grant_final' : '');
      return outputParams.length < 100
        ? stmt(
            db,
            `SELECT CASE WHEN changes()=0 OR EXISTS (
            SELECT 1 FROM passes p JOIN passes scope ON scope.id=p.id
            WHERE p.id=?/* scan-ephemeral-pass-id */ AND (${output.sql}))
            THEN 1 ELSE ${failure} END AS authorized${finalMarker}`,
            outputParams,
          )
        : stmt(db, `SELECT ${failure} AS authorized${finalMarker}`);
    });
    return [insert, firstAssertion, ...guardAssertions, ...outputAssertions];
  };
}
