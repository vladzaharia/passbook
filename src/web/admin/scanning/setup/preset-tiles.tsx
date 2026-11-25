import { Link } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  ChevronRight,
  Coffee,
  DoorOpen,
  Fence,
  Gauge,
  Layers,
  PackageCheck,
  Presentation,
  Ticket,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ScanSetupPreset } from '@/shared/contracts/scan-setup-intent.ts';
import { cn } from '@/web/lib/cn.ts';
import { CARD_SURFACE } from '@/web/ui/index.ts';
import { PRESETS, presetLabel } from './draft.ts';
import './setup.css';

const LOOK = {
  front_desk: { icon: DoorOpen, tone: 'bg-accent-subtle text-accent-fg' },
  event_night: { icon: Ticket, tone: 'bg-info-subtle text-info' },
  venue: { icon: Layers, tone: 'bg-warning-subtle text-warning' },
  club: { icon: ArrowLeftRight, tone: 'bg-success-subtle text-success' },
  conference: { icon: Presentation, tone: 'bg-accent-subtle text-accent-fg' },
  gates: { icon: Fence, tone: 'bg-info-subtle text-info' },
  counter: { icon: Coffee, tone: 'bg-warning-subtle text-warning' },
  pickup: { icon: PackageCheck, tone: 'bg-info-subtle text-info' },
  capacity: { icon: Gauge, tone: 'bg-success-subtle text-success' },
} as const satisfies Record<ScanSetupPreset, unknown>;

/** The starting points: an icon and a name each. A tile opens the wizard with its answers. */
export function PresetTiles({ orgId }: { orgId: string }) {
  return (
    <ul className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
      {PRESETS.map((p: ScanSetupPreset, i) => {
        const { icon: Icon, tone } = LOOK[p];
        return (
          <li key={p} className="wl-deal" style={{ '--wl-i': i } as CSSProperties}>
            <Link
              to="/admin/o/$orgId/scanning/setup"
              params={{ orgId }}
              search={{ preset: p }}
              className={cn(
                CARD_SURFACE,
                'group flex min-h-16 items-center gap-3 p-3 text-left wl-colors sm:min-h-28 sm:flex-col sm:items-stretch sm:justify-between sm:gap-4 sm:p-4',
                'hover:border-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              <span className="contents sm:flex sm:items-start sm:justify-between">
                <span
                  aria-hidden
                  className={cn('grid size-11 place-items-center rounded-lg', tone)}
                >
                  <Icon className="size-5" />
                </span>
                <ChevronRight aria-hidden className="order-last size-4 text-fg-muted" />
              </span>
              <span className="min-w-0 flex-1 text-sm font-medium text-fg-strong sm:flex-none">
                {presetLabel(p)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
