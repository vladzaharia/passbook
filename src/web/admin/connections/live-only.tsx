import type { ReactNode } from 'react';
import { ENTITY } from '../../lib/entities.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Button, EmptyState, PageHeader } from '../../ui/index.ts';

/**
 * Stored connections have no Test environment. Test mode shows this in place of every Connections
 * page, with the way back to Live; a developer sandbox, which has no Live, shows it with no way.
 */
export function LiveOnlyState() {
  const { membership } = useOrgScope();
  const sandbox = membership?.testOnly === true;
  return (
    <EmptyState
      art={ENTITY.connection.art}
      mood="curious"
      title="Connections run in Live."
      action={
        sandbox ? undefined : (
          <Button variant="outline" onClick={() => setMode('live')}>
            Switch to Live
          </Button>
        )
      }
    />
  );
}

/** A stored-connection page in Live; in Test its place is the live-only state (its queries never start). */
export function LiveOnly({ children }: { children: ReactNode }) {
  if (useMode() === 'live') return children;
  return (
    <>
      <PageHeader title="Connections" />
      <LiveOnlyState />
    </>
  );
}
