import { useEffect, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { BenchSkeleton } from '../../bench/skeleton.tsx';
import { BenchState } from '../../bench/state.tsx';
import { loadFile } from '../data.ts';
import type { Prefill } from '../prefill.ts';
import type { Sandbox } from '../session.ts';
import { retain } from '../token.ts';
import type { RunOp } from '../types.ts';
import { OpConsole } from './console.tsx';

type Loaded = { op: RunOp; origin: string } | 'missing' | null;

function useOp(slug: string | undefined, id: string | undefined): Loaded {
  const [state, setState] = useState<Loaded>(null);
  useEffect(() => {
    setState(null);
    if (!slug || !id) return;
    let live = true;
    loadFile(slug).then(
      (f) => {
        const op = f.ops.find((o) => o.id === id);
        if (live) setState(op ? { op, origin: f.origin } : 'missing');
      },
      () => live && setState('missing'),
    );
    return () => {
      live = false;
    };
  }, [slug, id]);
  return state;
}

/** One operation of a sandbox in use: its file is read, then the console for it. Keeps the try token fresh. */
export function Ready({
  sandbox,
  csrf,
  mode,
  slug,
  opId,
  codes,
  prefill,
}: {
  sandbox: Sandbox;
  csrf: string;
  mode: 'op' | 'console' | 'sheet';
  slug?: string | undefined;
  opId?: string | undefined;
  codes: ReadonlySet<string>;
  prefill?: Prefill | undefined;
}) {
  const loaded = useOp(slug, opId);
  useEffect(() => retain(csrf), [csrf]);
  if (loaded === 'missing')
    return (
      <BenchState
        scene="failed"
        title={CONSOLE_COPY.loadFailed}
        onRetry={() => location.reload()}
      />
    );
  if (!loaded) return <BenchSkeleton rows={3} />;
  return (
    <OpConsole
      key={loaded.op.id}
      op={loaded.op}
      origin={loaded.origin}
      csrf={csrf}
      templateId={sandbox.templateId}
      codes={codes}
      mode={mode}
      prefill={prefill ?? undefined}
    />
  );
}
