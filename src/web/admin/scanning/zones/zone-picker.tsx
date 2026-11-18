import { ChevronsUpDown, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  CheckboxField,
  FormField,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/web/ui/index.ts';
import { zoneNodes } from './zone-tree.ts';
import { useZones, zonesUnavailable } from './zones-api.ts';

export const MAX_PICKED = 8;

/**
 * Zones as removable chips, with the tree in a popover (a checkbox per zone, indent by level).
 * Renders nothing on a server without zones, so a form never offers what it cannot save.
 */
export function ZonePicker({
  orgId,
  value,
  onChange,
  label,
  help,
  disabled,
  status,
}: {
  orgId: string;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  label: string;
  help?: string;
  disabled?: boolean;
  /** A line under the field (what is open now). */
  status?: ReactNode;
}) {
  const zones = useZones(orgId || undefined, false, Boolean(orgId));
  if (zonesUnavailable(zones.error)) return null;
  const nodes = zoneNodes(zones.data ?? []);
  const name = (id: string) => nodes.find((n) => n.zone.id === id)?.zone.name ?? 'Archived zone';
  const full = value.length >= MAX_PICKED;
  return (
    <FormField
      label={label}
      help={[help, value.length ? `${value.length} of ${MAX_PICKED}.` : '']
        .filter(Boolean)
        .join(' ')}
    >
      {(p) => (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {value.map((id) => (
              <span
                key={id}
                className="inline-flex min-h-8 items-center gap-1 rounded-full border border-accent bg-accent-subtle ps-3 text-xs font-medium text-accent-fg"
              >
                {name(id)}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${name(id)}`}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  className="inline-flex size-8 items-center justify-center rounded-full hover:bg-state-hover-tint pointer-coarse:size-11"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </span>
            ))}
            {value.length === 0 ? <span className="text-sm text-fg-muted">Any zone</span> : null}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  aria-describedby={p['aria-describedby']}
                  type="button"
                  disabled={disabled || zones.isPending}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border-strong bg-surface-raised px-2 text-xs font-medium text-fg-strong hover:border-fg-muted pointer-coarse:min-h-11"
                >
                  {zones.isPending ? 'Loading…' : 'Choose zones'}
                  <ChevronsUpDown aria-hidden className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                aria-label={label}
                className="max-h-80 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-2"
              >
                {nodes.length === 0 ? (
                  <p className="p-2 text-sm text-fg-muted">No zones yet.</p>
                ) : (
                  <ul aria-label={label}>
                    {nodes.map(({ zone, level }) => (
                      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: ARIA 1.2 allows aria-level on listitem; axe agrees
                      <li
                        key={zone.id}
                        aria-level={level}
                        style={{ paddingInlineStart: `${(level - 1) * 20}px` }}
                      >
                        <CheckboxField
                          label={zone.name}
                          checked={value.includes(zone.id)}
                          disabled={full && !value.includes(zone.id)}
                          onCheckedChange={(on) =>
                            onChange(
                              on === true
                                ? [...value, zone.id]
                                : value.filter((v) => v !== zone.id),
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </PopoverContent>
            </Popover>
          </div>
          {status ? <p className="text-xs text-fg-muted">{status}</p> : null}
        </div>
      )}
    </FormField>
  );
}
