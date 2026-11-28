import { PLAN_ICONS } from '@/generated/plan-icons.ts';
import { cn } from '@/web/lib/cn.ts';

export interface PlanIconProps {
  /** Preset id: trial, starter, standard, business, premium, enterprise, legacy. */
  id: string;
  /** Decorative unless labelled. */
  label?: string;
  /** One colour (currentColor) instead of the ticket's own. */
  mono?: boolean;
  className?: string;
}

/** A plan's ticket icon. The svg is generated markup (tools/build-plan-icons.ts), never user input. */
export function PlanIcon({ id, label, mono, className }: PlanIconProps) {
  const icon = PLAN_ICONS[id];
  if (!icon) return null;
  return (
    <span
      data-plan-icon={id}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn('inline-flex size-5 shrink-0 [&>svg]:size-full', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: generated, static svg
      dangerouslySetInnerHTML={{ __html: mono ? icon.mono : icon.svg }}
    />
  );
}
