import { Link } from '@tanstack/react-router';
import { ArchiveX, BadgeCheck, Mail, ScanLine, ScanSearch, Wallet } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { OrgActivity } from '@/shared/contracts/metrics.ts';
import { cn } from '@/web/lib/cn.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { formatCount } from '@/web/lib/format.ts';
import { Button, Card, CardBody, EntityArt } from '@/web/ui/index.ts';
import { useRememberedCount } from './count.ts';
import { type Kpi, Tile } from './kpis.tsx';
import type { Range } from './range.ts';

/** Five counts for the range: issued, in a wallet now, removed, scans, redemptions. */
export function OrgTiles({
  data,
  range,
  enter,
  countScope,
  canScan,
}: {
  data: OrgActivity;
  range: Range;
  enter: boolean;
  countScope: string;
  canScan: boolean;
}) {
  const { totals: t, series: s } = data;
  const scans = canScan ? { to: '/admin/scanning' } : { to: '/admin/passes' };
  const kpis: Kpi[] = [
    {
      id: 'issued',
      label: 'Issued',
      value: t.issued,
      icon: ENTITY.pass.icon,
      series: s.issued,
      to: '/admin/passes',
    },
    {
      id: 'inWallet',
      label: 'In a wallet',
      value: t.inWallet,
      icon: Wallet,
      series: [],
      to: '/admin/passes',
      search: { status: 'active', onDevice: 'true' },
    },
    {
      id: 'removed',
      label: 'Removed',
      value: t.removed,
      icon: ArchiveX,
      series: [],
      to: '/admin/passes',
      search: { status: 'removed' },
    },
    {
      id: 'scans',
      label: 'Scans',
      value: t.scans,
      icon: ScanLine,
      series: s.scans,
      ...scans,
    },
    {
      id: 'redemptions',
      label: 'Redemptions',
      value: t.redemptions,
      icon: BadgeCheck,
      series: [],
      ...scans,
    },
  ];
  return (
    <ul
      aria-label="Totals"
      className={cn(
        'grid grid-cols-2 gap-3 max-md:[&>li:last-child:nth-child(odd)]:col-span-2 md:grid-cols-6 xl:grid-cols-5 md:[&>li]:col-span-2 md:[&>li:nth-child(n+4)]:col-span-3 xl:[&>li]:col-span-1 xl:[&>li:nth-child(n+4)]:col-span-1',
        enter && 'wl-stagger',
      )}
    >
      {kpis.map((k, i) => (
        <Tile key={k.id} kpi={k} index={i} range={range} countScope={countScope} />
      ))}
    </ul>
  );
}

/** Passes sent but on no device: the count opens the pass list filtered to them, ready to email. */
export function NotAddedCard({
  count,
  countScope,
  canOperate,
}: {
  count: number;
  countScope: string;
  canOperate: boolean;
}) {
  const shown = useRememberedCount(`${countScope}:notAdded`, count);
  const list = { status: 'active', onDevice: 'false' } as const;
  return (
    <Card className="wl-notadded">
      <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <EntityArt name="passes" size="sm" still />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm text-fg-muted">Not added yet</h2>
          <p className="text-3xl leading-none font-semibold tracking-[-0.02em] text-fg-strong tabular-nums">
            {formatCount(shown)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" style={{ '--i': 0 } as CSSProperties}>
          <Button asChild variant="ghost" size="sm" iconStart={<ScanSearch aria-hidden />}>
            <Link to="/admin/passes" search={{ noScanDays: 30 }}>
              No scan in 30 days
            </Link>
          </Button>
          <Button
            asChild
            variant={count > 0 ? 'primary' : 'outline'}
            iconStart={<Mail aria-hidden />}
          >
            <Link to="/admin/passes" search={list}>
              {canOperate ? 'Email holders' : 'View passes'}
            </Link>
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
