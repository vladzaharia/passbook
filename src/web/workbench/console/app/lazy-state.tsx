import { type ComponentProps, lazy, Suspense } from 'react';

// The Workbench states are their own chunk, so a console that is running reads and draws none of it.
const Failed = lazy(() =>
  import('../../states/states.tsx').then((m) => ({ default: m.ToolFailed })),
);
const Stage = lazy(() =>
  import('../../states/states.tsx').then((m) => ({ default: m.StageState })),
);

/** `ToolFailed`, loaded when first needed. */
export function LazyFailed(props: ComponentProps<typeof Failed>) {
  return (
    <Suspense fallback={null}>
      <Failed {...props} />
    </Suspense>
  );
}

/** `StageState`, loaded when first needed. */
export function LazyStage(props: ComponentProps<typeof Stage>) {
  return (
    <Suspense fallback={null}>
      <Stage {...props} />
    </Suspense>
  );
}
