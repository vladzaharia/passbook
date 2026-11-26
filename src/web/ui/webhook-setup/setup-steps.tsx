import { ChevronDown, ExternalLink, Info } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { formatMonthYear } from '../../lib/format.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { CheckboxField } from '../checkbox.tsx';
import { StepMarker } from '../step-marker.tsx';
import { groupParts, SetupPartView } from './setup-part.tsx';
import type { SetupStep, SetupTopic, SetupValues } from './types.ts';

export interface SetupStepsProps {
  steps: readonly SetupStep[];
  /** What `copy` fields resolve to. */
  values: SetupValues;
  topics?: readonly SetupTopic[];
  /** Done ticks persist here per connection (a convenience: nothing depends on them). */
  storageKey?: string;
  className?: string;
}

function readDone(key: string | undefined): string[] {
  if (!key) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function useDone(key: string | undefined) {
  const [done, setDone] = useState<string[]>(() => readDone(key));
  useEffect(() => setDone(readDone(key)), [key]);
  function set(next: string[]) {
    setDone(next);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage is a convenience; the ticks stay for this view.
    }
  }
  return [done, set] as const;
}

/**
 * The provider's side as numbered steps, rendered from the guide's data. At 640 and up every step
 * is open. On a phone they are an accordion, one open at a time, and ticking a step Done opens the
 * next.
 */
export function SetupSteps({ steps, values, topics = [], storageKey, className }: SetupStepsProps) {
  const phone = useMediaQuery(PHONE);
  const base = useId();
  const [done, setDone] = useDone(storageKey);
  const firstOpen = Math.max(
    0,
    steps.findIndex((s) => !done.includes(s.id)),
  );
  const [open, setOpen] = useState<number | null>(null);
  const at = open ?? firstOpen;

  function tick(i: number, id: string) {
    const on = !done.includes(id);
    setDone(on ? [...done, id] : done.filter((x) => x !== id));
    if (on && phone) setOpen(Math.min(i + 1, steps.length - 1));
  }

  return (
    <div className={cn('@container min-w-0', className)}>
      <ol className="flex flex-col gap-5">
        {steps.map((s, i) => {
          const finished = done.includes(s.id);
          const shown = !phone || at === i;
          const head = `${base}-h${i}`;
          const body = `${base}-b${i}`;
          const title = (
            <>
              <StepMarker state={finished ? 'done' : 'todo'} n={i + 1} />
              <span className="min-w-0 flex-1 text-left text-sm font-medium text-fg-strong">
                {s.title}
                {finished ? <span className="sr-only"> (done)</span> : null}
              </span>
            </>
          );
          return (
            <li key={s.id} data-open={shown || undefined} className="min-w-0">
              {phone ? (
                <button
                  type="button"
                  id={head}
                  aria-expanded={shown}
                  aria-controls={body}
                  onClick={() => setOpen(shown ? -1 : i)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {title}
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      'size-4 shrink-0 text-fg-muted transition-transform duration-(--wl-dur-hover) motion-reduce:transition-none',
                      shown && 'rotate-180',
                    )}
                  />
                </button>
              ) : (
                <div className="flex items-center gap-3">
                  <h4 id={head} className="contents">
                    {title}
                  </h4>
                  {s.side === 'passbook' ? (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted">
                      In PassBook
                    </span>
                  ) : null}
                </div>
              )}
              <section
                id={body}
                aria-labelledby={head}
                hidden={!shown}
                className="mt-3 flex min-w-0 flex-col gap-3 pl-0 @lg:pl-9"
              >
                {groupParts(s.parts).map((part, k) => (
                  <SetupPartView
                    // Parts have no ids: they never reorder within a step.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static guide data
                    key={k}
                    part={part}
                    values={values}
                    topics={topics}
                  />
                ))}
                {s.verified === false ? (
                  <p className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <Info aria-hidden className="size-3.5 shrink-0" />
                    Labels may differ.
                  </p>
                ) : null}
                <CheckboxField
                  label="Done"
                  checked={finished}
                  onCheckedChange={() => tick(i, s.id)}
                  className="w-fit"
                />
              </section>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Where the guide came from: the provider's own pages, and when it was last checked against them. */
export function SetupSources({
  provider,
  consoleUrl,
  docs,
  checkedAt,
  className,
}: {
  provider: string;
  consoleUrl?: string | null | undefined;
  docs: readonly { label: string; url: string }[];
  checkedAt: string;
  className?: string;
}) {
  const link =
    'inline-flex min-h-8 items-center gap-1 rounded-sm text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11';
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-fg-muted',
        className,
      )}
    >
      <span className="flex flex-wrap items-center gap-x-4">
        {consoleUrl ? (
          <a href={consoleUrl} target="_blank" rel="noreferrer" className={link}>
            Open {provider} <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only"> (new tab)</span>
          </a>
        ) : null}
        {docs.map((d) => (
          <a key={d.url} href={d.url} target="_blank" rel="noreferrer" className={link}>
            {d.label} <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only"> (new tab)</span>
          </a>
        ))}
      </span>
      <span>Checked {formatMonthYear(checkedAt)}</span>
    </div>
  );
}
