import { ApiKeysView, type ApiKeysViewProps } from './api-keys-page.tsx';
import { KeyDetailView } from './key-detail-page.tsx';
import { useKeyAccess } from './use-key-access.ts';

/** Admin's list: the access comes from the session and the URL's scope. */
export function ApiKeysPage(props: ApiKeysViewProps) {
  return <ApiKeysView access={useKeyAccess()} {...props} />;
}

/** Admin's key page, on the same access. */
export function KeyDetailPage({ keyId }: { keyId: string }) {
  return <KeyDetailView access={useKeyAccess()} keyId={keyId} />;
}
