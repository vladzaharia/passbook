import { ShieldPlus } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { Button, Card, CardBody, CardHeader, ErrorState, Skeleton } from '@/web/ui/index.ts';
import { PlatformCard } from './platform-card.tsx';
import { MakeDefaultDialog } from './platform-default.tsx';
import { MovePassesDialog } from './platform-move.tsx';
import { PlatformMoves } from './platform-moves.tsx';
import { type PlatformIdentity, type Slot, usePlatformIdentities } from './platform-queries.ts';
import { PlatformRun } from './platform-run.tsx';
import { PlatformSetupWizard } from './platform-setup-wizard.tsx';

const SLOTS: readonly Slot[] = ['root', 'devtest'];
const ORDER = (row: PlatformIdentity) => (row.slot === 'root' ? 0 : row.slot === 'devtest' ? 1 : 2);

/** The platform's own Apple identities: root, device test and the legacy one, with their actions. */
export function PlatformSection() {
  const list = usePlatformIdentities();
  const [setup, setSetup] = useState(false);
  const [defaulting, setDefaulting] = useState<PlatformIdentity | null>(null);
  const [moving, setMoving] = useState<PlatformIdentity | null>(null);
  const [movedOrg, setMovedOrg] = useState<string>();
  const now = Date.now();
  if (list.isPending) return <Skeleton className="mb-6 h-48 w-full" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  const { items, openRuns } = list.data;
  const rows = [...items].sort((a, b) => ORDER(a) - ORDER(b));
  const open = new Set(openRuns.map((r) => r.slot));
  // A slot with no identity and no run in flight is the one to set up.
  const free = SLOTS.filter((s) => !items.some((i) => i.slot === s) && !open.has(s));
  return (
    <section aria-labelledby="platform-identities" className="mb-6 flex flex-col gap-6">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2">
        <h2 id="platform-identities" className="text-base font-semibold text-fg-strong">
          Platform identities
        </h2>
        {free.length > 0 ? (
          <Button
            variant="outline"
            iconStart={<ShieldPlus aria-hidden />}
            onClick={() => setSetup(true)}
          >
            Set up
          </Button>
        ) : null}
      </div>
      <div className="wl-deal grid gap-6 @container md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row, i) => (
          <PlatformCard
            key={row.id}
            row={row}
            index={i}
            now={now}
            onMakeDefault={setDefaulting}
            onMove={setMoving}
          />
        ))}
        {openRuns.map((r, i) => (
          <Card key={r.runId} style={{ '--i': rows.length + i } as CSSProperties}>
            <CardHeader title={r.slot === 'root' ? 'Root' : 'Device test'} />
            <CardBody>
              <PlatformRun runId={r.runId} />
            </CardBody>
          </Card>
        ))}
      </div>
      {movedOrg ? <PlatformMoves orgId={movedOrg} /> : null}
      <PlatformSetupWizard open={setup} onOpenChange={setSetup} slots={free} />
      <MakeDefaultDialog
        row={defaulting}
        now={now}
        onOpenChange={(o) => !o && setDefaulting(null)}
      />
      <MovePassesDialog
        from={moving}
        identities={items}
        onOpenChange={(o) => !o && setMoving(null)}
        onStarted={setMovedOrg}
      />
    </section>
  );
}
