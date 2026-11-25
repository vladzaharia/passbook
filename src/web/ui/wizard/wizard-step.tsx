import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import { useChangeCount } from '../../lib/change-count.ts';
import { cn } from '../../lib/cn.ts';
import { WizardStepContext } from './step-context.ts';
import type { WizardModel } from './use-wizard.ts';

/**
 * The step body: its heading, the slide from the direction of travel, and the one line a refused
 * finish leaves at the foot. On a step change the scroll container goes back to the top and the
 * heading takes focus; on first render focus is the dialog's (the `data-autofocus` field).
 * `level` is 3 under a dialog's title and 2 on a page under its h1.
 */
export function WizardStep<Id extends string>({
  wizard,
  level = 3,
  notice,
  children,
}: {
  wizard: WizardModel<Id>;
  level?: 2 | 3;
  /** At the top of the step, above the heading. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const changed = useChangeCount(wizard.motion.key);
  useEffect(() => {
    if (!changed) return;
    const body = heading.current?.closest<HTMLElement>('[data-dialog-body]');
    if (body) body.scrollTop = 0;
    else window.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [changed]);
  const step = wizard.steps[wizard.index];
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <WizardStepContext.Provider
      value={{ id: wizard.id, last: wizard.last, finishing: wizard.finishing }}
    >
      <div
        key={wizard.motion.key}
        data-step={wizard.id}
        className={cn('flex flex-col gap-5', changed > 0 && 'wl-step')}
        style={{ '--wl-step-x': `${wizard.motion.direction * 16}px` } as CSSProperties}
      >
        {notice}
        <Heading
          ref={heading}
          tabIndex={-1}
          className={
            step?.heading ? 'text-base font-semibold text-fg-strong outline-none' : 'sr-only'
          }
        >
          {step?.heading ?? step?.title}
        </Heading>
        {children}
        {wizard.formError ? (
          <p role="alert" className="text-sm text-danger">
            {wizard.formError}
          </p>
        ) : null}
      </div>
    </WizardStepContext.Provider>
  );
}
