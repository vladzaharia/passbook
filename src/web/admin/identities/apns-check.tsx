import type { z } from 'zod';
import type { ApnsProbeResultSchema } from '@/shared/contracts/identities.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button } from '@/web/ui/index.ts';
import { useCheckApns } from './queries.ts';

type Result = z.infer<typeof ApnsProbeResultSchema>;

export function probeLine(result: Result): string {
  const reason = result.reason ? `: ${result.reason}` : '';
  switch (result.health) {
    case 'healthy':
      return 'APNs accepted the certificate.';
    case 'failing':
      return `APNs rejected the certificate${reason}.`;
    case 'unavailable':
      return 'No APNs binding to check.';
    default:
      return `APNs gave no clear answer${reason || ` (HTTP ${result.status})`}. Try again later.`;
  }
}

export function CheckApnsButton({ identityId }: { identityId: string }) {
  const check = useCheckApns(identityId);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" loading={check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? 'Checking' : 'Check APNs'}
      </Button>
      <p className="text-sm text-fg-muted" role="status">
        {check.data ? probeLine(check.data) : null}
        {check.isError ? errorMessage(check.error) : null}
      </p>
    </div>
  );
}
