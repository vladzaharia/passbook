import type { Mode } from '../../../shared/contracts/common.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { first } from '../../platform/db.ts';

export interface ExternalIdScope {
  orgId: string;
  mode: Mode;
  templateId: string;
}

/** Another live (not deleted) pass of the template holds this externalId. */
export async function externalIdTaken(
  db: D1Database,
  scope: ExternalIdScope,
  externalId: string,
  exceptPassId?: string,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE org_id = ? AND mode = ? AND template_id = ? AND external_id = ?
       AND deleted_at IS NULL AND id IS NOT ? LIMIT 1`,
    [scope.orgId, scope.mode, scope.templateId, externalId, exceptPassId ?? null],
  );
  return row !== null;
}

/** The same rule inside the create transaction, so two concurrent creates cannot both win. */
export const externalIdFreeCheck = (
  templateId: string,
  externalId: string,
  exceptPassId: string | null = null,
): Check =>
  tenantCheck(
    'lineage',
    `NOT EXISTS (SELECT 1 FROM passes x WHERE x.org_id = {org} AND x.mode = {mode}
       AND x.template_id = ? AND x.external_id = ? AND x.deleted_at IS NULL AND x.id IS NOT ?)`,
    [templateId, externalId, exceptPassId],
  );
