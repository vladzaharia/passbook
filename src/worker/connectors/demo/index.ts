import { type ConnectorDefinition, ConnectorError } from '../types.ts';
import { type Config, config } from './config.ts';
import { buildClassic, CLASSIC_FIELDS, classicRef } from './datasets/classic.ts';
import { buildRecord, DATASET_DEFS, indexOf, refOf } from './datasets/index.ts';
import { isoDate } from './world.ts';

const CLASSIC_PAGE = 10;

/** Every field any dataset can emit, so the mapping UI has names before a dataset is chosen. */
const outputFields = Object.assign(
  {},
  CLASSIC_FIELDS,
  ...Object.values(DATASET_DEFS).map((d) => d.fields),
);

function layout(c: Config) {
  if (c.dataset === 'classic') {
    return {
      page: CLASSIC_PAGE,
      refOf: classicRef,
      indexOf: (ref: string) => {
        const m = /^m-(\d+)$/.exec(ref);
        const n = m ? Number(m[1]) : 0;
        return n > 0 && classicRef(n) === ref ? n : null;
      },
      build: (i: number) => buildClassic(c, classicRef(i)),
    };
  }
  const def = DATASET_DEFS[c.dataset];
  return {
    page: def.pageSize,
    refOf: (i: number) => refOf(def, i),
    indexOf: (ref: string) => indexOf(def, ref),
    build: (i: number) => buildRecord(def, c, i),
  };
}

function refs(c: Config): string[] {
  const { refOf: toRef } = layout(c);
  return Array.from({ length: c.count }, (_, i) => toRef(i + 1));
}

function maybeFail(c: Config): void {
  if (c.fail === 'auth') throw new ConnectorError('AUTH', { permanent: true, httpStatus: 401 });
  if (c.fail === 'forbidden') {
    throw new ConnectorError('FORBIDDEN', { permanent: true, httpStatus: 403 });
  }
  if (c.fail === 'timeout') throw new ConnectorError('TIMEOUT');
  if (c.fail === 'upstream') throw new ConnectorError('UPSTREAM', { httpStatus: 503 });
  if (c.fail === 'rate_limited') {
    throw new ConnectorError('RATE_LIMITED', { httpStatus: 429, retryAfterMs: 60_000 });
  }
}

/** Cursor is `<revision>:<offset>`. A cursor from an older revision restarts the listing. */
function parseCursor(cursor: string | null, revision: number): number {
  const match = cursor ? /^(\d+):(\d+)$/.exec(cursor) : null;
  if (!match || Number(match[1]) !== revision) return 0;
  return Number(match[2]);
}

/** Deterministic fake upstream for local dev, e2e and demos. */
const definition: ConnectorDefinition<Config, undefined> = {
  type: 'demo',
  version: 2,
  displayName: 'Demo',
  description: 'Sample records to try a sync.',
  category: 'try',
  order: 10,
  capabilities: { poll: true, delta: true },
  egress: () => [],
  webhookReferenceMode: 'refs-only',
  configSchema: config,
  fixedConfig: ['dataset'],
  outputFields,
  defaults: { intervalSeconds: 60, maxConcurrency: 4, requestsPerMinute: 600, timeoutMs: 5_000 },

  /** Version 1 had no datasets: it is `classic`. */
  migrate(_old, stored) {
    return config.parse({ ...(stored as object), dataset: 'classic' });
  },

  prepareConfig(c, { now }) {
    return c.dataset === 'classic' || c.anchor ? c : { ...c, anchor: isoDate(now) };
  },

  async test(ctx) {
    maybeFail(ctx.connection.config);
    return { ok: true, detail: `${ctx.connection.config.count} demo records.` };
  },

  async fetchRecord(ctx, ref) {
    const c = ctx.connection.config;
    maybeFail(c);
    const l = layout(c);
    const index = l.indexOf(ref);
    if (c.missing.includes(ref) || index === null || index > c.count)
      return { status: 'not_found' };
    return { status: 'ok', ...l.build(index) };
  },

  async listChanges(ctx, cursor) {
    const c = ctx.connection.config;
    maybeFail(c);
    const l = layout(c);
    const all = [
      ...refs(c),
      ...c.missing.filter((m) => !(l.indexOf(m) !== null && (l.indexOf(m) ?? 0) <= c.count)),
    ];
    const offset = parseCursor(cursor, c.revision);
    if (c.fail === 'page_two' && offset > 0)
      throw new ConnectorError('UPSTREAM', { httpStatus: 503 });
    const page = all.slice(offset, offset + l.page);
    const next = Math.min(offset + l.page, all.length);
    return {
      changes: page.map((ref) => {
        if (c.missing.includes(ref)) return { ref, deleted: true };
        const index = l.indexOf(ref) ?? 0;
        return { ref, record: l.build(index).record };
      }),
      cursor: `${c.revision}:${next}`,
      hasMore: next < all.length,
    };
  },
};
export default definition;
