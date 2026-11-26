import { useRouter } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { sessionOperationsClient } from '../../lib/operations-client.ts';
import { OperationsProvider, OperationTray } from '../operation/index.ts';

/** The shared tray over the SPA's session client; a row's page opens through the router. */
export default function ActivityTrayBody() {
  const router = useRouter();
  const client = useMemo(sessionOperationsClient, []);
  const onNavigate = useCallback(
    (href: string) => {
      // `result.href` is an app path; the typed router takes it as a plain location.
      router.history.push(href);
    },
    [router],
  );
  return (
    <OperationsProvider client={client}>
      <OperationTray onNavigate={onNavigate} notify />
    </OperationsProvider>
  );
}
