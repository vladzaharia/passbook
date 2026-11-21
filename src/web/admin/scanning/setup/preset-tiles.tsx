import { Link } from '@tanstack/react-router';
import { ChevronRight, DoorOpen, Layers, Ticket } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ScanSetupPreset } from '@/shared/contracts/scan-setup-intent.ts';
import { cn } from '@/web/lib/cn.ts';
import { CARD_SURFACE } from '@/web/ui/index.ts';
import { PRESET_LABEL, PRESETS } from './draft.ts';
import './setup.css';

const LOOK = {
  front_desk: { icon: DoorOpen, tone: 'bg-accent-subtle text-accent-fg' },
  event_night: { icon: Ticket, tone: 'bg-info-subtle text-info' },
  venue: { icon: Layers, tone: 'bg-warning-subtle text-warning' },
} as const;

/** The three starting points: an icon and a name each. A tile opens the wizard with its answers. */
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
                'group flex min-h-28 flex-col justify-between gap-4 p-4 text-left wl-colors',
                'hover:border-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              <span className="flex items-start justify-between">
                <span
                  aria-hidden
                  className={cn('grid size-11 place-items-center rounded-lg', tone)}
                >
                  <Icon className="size-5" />
                </span>
                <ChevronRight aria-hidden className="size-4 text-fg-muted" />
              </span>
              <span className="text-sm font-medium text-fg-strong">{PRESET_LABEL[p]}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
