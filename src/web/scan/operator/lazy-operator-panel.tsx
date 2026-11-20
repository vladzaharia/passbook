import { type ComponentProps, lazy, Suspense } from 'react';

const OperatorPanel = lazy(() =>
  import('./operator-panel.tsx').then((m) => ({ default: m.OperatorPanel })),
);

/** The desk's sidebar, loaded when an operator or folded device first needs it. */
export function LazyOperatorPanel(props: ComponentProps<typeof OperatorPanel>) {
  return (
    <Suspense fallback={null}>
      <OperatorPanel {...props} />
    </Suspense>
  );
}
