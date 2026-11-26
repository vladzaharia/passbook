import { useEffect, useState } from 'react';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchGate, BenchState } from '../bench/state.tsx';
import type { TesterAuth } from './client.ts';
import { Workspace } from './workspace.tsx';

export function Tester({
  connect,
  types,
}: {
  connect: () => Promise<TesterAuth>;
  types: readonly string[];
}) {
  const [auth, setAuth] = useState<TesterAuth | 'loading' | 'error'>('loading');
  const [pending, setPending] = useState(connect);
  useEffect(() => {
    let live = true;
    setAuth('loading');
    pending.then(
      (a) => live && setAuth(a),
      () => live && setAuth('error'),
    );
    return () => {
      live = false;
    };
  }, [pending]);

  if (auth === 'loading') return <BenchSkeleton rows={5} />;
  if (auth === 'error') return <BenchState scene="failed" onRetry={() => setPending(connect())} />;
  if (auth.kind === 'signed-out') return <BenchGate tool="webhooks" />;
  if (auth.kind === 'no-sandbox')
    return (
      <BenchState scene="no-sandbox" title={BENCH_WEBHOOKS_COPY.states.sandboxFirst}>
        <a className="btn" href={PATHS.quickstart}>
          {BENCH_WEBHOOKS_COPY.states.quickstart}
        </a>
      </BenchState>
    );
  return <Workspace api={auth.api} types={types} />;
}
