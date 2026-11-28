import { useEffect, useSyncExternalStore } from 'react';
import { STEP_UP_COPY } from '@/shared/copy/step-up.ts';
import { dismissStepUp, pendingStepUp, subscribeStepUp } from '../lib/step-up.ts';
import { restoreDraft, saveDraft } from '../lib/step-up-draft.ts';
import { stepUpExit, stepUpHref } from '../lib/step-up-exit.ts';
import { ConfirmDialog } from './alert-dialog.tsx';
import { Button } from './button.tsx';
import { Sheet, SheetContent } from './sheet.tsx';

/** "Confirm it's you": mounted once at the root; any API call answered STEP_UP_REQUIRED opens it. */
export function StepUpDialog({ size = 'dialog' }: { size?: 'dialog' | 'sheet' }) {
  const signInUrl = useSyncExternalStore(subscribeStepUp, pendingStepUp);
  // Back from Polaris ID: put the typed fields back, once.
  useEffect(() => restoreDraft(`${window.location.pathname}${window.location.search}`), []);
  const onOpenChange = (open: boolean) => {
    if (!open) dismissStepUp();
  };
  const onConfirm = () => {
    const here = `${window.location.pathname}${window.location.search}`;
    saveDraft(here);
    stepUpExit.go(stepUpHref(signInUrl || '/auth/oidc/start?prompt=login&max_age=0', here));
  };
  if (size === 'sheet') {
    return (
      <Sheet open={signInUrl !== null} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          title={STEP_UP_COPY.title}
          footer={<Button onClick={onConfirm}>{STEP_UP_COPY.confirm}</Button>}
        >
          <p className="p-4 text-sm text-fg-muted">{STEP_UP_COPY.body}</p>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <ConfirmDialog
      open={signInUrl !== null}
      onOpenChange={onOpenChange}
      title={STEP_UP_COPY.title}
      description={STEP_UP_COPY.body}
      confirmLabel={STEP_UP_COPY.confirm}
      onConfirm={onConfirm}
    />
  );
}
