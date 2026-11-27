import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { wbPath } from '@/shared/workbench.ts';
import { useOperation } from '../../ui/operation/index.ts';
import { sandboxOfOperation } from '../console/sandbox-actions.ts';
import { loadSession, updateSession } from '../console/session.ts';
import { dropToken } from '../host/token.ts';

/**
 * What follows a sandbox action once its operation ends well, wherever it was started: the held token
 * belongs to the old key, so it goes; every Workbench read starts again; a delete leaves for the
 * chooser, and a start over for the new sandbox's Home. The tray keeps the operation current, so
 * this polls the operation (the person's own, so with the session) until it ends.
 */
export function useFollowEnd(id: string | null, orgId: string | undefined): void {
  const { operation: op } = useOperation(id);
  const queries = useQueryClient();
  const navigate = useNavigate();
  const told = useRef<string | null>(null);
  const done = op?.status === 'succeeded' ? op : null;
  useEffect(() => {
    if (!done || told.current === done.id) return;
    told.current = done.id;
    if (orgId) dropToken(orgId);
    const made = done.kind === 'sandbox.recreate' ? sandboxOfOperation(done) : null;
    void (async () => {
      // The page's session read is kept for the visit: a delete starts a fresh one, a start over names the new sandbox.
      if (done.kind === 'sandbox.delete') {
        window.location.assign('/workbench');
        return;
      }
      const session = await loadSession();
      if (made && session.kind === 'ready') updateSession({ ...session, sandbox: made });
      await queries.invalidateQueries({ queryKey: ['workbench'] });
      if (made) void navigate({ to: wbPath(made.orgId, 'home') });
    })();
  }, [done, orgId, queries, navigate]);
}
