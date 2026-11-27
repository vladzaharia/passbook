import { useRef, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { StepMarker } from '../step-marker.tsx';
import type { SetupTopic } from './types.ts';

export interface TopicChecklistProps {
  topics: readonly SetupTopic[];
  /** Topic ids a delivery has named so far. Ticks draw as ids arrive. */
  seen?: readonly string[];
  heading?: string;
  /** Without ticks: the plain list of what to subscribe to (the guide's `topics` part). */
  plain?: boolean;
  className?: string;
}

/** "1 of 2 seen": required topics only. A test sends one topic, so optional ones never hold it up. */
export function topicProgress(topics: readonly SetupTopic[], seen: readonly string[]) {
  const required = topics.filter((t) => t.required);
  return { seen: required.filter((t) => seen.includes(t.id)).length, of: required.length };
}

/** The topics to subscribe to, required first, ticking as deliveries name them. */
export function TopicChecklist({
  topics,
  seen = [],
  heading = 'Topics',
  plain,
  className,
}: TopicChecklistProps) {
  const [all, setAll] = useState(false);
  // A tick draws only for a topic that arrived after the list mounted.
  const known = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  if (known.current === null) known.current = new Set(seen);
  for (const id of seen) {
    if (!known.current.has(id)) {
      known.current.add(id);
      fresh.current.add(id);
    }
  }
  const optional = topics.filter((t) => !t.required);
  const firstOptional = optional.find((t) => !seen.includes(t.id));
  const shown = topics.filter(
    (t) => all || plain || t.required || seen.includes(t.id) || t === firstOptional,
  );
  const hidden = topics.length - shown.length;
  // A label only where every topic has one: a mix reads as an inconsistency.
  const labelled = topics.every((t) => t.label);
  const progress = topicProgress(topics, seen);
  return (
    <section aria-label={heading} className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-fg-strong">{heading}</h4>
        {plain || progress.of === 0 ? null : (
          <span className="text-xs tabular-nums text-fg-muted">
            {progress.seen} of {progress.of} seen
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {shown.map((t) => {
          const got = seen.includes(t.id);
          return (
            <li key={t.id} className="flex min-h-6 items-center gap-2.5 text-sm">
              {plain ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-border-strong" />
              ) : got ? (
                <StepMarker state="done" n={0} size="sm" fresh={fresh.current.has(t.id)} />
              ) : (
                <span
                  aria-hidden
                  className="size-5 shrink-0 rounded-full border border-border-strong bg-surface-overlay"
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {labelled && t.label ? <span className="text-fg">{t.label} </span> : null}
                <span className={cn('font-mono text-xs', labelled ? 'text-fg-muted' : 'text-fg')}>
                  {t.id}
                </span>
                {plain ? null : <span className="sr-only">{got ? ' (seen)' : ' (not seen)'}</span>}
              </span>
              <span className="shrink-0 text-xs text-fg-muted">
                {t.required ? 'required' : 'optional'}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(true)}
          className="-my-1 min-h-8 self-start rounded-sm text-left text-xs text-fg-muted underline-offset-2 hover:text-fg-strong hover:underline focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
        >
          {hidden} more optional
        </button>
      ) : null}
    </section>
  );
}
