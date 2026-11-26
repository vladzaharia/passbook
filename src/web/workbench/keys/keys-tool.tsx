import { useLocation, useRouter } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from 'react';
import { WORKBENCH_KEY_MAX_MS, WORKBENCH_KEY_SCOPES } from '@/shared/contracts/workbench.ts';
import { wbPath } from '@/shared/workbench.ts';
import { ApiKeysView } from '../../admin/api-keys/api-keys-page.tsx';
import { type KeysHost, KeysHostProvider } from '../../admin/api-keys/keys-host.tsx';
import { useSession } from '../../lib/session.ts';
import { RowLink } from '../../ui/row-link.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { RecentCalls } from './recent-calls.tsx';

const DAY = 86_400_000;

/** A key's page loads when one is opened. */
const KeyDetailView = lazy(() =>
  import('../../admin/api-keys/key-detail-page.tsx').then((m) => ({ default: m.KeyDetailView })),
);

/**
 * Keys in the Workbench: admin's list, wizard and key page on the Workbench token. Test keys only,
 * and a new key holds Test-data scopes for at most 30 days (the cap the server holds a token to).
 * A key opens at `#<keyId>` in place of the list.
 */
export function KeysTool() {
  const host = useToolHost();
  const session = useSession();
  const router = useRouter();
  const hash = useLocation({ select: (l) => l.hash });
  const search = useLocation({ select: (l) => l.searchStr });
  const [asked, setAsked] = useState(false);
  const { orgId, name, kind } = host.context;
  const principal = session.authed?.user.id ?? '';
  const listPath = wbPath(orgId, 'keys');
  const keyId = hash ? decodeURIComponent(hash) : undefined;

  const bound = useMemo<KeysHost>(
    () => ({
      listPath,
      keyLink: (_org: string | null, id: string, children: ReactNode) => (
        <RowLink to="/workbench/o/$orgId/keys" params={{ orgId }} hash={id}>
          {children}
        </RowLink>
      ),
      cap: { scopes: WORKBENCH_KEY_SCOPES, maxDays: WORKBENCH_KEY_MAX_MS / DAY },
      primary: (action) => <BenchSlot name="action">{action}</BenchSlot>,
      aside: (id) => <RecentCalls orgId={orgId} keyId={id} />,
      access: {
        state: 'ready',
        principal,
        orgId,
        orgName: name,
        // A sandbox's key holds no key-minting scope, so its keys are read here.
        canManage: kind === 'org',
        capabilities: null,
        developerOrg: true,
        canAudit: false,
      },
    }),
    [listPath, orgId, name, kind, principal],
  );

  const createRequested = asked || new URLSearchParams(search).has('new');
  const handled = useCallback(() => {
    setAsked(false);
    const next = new URLSearchParams(search);
    if (!next.has('new')) return;
    next.delete('new');
    const rest = next.toString();
    router.history.replace(`${listPath}${rest ? `?${rest}` : ''}${hash ? `#${hash}` : ''}`);
  }, [search, router, listPath, hash]);

  return (
    <ToolPage tool="keys">
      <KeysHostProvider value={bound}>
        <div className="wb-tool-keys min-w-0">
          {keyId ? (
            <Suspense fallback={<SkeletonRows label="Loading API key" />}>
              <KeyDetailView access={bound.access} keyId={keyId} />
            </Suspense>
          ) : (
            <ApiKeysView
              access={bound.access}
              createRequested={createRequested}
              onCreateRequestHandled={handled}
            />
          )}
        </div>
      </KeysHostProvider>
    </ToolPage>
  );
}
