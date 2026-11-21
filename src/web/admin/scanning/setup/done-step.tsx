import { Check, ChevronRight, Hourglass, QrCode } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ScanSetupResult } from '@/shared/contracts/scan-setup-intent.ts';
import { Badge, Button, type Crumb, PageHeader } from '@/web/ui/index.ts';
import { PairSheet } from '../sessions/pair-sheet.tsx';
import { type PairDevice, PairRoll } from './pair-roll.tsx';
import { PinList } from './pin-list.tsx';

/** Done: the door is made. Pair the devices from one QR, read the PINs once, open the session. */
export function DoneStep({
  result,
  deviceMeta,
  crumbs,
  onOpen,
  pollMs,
}: {
  result: ScanSetupResult;
  /** Layout and direction per device, in order, for the list. */
  deviceMeta: readonly string[];
  crumbs: readonly Crumb[];
  onOpen: (sessionId: string) => void;
  pollMs?: number;
}) {
  const session = result.sessions[0];
  const [sheet, setSheet] = useState(false);
  const [paired, setPaired] = useState<ReadonlySet<string>>(new Set());
  const onPaired = useCallback(
    (id: string) => setPaired((p) => (p.has(id) ? p : new Set(p).add(id))),
    [],
  );
  if (!session) return null;
  const devices: PairDevice[] = session.devices.map((d) => ({
    id: d.id,
    name: d.name,
    pairing: d.pairing,
  }));
  const next = devices.find((d) => !paired.has(d.id));
  const pins = result.staff.flatMap((s) =>
    s.pin ? [{ id: s.id, name: s.name, role: s.role, pin: s.pin }] : [],
  );
  return (
    <div className="grid gap-6">
      <PageHeader
        title={`${session.name} is ready`}
        breadcrumbs={crumbs}
        actions={
          <>
            <Button
              variant="outline"
              iconStart={<QrCode aria-hidden />}
              onClick={() => setSheet(true)}
            >
              Pair devices
            </Button>
            <Button iconEnd={<ChevronRight aria-hidden />} onClick={() => onOpen(session.id)}>
              Open session
            </Button>
          </>
        }
      />
      {sheet ? (
        <PairSheet sessionId={session.id} onClose={() => setSheet(false)} pollMs={pollMs} />
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-surface-raised p-4 pt-0">
          <PairRoll devices={devices} paired={paired} onPaired={onPaired} pollMs={pollMs} />
        </div>
        <div className="grid gap-6">
          <section
            aria-label="Devices"
            className="rounded-lg border border-border bg-surface-raised"
          >
            <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-fg-strong">
              Devices
            </h3>
            <ul>
              {devices.map((d, i) => (
                <li
                  key={d.id}
                  className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg-strong">{d.name}</p>
                    <p className="text-xs text-fg-muted">{deviceMeta[i]}</p>
                  </div>
                  {paired.has(d.id) ? (
                    <Badge tone="success">
                      <Check aria-hidden />
                      Paired
                    </Badge>
                  ) : d.id === next?.id ? (
                    <Badge tone="accent">
                      <Hourglass aria-hidden />
                      Pairing
                    </Badge>
                  ) : (
                    <Badge>Next</Badge>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <PinList rows={pins} />
        </div>
      </div>
    </div>
  );
}
