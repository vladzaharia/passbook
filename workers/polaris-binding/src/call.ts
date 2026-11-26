import { isFrozen, writeFreeze } from './freeze.ts';
import { alert, finish, logRefusal, type Meta, reserve } from './ledger.ts';
import { type Deps, pocketRequest, type Req } from './pocket-http.ts';
import { type BindingEnv, type Bucket, IdpError } from './types.ts';

/** Ledger and budget plumbing around Polaris ID calls. The RPC bodies only describe what to ask. */
export function createCall(env: BindingEnv, deps: Deps) {
  const db = env.DB;

  /** Input and allowlist checks. A refusal is ledgered, then thrown; Polaris ID is not called. */
  async function guard<T>(m: Meta, check: () => Promise<T> | T): Promise<T> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof IdpError && error.code === 'IDP_REFUSED')
        await logRefusal(db, m, deps.now(), error.message);
      throw error;
    }
  }

  /** Reserves budget per bucket, runs `fn`, and ledgers the outcome (status of the last Polaris ID request). */
  async function ledgered<T>(
    buckets: Bucket | Bucket[],
    m: Meta,
    fn: (req: Req) => Promise<T>,
  ): Promise<T> {
    const callId = crypto.randomUUID();
    const started = deps.now();
    for (const bucket of Array.isArray(buckets) ? buckets : [buckets])
      await reserve(db, callId, bucket, m, started);
    let last: { status: string | null; requestId: string | null } = {
      status: null,
      requestId: null,
    };
    const req: Req = async (method, path, payload, timeoutMs) => {
      // A freeze that lands mid-call stops the next write, not only the next call.
      if (method !== 'GET' && (await isFrozen(db))) {
        await logRefusal(db, m, deps.now(), 'IDP_FROZEN');
        throw new IdpError('IDP_FROZEN', 'Polaris ID changes are paused.');
      }
      const res = await pocketRequest(env, deps, method, path, payload, timeoutMs);
      last = { status: String(res.status), requestId: res.requestId };
      return res;
    };
    let result: { value: T } | undefined;
    let failed: unknown;
    try {
      result = { value: await fn(req) };
    } catch (error) {
      failed = error;
      if (error instanceof IdpError) {
        // The code, not the last HTTP status: a refused read that answered 200 must not ledger as 200.
        last.status = error.code;
        if (error.code === 'IDP_REFUSED') await logRefusal(db, m, deps.now(), error.message);
        if (error.code === 'IDP_AUTH') alert('error', 'binding.idp_auth', { method: m.method });
      }
    }
    try {
      await finish(
        db,
        callId,
        m,
        {
          status: last.status ?? 'error',
          requestId: last.requestId,
          durationMs: deps.now() - started,
        },
        deps.now(),
      );
    } catch {
      // The call already happened: a ledger write failure must not hide its outcome.
      alert('error', 'binding.ledger_write_failed', { method: m.method, callId });
    }
    if (failed instanceof IdpError && failed.code === 'IDP_DRIFT') await driftStorm();
    if (result) return result.value;
    throw failed;
  }

  /** Three drifts in ten minutes mean something else is writing: pause changes until the owner looks. */
  async function driftStorm(): Promise<void> {
    const row = await db
      .prepare(
        "SELECT count(*) AS n FROM idp_calls WHERE phase = 'end' AND status = 'IDP_DRIFT' AND at > ?",
      )
      .bind(deps.now() - 600_000)
      .first<{ n: number }>();
    if ((row?.n ?? 0) < 3) return;
    if ((await writeFreeze(db, 'drift_storm', 'system:binding', deps.now())) === 'frozen')
      alert('error', 'binding.drift_storm', { drifts: row?.n });
  }

  return { guard, ledgered };
}
export type Call = ReturnType<typeof createCall>;
