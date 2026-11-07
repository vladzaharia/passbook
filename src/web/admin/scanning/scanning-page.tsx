import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/web/ui/index.ts';
import { StaffTab } from './placeholder-tabs.tsx';
import { useScannerPages } from './queries.ts';
import { NewScannerDialog } from './scanners/new-scanner-dialog.tsx';
import type { ScannerDraft } from './scanners/scanner-draft.ts';
import { ScannersTab } from './scanners/scanners-tab.tsx';
import {
  DEFAULT_TAB,
  SCANNING_TABS,
  type ScanningSearch,
  type ScanningTab,
  withTab,
} from './search.ts';
import { NewSessionDialog } from './sessions/session-dialog.tsx';
import { SessionsTab } from './sessions/sessions-tab.tsx';

const EventsTab = lazy(() => import('./events-tab.tsx').then((m) => ({ default: m.EventsTab })));
const ScansTab = lazy(() => import('./scans-tab.tsx').then((m) => ({ default: m.ScansTab })));

const LABEL: Record<ScanningTab, string> = {
  sessions: 'Sessions',
  scanners: 'Devices',
  events: 'Events',
  staff: 'Staff',
  scans: 'Activity',
};

/**
 * Scanning: one page, tabs by `?tab=` (replace history, like detail tabs). One primary per tab,
 * and when the tab is truly empty that primary moves into the empty state.
 */
export function ScanningPage({ search }: { search: ScanningSearch }) {
  const navigate = useNavigate();
  const { orgId } = useOrgScope();
  const tab = search.tab ?? DEFAULT_TAB;
  const live = useScannerPages(orgId, false);
  // New scanner, or Duplicate with the other scanner's settings.
  const [creating, setCreating] = useState<{ initial?: ScannerDraft } | undefined>();
  const [creatingSession, setCreatingSession] = useState<{ initial?: ScanningSession }>();
  useEffect(() => {
    if (search.new !== '1') return;
    if (search.tab === 'scanners') setCreating({});
    else setCreatingSession({});
    void navigate({ to: '.', search: (prev) => ({ ...prev, new: undefined }), replace: true });
  }, [search.new, search.tab, navigate]);
  const noScanners =
    !live.isPending && !live.isError && !live.data?.pages.some((p) => p.items.length);

  const newScanner = (variant: 'primary' | 'outline'): ReactNode => (
    <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating({})}>
      New scanner
    </Button>
  );
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
        description="Manage scanning sessions, devices and admission rules."
        actions={
          tab === 'sessions' ? (
            <Button iconStart={<Plus aria-hidden />} onClick={() => setCreatingSession({})}>
              New scanning session
            </Button>
          ) : tab === 'scanners' ? (
            newScanner(noScanners ? 'outline' : 'primary')
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Scanning">
          {SCANNING_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="sessions">
          <SessionsTab
            onNew={() => setCreatingSession({})}
            onDuplicate={(initial) => setCreatingSession({ initial })}
          />
        </TabsContent>
        <TabsContent value="scanners">
          <ScannersTab
            live={live}
            newButton={newScanner('primary')}
            onDuplicate={(initial) => setCreating({ initial })}
          />
        </TabsContent>
        <TabsContent value="events">
          <Suspense fallback={<p role="status">Loading events…</p>}>
            <EventsTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="staff">
          <StaffTab />
        </TabsContent>
        <TabsContent value="scans">
          <Suspense fallback={<p role="status">Loading scans…</p>}>
            <ScansTab search={search} />
          </Suspense>
        </TabsContent>
      </Tabs>
      {creating ? (
        <NewScannerDialog
          open
          initial={creating.initial}
          onOpenChange={(o) => !o && setCreating(undefined)}
        />
      ) : null}
      {creatingSession ? (
        <NewSessionDialog
          initial={creatingSession.initial}
          onClose={() => setCreatingSession(undefined)}
          onCreated={(sessionId) => {
            setCreatingSession(undefined);
            void navigate({ to: '/admin/scanning/sessions/$sessionId', params: { sessionId } });
          }}
        />
      ) : null}
    </>
  );
}
