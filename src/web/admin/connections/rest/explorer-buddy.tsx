import type { ReactNode } from 'react';
import { Buddy } from '../../../ui/index.ts';

export type Mood = 'happy' | 'curious' | 'sad';

/** NO_RECORDS is a question, the rest a dead end: a curious buddy asks, a sad one sighs. */
export const moodOf = (code: string): Mood => (code === 'NO_RECORDS' ? 'curious' : 'sad');

/**
 * The buddy beside a result line: it seats on the top edge of its box (one per view), so the box leaves
 * room above it. Remounted per result, it plays once; reduced motion keeps it still (art.css).
 */
export function ExplorerBuddy({ mood, children }: { mood: Mood; children: ReactNode }) {
  return (
    <div className="relative flex min-h-14 min-w-0 items-center gap-3 pl-[4.75rem]">
      <div aria-hidden className="absolute bottom-1 left-0 h-0 w-16">
        <Buddy key={mood} size="sm" mood={mood} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
