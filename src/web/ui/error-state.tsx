import { ChevronRight, RefreshCw, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { errorMessage, isApiError } from '../lib/errors.ts';
import { useChangeCount } from '../lib/motion.ts';
import { Buddy } from './art/buddy.tsx';
import { UnpluggedArt } from './art/unplugged.tsx';
import { Button } from './button.tsx';

export interface ErrorStateProps {
  error?: unknown;
  /** One sentence: what happened and what to do. Defaults to the error's message. */
  title?: string;
  /** May return a promise (refetch); the button shows the RefreshCw verb meanwhile. */
  onRetry?: () => unknown;
  retryLabel?: string;
  action?: ReactNode;
  /** A section of a page (a tab, a card): the small art, no buddy, so a view has one at most. */
  inline?: boolean;
  className?: string;
}

/** A dynamic import that failed: offline, or a deploy replaced the chunk. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|error loading dynamically|ChunkLoadError|Failed to fetch dynamically/i.test(
    message,
  );
}

/**
 * Neutral card, one sentence, Retry; the request id hides under Details. The sad buddy sits on its
 * top edge beside the pulled plug; inline, a danger tile on the unplugged art. A failure after
 * Retry shakes the art once; the first render never shakes.
 */
export function ErrorState({
  error,
  title,
  onRetry,
  retryLabel = 'Retry',
  action,
  inline = false,
  className,
}: ErrorStateProps) {
  const requestId = isApiError(error) ? error.requestId : undefined;
  const [retrying, setRetrying] = useState(false);
  // Each Retry sends the buddy back to the plug.
  const [tries, setTries] = useState(0);
  const failedAgain = useChangeCount(error);
  const art = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const svg = art.current?.querySelector('svg');
    if (!failedAgain || !svg) return;
    svg.removeAttribute('data-shake');
    void svg.getBoundingClientRect();
    svg.setAttribute('data-shake', '');
  }, [failedAgain]);

  async function retry() {
    setTries((n) => n + 1);
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      className={cn(
        'relative flex flex-col items-center gap-4 rounded-lg border border-border bg-surface-raised p-4 text-center shadow-[var(--wl-edge),var(--pk-elevation-1)]',
        inline ? 'sm:flex-row sm:text-left' : 'mt-18 pt-8',
        className,
      )}
    >
      <div ref={art} className={inline ? 'relative shrink-0' : 'contents'}>
        {inline ? (
          <>
            <UnpluggedArt size="sm" />
            <span
              aria-hidden
              className="absolute -top-1 -left-1 inline-flex size-6 items-center justify-center rounded-md border border-danger-border bg-danger-subtle text-danger [&_svg]:size-3.5"
            >
              <TriangleAlert />
            </span>
          </>
        ) : (
          <Buddy mood="sad" scene="plug" replay={tries} prop={<UnpluggedArt size="sm" />} />
        )}
      </div>
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col items-center gap-2',
          inline && 'sm:items-start',
        )}
      >
        <p role="alert" className="max-w-[65ch] text-sm text-fg-strong">
          {title ?? errorMessage(error)}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button
              variant="outline"
              size="sm"
              loading={retrying}
              busy="spin"
              iconStart={<RefreshCw aria-hidden />}
              onClick={() => void retry()}
            >
              {retryLabel}
            </Button>
          ) : null}
          {action}
          {requestId ? (
            <details className="group text-xs text-fg-muted">
              <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm px-1 hover:text-fg-strong pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 motion-safe:transition-transform motion-safe:duration-(--wl-dur-enter) group-open:rotate-90"
                />
                Details
              </summary>
              <p className="px-1 font-mono text-xs text-fg-muted">Request {requestId}</p>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
