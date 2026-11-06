import type { ScanChip } from '../../../shared/contracts/scan-display.ts';
import { scanIcon } from './icons.ts';

/** A pill: 28 tall. The tone only picks a colour pair; the text says everything. */
export function DisplayChip({ chip }: { chip: ScanChip }) {
  const Icon = scanIcon(chip.icon);
  return (
    <span className="sd-chip" data-tone={chip.tone}>
      {Icon ? <Icon aria-hidden size={14} strokeWidth={2.25} /> : null}
      <span dir="auto">{chip.text}</span>
    </span>
  );
}

export function ChipRow({ chips }: { chips: readonly ScanChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="sd-chips">
      {chips.map((chip) => (
        <DisplayChip key={chip.id} chip={chip} />
      ))}
    </div>
  );
}
