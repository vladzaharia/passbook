import type { z } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import type { ConnectionPreviewSchema } from '../../../shared/contracts/index.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { getDeps } from './deps.ts';
import { applyMapping } from './mapping.ts';
import { getPassByRef } from './repo-passes.ts';
import { classify, prepare } from './runtime.ts';
import { requireConnection } from './service.ts';
import { sampleFields } from './test-config.ts';
import { matchesVoidWhen } from './void-when.ts';

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
  prep: Awaited<ReturnType<typeof prepare>>,
): Promise<{ ref: string; record: UpstreamRecord; email?: string }[]> {
  const { def, cc } = prep;
  const out: { ref: string; record: UpstreamRecord }[] = [];
  if (!def.listChanges || !(def.hasList?.(cc.connection.config) ?? true)) return out;
  let cursor: string | null = null;
  let fetches = 0;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_RECORDS; page++) {
    const listed = await def.listChanges(cc, cursor);
    for (const change of listed.changes) {
      if (out.length >= MAX_RECORDS) break;
      if (change.deleted) continue;
      if (change.record) {
        out.push({ ref: change.ref, record: change.record });
      } else if (fetches < MAX_FETCHES) {
        fetches += 1;
        const fetched = await def.fetchRecord(cc, change.ref);
        if (fetched.status === 'ok') out.push({ ref: change.ref, record: fetched.record });
      }
    }
    if (!listed.hasMore || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return out;
}

/**
 * A dry run of the next sync over at most 200 records: what it would create, update, skip or reject.
 * Reads the source and the connection's passes; writes nothing and moves no cursor.
 */
export async function previewSync(
  sctx: ServiceContext,
  id: string,
  authority?: ConnectionAuthority,
): Promise<Result> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  const startedAt = sctx.clock.now();
  const counts = { create: 0, update: 0, unchanged: 0, skipped: 0, errors: 0 };
  const empty = (errorCode?: string): Result => ({
    ok: errorCode === undefined,
    ...(errorCode ? { errorCode } : {}),
    records: 0,
    counts,
    samples: [],
    columns: [],
    durationMs: sctx.clock.now() - startedAt,
  });
  await assertConnectionAuthority(sctx, authority);
  let records: Awaited<ReturnType<typeof readRecords>>;
  try {
    records = await readRecords(await prepare(sctx, conn));
  } catch (error) {
    await assertConnectionAuthority(sctx, authority);
    const failure = classify(error);
    if (failure.code === 'INTERNAL')
      sctx.log.error('connection.preview_failed', { connectionId: id, code: failure.code });
    return empty(failure.code);
  }
  await assertConnectionAuthority(sctx, authority);

  const deps = getDeps();
  const samples: Sample[] = [];
  const note = (s: Sample) => {
    if (samples.length < MAX_SAMPLES) samples.push(s);
  };
  for (const { ref, record } of records) {
    const fields = applyMapping(conn.mapping, record);
    const pass = await getPassByRef(sctx.env.DB, conn.orgId, conn.id, ref);
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
    if (!pass) {
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
