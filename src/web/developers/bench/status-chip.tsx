import type { ReactNode } from 'react';
import { statusText } from '../ui/status-text.ts';
import './kit.css';

/** The bench's one status vocabulary. The words carry the meaning; the tone only agrees. */
export type StatusTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/** 2xx success, 1xx and 3xx info, 4xx warning, 5xx danger; no answer (null, 0) neutral. */
export function toneOfStatus(status: number | null | undefined): StatusTone {
  if (!status) return 'neutral';
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  if (status >= 200 && status < 300) return 'success';
  return 'info';
}

/** A delivery or job state: done success, failed danger, the rest (pending, rolling, paused) neutral. */
export function toneOfState(state: string): StatusTone {
  if (state === 'delivered' || state === 'succeeded' || state === 'active') return 'success';
  if (state === 'failed' || state === 'revoked') return 'danger';
  return 'neutral';
}

/**
 * A status as a small mono chip, 22 px tall. An HTTP status shows its number and names its reason in
 * the tooltip; anything else passes its words and a tone. Never a bare "-": no answer is a state.
 */
export function StatusChip({
  status,
  tone,
  children,
}: {
  status?: number | null;
  tone?: StatusTone;
  /** The words, when this is not an HTTP status ("Failed", "Pending"). */
  children?: ReactNode;
}) {
  const http = typeof status === 'number' && status > 0;
  return (
    <span
      className="bench-sc"
      data-tone={tone ?? toneOfStatus(status)}
      title={http ? statusText(status) : undefined}
    >
      {children ?? (http ? status : null)}
    </span>
  );
}
