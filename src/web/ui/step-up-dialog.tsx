import { useEffect, useSyncExternalStore } from 'react';
import { STEP_UP_COPY } from '@/shared/copy/step-up.ts';
import { dismissStepUp, pendingStepUp, subscribeStepUp } from '../lib/step-up.ts';
import { restoreDraft, saveDraft } from '../lib/step-up-draft.ts';
import { stepUpExit, stepUpHref } from '../lib/step-up-exit.ts';
import { ConfirmDialog } from './alert-dialog.tsx';

/** "Confirm it's you": mounted once at the root; any API call answered STEP_UP_REQUIRED opens it. */
export function StepUpDialog() {
  const signInUrl = useSyncExternalStore(subscribeStepUp, pendingStepUp);
  // Back from Polaris ID: put the typed fields back, once.
  useEffect(() => restoreDraft(`${window.location.pathname}${window.location.search}`), []);
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
        const here = `${window.location.pathname}${window.location.search}`;
        saveDraft(here);
        stepUpExit.go(stepUpHref(signInUrl || '/auth/oidc/start?prompt=login&max_age=0', here));
      }}
    />
  );
}
