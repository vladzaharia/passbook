import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { toast } from '../../ui/index.ts';
import { useBroadcastActions } from './api.ts';
import { bodyOf, type ComposerState } from './composer-state.ts';
import { SCOPE_CHANGED } from './labels.ts';

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
  const qc = useQueryClient();
  const router = useRouter();
  const session = qc.getQueryData(sessionQuery.queryKey);
  const principalId = useRef(session?.authenticated ? session.user.id : undefined);
  const scope = useOrgScope();
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const authorized = () => {
    if (
      !mounted.current ||
      !orgId ||
      currentScope.current.isLoading ||
      currentScope.current.isError ||
      currentScope.current.orgId !== orgId ||
      (draft && draft.orgId !== orgId)
    )
      return false;

    const membershipState = qc.getQueryState(membershipsQuery.queryKey);
    const membership = qc
      .getQueryData(membershipsQuery.queryKey)
      ?.items.find((m) => m.orgId === orgId && m.revokedAt === null);
    const currentSession = qc.getQueryData(sessionQuery.queryKey);
    if (
      membershipState?.status !== 'success' ||
      !membership?.capabilities.includes('messages:manage') ||
      qc.getQueryState(sessionQuery.queryKey)?.status !== 'success' ||
      !principalId.current ||
      !currentSession?.authenticated ||
      currentSession.user.id !== principalId.current
    )
      return false;

    const location = router.state.location;
    if (location.pathname.replace(/\/+$/, '') !== '/admin/messages/new') return false;
    if (draft && location.search.from !== draft.id) return false;
    return currentScope.current.requestedSelection === orgId;
  };
  const [sentId, setSentId] = useState<string>();
  const guarded = () => {
    if (!mounted.current) return false;
    if (!authorized()) throw new Error(SCOPE_CHANGED);
    return true;
  };
  const submit = async (mode: SendMode) => {
    if (!orgId) throw new Error(SCOPE_CHANGED);
    if (!guarded()) return;
    const body = bodyOf(orgId, state, draft ? 'draft' : mode, mode === 'schedule' ? at : undefined);
    if (!body) return;
    let made: BroadcastDto;
    if (draft) {
      made = await actions.update.mutateAsync({ id: draft.id, body });
      if (mode !== 'draft') {
        if (made.id !== draft.id || made.orgId !== orgId || !guarded()) return;
        made = await actions.send.mutateAsync({
          id: draft.id,
          at: mode === 'schedule' ? at : undefined,
        });
      }
    } else made = await actions.create.mutateAsync(body);
    if (made.orgId !== orgId || !guarded()) return;
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
