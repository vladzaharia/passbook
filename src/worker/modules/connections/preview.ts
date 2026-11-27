import type { z } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import type { ConnectionPreviewSchema } from '../../../shared/contracts/index.ts';
import type { AnyConnector, ConnectorContext, UpstreamRecord } from '../../connectors/types.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionAuthority } from './access.ts';
import { getDeps } from './deps.ts';
import { applyMapping } from './mapping.ts';
import { captureConnectionRelease } from './record-issuance.ts';
import { getPassByRef } from './repo-passes.ts';
import { classify, prepare } from './runtime.ts';
import { requireConnection } from './service.ts';
import { openUnsaved, sampleFields } from './test-config.ts';
import { matchesVoidWhen } from './void-when.ts';

type Unsaved = Parameters<typeof openUnsaved>[1];

type Result = z.infer<typeof ConnectionPreviewSchema>;
type Sample = Result['samples'][number];

const MAX_RECORDS = 200;
const MAX_PAGES = 4;
/** Records the source gives by reference only cost a request each. */
const MAX_FETCHES = 50;
const MAX_SAMPLES = 10;
const COLUMN_ROWS = 3;
const MAX_VALUES = 20;
const CELL = 80;

export interface Found {
  ref: string;
  record: UpstreamRecord;
}

const WINDOW_DAYS = 30;
const TIME_KEYS = [
  'updatedAt',
  'updated_at',
  'createdAt',
  'created_at',
  'date_created',
  'modified',
];

/** When the record last changed, from the usual field names; null when it has none. */
function recordTime(record: UpstreamRecord): number | null {
  for (const key of TIME_KEYS) {
    const v = record[key];
    const ms =
      typeof v === 'number'
        ? v < 1e11
          ? v * 1000
          : v
        : typeof v === 'string'
          ? Date.parse(v)
          : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

const cut = (text: string) => (text.length > CELL ? text.slice(0, CELL) : text);

/** Distinct text values of one field over all records; none when it reads as free-form. */
function valuesOf(flat: Map<string, string>[], pointer: string) {
  const counts = new Map<string, number>();
  for (const cells of flat) {
    const hit = cells.get(pointer);
    if (hit !== undefined) counts.set(cut(hit), (counts.get(cut(hit)) ?? 0) + 1);
  }
  const list = [...counts].sort((a, b) => b[1] - a[1]);
  if (list.length > MAX_VALUES || list.length === flat.length) return [];
  return list.map(([value, count]) => ({ value, count }));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The source's first records: a list's pages, else the test record. */
async function readRecords(
  def: AnyConnector,
  cc: ConnectorContext<unknown, unknown>,
  since: number,
): Promise<{ records: Found[]; excluded: number }> {
  const out: Found[] = [];
  let excluded = 0;
  if (!def.listChanges || !(def.hasList?.(cc.connection.config) ?? true))
    return { records: out, excluded };
  let cursor: string | null = null;
  let fetches = 0;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_RECORDS; page++) {
    const listed = await def.listChanges(cc, cursor);
    for (const change of listed.changes) {
      if (out.length >= MAX_RECORDS) break;
      if (change.deleted) continue;
      let record = change.record;
      if (!record && fetches < MAX_FETCHES) {
        fetches += 1;
        const fetched = await def.fetchRecord(cc, change.ref);
        if (fetched.status === 'ok') record = fetched.record;
      }
      if (!record) continue;
      const at = recordTime(record);
      if (at !== null && at < since) excluded += 1;
      else out.push({ ref: change.ref, record });
    }
    if (!listed.hasMore || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return { records: out, excluded };
}

export interface Plan {
  orgId: string;
  /** Null for an unsaved configuration: it has no passes yet. */
  connectionId: string | null;
  mapping: Parameters<typeof applyMapping>[0];
  voidWhen: Parameters<typeof matchesVoidWhen>[0];
  autoCreate: boolean;
  defaultTemplateId: string | null;
}

/**
 * A dry run of the next sync over the last 30 days of records, at most 200. Reads the source and the
 * connection's passes; writes nothing and moves no cursor. Reading needs no write authority.
 */
export async function previewSync(
  sctx: ServiceContext,
  id: string,
  authority?: ConnectionAuthority,
): Promise<Result> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  const startedAt = sctx.clock.now();
  let loaded: Awaited<ReturnType<typeof prepare>>;
  try {
    loaded = await prepare(sctx, conn);
  } catch (error) {
    return failed(sctx, startedAt, error, id);
  }
  return runPreview(
    sctx,
    {
      orgId: conn.orgId,
      connectionId: conn.id,
      mapping: conn.mapping,
      voidWhen: conn.voidWhen,
      autoCreate: conn.autoCreate,
      defaultTemplateId: conn.defaultTemplateId,
    },
    (since) => readRecords(loaded.def, loaded.cc, since),
    startedAt,
    conn.id,
  );
}

/** The same dry run for an unsaved configuration, with the mapping and rules it would get. */
export async function previewUnsaved(
  sctx: ServiceContext,
  input: Unsaved,
  authority?: ConnectionAuthority,
): Promise<Result> {
  if (authority && authority.orgId !== input.orgId) throw new ForbiddenError();
  const startedAt = sctx.clock.now();
  const { def, cc } = await openUnsaved(sctx, input, authority);
  const plan: Plan = {
    orgId: input.orgId,
    connectionId: null,
    mapping: input.mapping ?? null,
    voidWhen: input.voidWhen ?? [],
    autoCreate: input.autoCreate ?? false,
    defaultTemplateId: input.defaultTemplateId ?? null,
  };
  return runPreview(sctx, plan, (since) => readRecords(def, cc, since), startedAt, null);
}

const zero = { create: 0, update: 0, unchanged: 0, skipped: 0, errors: 0, waiting: 0 };

export function failed(
  sctx: ServiceContext,
  startedAt: number,
  error: unknown,
  id: string | null,
): Result {
  const failure = classify(error);
  if (failure.code === 'INTERNAL')
    sctx.log.error('connection.preview_failed', { connectionId: id, code: failure.code });
  return {
    ok: false,
    errorCode: failure.code,
    records: 0,
    counts: { ...zero },
    releaseBlocked: null,
    window: {
      days: WINDOW_DAYS,
      limit: MAX_RECORDS,
      since: startedAt - WINDOW_DAYS * 864e5,
      excluded: 0,
    },
    samples: [],
    columns: [],
    durationMs: sctx.clock.now() - startedAt,
  };
}

/** Runs the dry run over the records `source` gives (those on or after `since`). */
export async function runPreview(
  sctx: ServiceContext,
  conn: Plan,
  source: (since: number) => Promise<{ records: Found[]; excluded: number }>,
  startedAt: number,
  id: string | null,
): Promise<Result> {
  const counts = { ...zero };
  const since = startedAt - WINDOW_DAYS * 864e5;
  let read: Awaited<ReturnType<typeof readRecords>>;
  try {
    read = await source(since);
  } catch (error) {
    return failed(sctx, startedAt, error, id);
  }
  const { records, excluded } = read;
  const release = await captureConnectionRelease(sctx, conn);
  const blocked = release?.kind === 'blocked' ? release.code : null;

  const deps = getDeps();
  const samples: Sample[] = [];
  const note = (s: Sample) => {
    if (samples.length < MAX_SAMPLES) samples.push(s);
  };
  for (const { ref, record } of records) {
    const fields = applyMapping(conn.mapping, record);
    const pass = conn.connectionId
      ? await getPassByRef(sctx.env.DB, conn.orgId, conn.connectionId, ref)
      : null;
    const voids = matchesVoidWhen(conn.voidWhen, record);
    if (!pass && (voids || !conn.autoCreate)) {
      counts.skipped += 1;
      note({ ref, action: 'skipped', fields });
      continue;
    }
    const template = pass
      ? { id: pass.templateId, version: pass.templateVersion }
      : conn.defaultTemplateId
        ? { id: conn.defaultTemplateId, version: null }
        : null;
    if (!template) {
      counts.errors += 1;
      note({ ref, action: 'error', fields, message: 'Choose a template.' });
      continue;
    }
    try {
      const merged = { ...(pass?.personalization ?? {}), ...fields } as Record<string, Json>;
      await deps.validateFields(sctx, template, merged);
    } catch (error) {
      counts.errors += 1;
      note({
        ref,
        action: 'error',
        fields,
        message: (error instanceof Error ? error.message : 'Not valid.').slice(0, 300),
      });
      continue;
    }
    if (!pass && blocked) {
      counts.waiting += 1;
      note({ ref, action: 'skipped', fields, message: 'Waits for template approval.' });
    } else if (!pass) {
      counts.create += 1;
      note({ ref, action: 'create', fields });
    } else if (
      voids ||
      Object.entries(fields).some(([k, v]) => !same(pass.personalization[k], v))
    ) {
      counts.update += 1;
      note({ ref, action: 'update', fields });
    } else {
      counts.unchanged += 1;
      note({ ref, action: 'unchanged', fields });
    }
  }

  const flat = records.map(
    ({ record }) => new Map(sampleFields(record).map((f) => [f.pointer, f.preview])),
  );
  const cells = new Map<string, string[]>();
  for (const row of flat.slice(0, COLUMN_ROWS))
    for (const [pointer, preview] of row)
      cells.set(pointer, [...(cells.get(pointer) ?? []), preview]);
  return {
    ok: true,
    records: records.length,
    counts,
    releaseBlocked: blocked,
    window: { days: WINDOW_DAYS, limit: MAX_RECORDS, since, excluded },
    samples,
    columns: [...cells].slice(0, 60).map(([pointer, list]) => ({
      pointer,
      label: pointer.slice(1).replace(/\//g, ' › '),
      samples: list.map(cut),
      values: records.length > COLUMN_ROWS ? valuesOf(flat, pointer) : [],
    })),
    durationMs: sctx.clock.now() - startedAt,
  };
}
