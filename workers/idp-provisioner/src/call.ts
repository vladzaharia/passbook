import { alert, finish, logRefusal, reserve } from './ledger.ts';
import { type Deps, pocketRequest, type Req } from './pocket-http.ts';
import { type Budgeted, IdpError, type ProvisionerEnv } from './types.ts';

/** Ledger and budget plumbing around Pocket ID calls. The RPC bodies in api.ts only describe what to ask. */
export function createCall(env: ProvisionerEnv, deps: Deps) {
  const db = env.DB;

  /** Input and allowlist checks. A refusal is ledgered, then thrown; Pocket ID is not called. */
  async function guard<T>(
    method: string,
    target: string | null,
    caller: string | undefined,
    check: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof IdpError && error.code === 'IDP_REFUSED')
        await logRefusal(db, method, target, caller ?? null, deps.now(), error.message);
      throw error;
    }
  }

  /** Reserves budget, runs `fn`, and ledgers the outcome (status of the last Pocket ID request). */
  async function ledgered<T>(
    method: Budgeted,
    target: string | null,
    caller: string | undefined,
    fn: (req: Req) => Promise<T>,
  ): Promise<T> {
    const callId = crypto.randomUUID();
    const who = caller ?? null;
    const started = deps.now();
    await reserve(db, callId, method, target, who, started);
    let last: { status: string | null; requestId: string | null } = {
      status: null,
      requestId: null,
    };
    const req: Req = async (m, path, payload) => {
      const res = await pocketRequest(env, deps, m, path, payload);
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
        if (error.code === 'IDP_REFUSED')
          await logRefusal(db, method, target, who, deps.now(), error.message);
        if (error.code === 'IDP_AUTH') alert('error', 'provisioner.idp_auth', { method });
      }
    }
    try {
      await finish(
        db,
        callId,
        method,
        target,
        who,
        {
          status: last.status ?? 'error',
          requestId: last.requestId,
          durationMs: deps.now() - started,
        },
        deps.now(),
      );
    } catch {
      // The call already happened: a ledger write failure must not hide its outcome.
      alert('error', 'provisioner.ledger_write_failed', { method, callId });
    }
    if (result) return result.value;
    throw failed;
  }

  return { guard, ledgered };
}
export type Call = ReturnType<typeof createCall>;
