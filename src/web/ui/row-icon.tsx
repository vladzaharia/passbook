import { ROW_ICONS } from '@/generated/plan-icons.ts';
import { cn } from '@/web/lib/cn.ts';

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
  if (!found) return null;
  return (
    <span
      data-row-icon={icon}
      data-area={found.area}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn('inline-flex size-5 shrink-0 [&>svg]:size-full', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: generated, static svg
      dangerouslySetInnerHTML={{ __html: mono ? found.mono : found.svg }}
    />
  );
}
