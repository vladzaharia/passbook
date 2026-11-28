import { Link } from '@tanstack/react-router';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { wbPath } from '@/shared/workbench.ts';
import { Button } from '../../ui/button.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { ToolFailed } from '../states/states.tsx';
import { PreviewQr } from '../ui/preview-qr.tsx';
import { titleOf } from './model.ts';
import { PassThumb } from './pass-thumb.tsx';
import { usePassDetail } from './use-passes.ts';

/** The newest few: each card reads its pass for the link, so the view stays small. */
const SHOWN = 12;

function PhoneCard({ pass }: { pass: PassSummaryDto }) {
  const detail = usePassDetail(pass.id, { poll: false });
  const title = titleOf(pass);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 shadow-elevation-1">
      <div className="flex min-w-0 items-center gap-3">
        <PassThumb voided={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-fg-strong">{title}</span>
          {pass.subtitle ? (
            <span className="block truncate text-xs text-fg-muted">{pass.subtitle}</span>
          ) : null}
        </span>
        <StatusChip tone="success">{WB_PASSES.status.active}</StatusChip>
      </div>
      {detail.data ? (
        <PreviewQr
          url={detail.data.downloadUrl}
          alt={WB_PASSES.phone.qrAlt(title)}
          open={WB_PASSES.phone.open}
        />
      ) : detail.isError ? (
        <ToolFailed error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Skeleton className="h-32 w-full" />
      )}
    </li>
  );
}

/**
 * On my phone (design §3.1, DS1): an org's Test passes by their real Add to Wallet link, as a QR
 * each. A sandbox's pass is a preview, so its link is the Test preview page.
 */
export function PhoneView({ orgId, passes }: { orgId: string; passes: readonly PassSummaryDto[] }) {
  const active = passes.filter((p) => p.status === 'active' && p.removedAt === null);
  if (active.length === 0)
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface-raised p-4">
        <p className="text-sm text-fg-muted">{WB_PASSES.phone.empty}</p>
        <Button asChild variant="outline" size="sm">
          <Link to={wbPath(orgId, 'design')}>{WB_PASSES.phone.action}</Link>
        </Button>
      </div>
    );
  return (
    <ul aria-label={WB_PASSES.view.phone} className="wb-phone-grid">
      {active.slice(0, SHOWN).map((p) => (
        <PhoneCard key={p.id} pass={p} />
      ))}
    </ul>
  );
}
