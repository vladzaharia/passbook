import { cn } from '@/web/lib/cn.ts';
import { hintSpoken } from './words.ts';

/** "•• 7F3A" for the eye, "ends 7 F 3 A" for a screen reader. */
export function TagCode({ hint, className }: { hint: string; className?: string }) {
  return (
    <span className={cn('font-mono', className)}>
      <span aria-hidden>•• {hint}</span>
      <span className="sr-only">{hintSpoken(hint)}</span>
    </span>
  );
}

/** The meta line's first words are the code; the rest is plain text. */
export function WithCode({ hint, text }: { hint: string; text: string }) {
  const rest = text.replace(/^•• [0-9A-F]{4}/, '');
  return (
    <>
      <TagCode hint={hint} />
      {rest}
    </>
  );
}
