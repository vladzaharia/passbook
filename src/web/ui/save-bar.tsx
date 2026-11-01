import { useBlocker } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ConfirmDialog } from './alert-dialog.tsx';
import { Button } from './button.tsx';

export interface SaveBarProps {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
}

/** Appears only while there are unsaved changes. */
export function SaveBar({ dirty, saving, onSave, onDiscard, saveLabel = 'Save' }: SaveBarProps) {
  if (!dirty) return null;
  return (
    <section
      aria-label="Unsaved changes"
      className="wl-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-overlay pb-[env(safe-area-inset-bottom)] shadow-elevation-3 lg:left-60"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <p className="text-sm text-fg-strong">Unsaved changes</p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
          <Button loading={saving} onClick={onSave}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Blocks in-app navigation (confirm dialog) and tab close (browser prompt) while dirty. */
export function useUnsavedChangesGuard(dirty: boolean) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
    disabled: !dirty,
  });
  useEffect(() => {
    if (!dirty && blocker.status === 'blocked') blocker.reset();
  }, [dirty, blocker]);
  return blocker;
}

/** Render once next to the form: `<UnsavedChangesDialog blocker={guard} />`. */
export function UnsavedChangesDialog({
  blocker,
}: {
  blocker: ReturnType<typeof useUnsavedChangesGuard>;
}) {
  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
      title="Discard unsaved changes?"
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => {
        if (blocker.status === 'blocked') blocker.proceed();
      }}
    />
  );
}
