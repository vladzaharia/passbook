import { maxNow } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateAuthority } from './access.ts';
import type { TemplateRow } from './repo.ts';
import { historyIs, noApprovedLiveHead, noPasses } from './repo-grant-checks.ts';
import { type TemplateGrantOptions, templateGrant } from './repo-grants.ts';

const history = `(EXISTS (SELECT 1 FROM template_candidates WHERE template_id = templates.id)
    OR EXISTS (SELECT 1 FROM template_releases WHERE template_id = templates.id))`;

export async function hasTemplateHistory(db: D1Database, id: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found FROM templates WHERE id = ? AND ${history}`,
    [id],
  );
  return !!row;
}

const CODES = {
  lineage: 'TEMPLATE_VERSION_CONFLICT',
  stale: 'TEMPLATE_VERSION_CONFLICT',
  config: 'TEMPLATE_VERSION_CONFLICT',
};

/** The row as authorized: an org template is matched through the grant, a shared one by `org_id IS NULL`. */
function target(row: TemplateRow, authority: TemplateAuthority, id = row.id) {
  return {
    id,
    status: row.status,
    origin: 'uploaded',
    ...(authority.kind === 'platform' ? { org_id: null } : {}),
  };
}

/**
 * Runs a template write that may lose a race: a changed row or authority returns false and the caller
 * classifies it (404 mask, 403, 409 or its fallback). Any other failure propagates.
 */
async function attempt(write: () => Promise<boolean>): Promise<boolean> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ConflictError) return false;
    throw error;
  }
}

/** Whether an approved Live release of the owning org is the head, so a rollback is the way back. */
export async function hasApprovedLiveHead(db: D1Database, templateId: string): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    `SELECT 1 AS found FROM templates t WHERE t.id = ? AND t.org_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM template_releases r
         WHERE r.template_id = t.id AND r.org_id = t.org_id AND r.mode = 'live' AND r.provider = 'apple'
           AND r.source = 'approved'
           AND r.generation = (SELECT MAX(x.generation) FROM template_releases x
             WHERE x.template_id = r.template_id AND x.org_id = r.org_id
               AND x.mode = 'live' AND x.provider = 'apple'))`,
    [templateId],
  );
  return !!row;
}

export function archiveUploadedTemplate(
  ctx: ServiceContext,
  row: TemplateRow,
  authority: TemplateAuthority,
  now: number,
): Promise<boolean> {
  return attempt(async () => {
    const g = templateGrant(ctx, authority, 'archive', { target: row.id, codes: CODES });
    g.update('templates', {
      set: { status: 'archived', updated_at: maxNow(now) },
      where: target(row, authority),
      require: 'one',
      returning: ['id'],
    });
    return ((await g.commit())[0]?.results.length ?? 0) === 1;
  });
}

/** Restores an archived template that has no approved Live head to roll back to. */
export function restoreUploadedTemplate(
  ctx: ServiceContext,
  row: TemplateRow,
  authority: TemplateAuthority,
  now: number,
): Promise<boolean> {
  return attempt(async () => {
    const g = templateGrant(ctx, authority, 'restore', {
      target: row.id,
      codes: CODES,
      checks: [noApprovedLiveHead(row.id)],
    });
    g.update('templates', {
      set: { status: 'active', updated_at: maxNow(now) },
      where: target(row, authority),
      require: 'one',
      returning: ['id'],
    });
    return ((await g.commit())[0]?.results.length ?? 0) === 1;
  });
}

function deletion(
  ctx: ServiceContext,
  id: string,
  authority: TemplateAuthority,
  withHistory: boolean,
) {
  const options: TemplateGrantOptions = {
    target: id,
    codes: CODES,
    checks: [historyIs(id, withHistory), noPasses(id)],
  };
  return templateGrant(ctx, authority, withHistory ? 'soft_delete' : 'delete', options);
}

export function softDeleteUploadedTemplate(
  ctx: ServiceContext,
  row: TemplateRow,
  id: string,
  authority: TemplateAuthority,
  now: number,
): Promise<boolean> {
  return attempt(async () => {
    const g = deletion(ctx, id, authority, true);
    g.update('templates', {
      set: { status: 'deleted', updated_at: maxNow(now) },
      where: target(row, authority, id),
      require: 'one',
      returning: ['id'],
    });
    return ((await g.commit())[0]?.results.length ?? 0) === 1;
  });
}

/** A pass created after the check surfaces as a foreign-key error, which the caller classifies. */
export async function deleteUploadedTemplate(
  ctx: ServiceContext,
  row: TemplateRow,
  id: string,
  authority: TemplateAuthority,
): Promise<boolean> {
  return attempt(async () => {
    const g = deletion(ctx, id, authority, false);
    g.delete('templates', {
      where: target(row, authority, id),
      require: 'one',
      returning: ['id'],
    });
    return ((await g.commit())[0]?.results.length ?? 0) === 1;
  });
}
