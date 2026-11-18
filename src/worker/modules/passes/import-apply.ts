import type { Personalization } from '../../../passkit/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { createPassRow } from './create.ts';
import { parsePlan } from './import-plan.ts';
import { publishPass } from './publish.ts';
import {
  type DeferredStarter,
  reissuePrincipalCheck,
  reissuePrincipalValid,
} from './repo-bulk-principal.ts';
import {
  CHUNK_ROWS,
  emailedCount,
  plannedRows,
  progressOf,
  type Reservation,
  type RowResult,
  reserveRows,
  type Scope,
  writeProgress,
  writeRowResult,
} from './repo-import-commit.ts';
import type { ImportRowRecord } from './repo-import-rows.ts';
import { getImport, type ImportRow } from './repo-imports.ts';
import { getPass } from './repo-read-pass.ts';
import type { Actor } from './service.ts';

export interface ImportRunParams {
  importId: string;
  orgId: string;
  mode: 'live' | 'test';
}

export interface ChunkResult {
  /** More planned rows remain. */
  more: boolean;
  /** The starter lost its right: the run stops without touching another row. */
  revoked?: true;
  /** The template's release moved since the check: nothing more is applied. */
  stale?: true;
}

const actorOf = (starter: DeferredStarter): Actor =>
  starter.kind === 'membership'
    ? { type: 'user', id: starter.userId }
    : { type: 'api_key', id: starter.keyId };

const parseJson = <T>(json: string | null, fallback: T): T => {
  try {
    return json === null ? fallback : (JSON.parse(json) as T);
  } catch {
    return fallback;
  }
};

/** Key order does not matter: `{a:1,b:2}` equals `{b:2,a:1}`. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Pass ids and the email choice for the rows that have none, in file order, within the budget left. */
async function reserve(
  ctx: ServiceContext,
  s: Scope,
  imp: ImportRow,
  rows: ImportRowRecord[],
): Promise<void> {
  const fresh = rows.filter((r) => r.action === 'create' && r.pass_id === null);
  if (fresh.length === 0) return;
  let left =
    imp.email === 1 ? (imp.email_budget ?? 0) - (await emailedCount(ctx.env.DB, imp.id)) : 0;
  const picks: Reservation[] = fresh.map((r) => {
    const emailed = r.holder_email !== null && left > 0;
    if (emailed) left--;
    return { row: r.row_no, passId: ctx.ids.id(), emailed };
  });
  await reserveRows(ctx, s, picks);
  for (const r of fresh) {
    const pick = picks.find((p) => p.row === r.row_no);
    r.pass_id = pick?.passId ?? null;
    r.emailed = pick?.emailed ? 1 : 0;
  }
}

async function createRow(
  ctx: ServiceContext,
  imp: ImportRow,
  starter: DeferredStarter,
  row: ImportRowRecord,
): Promise<RowResult['result']> {
  const passId = row.pass_id;
  if (!passId) throw new AppError('IMPORT_ROW_UNRESERVED', 500, 'The row has no reserved pass.');
  // A replayed step finds the pass its first run made, by the id reserved before the create.
  const made = await getPass(ctx.env.DB, passId, imp.org_id);
  if (made) {
    if (made.mode === imp.mode && made.templateId === imp.template_id) return 'created';
    throw new AppError('IMPORT_ID_TAKEN', 409, 'The reserved pass id is in use.');
  }
  await createPassRow(ctx, {
    orgId: imp.org_id,
    templateId: imp.template_id,
    templateVersion: imp.template_version ?? '',
    releaseId: imp.release_id ?? '',
    releaseGeneration: imp.release_generation ?? 0,
    input: parseJson<Personalization>(row.input, {}),
    holderEmail: row.holder_email,
    externalId: row.external_id,
    sendEmail: row.emailed === 1 && row.holder_email !== null,
    source: 'manual',
    fieldSource: 'import',
    mode: imp.mode,
    passId,
    execution: {
      kind: 'deferred',
      starter,
      ...(row.external_id === null ? {} : { guard: { externalId: row.external_id } }),
    },
    actor: actorOf(starter),
  });
  return 'created';
}

async function updateRow(
  ctx: ServiceContext,
  imp: ImportRow,
  starter: DeferredStarter,
  row: ImportRowRecord,
  keepManual: boolean,
): Promise<RowResult['result']> {
  const input = parseJson<Personalization>(row.input, {});
  let replayed = false;
  const published = await publishPass(ctx, {
    orgScope: { orgId: imp.org_id, mode: imp.mode, principal: 'session' },
    passId: row.pass_id ?? '',
    cause: starter.kind === 'membership' ? 'admin' : 'api',
    actor: actorOf(starter),
    dispatch: false,
    extraChecks: [reissuePrincipalCheck(imp.org_id, starter, ctx.clock.now())],
    mutate: (current) => {
      if (
        current.orgId !== imp.org_id ||
        current.mode !== imp.mode ||
        current.templateId !== imp.template_id ||
        current.connectionId !== null
      )
        throw new AppError('IMPORT_PASS_CHANGED', 409, 'The pass changed since the check.');
      const merged: Personalization = { ...current.personalization };
      const sources = { ...current.fieldSources };
      let changed = false;
      for (const [k, v] of Object.entries(input)) {
        if (sources[k] === 'manual' && keepManual) continue;
        if (canon(current.personalization[k]) === canon(v)) continue;
        merged[k] = v;
        sources[k] = 'import';
        changed = true;
      }
      if (current.version !== row.expected_version) {
        // Our own earlier write (a crash before the row was marked) leaves the values in place: done.
        if (current.version === (row.expected_version ?? 0) + 1 && !changed) {
          replayed = true;
          return {};
        }
        throw new AppError('IMPORT_PASS_CHANGED', 409, 'The pass changed since the check.');
      }
      return changed ? { personalization: merged, fieldSources: sources } : {};
    },
  });
  return replayed || published.changed ? 'updated' : 'unchanged';
}

/** Applies the next 20 planned rows of a committing import; the plan is the rows as checked, nothing else. */
export async function applyChunk(
  ctx: ServiceContext,
  params: ImportRunParams,
): Promise<ChunkResult> {
  const db = ctx.env.DB;
  const s: Scope = params;
  const imp = await getImport(db, params.orgId, params.mode, params.importId);
  if (imp?.state !== 'committing' || !imp.starter) return { more: false };
  const starter = parseJson<DeferredStarter | null>(imp.starter, null);
  // Re-proved before every chunk, and again in each create and publish grant.
  if (!starter || !(await reissuePrincipalValid(db, imp.org_id, starter, ctx.clock.now()))) {
    ctx.log.warn('pass_import.starter_revoked', {
      code: 'IMPORT_STARTER_REVOKED',
      importId: imp.id,
    });
    return { more: false, revoked: true };
  }
  const release = await requireApprovedRelease(
    ctx,
    imp.template_id,
    imp.org_id,
    imp.mode,
    'apple',
  ).catch((error: unknown) => {
    if (!(error instanceof AppError)) throw error;
    return null;
  });
  if (release?.id !== imp.release_id || release?.generation !== imp.release_generation)
    return { more: false, stale: true };

  const rows = await plannedRows(db, imp.id, CHUNK_ROWS);
  if (rows.length === 0) return { more: false };
  await reserve(ctx, s, imp, rows);
  const keepManual = parsePlan(imp.plan, ctx.log)?.keepManual === true;
  let revoked = false;
  for (const row of rows) {
    try {
      const result =
        row.action === 'create'
          ? await createRow(ctx, imp, starter, row)
          : await updateRow(ctx, imp, starter, row, keepManual);
      await writeRowResult(ctx, s, { row: row.row_no, state: 'done', result, code: null });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (!(await reissuePrincipalValid(db, imp.org_id, starter, ctx.clock.now()))) {
        revoked = true;
        break;
      }
      ctx.log.warn('pass_import.row_failed', {
        importId: imp.id,
        row: row.row_no,
        code: error.code,
      });
      await writeRowResult(ctx, s, {
        row: row.row_no,
        state: 'failed',
        result: null,
        code: error.code,
      });
    }
  }
  const progress = await progressOf(db, imp.id);
  await writeProgress(ctx, s, progress);
  if (progress.updated > 0) await dispatchSafely(ctx);
  if (revoked) {
    ctx.log.warn('pass_import.starter_revoked', {
      code: 'IMPORT_STARTER_REVOKED',
      importId: imp.id,
    });
    return { more: false, revoked: true };
  }
  return { more: (await plannedRows(db, imp.id, 1)).length > 0 };
}
