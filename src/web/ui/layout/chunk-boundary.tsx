import { Component, type ReactNode, Suspense } from 'react';
import { STATE_COPY } from '@/shared/copy/states.ts';

/** Plain markup and no kit imports: it must render when the chunk that holds the kit did not load. */
export function ChunkFallback() {
  return (
    <div
      role="alert"
      className="mx-auto grid min-h-[50dvh] max-w-sm place-content-center justify-items-center gap-4 p-6 text-center text-fg"
    >
      <p>{STATE_COPY.pageLoadFailed}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-on pointer-coarse:h-11"
      >
        {STATE_COPY.reload}
      </button>
    </div>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <ChunkFallback /> : this.props.children;
  }
}

/** A lazy chunk of the shell or the error pages: a skeleton while it loads, the fallback if it never does. */
export function ChunkBoundary({
  fallback = null,
  children,
}: {
  fallback?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Boundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </Boundary>
  );
}
