import { useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { holdableScopes } from '@/shared/developers-keys.ts';
import { SCOPE_LABEL } from './queries.ts';

type Kind = 'service' | 'personal';

/**
 * The ticked scopes of a new key. A change of key kind or mode unticks what the new one cannot hold and says so once;
 * the next change by hand clears the note.
 */
export function useKeyScopes(
  initial: readonly string[],
  orgId: string | null,
  capabilities: readonly OrgCapability[] | null,
  developerOrg = false,
) {
  const [scopes, setScopes] = useState<string[]>([...initial]);
  const [removed, setRemoved] = useState<string[]>([]);
  return {
    scopes,
    note: removed.length
      ? `Removed: ${removed.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}.`
      : undefined,
    set(next: string[]) {
      setRemoved([]);
      setScopes(next);
    },
    reset() {
      setRemoved([]);
      setScopes([...initial]);
    },
    /** Call with the kind and mode the key is about to have. */
    reconcile(kind: Kind, mode: Mode) {
      const holdable = holdableScopes(
        orgId === null ? 'platform' : kind,
        capabilities,
        mode,
        developerOrg,
      );
      const gone = scopes.filter((s) => !holdable.includes(s));
      setRemoved(gone);
      if (gone.length) setScopes(scopes.filter((s) => holdable.includes(s)));
    },
  };
}
