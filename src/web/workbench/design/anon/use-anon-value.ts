import { useMemo } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { toast } from '../../../ui/toaster.tsx';
import { copyToClipboard } from '../../playground/copy.ts';
import { encodeHash } from '../../playground/hash.ts';
import type { BlueprintPreviews } from '../../playground/model.ts';
import type { AnonValue } from './anon-context.tsx';
import { handoffTarget } from './handoff.ts';
import { useAnonState } from './use-anon-state.ts';

/** The page's state as the context the panels read: values, picker, Share and Save. */
export function useAnonValue(data: BlueprintPreviews, signedIn: boolean) {
  const s = useAnonState(data);
  const options = useMemo(
    () => s.blueprints.map((b) => ({ value: b.preview.id, label: b.preview.name })),
    [s.blueprints],
  );
  const value = useMemo<AnonValue>(
    () => ({
      blueprint: s.current,
      values: s.values,
      mode: s.state.mode,
      setValues: s.setValues,
      setMode: s.setMode,
      options,
      pick: s.pick,
      save: () => {
        const target = handoffTarget({ ...s.state, template: s.current.preview.id });
        // Signed in, the hand-off continues from here; signed out, after sign-in it comes back to it.
        location.assign(signedIn ? target : `/login?next=${encodeURIComponent(target)}`);
      },
      share: () => {
        const link = `${location.origin}${location.pathname}${encodeHash({ ...s.state, template: s.current.preview.id })}`;
        void copyToClipboard(link).then((ok) => ok && toast.success(WB_DESIGN.anon.copied));
      },
    }),
    [s.current, s.values, s.state, s.setValues, s.setMode, s.pick, options, signedIn],
  );
  return { s, value };
}
