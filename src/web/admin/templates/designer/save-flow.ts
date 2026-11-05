import { type Dispatch, type RefObject, useState } from 'react';
import { toast } from '../../../ui/index.ts';
import { mergeAssets, useSaveVersion } from './api.ts';
import { clearDraft } from './drafts.ts';
import type { DesignDoc } from './model.ts';
import type { Action } from './reducer.ts';

export interface Saved {
  version: string;
  activated: boolean;
}

/**
 * Save version. The saved document is the one sent: edits made while the request ran stay in
 * the designer and keep their draft; only the baseline moves.
 */
export function useSaveFlow({
  templateId,
  draftKey,
  latest,
  blocked,
  dispatch,
  onSaved,
}: {
  templateId: string;
  draftKey: string;
  /** The document as it is now, read after the request returns. */
  latest: RefObject<DesignDoc>;
  /** Number of errors (or null when the check is unusable): saving waits until it is 0. */
  blocked: () => number | null;
  dispatch: Dispatch<Action>;
  onSaved: (version: string) => void;
}) {
  const save = useSaveVersion(templateId);
  const [saved, setSaved] = useState<Saved | null>(null);

  async function run(snapshot: DesignDoc): Promise<'saved' | 'refused' | 'failed'> {
    const errors = blocked();
    if (errors !== 0) {
      toast.error(
        errors === null
          ? 'Fix the listed issues first.'
          : `Fix the ${errors} issue${errors === 1 ? '' : 's'} first.`,
        'Could not save',
      );
      return 'refused';
    }
    try {
      const result = await save.mutateAsync({ doc: snapshot, activate: false });
      dispatch({
        type: 'saved',
        snapshot,
        doc: { ...snapshot, assets: mergeAssets(result.assets) },
      });
      if (latest.current === snapshot) clearDraft(draftKey);
      if (result.version) onSaved(result.version);
      setSaved({ version: result.version ?? '', activated: result.activated });
      return 'saved';
    } catch (error) {
      toast.error(error, 'Could not save');
      return 'failed';
    }
  }

  return { saving: save.isPending, saved, setSaved, run };
}
