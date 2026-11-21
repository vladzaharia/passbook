import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { useUpdateSession } from './api.ts';
import { type SessionDraft, sessionBody, sessionDraft, sessionReady } from './draft.ts';

/**
 * A draft of the session's rules for one row to edit, and the save that writes it. The same body
 * as "More rules", so a row never drops a rule it does not show.
 */
export function useSectionEdit(session: ScanningSession, onDone: () => void) {
  const [draft, setDraft] = useState<SessionDraft>(() => sessionDraft(session));
  const [error, setError] = useState('');
  const update = useUpdateSession(session.id);
  return {
    draft,
    set: (patch: Partial<SessionDraft>) => setDraft((d) => ({ ...d, ...patch })),
    saving: update.isPending,
    ready: sessionReady(draft),
    error,
    async save() {
      setError('');
      try {
        const { orgId: _org, ...body } = sessionBody(draft);
        await update.mutateAsync({ ...body, revision: session.updatedAt });
        onDone();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
  };
}
