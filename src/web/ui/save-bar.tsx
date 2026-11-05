import { useBlocker } from '@tanstack/react-router';
import { Check, Save } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { DiscardDialog } from './alert-dialog.tsx';
import { useBottomBar } from './bottom-bar.ts';
import { Button } from './button.tsx';

export interface SaveBarProps {
  dirty: boolean;
  saving?: boolean;
  /** The save mutation is waiting for the network (TanStack paused it offline). */
  paused?: boolean;
  /** Without formId: Save runs this. In a SaveBarGroup it may resolve how the save ended. */
  onSave?: SaveHandler;
  /**
   * Save submits this kit Form instead, so a blocked save focuses the first invalid field and
   * announces one summary (form.tsx).
   */
  formId?: string;
  onDiscard: () => void;
  saveLabel?: string;
  /** A save option beside the buttons (Notify holders). */
  extra?: ReactNode;
}

/** How one form's save ended. 'refused': field errors show. 'failed': the form already said why. */
export type SaveResult = 'saved' | 'refused' | 'failed';

/** A save that resolves its result lets Form and SaveBarGroup follow up (focus, one "Saved"). */
export type SaveHandler = (() => void) | (() => Promise<SaveResult | undefined>);

/** A kit Form as its group sees it (form.tsx). */
export interface GroupedForm {
  invalid: boolean;
  onInvalid?: () => void;
  onValid: SaveHandler;
  /** Focus the first invalid field and announce one summary. */
  block: () => void;
}

/** A grouped SaveBar's state. `props` stays current without re-rendering the group. */
export interface SaveBarMember {
  dirty: boolean;
  saving: boolean;
  paused: boolean;
  extra?: ReactNode;
  props: { readonly current: SaveBarProps };
}

export interface SaveBarGroupApi {
  member: (id: string, state: SaveBarMember | null) => void;
  form: (id: string, form: { readonly current: GroupedForm } | null) => void;
  guard: (id: string, dirty: boolean | null) => void;
  /** A grouped SaveBar submits this form. */
  has: (formId: string) => boolean;
  save: () => void;
  /** A line the group's "Saved" toast carries after a form's save, e.g. "3 passes will update." */
  note: (text: string) => void;
}

/** Provided by SaveBarGroup (save-bar-group.tsx). */
export const SaveBarGroupContext = createContext<SaveBarGroupApi | null>(null);

/**
 * Appears while there are unsaved changes. Inside a SaveBarGroup it reports to the group, which
 * shows one bar for the page.
 */
export function SaveBar(props: SaveBarProps) {
  const group = useContext(SaveBarGroupContext);
  return group ? <GroupedSaveBar group={group} {...props} /> : <SaveBarView {...props} />;
}

function GroupedSaveBar({ group, ...props }: SaveBarProps & { group: SaveBarGroupApi }) {
  const fallback = useId();
  const id = props.formId ?? fallback;
  const latest = useRef(props);
  latest.current = props;
  const { dirty, saving = false, paused = false, extra } = props;
  useEffect(
    () => group.member(id, { dirty, saving, paused, extra, props: latest }),
    [group, id, dirty, saving, paused, extra],
  );
  useEffect(() => () => group.member(id, null), [group, id]);
  return null;
}

type Phase = 'hidden' | 'shown' | 'saved' | 'closing';

/**
 * After a save the Save icon turns into a check for 400 ms, then the bar slides down (200 ms);
 * Discard leaves at once. It stays mounted while closing.
 */
function SaveBarView({
  dirty,
  saving,
  paused,
  onSave,
  formId,
  onDiscard,
  saveLabel = 'Save',
  extra,
}: SaveBarProps) {
  const [phase, setPhase] = useState<Phase>(dirty ? 'shown' : 'hidden');
  const barRef = useBottomBar<HTMLElement>();
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
      ref={barRef}
      aria-label="Unsaved changes"
      // The shell pads the end of main while a bar is up (app-shell.tsx), so nothing hides under it.
      data-save-bar=""
      data-closing={phase === 'closing' || undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && phase === 'closing') setPhase('hidden');
      }}
      className="wl-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface-overlay pb-[env(safe-area-inset-bottom)] shadow-elevation-3 lg:left-60"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-safe py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:[--wl-gutter:1.5rem]">
        {/* Phones: the buttons say it; the label stays for screen readers and for "Saved". */}
        <p className={cn('text-sm text-fg-strong', !done && 'max-sm:sr-only')} role="status">
          {done ? 'Saved' : 'Unsaved changes'}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-x-4">
          {extra}
          <div className="flex gap-2 max-sm:[&>*]:flex-1">
            <Button variant="outline" disabled={saving || paused || done} onClick={onDiscard}>
              Discard
            </Button>
            <Button
              type={formId ? 'submit' : 'button'}
              form={formId}
              loading={saving && !paused}
              paused={paused}
              disabled={done}
              iconStart={done ? <Check aria-hidden className="wl-check" /> : <Save aria-hidden />}
              onClick={formId || !onSave ? undefined : () => void onSave()}
            >
              {saveLabel}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Blocks in-app navigation (confirm dialog) and tab close (browser prompt) while dirty. Inside a
 * SaveBarGroup it hands its state to the group, which asks once for the page.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const group = useContext(SaveBarGroupContext);
  const id = useId();
  const own = dirty && !group;
  const blocker = useBlocker({
    shouldBlockFn: () => own,
    enableBeforeUnload: () => own,
    withResolver: true,
    disabled: !own,
  });
  useEffect(() => group?.guard(id, dirty), [group, id, dirty]);
  useEffect(() => () => group?.guard(id, null), [group, id]);
  useEffect(() => {
    if (!own && blocker.status === 'blocked') blocker.reset();
  }, [own, blocker]);
  return blocker;
}

/** Render once next to the form: `<UnsavedChangesDialog blocker={guard} />`. */
export function UnsavedChangesDialog({
  blocker,
}: {
  blocker: ReturnType<typeof useUnsavedChangesGuard>;
}) {
  return (
    <DiscardDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
      onDiscard={() => {
        if (blocker.status === 'blocked') blocker.proceed();
      }}
    />
  );
}
