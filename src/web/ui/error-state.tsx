import { ChevronRight, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { errorMessage, isApiError } from '../lib/errors.ts';
import { useChangeCount } from '../lib/motion.ts';
import { ACTED_STATES } from './art/state-acts.ts';
import { UnpluggedArt } from './art/unplugged.tsx';
import { Button } from './button.tsx';
import { useInCard } from './in-card.ts';
import { StateView } from './state-view.tsx';

export interface ErrorStateProps {
  error?: unknown;
  /** One sentence: what happened and what to do. Defaults to the error's message. */
  title?: string;
  /** What failed to load ("messages"): "Could not load messages." leads, the error's message follows. */
  subject?: string;
  /** May return a promise (refetch); the button shows the RefreshCw verb meanwhile. */
  onRetry?: () => unknown;
  retryLabel?: string;
  action?: ReactNode;
  /**
   * A section of a page (a tab, a card): the small art, no buddy, so a view has one at most.
   * Defaults to true inside a Card (InCardContext), false elsewhere; pass it to override.
   */
  inline?: boolean;
  /** `stage`: the Workbench's dot-grid canvas, as its empty states have. */
  surface?: 'stage';
  /** Replaces the sentence's type (the Workbench sets one scale for its states). */
  titleClassName?: string;
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
 * Slate card, one sentence, Try again; the request id hides under Details. The sad buddy stands inside
 * the box above the title beside the pulled plug (art/state-art.tsx, as on the SSR 500); inline, a danger tile on
 * the unplugged art. A failure after Try again shakes the art once; the first render never shakes.
 */
export function ErrorState({
  error,
  title,
  subject,
  onRetry,
  retryLabel = STATE_COPY.retry,
  action,
  inline: inlineProp,
  titleClassName,
  surface,
  className,
}: ErrorStateProps) {
  const inCard = useInCard();
  const inline = inlineProp ?? inCard;
  const requestId = isApiError(error) ? error.requestId : undefined;
  const code = isApiError(error) ? error.code : undefined;
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
    <StateView
      size={inline ? 'inline' : 'panel'}
      state="failed"
      picture={<UnpluggedArt size="sm" />}
      scene={ACTED_STATES.broken.scene}
      replay={tries}
      artRef={art}
      alert
      title={subject ? `Could not load ${subject}.` : (title ?? errorMessage(error))}
      line={subject ? (title ?? errorMessage(error)) : undefined}
      action={
        onRetry ? (
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
        ) : undefined
      }
      secondary={action}
      canvas={surface === 'stage' && !inline}
      {...(titleClassName ? { titleClassName } : {})}
      className={className}
    >
      {requestId || code ? (
        <details className="group text-xs text-fg-muted">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm px-1 hover:text-fg-strong pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-3.5 motion-safe:transition-transform motion-safe:duration-(--wl-dur-enter) group-open:rotate-90"
            />
            Details
          </summary>
          <p className="flex flex-col px-1 font-mono text-xs text-fg-muted">
            {code ? <span>Code {code}</span> : null}
            {requestId ? <span>Request {requestId}</span> : null}
          </p>
        </details>
      ) : null}
    </StateView>
  );
}
