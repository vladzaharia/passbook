import { type Dispatch, type RefObject, useState } from 'react';
import { toast } from '../../../ui/index.ts';
import { mergeAssets, useSaveVersion } from './api.ts';
import { clearDraft, saveDraft } from './drafts.ts';
import type { DesignDoc } from './model.ts';
import { type Action, signature } from './reducer.ts';

/**
 * Save version. The saved document is the one sent: edits made while the request ran stay in
 * the designer and keep their draft; only the baseline moves.
 */
export function useSaveFlow({
  templateId,
  draftKey,
  latest,
  savedDoc,
  draftBase,
  blocked,
  dispatch,
  onSaved,
}: {
  templateId: string;
  draftKey: string;
  /** The document as it is now, read after the request returns. */
  latest: RefObject<DesignDoc>;
  /** Baseline of the current draft, including a previously saved inactive version. */
  savedDoc: DesignDoc;
  draftBase: string;
  /** Number of errors (or null when the check is unusable): saving waits until it is 0. */
  blocked: () => number | null;
  dispatch: Dispatch<Action>;
  onSaved: (version: string) => void;
}) {
  const save = useSaveVersion(templateId);
  const [saved, setSaved] = useState(false);

  function keepDraft() {
    if (signature(latest.current) !== signature(savedDoc))
      saveDraft(draftKey, { base: draftBase, doc: latest.current, at: Date.now() });
  }

  async function run(snapshot: DesignDoc): Promise<'saved' | 'refused' | 'failed'> {
    const errors = blocked();
    if (errors !== 0) {
      toast.error(
        errors === null
          ? 'Wait for a successful check and fix any listed issues.'
          : `Fix the ${errors} issue${errors === 1 ? '' : 's'} first.`,
        'Could not save',
      );
      return 'refused';
    }
    try {
      const result = await save.mutateAsync(snapshot);
      if (!result.saved || !result.version) {
        keepDraft();
        toast.error(
          'The server did not save this version. Review the issues and try again.',
          'Could not save',
        );
        return 'refused';
      }
      dispatch({
        type: 'saved',
        snapshot,
        doc: { ...snapshot, assets: mergeAssets(result.assets) },
      });
      if (latest.current === snapshot) clearDraft(draftKey);
      onSaved(result.version);
      setSaved(true);
      return 'saved';
    } catch (error) {
      keepDraft();
      toast.error(error, 'Could not save');
      return 'failed';
    }
  }

  return { saving: save.isPending, saved, run };
}
