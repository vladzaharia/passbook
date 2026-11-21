import { Barcode, Monitor, Plus, Smartphone, TabletSmartphone, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, IconButton, SegmentedControl, Select } from '@/web/ui/index.ts';
import {
  type DeviceDraft,
  DIRECTION_LABEL,
  type Direction,
  LAYOUT_LABEL,
  type Layout,
  newDevice,
} from '../draft.ts';
import { deviceNames } from '../summary.ts';
import type { StepProps } from './step-props.ts';

const MAX_DEVICES = 10;
const ICON: Record<Layout, ReactNode> = {
  phone: <Smartphone aria-hidden />,
  operator: <TabletSmartphone aria-hidden />,
  customer: <Monitor aria-hidden />,
  barcode: <Barcode aria-hidden />,
};
const LAYOUTS = (Object.keys(LAYOUT_LABEL) as Layout[]).map((value) => ({
  value,
  label: LAYOUT_LABEL[value],
}));

function Row({
  name,
  device,
  derived,
  onChange,
  onRemove,
}: {
  name: string;
  device: DeviceDraft;
  /** The direction the planner derived; the dot marks it until the admin picks one. */
  derived: Direction;
  onChange: (d: DeviceDraft) => void;
  onRemove: () => void;
}) {
  const shown = device.direction ?? derived;
  const customer = device.layout === 'customer';
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised p-3">
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted [&_svg]:size-5"
      >
        {ICON[device.layout]}
      </span>
      <span className="min-w-24 flex-1 text-sm font-medium text-fg-strong">{name}</span>
      <Select
        aria-label={`Layout of ${name}`}
        options={LAYOUTS}
        value={device.layout}
        className="w-48"
        onValueChange={(layout) => {
          const next = layout as Layout;
          // A barcode reader cannot tell in from out.
          onChange({
            ...device,
            layout: next,
            direction: next === 'barcode' && device.direction === 'both' ? 'in' : device.direction,
          });
        }}
      />
      {customer ? (
        <span className="w-24 text-center text-sm text-fg-muted">
          <span className="sr-only">No direction</span>
          <span aria-hidden>—</span>
        </span>
      ) : (
        <SegmentedControl
          label={`Direction of ${name}`}
          value={shown}
          options={(['in', 'out', 'both'] as const).map((value) => ({
            value,
            label: `${DIRECTION_LABEL[value]}${device.direction === undefined && value === derived ? ' •' : ''}`,
            title: DIRECTION_LABEL[value],
            disabled: device.layout === 'barcode' && value === 'both',
          }))}
          onValueChange={(direction) => onChange({ ...device, direction })}
        />
      )}
      <IconButton label={`Remove ${name}`} icon={<X aria-hidden />} onClick={onRemove} />
    </li>
  );
}

/** Devices: a layout and a direction each. The direction shows what the answers derive. */
export function DevicesStep({
  draft,
  set,
  directions,
}: StepProps & { directions: readonly Direction[] }) {
  const names = deviceNames(draft);
  return (
    <div className="grid gap-4">
      <ul className="grid gap-3">
        {draft.devices.map((d, i) => (
          <Row
            key={d.id}
            name={names[i] ?? ''}
            device={d}
            derived={directions[i] ?? 'in'}
            onChange={(next) =>
              set({ devices: draft.devices.map((x) => (x.id === d.id ? next : x)) })
            }
            onRemove={() => set({ devices: draft.devices.filter((x) => x.id !== d.id) })}
          />
        ))}
      </ul>
      {draft.devices.length < MAX_DEVICES ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            iconStart={<Plus aria-hidden />}
            onClick={() => set({ devices: [...draft.devices, newDevice('phone')] })}
          >
            Add device
          </Button>
        </div>
      ) : null}
    </div>
  );
}
