import type { CSSProperties } from 'react';
import { AREA_ACCENTS, ROW_ICONS } from '@/generated/plan-icons.ts';
import { cn } from '@/web/lib/cn.ts';
import { useSvg } from './plan-icon.tsx';

export interface RowIconProps {
  /** Pricing-row key, such as live-passes or area-use. */
  icon: string;
  /** Decorative unless labelled. */
  label?: string;
  /** One colour (currentColor) instead of the area's own. */
  mono?: boolean;
  className?: string;
}

/** A feature row's icon: an area-coloured ticket with a glyph. The svg is generated markup. */
export function RowIcon({ icon, label, mono, className }: RowIconProps) {
  const found = ROW_ICONS[icon];
  const svg = useSvg(mono ? found?.mono : found?.svg);
  if (!found) return null;
  return (
    <span
      data-row-icon={icon}
      data-area={found.area}
      style={{ '--row-accent': AREA_ACCENTS[found.area] } as CSSProperties}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn('inline-flex size-5 shrink-0 [&>svg]:size-full', className)}
    >
      {svg}
    </span>
  );
}
