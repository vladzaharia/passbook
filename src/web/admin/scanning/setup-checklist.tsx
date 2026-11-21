import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { ScannerSetupListSchema } from '@/shared/contracts/scan-setups.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, Card, CardBody, Checklist, type ChecklistStep } from '@/web/ui/index.ts';
import { type ScanningSearch, type ScanningTab, withTab } from './search.ts';
import { useScanningSessions } from './sessions/api.ts';
import { useZones } from './zones-query.ts';

export interface SetupCounts {
  sessions: number;
  zones: number;
  paired: number;
  staff: number;
}

const STEPS: { id: keyof SetupCounts; label: string; tab?: ScanningTab; cta: string }[] = [
  { id: 'sessions', label: 'Create a session', cta: 'New session' },
  { id: 'zones', label: 'Add a zone', tab: 'zones', cta: 'New zone' },
  { id: 'paired', label: 'Pair a scanner', tab: 'devices', cta: 'Pair' },
  { id: 'staff', label: 'Add staff', tab: 'staff', cta: 'Add staff' },
];

/** Each step checks itself from counts. Null counts (still loading) never read as done. */
export function setupSteps(counts: SetupCounts, onNew: (() => void) | undefined): ChecklistStep[] {
  return STEPS.map(({ id, label, tab, cta }) => ({
    id,
    label,
    done: counts[id] > 0,
    action: tab ? (
      <Button asChild variant="outline" size="sm">
        <Link to="." search={(prev) => withTab(prev as ScanningSearch, tab)}>
          {cta}
        </Link>
      </Button>
    ) : onNew ? (
      <Button variant="outline" size="sm" onClick={onNew}>
        {cta}
      </Button>
    ) : null,
  }));
}

const StaffCountSchema = z.object({ items: z.array(z.unknown()) });

/** Door setup in order: session, zone, paired scanner, staff. Hidden once all four are done. */
export function SetupChecklist({ onNew }: { onNew?: () => void }) {
  const { orgId } = useOrgScope();
  const mode = useMode();
  const sessions = useScanningSessions(orgId);
  const zones = useZones();
  // Ask the API for one paired scanner, so a paired device on a later page still counts.
  const paired = useQuery({
    queryKey: ['admin', 'scanning', 'scanners', 'paired', orgId, mode],
    enabled: Boolean(orgId),
    queryFn: ({ signal }) =>
      api.get('/api/v1/scan-setups', ScannerSetupListSchema, {
        query: { orgId, status: 'paired', limit: 1 },
        signal,
      }),
  });
  const staff = useQuery({
    queryKey: ['admin', 'scanning', 'staff', orgId, mode, 'setup'],
    enabled: Boolean(orgId),
    queryFn: ({ signal }) =>
      api.get('/api/v1/scan-staff', StaffCountSchema, { query: { orgId, limit: 1 }, signal }),
  });
  if (!sessions.data || !zones.data || !paired.data || !staff.data) return null;
  const counts: SetupCounts = {
    sessions: sessions.data.pages.flatMap((p) => p.items).filter((s) => s.orgId === orgId).length,
    zones: zones.data.items.length,
    paired: paired.data.items.filter((x) => x.orgId === orgId).length,
    staff: staff.data.items.length,
  };
  const steps = setupSteps(counts, onNew);
  if (steps.every((s) => s.done)) return null;
  return (
    <Card>
      <CardBody>
        <Checklist title="Set up a door" steps={steps} />
      </CardBody>
    </Card>
  );
}
