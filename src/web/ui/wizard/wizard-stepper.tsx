import { ChevronDown } from 'lucide-react';
import { type CSSProperties, type ReactNode, useId, useRef } from 'react';
import { cn } from '../../lib/cn.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu.tsx';
import { StepMarker } from '../step-marker.tsx';
import type { WizardRail } from './wizard-types.ts';

/**
 * The wizard's steps. A frame 43.5rem wide or more shows a rail: numbered markers down the side,
 * done steps as buttons back to them with what was chosen under them. Narrower, one line, "Step 2
 * of 4 · Access", over a thin progress bar. Put it in a `@container` that holds the step too.
 */
export function WizardStepper({ wizard }: { wizard: WizardRail }) {
  const { steps, index } = wizard;
  const base = useId();
  // A marker pops only for a step that became done after this rail mounted, and keeps the class
  // until it leaves done (dropping it mid-animation would cut the pop short).
  const before = useRef(new Map<string, string>());
  const popped = useRef(new Set<string>());
  for (const s of steps) {
    const was = before.current.get(s.id);
    if (s.state !== 'done') popped.current.delete(s.id);
    else if (was !== undefined && was !== 'done') popped.current.add(s.id);
    before.current.set(s.id, s.state);
  }
  const live = steps.filter((s) => !s.skip);
  const at = steps.slice(0, index + 1).filter((s) => !s.skip).length;
  const step = steps[index];
  const line = (
    <>
      Step {at} of {live.length}
      {step ? <span className="text-fg-strong"> · {step.title}</span> : null}
    </>
  );
  return (
    <nav aria-label="Steps" className="@[43.5rem]:w-52 @[43.5rem]:shrink-0">
      <div className="@[43.5rem]:hidden">
        {wizard.mode === 'edit' ? (
          <StepPicker wizard={wizard} line={line} />
        ) : (
          <p className="text-sm text-fg-muted">{line}</p>
        )}
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-border">
          <div
            className="wl-fill h-full origin-left rounded-full bg-accent"
            style={{ transform: `scaleX(${at / Math.max(live.length, 1)})` } as CSSProperties}
          />
        </div>
      </div>
      <ol className="relative hidden flex-col @[43.5rem]:flex">
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          const n = steps.slice(0, i + 1).filter((x) => !x.skip).length;
          const here = s.state === 'current';
          const jump =
            s.state === 'done' ||
            s.state === 'invalid' ||
            (wizard.mode === 'edit' && !here && s.state !== 'skipped');
          const summary = s.state === 'done' && s.summary ? s.summary : undefined;
          const word =
            s.state === 'invalid' ? 'needs attention' : s.state === 'skipped' ? 'skipped' : '';
          const ids = { title: `${base}-t${i}`, detail: `${base}-d${i}`, word: `${base}-w${i}` };
          const described = [summary && ids.detail, word && ids.word].filter(Boolean).join(' ');
          const body = (
            <>
              <StepMarker state={s.state} n={n} fresh={popped.current.has(s.id)} />
              <span className="flex min-w-0 flex-col pt-0.5 text-left">
                <span
                  id={ids.title}
                  className={cn(
                    'text-sm',
                    here
                      ? 'font-medium text-fg-strong'
                      : s.state === 'done'
                        ? 'text-fg'
                        : 'text-fg-muted',
                    s.state === 'skipped' && 'line-through',
                    s.state === 'invalid' && 'text-fg-strong',
                    jump && 'group-hover:text-fg-strong',
                  )}
                >
                  {s.title}
                </span>
                {summary ? (
                  <span id={ids.detail} title={summary} className="truncate text-xs text-fg-muted">
                    {summary}
                  </span>
                ) : null}
                {word ? (
                  <span id={ids.word} className="sr-only">
                    {word}
                  </span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={s.id} className={cn('relative', !last && 'pb-6')}>
              {last ? null : (
                <span
                  aria-hidden
                  className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border"
                >
                  <span
                    className="wl-fill absolute inset-0 origin-top bg-accent"
                    style={{ transform: `scaleY(${s.state === 'done' ? 1 : 0})` } as CSSProperties}
                  />
                </span>
              )}
              {jump ? (
                <button
                  type="button"
                  aria-labelledby={ids.title}
                  aria-describedby={described || undefined}
                  onClick={() => wizard.go(s.id)}
                  className="group flex w-full items-start gap-3 rounded-md"
                >
                  {body}
                </button>
              ) : (
                <div aria-current={here ? 'step' : undefined} className="flex items-start gap-3">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const STATE_WORD = {
  invalid: 'Needs attention',
  skipped: 'Skipped',
  done: 'Done',
  current: 'Current',
} as const;

/** Compact edit mode: the "Step 2 of 4" line opens a list of every step, like the rail's buttons. */
function StepPicker({ wizard, line }: { wizard: WizardRail; line: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Go to step"
        className="-my-2 flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 text-left text-sm text-fg-muted focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="min-w-0 truncate">{line}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="sm:min-w-64">
        {wizard.steps.map((s, i) => {
          const n = wizard.steps.slice(0, i + 1).filter((x) => !x.skip).length;
          const word = s.state === 'todo' ? '' : STATE_WORD[s.state];
          return (
            <DropdownMenuItem
              key={s.id}
              disabled={s.state === 'skipped'}
              aria-current={s.state === 'current' ? 'step' : undefined}
              onSelect={() => wizard.go(s.id)}
            >
              <StepMarker state={s.state} n={n} size="sm" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {word ? <span className="text-xs text-fg-muted">{word}</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
