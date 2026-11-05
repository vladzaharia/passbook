import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { useMediaQuery } from '../lib/media.ts';
import { prefersReducedMotion, useChangeCount } from '../lib/motion.ts';
import { Button } from './button.tsx';
import { Tick } from './checkbox.tsx';
import { useBlockedSubmit } from './form.tsx';
import { WizardStage } from './wizard-stage.tsx';

export interface WizardStep {
  id: string;
  title: string;
}

export interface WizardProps {
  steps: readonly WizardStep[];
  /** Index of the current step. */
  current: number;
  /** A done step was clicked: go back to it (its state is kept by the caller). */
  onStep: (index: number) => void;
  /** Live preview or summary: a stage right of the steps at 1024 and up, hidden below. */
  aside?: ReactNode;
  /** The stage's visible label and landmark name. */
  asideLabel?: string;
  /**
   * Cancel only navigates away: the page's useUnsavedChangesGuard asks once when there is unsaved
   * input, like any other way out.
   */
  onCancel: () => void;
  onBack?: () => void;
  /**
   * Without formId: Next runs this. Returning false (exactly) means the step is incomplete: once its errors
   * render, the first invalid control takes focus and one summary is announced.
   * With formId: Next submits that form (its validation runs).
   */
  onNext?: () => unknown;
  formId?: string;
  /** "Next" on early steps, "Create" on the last. */
  nextLabel?: string;
  /** Next or Create cannot run yet (the step explains why). */
  nextDisabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}

/** Numbered circles joined by a hairline that fills; done steps are buttons with a check. */
export function Stepper({
  steps,
  current,
  onStep,
}: Pick<WizardProps, 'steps' | 'current' | 'onStep'>) {
  const progress = steps.length > 1 ? current / (steps.length - 1) : 1;
  const step = steps[current];
  return (
    <nav aria-label="Steps">
      <div className="sm:hidden">
        <p className="text-sm text-fg-muted">
          Step {current + 1} of {steps.length}
          {step ? <span className="text-fg-strong"> · {step.title}</span> : null}
        </p>
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-border">
          <div
            className="wl-fill h-full origin-left rounded-full bg-accent"
            style={{ transform: `scaleX(${(current + 1) / steps.length})` } as CSSProperties}
          />
        </div>
      </div>
      <ol
        className="relative grid items-start max-sm:hidden"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {/* Circles sit at equal column centres; the line runs from the first to the last. */}
        <span
          aria-hidden
          className="absolute top-2.5 h-px bg-border"
          style={{ left: `${50 / steps.length}%`, right: `${50 / steps.length}%` }}
        >
          <span
            className="wl-fill absolute inset-0 origin-left bg-accent"
            style={{ transform: `scaleX(${progress})` } as CSSProperties}
          />
        </span>
        {steps.map((s, i) => {
          const done = i < current;
          const here = i === current;
          const circle = (
            <span
              className={cn(
                'relative inline-flex size-5 items-center justify-center rounded-full border text-[0.6875rem] font-semibold tabular-nums',
                done && 'wl-step-done border-accent bg-accent text-accent-on',
                here && 'border-accent bg-surface-page text-accent-fg',
                !done && !here && 'border-border-strong bg-surface-page text-fg-muted',
              )}
            >
              {done ? <Tick draw className="size-3" /> : i + 1}
            </span>
          );
          return (
            <li key={s.id} className="relative flex min-w-0 flex-col items-center gap-1.5">
              {done ? (
                <button
                  type="button"
                  onClick={() => onStep(i)}
                  className="group flex flex-col items-center gap-1.5 rounded-md"
                >
                  {circle}
                  <span className="text-xs text-fg-muted group-hover:text-fg-strong">
                    {s.title}
                  </span>
                </button>
              ) : (
                <span
                  aria-current={here ? 'step' : undefined}
                  className="flex flex-col items-center gap-1.5"
                >
                  {circle}
                  <span className={cn('text-xs', here ? 'text-fg-strong' : 'text-fg-muted')}>
                    {s.title}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Fixed at the bottom like SaveBar (beside the sidebar at 1024 and up): Cancel left, Back and
 * Next or Create right.
 */
export function WizardBar({
  onCancel,
  onBack,
  onNext,
  formId,
  nextLabel = 'Next',
  nextDisabled,
  busy,
}: Pick<
  WizardProps,
  'onCancel' | 'onBack' | 'onNext' | 'formId' | 'nextLabel' | 'nextDisabled' | 'busy'
>) {
  return (
    <section
      aria-label="Wizard actions"
      // Part of the page, not a transient bar: it arrives with the route, no slide.
      data-static=""
      className="wl-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-overlay pb-[env(safe-area-inset-bottom)] shadow-elevation-3 lg:left-60"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-2 px-safe py-3 sm:[--wl-gutter:1.5rem]">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <div className="flex gap-2">
          {onBack ? (
            <Button variant="outline" disabled={busy} onClick={onBack}>
              Back
            </Button>
          ) : null}
          <Button
            type={formId ? 'submit' : 'button'}
            form={formId}
            loading={busy}
            disabled={nextDisabled}
            onClick={formId ? undefined : onNext}
          >
            {nextLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * The wizard shell: Stepper on top, one content width on every step, the aside as a stage at 1024
 * and up, and the WizardBar. A step change scrolls to the top and focuses the step heading (for
 * screen readers; the stepper shows it); the new step slides 16 px in from the direction of travel
 * (opacity only under reduced motion).
 */
export function Wizard({
  steps,
  current,
  onStep,
  aside,
  asideLabel = 'Preview',
  children,
  onNext,
  ...bar
}: WizardProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const blocked = useBlockedSubmit<HTMLDivElement>();
  // The stage is a desktop companion; below 1024 it would stack under the step as dead space.
  const staged = useMediaQuery('(min-width: 1024px)') && Boolean(aside);
  const previous = useRef(current);
  const direction = current >= previous.current ? 1 : -1;
  const changed = useChangeCount(current);
  useEffect(() => {
    previous.current = current;
    if (!changed) return;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    heading.current?.focus({ preventScroll: true });
  }, [current, changed]);
  const step = steps[current];
  const body = (
    <div
      key={current}
      ref={blocked.ref}
      data-step={step?.id}
      className={cn('flex min-w-0 flex-col gap-6', changed > 0 && 'wl-step')}
      style={{ '--wl-step-x': `${direction * 16}px` } as CSSProperties}
    >
      <h2 ref={heading} tabIndex={-1} className="sr-only">
        {step?.title}
      </h2>
      {children}
      {blocked.live}
    </div>
  );
  const next = onNext
    ? () => {
        if (onNext() === false) blocked.block();
      }
    : undefined;
  return (
    <div data-staged={staged || undefined} className="wl-wizard flex min-w-0 flex-col gap-6 pb-24">
      <Stepper steps={steps} current={current} onStep={onStep} />
      {body}
      {staged ? <WizardStage label={asideLabel}>{aside}</WizardStage> : null}
      <WizardBar {...bar} onNext={next} />
    </div>
  );
}
