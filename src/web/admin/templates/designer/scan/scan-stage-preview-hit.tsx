import type { ReactNode } from 'react';
import type { ScanDisplayPanel } from '@/shared/contracts/scan-display.ts';
import { DisplayChip } from '@/web/scan/display/chip.tsx';
import { scanIcon } from '@/web/scan/display/icons.ts';
import { DisplayRowView } from '@/web/scan/display/panel.tsx';

interface HitProps {
  id: string;
  focusKey?: string;
  label: string;
  selected: string | null;
  active: string;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  phone: boolean;
  children: ReactNode;
  className?: string;
  locked?: boolean;
}

export function Hit({
  id,
  focusKey = id,
  label,
  selected,
  active,
  onSelect,
  onFocus,
  phone,
  children,
  className = '',
  locked = false,
}: HitProps) {
  if (phone)
    return (
      <div className={`sp-hit ${className}`} data-locked={locked || undefined}>
        {children}
      </div>
    );
  return (
    <button
      type="button"
      className={`sp-hit ${className}`}
      data-locked={locked || undefined}
      data-preview-target={focusKey}
      data-selection-id={id}
      data-selected={(!locked && selected === id) || undefined}
      aria-label={label}
      aria-pressed={locked ? undefined : selected === id}
      title={locked ? label : undefined}
      tabIndex={active === focusKey ? 0 : -1}
      onFocus={() => onFocus(focusKey)}
      onClick={() => {
        if (!locked) onSelect(id);
      }}
    >
      {children}
    </button>
  );
}

export type HitState = Pick<HitProps, 'selected' | 'active' | 'onSelect' | 'onFocus' | 'phone'>;

export function PreviewPanel({ panel, hit }: { panel: ScanDisplayPanel; hit: HitState }) {
  const Icon = scanIcon(panel.icon);
  return (
    <div className="sd-panel" data-kind={panel.kind} data-tone={panel.tone ?? undefined}>
      <Hit
        {...hit}
        id={panel.id}
        label={`Panel ${panel.title ?? 'Untitled'}, ${panel.rows.length} ${panel.rows.length === 1 ? 'row' : 'rows'}`}
        className="sp-panel-hit"
      >
        <span className="sd-panel-head">
          {Icon ? <Icon aria-hidden size={16} /> : null}
          <span dir="auto">{panel.title ?? 'Panel'}</span>
        </span>
      </Hit>
      <div className="sd-rows">
        {panel.rows.map((row) =>
          row.type === 'chips' ? (
            <div key={row.id} className="sp-chip-row">
              <Hit {...hit} id={row.id} label="Row, chips" className="sp-chip-row-label">
                Chips
              </Hit>
              <div className="sd-chips">
                {row.items.map((chip) => (
                  <Hit
                    {...hit}
                    key={chip.id}
                    id={chip.id}
                    label={`Chip ${chip.text}`}
                    className="sp-chip-hit"
                  >
                    <DisplayChip chip={chip} />
                  </Hit>
                ))}
              </div>
            </div>
          ) : (
            <Hit {...hit} key={row.id} id={row.id} label={`Row ${row.type}`} className="sp-row-hit">
              <DisplayRowView row={row} />
            </Hit>
          ),
        )}
      </div>
    </div>
  );
}
