import { lazy, Suspense } from 'react';

// A second hop keeps the Console's preload list out of the Home route's own chunk.
const ReadOnlyConsole = lazy(() => import('./readonly-console.tsx'));

export default function ReadOnlyConsoleGate() {
  return (
    <Suspense fallback={null}>
      <ReadOnlyConsole />
    </Suspense>
  );
}
