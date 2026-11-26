import { useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { holdableScopes } from '@/shared/developers-keys.ts';
import { isPlatformScope } from './key-kind-fields.ts';
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
    /** Switch a platform-page key between Platform and All organizations: the other side's ticks go, once said. */
    switchFlavour(platformSide: boolean) {
      const own = (s: string) => isPlatformScope(s) === platformSide;
      const gone = scopes.filter((s) => !own(s));
      // The untouched default is not worth a note.
      setRemoved(gone.filter((s) => s !== 'platform:read' && !initial.includes(s)));
      const kept = scopes.filter(own);
      setScopes(kept.length ? kept : platformSide ? ['platform:read'] : [...initial]);
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
