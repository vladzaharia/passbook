import { ctxMeta, type Meta, meta, noteCall } from './ledger.ts';
import { withLock } from './lock.ts';
import type { Req } from './pocket-http.ts';
import { assertCtx, refuse } from './policy.ts';
import type { Registry, Settings } from './registry.ts';
import type { Shared } from './shared.ts';
import type { Bucket } from './types.ts';

export interface Run {
  req: Req;
  /** The caller's `dryRun` alone: setup writes are not gated by `WRITE_MODE` (design 3.4). */
  dry: boolean;
  registry: Registry;
  settings: Settings;
  m: Meta;
  ref: string;
  /** Ledgers a dry run: the request that would have gone out is computed, none is sent. */
  note(): Promise<void>;
}

/**
 * What the six setup writes share: a validated context, the freeze and settings gate, one budget start (`preview`
 * for a dry run), the ledger, and a lease so two setup calls never interleave a read-modify-write.
 */
export function setupRunner(s: Shared) {
  return async function run<T>(
    o: {
      method: string;
      delta: string;
      lease: string;
      bucket: Bucket;
      check?: (registry: Registry) => void;
      /** Reads health again instead of trusting the cache: for the writes that decide who can sign in. */
      fresh?: boolean;
    },
    ctx: unknown,
    fn: (x: Run) => Promise<T>,
  ): Promise<T> {
    const c = await s.call.guard(meta(o.method), () => {
      // `WRITE_MODE` does not guard these, so a caller that forgot the flag must not get a live write.
      if (typeof (ctx as { dryRun?: unknown } | null)?.dryRun !== 'boolean')
        refuse('Setup needs dryRun true or false.');
      return assertCtx(ctx);
    });
    const m = ctxMeta(o.method, c, { delta: o.delta });
    const { registry, settings } = await s.gate.requireSetup(m, o.fresh);
    await s.call.guard(m, () => o.check?.(registry));
    const dry = c.dryRun;
    return s.call.ledgered(dry ? 'preview' : o.bucket, m, (req) =>
      withLock(s.db, o.lease, s.deps.now, () =>
        fn({
          req,
          dry,
          registry,
          settings,
          m,
          ref: c.ref,
          note: () => noteCall(s.db, 'dry_run', m, s.deps.now(), 'dry_run'),
        }),
      ),
    );
  };
}
