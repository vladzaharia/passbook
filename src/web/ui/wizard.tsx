import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { useChangeCount } from '../lib/change-count.ts';
import { useMediaQuery } from '../lib/media.ts';
import { useBlockedSubmit } from './form.tsx';
import { type WizardBarAction, WizardButtons } from './wizard/wizard-actions.tsx';
import { WizardStep } from './wizard/wizard-step.tsx';
import { WizardStepper } from './wizard/wizard-stepper.tsx';
import type { WizardRail, WizardStepDef, WizardStepState } from './wizard/wizard-types.ts';
import { WizardStage } from './wizard-stage.tsx';

export interface WizardProps {
  steps: readonly WizardStepDef[];
  /** From `useWizard().frame`: each step's state. Without it, steps behind are done. */
  states?: readonly WizardStepState[];
  /** One line at the foot of the step (from `useWizard().frame`). */
  formError?: string | undefined;
  /** A press on a blocked Next; without it the press announces the hint. */
  onBlocked?: () => void;
  /** What a locked step (`locked` on its def) says on hover: "Change this on the connection." */
  lockedReason?: string | undefined;
  /** Index of the current step. */
  current: number;
  /** A done step was clicked: go back to it (its state is kept by the caller). */
  onStep: (index: number) => void;
  /** Ids of steps this run does not need: a dashed circle and a struck label; Next hops over them. */
  skipped?: readonly string[];
  /** Live preview or summary: a stage right of the steps at 1024 and up, hidden below. */
  aside?: ReactNode;
  /** The stage's visible label and landmark name. */
  asideLabel?: string;
  /** Name the stage for screen readers only. */
  asideQuiet?: boolean;
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
  /** The last step ends in something hard to take back (a void): the button wears the danger style. */
  nextTone?: 'danger';
  /**
   * Next or Create cannot run yet (the step explains why). Soft: the button stays focusable, a press
   * neither submits nor calls onNext, and focuses the first invalid control or announces the hint.
   */
  nextDisabled?: boolean;
  /** Why Next is off, in a few words; shown beside it while it is disabled. */
  nextHint?: string;
  /** The page's own actions beside Back and Next (Skip for now, Copy URL on a phone); on a phone they and Cancel share a menu. */
  barMenu?: readonly WizardBarAction[] | undefined;
  busy?: boolean;
  children: ReactNode;
}

/**
 * Fixed at the bottom like SaveBar (beside the sidebar at 1024 and up): Cancel left, Back and
 * Next or Create right. one row on a phone too.
 */
export function WizardBar({
  onCancel,
  onBack,
  onNext,
  onBlocked,
  formId,
  nextLabel = 'Next',
  nextTone,
  nextDisabled,
  nextHint,
  barMenu,
  busy,
}: Pick<
  WizardProps,
  | 'onCancel'
  | 'onBack'
  | 'onNext'
  | 'formId'
  | 'nextLabel'
  | 'nextTone'
  | 'nextDisabled'
  | 'nextHint'
  | 'barMenu'
  | 'busy'
> & { onBlocked?: () => void }) {
  // The bar's height as a variable, so the page keeps its last line clear of it (a phone's bar is three rows).
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--wl-wizard-bar', `${el.offsetHeight}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty('--wl-wizard-bar');
    };
  }, []);
  return (
    <section
      ref={bar}
      aria-label="Wizard actions"
      // Part of the page, not a transient bar: it arrives with the route, no slide.
      data-static=""
      className="wl-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-overlay pb-[env(safe-area-inset-bottom)] shadow-elevation-3 lg:left-60"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-safe py-3 max-sm:flex-wrap sm:[--wl-gutter:1.5rem]">
        <WizardButtons
          keepCancel
          menu={barMenu}
          first={!onBack}
          label={nextLabel}
          tone={nextTone}
          blocked={nextDisabled}
          hint={nextHint}
          working={busy}
          formId={formId}
          onCancel={onCancel}
          onBack={onBack}
          onNext={onNext as (() => void) | undefined}
          onBlocked={onBlocked}
        />
      </div>
    </section>
  );
}

/** The rail model of a page wizard, from its props: done steps behind, to do ahead. */
function railOf({
  steps,
  states,
  current,
  onStep,
  skipped = [],
  lockedReason,
}: Pick<
  WizardProps,
  'steps' | 'states' | 'current' | 'onStep' | 'skipped' | 'lockedReason'
>): WizardRail {
  return {
    mode: 'create',
    lockedReason,
    index: current,
    steps: steps.map((s, i) => ({
      ...s,
      skip: skipped.includes(s.id),
      state:
        states?.[i] ??
        (s.locked
          ? 'done'
          : i === current
            ? 'current'
            : skipped.includes(s.id)
              ? 'skipped'
              : i < current
                ? 'done'
                : 'todo'),
    })),
    go: (to) => {
      const at = typeof to === 'number' ? to : steps.findIndex((s) => s.id === to);
      if (at >= 0) onStep(at);
    },
  };
}

/**
 * Progress above a page that is not a step (an import's check and results): the compact line and
 * bar. Capped under the rail's 43.5rem so it never turns into a rail.
 */
export function Stepper(props: Pick<WizardProps, 'steps' | 'current' | 'onStep' | 'skipped'>) {
  return (
    <div className="@container max-w-[40rem]">
      <WizardStepper wizard={railOf(props)} />
    </div>
  );
}

/**
 * The page wizard: the rail beside the step from 43.5rem of frame width (one compact line above
 * it below that), the aside as a stage at 1024 and up, and the WizardBar. A step change scrolls
 * to the top and focuses the step heading; the new step slides 16 px in from the direction of
 * travel (a fade under reduced motion). Next is soft-disabled: see `nextDisabled`.
 */
export function Wizard({
  steps,
  current,
  onStep,
  skipped,
  aside,
  asideLabel = 'Preview',
  asideQuiet,
  children,
  onNext,
  states,
  formError,
  onBlocked,
  lockedReason,
  ...bar
}: WizardProps) {
  const blocked = useBlockedSubmit<HTMLDivElement>();
  // The stage is a desktop companion; below 1024 it would stack under the step as dead space.
  const staged = useMediaQuery('(min-width: 1024px)') && Boolean(aside);
  const previous = useRef(current);
  const key = useChangeCount(current);
  const direction = current >= previous.current ? 1 : -1;
  useEffect(() => {
    previous.current = current;
  }, [current]);
  const rail = railOf({ steps, states, current, onStep, skipped, lockedReason });
  const view = {
    ...rail,
    id: steps[current]?.id ?? '',
    last: !steps.slice(current + 1).some((s) => !skipped?.includes(s.id)),
    finishing: Boolean(bar.busy),
    motion: { key, direction } as const,
    formError,
  };
  const next = onNext
    ? () => {
        if (onNext() === false) blocked.block(bar.nextHint);
      }
    : undefined;
  return (
    <div
      data-staged={staged || undefined}
      className="wl-wizard flex min-w-0 flex-col gap-6 pb-[calc(var(--wl-wizard-bar,6rem)+1.5rem)]"
    >
      <div className="@container">
        <div className="flex flex-col gap-5 @[43.5rem]:flex-row @[43.5rem]:gap-8">
          <div className="@[43.5rem]:sticky @[43.5rem]:top-[calc(4.5rem+env(safe-area-inset-top))] @[43.5rem]:self-start">
            <WizardStepper wizard={rail} />
          </div>
          <div ref={blocked.ref} className="@container min-w-0 flex-1">
            <WizardStep wizard={view} level={2}>
              {children}
            </WizardStep>
            {blocked.live}
          </div>
        </div>
      </div>
      {staged ? (
        <WizardStage label={asideLabel} quiet={asideQuiet}>
          {aside}
        </WizardStage>
      ) : null}
      <WizardBar
        {...bar}
        onNext={next}
        onBlocked={onBlocked ?? (() => blocked.block(bar.nextHint))}
      />
    </div>
  );
}
