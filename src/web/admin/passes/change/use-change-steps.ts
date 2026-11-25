import type { z } from 'zod';
import type { ChangeRunPreviewSchema } from '@/shared/contracts/broadcasts-change.ts';
import { useWizard, type WizardModel, type WizardStepDef } from '../../../ui/index.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { exactNothing } from './review-step.tsx';
import type { ChangeStepId } from './steps.ts';
import type { ChangeWizard } from './use-change-wizard.ts';

type Preview = z.infer<typeof ChangeRunPreviewSchema>;

/** The text a notified holder needs before Next, or undefined. */
export const needsText = (w: ChangeWizard) =>
  w.notify && w.kind === 'fields' && w.message.trim() === '';

/** Why Review cannot run yet: the check is out, or there is nothing to do. */
function reviewWait(w: ChangeWizard, p: Preview | undefined) {
  if (!p || !w.fresh) return C.review.checking;
  if (p.targeted === 0 || exactNothing(p)) return C.review.nothing;
  return undefined;
}

/**
 * The wizard's steps: Change, Holders (skipped for a void, which tells nobody and starts now) and
 * Review. `onFinish` is the run button; a void asks first, so it is the page's to decide.
 */
export function useChangeSteps(
  w: ChangeWizard,
  onFinish: () => Promise<unknown> | unknown,
): WizardModel<ChangeStepId> {
  const p = w.preview.data;
  const void_ = w.kind === 'void';
  const wait = reviewWait(w, p);
  const steps: WizardStepDef<ChangeStepId>[] = [
    {
      id: 'change',
      title: C.steps.change,
      heading: C.headings.change,
      summary: w.kind === 'fields' ? `${C.kinds.fields}: ${w.rows.length}` : C.kinds[w.kind],
    },
    {
      id: 'holders',
      title: C.steps.holders,
      heading: C.headings.holders,
      skip: void_,
      summary: w.notify && w.tellable ? 'Notify' : 'Silent',
    },
    { id: 'review', title: C.steps.review, heading: C.headings.review },
  ];
  return useWizard<ChangeStepId>({
    steps,
    errors: {
      change: w.kind === 'fields' && !w.patch ? { fields: C.needChange } : {},
      holders: {
        ...(needsText(w) ? { message: C.holders.needMessage } : {}),
        ...(w.whenOk ? {} : { when: C.holders.needTime }),
      },
      review: wait ? { wait } : {},
    },
    hints: {
      change: C.needChange,
      holders: needsText(w) ? C.holders.needMessage : C.holders.needTime,
      ...(wait ? { review: wait } : {}),
    },
    fieldStep: {},
    onFinish,
  });
}
