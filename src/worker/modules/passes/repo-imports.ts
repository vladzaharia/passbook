import { grant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { inList, type WhereValue } from '../../platform/authority-expr.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';

export interface ImportRow {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  template_id: string;
  release_id: string | null;
  release_generation: number | null;
  template_version: string | null;
  source_kind: 'file' | 'url';
  source_name: string;
  object_key: string | null;
  object_sha256: string | null;
  plan: string | null;
  state: string;
  error_code: string | null;
  check_id: string | null;
  email: number;
  skip_invalid: number;
  starter: string | null;
  email_budget: number | null;
  rows: number;
  to_create: number;
  to_update: number;
  unchanged: number;
  errors: number;
  warnings: number;
  done: number;
  created: number;
  updated: number;
  failed: number;
  not_emailed: number;
  removed: number;
  created_by: string;
  created_at: number;
  checked_at: number | null;
  committed_at: number | null;
  finished_at: number | null;
  expires_at: number;
}

/** Every read names the org and mode: a draft of another org or mode does not exist. */
export function getImport(
  db: D1Database,
  orgId: string,
  mode: string,
  id: string,
): Promise<ImportRow | null> {
  return first<ImportRow>(
    db,
    'SELECT * FROM pass_imports WHERE id = ? AND org_id = ? AND mode = ?',
    [id, orgId, mode],
  );
}

export function listImports(
  db: D1Database,
  orgId: string,
  mode: string,
  limit: number,
  cursor: { createdAt: number; id: string } | null,
): Promise<ImportRow[]> {
  const where = cursor ? 'AND (created_at, id) < (?, ?)' : '';
  const params: SqlValue[] = cursor ? [cursor.createdAt, cursor.id] : [];
  return all<ImportRow>(
    db,
    `SELECT * FROM pass_imports WHERE org_id = ? AND mode = ? ${where}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [orgId, mode, ...params, limit],
  );
}

export interface NewImport {
  id: string;
  templateId: string;
  templateVersion: string;
  releaseId: string;
  releaseGeneration: number;
  sourceKind: 'file' | 'url';
  sourceName: string;
  objectKey: string;
  objectSha256: string;
  plan: string | null;
  state: 'mapping' | 'checking';
  createdBy: string;
  now: number;
  expiresAt: number;
}

const CODES = { stale: 'IMPORT_STATE', lineage: 'IMPORT_NOT_FOUND' };
const stateIn = (states: readonly string[]) => ({ state: inList([...states]) });
const TABLES = ['pass_imports', 'pass_import_rows'] as const;

/** A grant of the request's principal: the draft belongs to its org and mode and to nobody else. */
export function importGrant(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  /** What the draft must look like now: `{ state: inList([...]) }`, plus `check_id` for a check's own writes. */
  where?: Record<string, WhereValue>,
) {
  return grant(ctx, {
    purpose: 'org_mode.pass.import',
    principal: tenantPrincipal(authority),
    target: id,
    tables: TABLES,
    checks: [
      ...capabilityChecks(authority),
      ...(where ? [exactlyOne('pass_imports', { id, ...where }, undefined, 'stale')] : []),
    ],
    codes: CODES,
  });
}

export async function insertImport(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  n: NewImport,
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org_mode.pass.import',
    principal: tenantPrincipal(authority),
    target: n.id,
    tables: TABLES,
    checks: capabilityChecks(authority),
    codes: CODES,
  });
  g.insertSelect(
    'pass_imports',
    [
      'id',
      'template_id',
      'release_id',
      'release_generation',
      'template_version',
      'source_kind',
      'source_name',
      'object_key',
      'object_sha256',
      'plan',
      'state',
      'created_by',
      'created_at',
      'expires_at',
    ],
    [
      n.id,
      n.templateId,
      n.releaseId,
      n.releaseGeneration,
      n.templateVersion,
      n.sourceKind,
      n.sourceName,
      n.objectKey,
      n.objectSha256,
      n.plan,
      n.state,
      n.createdBy,
      n.now,
      n.expiresAt,
    ],
  );
  await g.commit();
}

export interface CheckStart {
  /** This run's id: its row inserts and its finish must carry it, so a second run cannot mix rows in. */
  checkId: string;
  plan: string;
  templateVersion: string;
  releaseId: string;
  releaseGeneration: number;
  emailBudget: number;
}

/** `checking`, with the old rows gone: the draft is rebuilt from the file and the plan. */
export async function beginCheck(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  s: CheckStart,
): Promise<void> {
  const g = importGrant(ctx, authority, id, stateIn(['mapping', 'checking', 'ready', 'stale']));
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: {
      state: 'checking',
      check_id: s.checkId,
      plan: s.plan,
      template_version: s.templateVersion,
      release_id: s.releaseId,
      release_generation: s.releaseGeneration,
      email_budget: s.emailBudget,
      error_code: null,
    },
  });
  g.joined('pass_import_rows', { where: { import_id: id }, delete: true });
  await g.commit();
}

export interface CheckCounts {
  rows: number;
  create: number;
  update: number;
  unchanged: number;
  errors: number;
  warnings: number;
}

export async function finishCheck(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  checkId: string,
  c: CheckCounts,
): Promise<void> {
  const g = importGrant(ctx, authority, id, { state: 'checking', check_id: checkId });
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: {
      state: 'ready',
      rows: c.rows,
      to_create: c.create,
      to_update: c.update,
      unchanged: c.unchanged,
      errors: c.errors,
      warnings: c.warnings,
      checked_at: ctx.clock.now(),
    },
  });
  await g.commit();
}

/** A draft that is not committing goes; its rows follow by cascade. The file is deleted by the caller. */
export async function discardDraft(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
): Promise<void> {
  const g = importGrant(
    ctx,
    authority,
    id,
    stateIn(['mapping', 'checking', 'ready', 'stale', 'failed']),
  );
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: { state: 'discarded' },
  });
  g.joined('pass_import_rows', { where: { import_id: id }, delete: true });
  await g.commit();
}

/** A check that could not run: back to `mapping`, with the reason for the client. */
export async function failCheck(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  code: string,
): Promise<void> {
  const g = importGrant(ctx, authority, id, stateIn(['mapping', 'checking']));
  g.update('pass_imports', {
    where: { id },
    require: 'one',
    set: { state: 'mapping', error_code: code },
  });
  await g.commit();
}
