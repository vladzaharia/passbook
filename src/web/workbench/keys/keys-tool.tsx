import { useLocation, useRouter } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from 'react';
import { OrgCapabilitySchema } from '@/shared/contracts/org-membership.ts';
import { WORKBENCH_KEY_MAX_MS, WORKBENCH_KEY_SCOPES } from '@/shared/contracts/workbench.ts';
import { wbPath } from '@/shared/workbench.ts';
import { type KeysHost, KeysHostProvider } from '../../admin/api-keys/keys-host.tsx';
import { useMemberships, useSession } from '../../lib/session.ts';
import { RowLink } from '../../ui/row-link.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { RecentCalls } from './recent-calls.tsx';

const DAY = 86_400_000;

/**
 * The list and a key's page are admin's components on the kit's table and Radix menus: they load
 * after the tool's first paint, so the route's own weight stays its shell.
 */
const ApiKeysView = lazy(() =>
  import('../../admin/api-keys/api-keys-page.tsx').then((m) => ({ default: m.ApiKeysView })),
);
const KeyDetailView = lazy(() =>
  import('../../admin/api-keys/key-detail-page.tsx').then((m) => ({ default: m.KeyDetailView })),
);

/**
 * Keys in the Workbench: admin's list, wizard and key page on the Workbench token. Test keys only,
 * and a new key holds Test-data scopes for at most 30 days (the cap the server holds a token to).
 * A key opens at `#<keyId>` in place of the list.
 */
export function KeysTool() {
  return <OrgKeys />;
}

function OrgKeys() {
  const host = useToolHost();
  const grants = useMemberships();
  const session = useSession();
  const router = useRouter();
  const hash = useLocation({ select: (l) => l.hash });
  const search = useLocation({ select: (l) => l.searchStr });
  const [asked, setAsked] = useState(false);
  const { orgId, name, kind } = host.context;
  const principal = session.authed?.user.id ?? '';
  const listPath = wbPath(orgId, 'keys');
  const keyId = hash ? decodeURIComponent(hash) : undefined;

  // A sandbox's person is the admin of their own sandbox: the token manages its keys as they do
  // (key-access.test.ts). An org's member holds what their roles grant.
  const caps = useMemo(
    () =>
      kind === 'sandbox'
        ? OrgCapabilitySchema.options
        : (grants.data?.items.find((m) => m.userId === principal && m.orgId === orgId)
            ?.capabilities ?? []),
    [kind, grants.data, principal, orgId],
  );
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
        // The member's own capabilities: the server answers a token the same way (key-access.test.ts).
        canManage: caps.includes('integrations:manage'),
        capabilities: caps,
        developerOrg: true,
        canAudit: caps.includes('audit:read'),
      },
    }),
    [listPath, orgId, name, caps, principal],
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

  if (kind !== 'sandbox' && grants.isPending)
    return (
      <ToolPage tool="keys">
        <SkeletonRows label="Loading access" />
      </ToolPage>
    );
  return (
    <ToolPage tool="keys">
      <KeysHostProvider value={bound}>
        <div className="wb-tool-keys min-w-0">
          {keyId ? (
            <Suspense fallback={<SkeletonRows label="Loading API key" />}>
              <KeyDetailView access={bound.access} keyId={keyId} />
            </Suspense>
          ) : (
            <Suspense fallback={<SkeletonRows label="Loading API keys" />}>
              <ApiKeysView
                access={bound.access}
                createRequested={createRequested}
                onCreateRequestHandled={handled}
              />
            </Suspense>
          )}
        </div>
      </KeysHostProvider>
    </ToolPage>
  );
}
