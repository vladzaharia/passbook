import type { z } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import type {
  TestConfigResponseSchema,
  TestConfigSchema,
} from '../../../shared/contracts/index.ts';
import type { AnyConnector, ConnectorContext, UpstreamRecord } from '../../connectors/types.ts';
import type { Actor } from '../../platform/context.ts';
import { baseUrl } from '../../platform/env.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { createSafeFetch } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { getDeps } from './deps.ts';
import { recordConnectionAudit } from './repo-sync.ts';
import { classify } from './runtime.ts';
import { auditActor } from './service.ts';
import { assertOrg, assertSafeUrls, parseWith, requireConnector } from './validate.ts';

type Input = z.infer<typeof TestConfigSchema>;
type Result = z.infer<typeof TestConfigResponseSchema>;

const MAX_FIELDS = 60;
const MAX_DEPTH = 3;
const PREVIEW = 120;

/** Leaf JSON pointers of a record with short previews (depth 3, 60 fields). */
export function sampleFields(record: UpstreamRecord): { pointer: string; preview: string }[] {
  const out: { pointer: string; preview: string }[] = [];
  const token = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
  const walk = (value: Json, pointer: string, depth: number) => {
    if (out.length >= MAX_FIELDS) return;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && depth < MAX_DEPTH) {
      for (const [k, v] of Object.entries(value)) walk(v, `${pointer}/${token(k)}`, depth + 1);
      return;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    out.push({ pointer, preview: text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text });
  };
  for (const [k, v] of Object.entries(record)) walk(v, `/${token(k)}`, 1);
  return out;
}

/** The first record the source gives: the list's first page, else the test record. */
export async function firstRecord(
  def: AnyConnector,
  cc: ConnectorContext<unknown, unknown>,
): Promise<UpstreamRecord | null> {
  if (def.listChanges && (def.hasList?.(cc.connection.config) ?? true)) {
    const page = await def.listChanges(cc, null);
    const first = page.changes.find((c) => !c.deleted);
    if (!first) return null;
    if (first.record) return first.record;
    const fetched = await def.fetchRecord(cc, first.ref);
    return fetched.status === 'ok' ? fetched.record : null;
  }
  const ref = (cc.connection.config as { testRef?: unknown }).testRef;
  if (typeof ref !== 'string' || !ref) return null;
  const fetched = await def.fetchRecord(cc, ref);
  return fetched.status === 'ok' ? fetched.record : null;
}

/**
 * Runs the connector's test and reads one record for an unsaved configuration, through the
 * platform safe fetch. Nothing is stored; the secrets live for this request only.
 */
export async function testConfig(
  sctx: ServiceContext,
  actor: Actor,
  input: Input,
  authority?: ConnectionAuthority,
): Promise<Result> {
  if (authority && authority.orgId !== input.orgId) throw new ForbiddenError();
  await assertConnectionAuthority(sctx, authority);
  const def = requireConnector(input.connectorType);
  await assertOrg(sctx, input.orgId);
  const config = parseWith(def.configSchema, input.config, 'config');
  const secrets = def.secretSchema
    ? parseWith(def.secretSchema, input.secrets ?? {}, 'secrets')
    : undefined;
  if (def.urls) {
    await assertConnectionAuthority(sctx, authority);
    await assertSafeUrls(sctx, def.urls(config));
  }
  const startedAt = sctx.clock.now();
  if (!def.listChanges && !def.urls) {
    await assertConnectionAuthority(sctx, authority);
    // Push-only connectors fetch nothing; records arrive in signed webhooks.
    return { ok: true, detail: 'Records arrive by webhook.', durationMs: 0 };
  }
  const deps = getDeps();
  const cc: ConnectorContext<unknown, unknown> = {
    connection: { id: 'test', orgId: input.orgId, generation: 0, config },
    secrets,
    now: () => sctx.clock.now(),
    fetch: createSafeFetch({
      platformHosts: [new URL(baseUrl(sctx.env)).hostname, 'workers.dev'],
      timeoutMs: def.defaults.timeoutMs,
      ...(deps.resolver ? { resolver: deps.resolver } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
    log: (event, data) =>
      sctx.log.info(`connector.${event}`, { orgId: input.orgId, connectorType: def.type, ...data }),
  };
  let result: Result;
  try {
    await assertConnectionAuthority(sctx, authority);
    const outcome = (await def.test?.(cc)) ?? { ok: true as const };
    await assertConnectionAuthority(sctx, authority);
    const record = await firstRecord(def, cc);
    result = {
      ok: true,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      durationMs: sctx.clock.now() - startedAt,
      ...(record ? { sample: sampleFields(record) } : {}),
    };
  } catch (error) {
    await assertConnectionAuthority(sctx, authority);
    const failure = classify(error);
    if (failure.code === 'INTERNAL')
      sctx.log.error('connection.test_config_failed', { orgId: input.orgId, code: failure.code });
    result = { ok: false, errorCode: failure.code, durationMs: sctx.clock.now() - startedAt };
  }
  await recordConnectionAudit(
    sctx,
    {
      orgId: input.orgId,
      ...auditActor(actor),
      action: 'connection.test',
      targetType: 'connection',
      targetId: null,
      detail: { connectorType: def.type, ok: result.ok, errorCode: result.errorCode ?? null },
    },
    authority,
  );
  return result;
}
