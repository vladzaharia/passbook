import { decryptSecret, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Draft } from './checks.ts';

/** Present and usable: the ring loads and a round trip decrypts. Reports versions, never key material. */
export async function checkKek(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'kek', kind: 'build', label: 'Encryption key' } as const;
  try {
    const ring = await loadKekRing(ctx.env);
    const probe = new TextEncoder().encode('status');
    const sealed = await encryptSecret(ring, probe, 'status:kek');
    const opened = await decryptSecret(ring, sealed, 'status:kek');
    if (opened.length !== probe.length) throw new Error('KEK round trip mismatch');
    return {
      ...base,
      state: 'verified',
      detail: null,
      data: { currentVersion: ring.current, versions: ring.keys.size },
    };
  } catch (error) {
    ctx.log.error('status.kek_unavailable', { code: 'KEK_UNAVAILABLE', error });
    return { ...base, state: 'failing', detail: 'No usable KEK_V1 secret.' };
  }
}

interface FailureCount {
  kind: string;
  n: number;
}

/** Terminal failures kept for review: outbox rows that gave up and webhook payloads that failed. */
export async function checkTerminalFailures(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'failures', kind: 'queue', label: 'Terminal failures' } as const;
  let rows: FailureCount[];
  try {
    rows = await all<FailureCount>(
      ctx.env.DB,
      `SELECT 'outbox_' || kind AS kind, count(*) AS n FROM outbox WHERE state = 'failed' GROUP BY kind
     UNION ALL
     SELECT 'webhook' AS kind, count(*) AS n FROM connection_webhook_retention WHERE state = 'failed'`,
    );
  } catch (error) {
    ctx.log.warn('status.probe_failed', { component: 'failures', code: 'PROBE_FAILED', error });
    return { ...base, state: 'failing', detail: 'Probe failed.' };
  }
  const data: Record<string, number> = { outbox_push: 0, outbox_email: 0, webhook: 0 };
  for (const row of rows) data[row.kind] = row.n;
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  return {
    ...base,
    state: total > 0 ? 'degraded' : 'verified',
    detail: total > 0 ? `${total} retained: ${describe(data)}.` : null,
    data,
  };
}

const describe = (data: Record<string, number>) =>
  Object.entries(data)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ');
