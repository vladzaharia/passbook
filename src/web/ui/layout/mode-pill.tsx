import type { Mode } from '@/shared/contracts/common.ts';
import { StatusIcon } from '../status-pill.tsx';

import { ModeLabel } from './mode-label.tsx';

/**
 * The one Test marker: on rows, details, cards and keys. Live shows nothing. Rows that would all
 * repeat it use `compact` (the icon, with the sentence in a tooltip).
 */
export function ModePill({
  mode,
  compact,
  className,
}: {
  mode: Mode | undefined;
  compact?: boolean;
  className?: string | undefined;
}) {
  if (mode !== 'test') return null;
  return compact ? (
    <StatusIcon status="test" className={className} />
  ) : (
    <ModeLabel mode={mode} className={className} />
  );
}
