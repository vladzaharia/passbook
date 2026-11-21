import { Card, CardBody, CardHeader, Skeleton } from '@/web/ui/index.ts';
import { CheckList } from '../setup/check-list.tsx';
import type { useSessionFixes } from './session-fixes.ts';
import type { useSessionLive } from './session-live.ts';

/** The setup checks, live: the same checks and one-tap fixes as the wizard's Review. */
export function SessionChecks({
  live,
  fixes,
  canManage,
}: {
  live: ReturnType<typeof useSessionLive>;
  fixes: ReturnType<typeof useSessionFixes>;
  canManage: boolean;
}) {
  return (
    <Card>
      <CardHeader title="Checks" />
      <CardBody>
        {live.ready ? (
          <CheckList
            checks={live.checks}
            namesFor={fixes.namesFor}
            onFix={canManage ? fixes.apply : () => undefined}
          />
        ) : (
          <Skeleton className="h-10" aria-label="Loading checks" role="status" />
        )}
      </CardBody>
    </Card>
  );
}
