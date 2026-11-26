import { useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { sessionOperationsClient } from '../../lib/operations-client.ts';
import type { OperationsClient } from '../operation/client.ts';
import { OperationsProvider, OperationTray } from '../operation/index.ts';
import type { Operation } from '../operation/types.ts';

/** The shared tray over the host's client (the SPA's session by default); a row's page opens through the router. */
export default function ActivityTrayBody({
  client,
  include,
}: {
  client?: OperationsClient;
  include?: (op: Operation) => boolean;
}) {
  const router = useRouter();
  const onNavigate = useCallback(
    (href: string) => {
      // `result.href` is an app path; the typed router takes it as a plain location.
      router.history.push(href);
    },
    [router],
  );
  return (
    <OperationsProvider client={client ?? sessionOperationsClient()}>
      <OperationTray onNavigate={onNavigate} notify include={include} />
    </OperationsProvider>
  );
}
