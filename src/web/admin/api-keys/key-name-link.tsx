import type { ReactNode } from 'react';
import { RowLink } from '@/web/ui/index.ts';

/** A key's name, linking to its page in its organization's console or the platform's. */
export function KeyNameLink({
  orgId,
  id,
  children,
}: {
  orgId: string | null;
  id: string;
  children: ReactNode;
}) {
  return orgId === null ? (
    <RowLink to="/admin/platform/api-keys/$keyId" params={{ keyId: id }}>
      {children}
    </RowLink>
  ) : (
    <RowLink to="/admin/o/$orgId/api-keys/$keyId" params={{ orgId, keyId: id }}>
      {children}
    </RowLink>
  );
}
