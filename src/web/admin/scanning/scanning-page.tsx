import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Plus, WandSparkles } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Button,
  ErrorState,
  PageHeader,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/web/ui/index.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useScannerPages } from './queries.ts';
import { ScannersTab } from './scanners/scanners-tab.tsx';
import {
  DEFAULT_TAB,
  SCANNING_TABS,
  type ScanningSearch,
  type ScanningTab,
  scanningSearchSchema,
  withTab,
} from './search.ts';
import { useScanningSessions } from './sessions/api.ts';
import { NewSessionDialog } from './sessions/session-dialog.tsx';
import { SessionsTab } from './sessions/sessions-tab.tsx';
import { StaffTab } from './staff-tab.tsx';

const EventsTab = lazy(() => import('./events-tab.tsx').then((m) => ({ default: m.EventsTab })));
const ZonesTab = lazy(() => import('./zones/zones-tab.tsx').then((m) => ({ default: m.ZonesTab })));
const TagsTab = lazy(() => import('../tags/tags-tab.tsx').then((m) => ({ default: m.TagsTab })));
const ScansTab = lazy(() => import('./scans-tab.tsx').then((m) => ({ default: m.ScansTab })));

const LABEL: Record<ScanningTab, string> = {
  sessions: 'Sessions',
  devices: 'Devices',
  events: 'Events',
  zones: 'Zones',
  staff: 'Staff',
  activity: 'Activity',
  tags: 'Tags',
};

/**
 * Scanning: one page, tabs by `?tab=` (replace history, like detail tabs). One primary per tab,
 * and when the tab is truly empty that primary moves into the empty state.
 */
export function ScanningPage({ search }: { search: ScanningSearch }) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const [creatingSession, setCreatingSession] = useState<{ initial?: ScanningSession }>();
  const canManage = Boolean(
    scope.orgId && scope.membership?.capabilities.includes('scanning:manage'),
  );
  // An old or unknown ?tab= is rewritten to the tab the page shows.
  const rawTab = useLocation({ select: (l) => new URLSearchParams(l.searchStr).get('tab') });
  const parsedTab = scanningSearchSchema.shape.tab.parse(rawTab ?? undefined);
  const shownTab = parsedTab && parsedTab !== DEFAULT_TAB ? parsedTab : null;
  useEffect(() => {
    if (rawTab === null || rawTab === shownTab) return;
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, tab: shownTab ?? undefined }),
      replace: true,
    });
  }, [rawTab, shownTab, navigate]);
  useEffect(() => {
    if (!scope.isLoading && (scope.isError || !canManage)) setCreatingSession(undefined);
  }, [canManage, scope.isError, scope.isLoading]);
  if (scope.isLoading) return <SkeletonRows label="Loading scanning" />;
  if (scope.isError) return <ErrorState error={scope.error} onRetry={() => scope.refetch()} />;
  if (!scope.orgId || !scope.membership?.capabilities.includes('scanning:read')) {
    return <OrgChooser />;
  }
  return (
    <>
      <ScopedScanningPage
        key={`${scope.orgId}:${canManage}`}
        search={search}
        orgId={scope.orgId}
        canManage={canManage}
        setCreatingSession={setCreatingSession}
      />
      {canManage && creatingSession ? (
        <NewSessionDialog
          initial={creatingSession.initial}
          onClose={() => setCreatingSession(undefined)}
          onCreated={(sessionId) => {
            setCreatingSession(undefined);
            if (!scope.orgId) return;
            void navigate({
              to: '/admin/o/$orgId/scanning/sessions/$sessionId',
              params: { orgId: scope.orgId, sessionId },
              search: { addDevice: '1' },
            });
          }}
        />
      ) : null}
    </>
  );
}

function ScopedScanningPage({
  search,
  orgId,
  canManage,
  setCreatingSession,
}: {
  search: ScanningSearch;
  orgId: string;
  canManage: boolean;
  setCreatingSession: (session: { initial?: ScanningSession } | undefined) => void;
}) {
  const navigate = useNavigate();
  const mode = useMode();
  const tab = search.tab ?? DEFAULT_TAB;
  const live = useScannerPages(orgId, false);
  useEffect(() => {
    if (search.new !== '1') return;
    if (canManage) setCreatingSession({});
    void navigate({ to: '.', search: (prev) => ({ ...prev, new: undefined }), replace: true });
  }, [search.new, navigate, canManage, setCreatingSession]);
  const sessions = useScanningSessions(orgId);
  const noSessions =
    !sessions.isPending &&
    !sessions.isError &&
    !sessions.data?.pages.some((p) => p.items.some((i) => i.orgId === orgId));
  const noScanners =
    !live.isPending && !live.isError && !live.data?.pages.some((p) => p.items.length);

  // Nothing set up yet: the empty state stands alone, the other tabs would all be empty too.
  const bare = tab === 'sessions' && noSessions && noScanners;

  const newSession = (variant: 'primary' | 'outline'): ReactNode =>
    canManage ? (
      <Button
        variant={variant}
        iconStart={<Plus aria-hidden />}
        onClick={() => setCreatingSession({})}
      >
        New session
      </Button>
    ) : null;
  const setUp =
    canManage && !noSessions ? (
      <Button asChild iconStart={<WandSparkles aria-hidden />}>
        <Link to="/admin/o/$orgId/scanning/setup" params={{ orgId }}>
          Set up scanning
        </Link>
      </Button>
    ) : null;
  const setTab = (next: string) =>
    void navigate({
      to: '.',
      search: (prev) => withTab(prev as ScanningSearch, next as ScanningTab),
      replace: true,
    });

  return (
    <>
      <PageHeader
        title="Scanning"
        actions={
          tab === 'sessions' ? (
            noSessions ? undefined : (
              <>
                {setUp}
                {newSession('outline')}
              </>
            )
          ) : tab === 'devices' ? (
            noScanners ? undefined : (
              newSession('primary')
            )
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        {bare ? null : (
          <TabsList aria-label="Scanning">
            {SCANNING_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsContent value="sessions">
          <SessionsTab
            canManage={canManage}
            onNew={() => setCreatingSession({})}
            onDuplicate={(initial) => setCreatingSession({ initial })}
          />
        </TabsContent>
        <TabsContent value="devices">
          <ScannersTab live={live} newButton={newSession('primary')} />
        </TabsContent>
        <TabsContent value="events">
          <Suspense fallback={<SkeletonRows label="Loading events" />}>
            <EventsTab key={mode} />
          </Suspense>
        </TabsContent>
        <TabsContent value="zones">
          <Suspense fallback={<SkeletonRows label="Loading zones" />}>
            <ZonesTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="staff">
          <StaffTab />
        </TabsContent>
        <TabsContent value="tags">
          <Suspense fallback={<SkeletonRows label="Loading tags" />}>
            <TagsTab key={mode} search={search} />
          </Suspense>
        </TabsContent>
        <TabsContent value="activity">
          <Suspense fallback={<SkeletonRows label="Loading scans" />}>
            <ScansTab search={search} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}
