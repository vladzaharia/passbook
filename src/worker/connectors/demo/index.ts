import { z } from 'zod';
import { type ConnectorDefinition, ConnectorError, type UpstreamRecord } from '../types.ts';

const PAGE_SIZE = 10;
const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];

const config = z.object({
  seed: z
    .string()
    .max(60)
    .default('demo')
    .meta({ 'x-label': 'Seed', 'x-help': 'Same seed, same members.', 'x-order': 1 }),
  /** Upstream holds m-001 .. m-<count>. */
  count: z
    .number()
    .int()
    .min(0)
    .max(500)
    .default(25)
    .meta({ 'x-label': 'Members', 'x-help': 'Up to 500.', 'x-order': 2 }),
  /** Raise to simulate upstream changes: points shift for every record. */
  revision: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .meta({ 'x-label': 'Revision', 'x-help': 'Raise it to change every member.', 'x-order': 3 }),
  /** Refs the upstream reports as deleted / not found. */
  missing: z
    .array(z.string().max(60))
    .max(100)
    .default([])
    .meta({ 'x-label': 'Missing members', 'x-help': 'Refs such as m-004.', 'x-order': 6 }),
  /** Simulate a failing upstream. */
  fail: z
    .enum(['none', 'auth', 'timeout', 'upstream', 'rate_limited'])
    .default('none')
    .meta({
      'x-order': 5,
      'x-label': 'Simulated failure',
      'x-enumLabels': {
        none: 'None',
        auth: 'Auth rejected',
        timeout: 'Timeout',
        upstream: 'Upstream error',
        rate_limited: 'Rate limited',
      },
    }),
  holderDomain: z
    .string()
    .max(100)
    .default('example.com')
    .meta({ 'x-label': 'Holder domain', 'x-placeholder': 'example.com', 'x-order': 4 }),
});
type Config = z.infer<typeof config>;

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function demoRef(index: number): string {
  return `m-${String(index).padStart(3, '0')}`;
}

function refs(c: Config): string[] {
  return Array.from({ length: c.count }, (_, i) => demoRef(i + 1));
}

function build(c: Config, ref: string): { record: UpstreamRecord; holderEmail: string } {
  const h = hash(`${c.seed}:${ref}`);
  return {
    record: {
      memberName: `Member ${ref.toUpperCase()}`,
      memberId: ref,
      status: h % 7 === 0 ? 'inactive' : 'active',
      tier: TIERS[h % TIERS.length] ?? 'Bronze',
      points: (h % 1000) + c.revision * 10,
      email: `${ref}@${c.holderDomain}`,
    },
    holderEmail: `${ref}@${c.holderDomain}`,
  };
}

function maybeFail(c: Config): void {
  if (c.fail === 'auth') throw new ConnectorError('AUTH', { permanent: true, httpStatus: 401 });
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
  version: 1,
  displayName: 'Demo',
  description: 'Sample members to try a sync.',
  capabilities: { poll: true, delta: true },
  webhookReferenceMode: 'refs-only',
  configSchema: config,
  outputFields: {
    memberName: { type: 'string' },
    memberId: { type: 'string' },
    status: { type: 'string' },
    tier: { type: 'string' },
    points: { type: 'number' },
    email: { type: 'string' },
  },
  defaults: { intervalSeconds: 60, maxConcurrency: 4, requestsPerMinute: 600, timeoutMs: 5_000 },

  async test(ctx) {
    maybeFail(ctx.connection.config);
    return { ok: true, detail: `${ctx.connection.config.count} demo records.` };
  },

  async fetchRecord(ctx, ref) {
    const c = ctx.connection.config;
    maybeFail(c);
    if (c.missing.includes(ref) || !refs(c).includes(ref)) return { status: 'not_found' };
    const { record, holderEmail } = build(c, ref);
    return { status: 'ok', record, holderEmail };
  },

  async listChanges(ctx, cursor) {
    const c = ctx.connection.config;
    maybeFail(c);
    const all = [...refs(c), ...c.missing.filter((m) => !refs(c).includes(m))];
    const offset = parseCursor(cursor, c.revision);
    const page = all.slice(offset, offset + PAGE_SIZE);
    const next = Math.min(offset + PAGE_SIZE, all.length);
    return {
      changes: page.map((ref) =>
        c.missing.includes(ref) ? { ref, deleted: true } : { ref, record: build(c, ref).record },
      ),
      cursor: `${c.revision}:${next}`,
      hasMore: next < all.length,
    };
  },
};
export default definition;
