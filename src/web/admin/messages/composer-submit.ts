import { useState } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { toast } from '../../ui/index.ts';
import { useBroadcastActions } from './api.ts';
import { bodyOf, type ComposerState } from './composer-state.ts';

export type SendMode = 'draft' | 'now' | 'schedule';

/**
 * Saves or sends what the composer holds. A new message is created; an edited draft is replaced
 * first and then sent. `sentId` is set once it is saved, so the page can leave.
 */
export function useComposerSubmit(
  orgId: string | undefined,
  state: ComposerState,
  at: number | undefined,
  draft: BroadcastDto | undefined,
) {
  const actions = useBroadcastActions();
  const [sentId, setSentId] = useState<string>();
  const submit = async (mode: SendMode) => {
    if (!orgId) return;
    const body = bodyOf(orgId, state, draft ? 'draft' : mode, mode === 'schedule' ? at : undefined);
    if (!body) return;
    let made: BroadcastDto;
    if (draft) {
      made = await actions.update.mutateAsync({ id: draft.id, body });
      if (mode !== 'draft')
        made = await actions.send.mutateAsync({
          id: draft.id,
          at: mode === 'schedule' ? at : undefined,
        });
    } else made = await actions.create.mutateAsync(body);
    if (mode === 'now') toast.info('Sending');
    else toast.success(mode === 'draft' ? 'Draft saved' : 'Scheduled');
    setSentId(made.id);
  };
  return {
    submit,
    sentId,
    pending: actions.create.isPending || actions.update.isPending || actions.send.isPending,
  };
}
