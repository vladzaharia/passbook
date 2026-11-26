import { RefreshCw } from 'lucide-react';
import { makeDefaultConfirm } from '@/web/lib/confirms-wallet.ts';
import { Button, ConfirmDialog, StepMarker, toast } from '@/web/ui/index.ts';
import { platformName } from './platform-card.tsx';
import { type PlatformIdentity, useMakeDefault } from './platform-queries.ts';
import { readiness } from './platform-ready.ts';
import { useCheckApns } from './queries.ts';

/**
 * Make default: what must hold first, each check ticked or open, then the kit confirm. The server
 * checks again and refuses a stale view (IDENTITY_NOT_READY); step-up is the api layer's.
 */
export function MakeDefaultDialog({
  row,
  now,
  onOpenChange,
}: {
  row: PlatformIdentity | null;
  now: number;
  onOpenChange: (open: boolean) => void;
}) {
  if (!row) return null;
  return <Body row={row} now={now} onOpenChange={onOpenChange} />;
}

function Body({
  row,
  now,
  onOpenChange,
}: {
  row: PlatformIdentity;
  now: number;
  onOpenChange: (open: boolean) => void;
}) {
  const make = useMakeDefault(row.id);
  const probe = useCheckApns(row.id);
  const checks = readiness(row, now);
  const ready = checks.every((c) => c.ok);
  const copy = makeDefaultConfirm(platformName(row));
  const pushOpen = checks.some((c) => (c.id === 'push' || c.id === 'probe') && !c.ok);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={copy.title}
      confirmLabel={copy.confirmLabel}
      confirmDisabled={!ready}
      description={
        <>
          {copy.description}
          {/* biome-ignore lint/a11y/useSemanticElements: the description is a <p>; a list element cannot nest in it */}
          <span className="mt-3 flex flex-col gap-1" role="list" aria-label="Readiness">
            {checks.map((c) => (
              // biome-ignore lint/a11y/useSemanticElements: see the list above
              <span key={c.id} role="listitem" className="flex min-h-8 items-center gap-2">
                <StepMarker state={c.ok ? 'done' : 'invalid'} n={1} size="sm" />
                <span className={c.ok ? 'text-fg' : 'text-fg-strong'}>{c.label}</span>
                <span className="sr-only">{c.ok ? 'Ready' : 'Not ready'}</span>
              </span>
            ))}
          </span>
          {pushOpen ? (
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              iconStart={<RefreshCw aria-hidden />}
              loading={probe.isPending}
              onClick={() =>
                probe.mutate(undefined, {
                  onError: (cause) => toast.error(cause, 'Could not check push'),
                })
              }
            >
              Check push
            </Button>
          ) : null}
        </>
      }
      onConfirm={async () => {
        await make.mutateAsync();
        toast.success(`${platformName(row)} is the default`);
      }}
    />
  );
}
