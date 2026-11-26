import { type ComponentProps, lazy, Suspense } from 'react';

// The buddy's scenes are for the empty, idle and failed moments: their own chunk, so a console that
// is running reads and draws none of it.
const State = lazy(() => import('../../bench/state.tsx').then((m) => ({ default: m.BenchState })));

type Props = ComponentProps<typeof import('../../bench/state.tsx').BenchState>;

/** `BenchState`, loaded when first needed. */
export function LazyState(props: Props) {
  return (
    <Suspense fallback={null}>
      <State {...props} />
    </Suspense>
  );
}
