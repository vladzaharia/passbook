import type { ScanRole } from '@/shared/contracts/scan.ts';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { Card, CardHeader } from '@/web/ui/index.ts';
import { AdmitsRow } from './section-admits.tsx';
import { ScannersRow } from './section-scanners.tsx';
import { WhenRow } from './section-when.tsx';
import { WhereRow } from './section-where.tsx';
import type { HoursDialog } from './session-hours-actions.tsx';
import type { useSessionLive } from './session-live.ts';

/** The session's setup as four questions, each answered and edited in place. */
export function SessionSetup({
  session,
  live,
  canManage,
  adding,
  setAdding,
  onDialog,
}: {
  session: ScanningSession;
  live: ReturnType<typeof useSessionLive>;
  canManage: boolean;
  adding: ScanRole | undefined;
  setAdding: (role: ScanRole | undefined) => void;
  onDialog: (dialog: HoursDialog) => void;
}) {
  return (
    <Card>
      <CardHeader title="Setup" />
      <AdmitsRow session={session} live={live} canManage={canManage} />
      <WhereRow session={session} live={live} canManage={canManage} />
      <WhenRow session={session} canManage={canManage} onDialog={onDialog} />
      <ScannersRow
        session={session}
        staff={live.staff.data?.items ?? []}
        canManage={canManage}
        adding={adding}
        setAdding={setAdding}
      />
    </Card>
  );
}
