import { STEP_UP_COPY } from '@/shared/copy/sign-in.ts';
import { dismissStepUp, stepUpExit, stepUpHref, useStepUp } from '../lib/step-up.ts';
import { ConfirmDialog } from './alert-dialog.tsx';

/** "Confirm it's you": mounted once at the root; any API call answered STEP_UP_REQUIRED opens it. */
export function StepUpDialog() {
  const signInUrl = useStepUp();
  return (
    <ConfirmDialog
      open={signInUrl !== null}
      onOpenChange={(open) => {
        if (!open) dismissStepUp();
      }}
      title={STEP_UP_COPY.title}
      description={STEP_UP_COPY.body}
      confirmLabel={STEP_UP_COPY.confirm}
      onConfirm={() => {
        if (!signInUrl) return;
        const here = `${window.location.pathname}${window.location.search}`;
        stepUpExit.go(stepUpHref(signInUrl, here));
      }}
    />
  );
}
