import { ArrowRight, Check, QrCode, TriangleAlert, Undo2, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Tone } from './activity-model.ts';
import './person.css';

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** A steady hue per name, so a person keeps their colour across lists. */
export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const DISC = { ok: Check, out: ArrowRight, hu: TriangleAlert, no: X, undone: Undo2 } as const;

/** The verdict as colour and glyph on the avatar's corner. */
export function VerdictDisc({ tone }: { tone: Tone }) {
  const Icon = DISC[tone];
  return (
    <span className="op-disc" data-tone={tone} aria-hidden>
      <Icon strokeWidth={3} />
    </span>
  );
}

export function PersonAvatar({
  name,
  photoUrl,
  tone,
  unknown = false,
  size,
}: {
  name: string;
  photoUrl?: string | null | undefined;
  tone?: Tone | undefined;
  unknown?: boolean;
  size?: 'sm' | 'lg';
}) {
  const style = { '--h': hueOf(name) } as CSSProperties;
  return (
    <span
      className="op-av"
      data-size={size}
      data-unknown={unknown || undefined}
      style={style}
      aria-hidden
    >
      {unknown ? <QrCode /> : photoUrl ? <img src={photoUrl} alt="" /> : initialsOf(name)}
      {tone ? <VerdictDisc tone={tone} /> : null}
    </span>
  );
}
