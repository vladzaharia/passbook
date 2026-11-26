import type { z } from 'zod';
import type {
  ProbeConfigSchema,
  ProbeConnectionSchema,
} from '../../../shared/contracts/connection-probe.ts';
import type { Config, Secrets } from '../../connectors/http-json/config.ts';
import type { ConnectorContext } from '../../connectors/types.ts';
import type { Actor } from '../../platform/context.ts';
import { bump } from '../../platform/counters.ts';
import { keyedDigest } from '../../platform/crypto.ts';
import { ForbiddenError, RateLimitedError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { connectorItem, requireConnectorEntitled } from './entitlement.ts';
import { masker } from './probe-mask.ts';
import { type ProbeRequest, type ProbeResult, runProbe } from './probe-run.ts';
import { readConnectorSecrets } from './secrets.ts';
import { auditActor, requireConnection } from './service-shared.ts';
import { assertCredentialOrigin, storedConfig } from './service-update.ts';
import { openUnsaved, unsavedContext } from './test-config.ts';
import { assertOrg, assertSafeUrls, parseWith, requireConnector } from './validate.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** A probe calls an outside host with the org's credentials and echoes what it says. */
export const PROBES_PER_HOUR = 60;
export const PROBES_PER_MINUTE = 10;

type Unsaved = z.infer<typeof ProbeConfigSchema>;
type Stored = z.infer<typeof ProbeConnectionSchema>;
type Ctx = ConnectorContext<Config, Secrets>;

/** One probe against the org's hourly allowance and the caller's minute allowance. */
export async function takeProbe(ctx: ServiceContext, orgId: string, actor: Actor): Promise<void> {
  const now = ctx.clock.now();
  const wait = (window: number, size: number) =>
    Math.max(1, Math.ceil((window + size - now) / 1000));
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const who = `${actor.type}:${actor.id ?? 'none'}`;
  if ((await bump(ctx.env.DB, `connection-probe:who:${who}`, minute)) > PROBES_PER_MINUTE)
    throw new RateLimitedError(wait(minute, MINUTE), 'Too many probes. Try again in a minute.');
  const hour = Math.floor(now / HOUR) * HOUR;
  if ((await bump(ctx.env.DB, `connection-probe:org:${orgId}`, hour)) > PROBES_PER_HOUR)
    throw new RateLimitedError(wait(hour, HOUR), 'Too many probes this hour. Try again later.');
}

/** The unsafe-URL refusal a save or test gives, as the probe's answer. */
function refused(error: unknown): ProbeResult | null {
  if (!(error instanceof ValidationError) || error.code !== 'UNSAFE_URL') return null;
  return {
    ok: false,
    errorCode: 'UNSAFE_URL',
    durationMs: 0,
    request: null,
    headers: {},
    pruned: null,
    detections: null,
    page: null,
  };
}

async function finish(
  sctx: ServiceContext,
  actor: Actor,
  orgId: string,
  targetId: string | null,
  baseUrl: string | null,
  result: ProbeResult | null,
): Promise<void> {
  // The audit names the host, the status and the outcome only; never a path, a query, a body or a credential.
  // It carries no authority predicate: a request that went out is recorded even if the grant lapsed meanwhile.
  await recordAudit(sctx, {
    orgId,
    ...auditActor(actor),
    action: 'connection.probe',
    targetType: 'connection',
    targetId,
    detail: {
      host: baseUrl && URL.canParse(baseUrl) ? new URL(baseUrl).host : null,
      status: result?.request?.status ?? null,
      ok: result?.ok ?? false,
    },
  });
}

/** Runs the probe for a built context; a request that went out is audited whatever happens next. */
async function execute(
  sctx: ServiceContext,
  actor: Actor,
  orgId: string,
  connectionId: string | null,
  cc: Ctx,
  req: ProbeRequest,
  secrets: unknown,
  authority: ConnectionAuthority,
): Promise<ProbeResult> {
  const config = cc.connection.config;
  const base = new URL(config.baseUrl);
  const tokens = {
    bind: `${orgId}|${connectionId ?? 'unsaved'}|${base.origin}|${base.pathname}`,
    mac: (value: string) => keyedDigest(sctx.env, 'connection-probe-token.v1', value),
  };
  let result: ProbeResult | null = null;
  try {
    result = await runProbe(cc, req, masker(secrets, config.auth.queryParam), tokens);
    await assertConnectionAuthority(sctx, authority);
    return result;
  } finally {
    await finish(sctx, actor, orgId, connectionId, config.baseUrl, result);
  }
}

const baseUrlOf = (config: unknown): string | null =>
  (config as Config | undefined)?.baseUrl ?? null;

/** Probes an unsaved configuration. Nothing is stored; the secrets live for this request only. */
export async function probeUnsaved(
  sctx: ServiceContext,
  actor: Actor,
  input: Unsaved,
  authority: ConnectionAuthority,
): Promise<ProbeResult> {
  await assertConnectionAuthority(sctx, authority);
  await takeProbe(sctx, input.orgId, actor);
  let opened: Awaited<ReturnType<typeof openUnsaved>>;
  try {
    opened = await openUnsaved(
      sctx,
      {
        orgId: input.orgId,
        connectorType: input.connectorType,
        config: input.config,
        ...(input.secrets ? { secrets: input.secrets } : {}),
      },
      authority,
    );
  } catch (error) {
    const result = refused(error);
    if (!result) throw error;
    await finish(sctx, actor, input.orgId, null, baseUrlOf(input.config), result);
    return result;
  }
  const cc = opened.cc as Ctx;
  return execute(sctx, actor, input.orgId, null, cc, input, cc.secrets, authority);
}

/** Probes a saved connection: its stored configuration and secrets unless the request gives its own. */
export async function probeStored(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
  input: Stored,
  authority: ConnectionAuthority,
): Promise<ProbeResult> {
  const conn = await requireConnection(sctx, id);
  if (authority.orgId !== conn.orgId) throw new ForbiddenError();
  const def = requireConnector(conn.connectorType);
  if (def.type !== 'http-json')
    throw new ValidationError('Only REST API connections can be probed.', [
      { path: 'connectorType', message: 'Not a REST API connection.' },
    ]);
  await assertConnectionAuthority(sctx, authority);
  await takeProbe(sctx, conn.orgId, actor);
  await assertOrg(sctx, conn.orgId);
  let config: Config;
  try {
    if (input.config) {
      config = parseWith(def.configSchema, input.config, 'config') as Config;
      await requireConnectorEntitled(sctx, conn.orgId, connectorItem(def.type, {}));
      await assertSafeUrls(sctx, def.urls?.(config) ?? []);
      // Stored secrets never travel to a host they were not entered for.
      assertCredentialOrigin(def, conn, config as Record<string, unknown>, input.secrets);
    } else {
      config = storedConfig(def, conn) as Config;
    }
  } catch (error) {
    const result = refused(error);
    if (!result) throw error;
    await finish(sctx, actor, conn.orgId, id, baseUrlOf(input.config), result);
    return result;
  }
  const given = input.secrets ?? (await readConnectorSecrets(sctx, conn)) ?? {};
  const secrets = (
    def.secretSchema ? parseWith(def.secretSchema, given, 'secrets') : {}
  ) as Secrets;
  await assertConnectionAuthority(sctx, authority);
  const cc = unsavedContext(sctx, def, conn.orgId, config, secrets) as Ctx;
  return execute(sctx, actor, conn.orgId, id, cc, input as ProbeRequest, secrets, authority);
}
