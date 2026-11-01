import { useBlocker } from '@tanstack/react-router';
import { Check, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';
import { ConfirmDialog } from './alert-dialog.tsx';
import { Button } from './button.tsx';

export interface SaveBarProps {
  dirty: boolean;
  saving?: boolean;
  /** The save mutation is waiting for the network (TanStack paused it offline). */
  paused?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
}

type Phase = 'hidden' | 'shown' | 'saved' | 'closing';

/**
 * Appears while there are unsaved changes. After a save the Save icon turns into a check for
 * 400 ms, then the bar slides down (200 ms); Discard leaves at once. It stays mounted while closing.
 */
export function SaveBar({
  dirty,
  saving,
  paused,
  onSave,
  onDiscard,
  saveLabel = 'Save',
}: SaveBarProps) {
  const [phase, setPhase] = useState<Phase>(dirty ? 'shown' : 'hidden');
  const wasSaving = useRef(false);
  useEffect(() => {
    if (saving) wasSaving.current = true;
    if (dirty) {
      setPhase('shown');
      if (saving || !wasSaving.current) return;
      // Still dirty after a save: it failed, or the form resets on the next render. Give it a beat.
      const t = setTimeout(() => {
        wasSaving.current = false;
      }, 500);
      return () => clearTimeout(t);
    }
    if (saving) return;
    const saved = wasSaving.current;
    wasSaving.current = false;
    setPhase((p) => (p === 'shown' && saved ? 'saved' : p === 'shown' ? 'hidden' : p));
    return undefined;
  }, [dirty, saving]);
  useEffect(() => {
    if (phase !== 'saved') return;
    const t = setTimeout(() => setPhase(prefersReducedMotion() ? 'hidden' : 'closing'), 400);
    return () => clearTimeout(t);
  }, [phase]);
  if (phase === 'hidden') return null;
  const done = phase === 'saved' || phase === 'closing';
  return (
    <section
      aria-label="Unsaved changes"
      data-closing={phase === 'closing' || undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && phase === 'closing') setPhase('hidden');
      }}
      className="wl-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-overlay pb-[env(safe-area-inset-bottom)] shadow-elevation-3 lg:left-60"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-safe py-3 sm:[--wl-gutter:1.5rem]">
        <p className="text-sm text-fg-strong" role="status">
          {done ? 'Saved' : 'Unsaved changes'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={saving || paused || done} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            loading={saving && !paused}
            paused={paused}
            disabled={done}
            iconStart={done ? <Check aria-hidden className="wl-check" /> : <Save aria-hidden />}
            onClick={onSave}
          >
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
