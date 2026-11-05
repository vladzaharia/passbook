import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/web/ui/index.ts';
import { EventsTab, ScansTab, StaffTab } from './placeholder-tabs.tsx';
import { useScannerPages } from './queries.ts';
import { ScannersTab } from './scanners/scanners-tab.tsx';
import {
  DEFAULT_TAB,
  SCANNING_TABS,
  type ScanningSearch,
  type ScanningTab,
  withTab,
} from './search.ts';

const LABEL: Record<ScanningTab, string> = {
  scanners: 'Scanners',
  events: 'Events',
  staff: 'Staff',
  scans: 'Scans',
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
  const noScanners =
    !live.isPending && !live.isError && !live.data?.pages.some((p) => p.items.length);

  const newScanner = (variant: 'primary' | 'outline'): ReactNode => (
    <Button variant={variant} iconStart={<Plus aria-hidden />}>
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
        actions={tab === 'scanners' ? newScanner(noScanners ? 'outline' : 'primary') : undefined}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Scanning">
          {SCANNING_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="scanners">
          <ScannersTab live={live} newButton={newScanner('primary')} />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab />
        </TabsContent>
        <TabsContent value="staff">
          <StaffTab />
        </TabsContent>
        <TabsContent value="scans">
          <ScansTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
