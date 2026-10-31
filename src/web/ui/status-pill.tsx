import type { ReactNode } from 'react';
import { type StatusKey, statusOf, TONE_ICON, type Tone } from '../lib/status.ts';
import { Badge } from './badge.tsx';

export interface StatusPillProps {
  /** A known status key (health or pass); unknown keys render neutral with the raw text. */
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
  return (
    <Badge tone={t} className={className}>
      <Icon aria-hidden />
      {children ?? entry?.label ?? status}
    </Badge>
  );
}
