import { FlaskConical } from 'lucide-react';
import type { Mode } from '@/shared/contracts/common.ts';
import { Badge } from '../badge.tsx';

/** The full Test marker, also used by documents that do not load compact status tooltips. */
export function ModeLabel({ mode, className }: { mode: Mode | undefined; className?: string }) {
  if (mode !== 'test') return null;
  return (
    <Badge tone="warning" className={className}>
      <FlaskConical aria-hidden />
      Test
    </Badge>
  );
}
