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
    const req: Req = async (method, path, payload) => {
      const res = await pocketRequest(env, deps, method, path, payload);
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
    if (result) return result.value;
    throw failed;
  }

  return { guard, ledgered };
}
export type Call = ReturnType<typeof createCall>;
