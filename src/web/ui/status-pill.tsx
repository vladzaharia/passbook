import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { useChangeCount } from '../lib/motion.ts';
import { humanizeStatus, type StatusKey, statusOf, TONE_ICON, type Tone } from '../lib/status.ts';
import { Badge } from './badge.tsx';

export interface StatusPillProps {
  /** A known status key (health or pass); unknown keys render neutral with a humanized label. */
  status: StatusKey | (string & {});
  tone?: Tone;
  children?: ReactNode;
  className?: string;
}

/** Icon plus text, never colour alone. */
export function StatusPill({ status, tone, children, className }: StatusPillProps) {
  const entry = statusOf(status);
  const t = tone ?? entry?.tone ?? 'neutral';
  const Icon = entry?.icon ?? TONE_ICON[t];
  const changed = useChangeCount(status);
  return (
    <Badge tone={t} className={cn('relative', className)}>
      <Icon aria-hidden />
      {children ?? entry?.label ?? humanizeStatus(status)}
      {changed ? <span key={changed} aria-hidden className="wl-ring" /> : null}
    </Badge>
  );
}
