import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SCAN_SURFACE_LABELS, wireSurface } from '@/shared/scan-surfaces.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Callout, Dialog, DialogContent, Select, toast } from '@/web/ui/index.ts';
import type { Pairing } from '../pairing-face.tsx';
import { PAIRING_POLL_MS } from '../scanner-api.ts';
import { PairSlot } from '../setup/pair-roll.tsx';
import { useAddSessionDevice, useRevokeDeviceById, useUpdateSessionDevice } from './api.ts';

type Direction = 'inherit' | 'in' | 'out' | 'both';
type Layout = 'auto' | 'phone' | 'operator' | 'customer';
interface Row {
  id: string;
  name: string;
}
const LAYOUTS: Layout[] = ['auto', 'phone', 'operator', 'customer'];
const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'inherit', label: 'Session default' },
  { value: 'in', label: 'Entry only' },
  { value: 'out', label: 'Exit only' },
  { value: 'both', label: 'Automatic in / out' },
];

/** A paired device: its layout and direction, changeable now. */
function PairedRow({ sessionId, device }: { sessionId: string; device: Row }) {
  const update = useUpdateSessionDevice(sessionId, device.id);
  const [layout, setLayout] = useState<Layout>('auto');
  const [direction, setDirection] = useState<Direction>('inherit');
  const save = (next: { layout: Layout; direction: Direction }) => {
    update.mutate(
      {
        ...(wireSurface(next.layout) ? { surface: wireSurface(next.layout) ?? 'auto' } : {}),
        overrides: next.direction === 'inherit' ? {} : { direction: next.direction },
      },
      { onError: (cause) => toast.error(cause, 'Could not save device') },
    );
  };
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-border py-2 first:border-t-0">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-fg-strong">
        <Check aria-hidden className="size-4 shrink-0 text-success" />
        <span className="truncate">{device.name}</span>
      </span>
      <Select
        aria-label={`Layout for ${device.name}`}
        value={layout}
        options={LAYOUTS.map((value) => ({
          value,
          label: value === 'customer' ? 'Customer screen' : SCAN_SURFACE_LABELS[value],
        }))}
        onValueChange={(v) => {
          setLayout(v as Layout);
          save({ layout: v as Layout, direction });
        }}
      />
      <Select
        aria-label={`Direction for ${device.name}`}
        value={direction}
        options={DIRECTIONS}
        onValueChange={(v) => {
          setDirection(v as Direction);
          save({ layout, direction: v as Direction });
        }}
      />
    </li>
  );
}

/**
 * One live QR for a session. When a device pairs, the next row and a fresh code take its place.
 * At most one unpaired row exists; closing the sheet revokes it.
 */
export function PairSheet({
  sessionId,
  onClose,
  pollMs,
}: {
  sessionId: string;
  onClose: () => void;
  pollMs?: number;
}) {
  const add = useAddSessionDevice(sessionId);
  const revoke = useRevokeDeviceById();
  const [current, setCurrent] = useState<(Row & { pairing: Pairing | null }) | null>(null);
  const [paired, setPaired] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const started = useRef(false);
  const closed = useRef(false);
  const live = useRef<string | null>(null);
  const row = useRef<Row | null>(null);

  const next = useCallback(async () => {
    setError('');
    try {
      const made = await add.mutateAsync({ surface: 'auto' });
      if (closed.current) {
        void revoke.mutateAsync(made.id).catch(() => undefined);
        return;
      }
      live.current = made.id;
      row.current = { id: made.id, name: made.name };
      setCurrent({ id: made.id, name: made.name, pairing: made.pairing });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [add, revoke]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void next();
  }, [next]);

  const onPaired = useCallback(
    (id: string) => {
      if (live.current !== id) return;
      live.current = null;
      const done = row.current;
      row.current = null;
      if (done) setPaired((list) => [...list, done]);
      setCurrent(null);
      void next();
    },
    [next],
  );

  const close = () => {
    closed.current = true;
    const id = live.current;
    live.current = null;
    if (id) revoke.mutate(id, { onError: (cause) => toast.error(cause, 'Could not remove code') });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title="Pair devices"
        size="lg"
        footer={<Button onClick={close}>{paired.length ? 'Done' : 'Close'}</Button>}
      >
        <div className="grid gap-4">
          {error ? (
            <Callout tone="danger">
              {error}{' '}
              <Button variant="outline" size="sm" onClick={() => void next()}>
                Try again
              </Button>
            </Callout>
          ) : null}
          {current?.pairing ? (
            <PairSlot
              key={current.id}
              device={{ id: current.id, name: 'Next device', pairing: current.pairing }}
              onPaired={onPaired}
              pollMs={pollMs ?? PAIRING_POLL_MS}
            />
          ) : null}
          <p role="status" className="text-sm font-semibold text-fg-strong tabular-nums">
            {paired.length} paired
          </p>
          {paired.length ? (
            <ul aria-label="Paired devices">
              {paired.map((d) => (
                <PairedRow key={d.id} sessionId={sessionId} device={d} />
              ))}
            </ul>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
