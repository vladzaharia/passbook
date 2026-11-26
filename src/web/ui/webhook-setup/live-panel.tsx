import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { Buddy, type BuddyScene } from '../art/index.ts';
import './webhook-setup.css';

/**
 * The frame every live check shares: the buddy seated on its top edge, one polite region that says
 * each change of state (never a count or a tick), and the content. `say` is the sentence for the
 * current state; `sayKey` changes when it should be spoken again.
 */
export function LivePanel({
  label,
  scene,
  mood,
  buddy = true,
  say,
  sayKey,
  className,
  children,
}: {
  label: string;
  scene: BuddyScene;
  mood?: 'happy' | 'sad' | 'curious';
  buddy?: boolean;
  say: string;
  sayKey: string;
  className?: string;
  children: ReactNode;
}) {
  // Mounted empty, so the first sentence is a change the region announces.
  const [said, setSaid] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the key says the state changed.
  useEffect(() => setSaid(say), [sayKey]);
  const [replay, setReplay] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger.
  useEffect(() => setReplay((n) => n + 1), [sayKey]);
  return (
    <section
      data-art-host=""
      aria-label={label}
      className={cn(
        'relative flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-4',
        buddy && 'wl-buddy-room [--wl-buddy-room:3.5rem]',
        className,
      )}
    >
      {buddy ? <Buddy size="sm" at="end" scene={scene} mood={mood} replay={replay} /> : null}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      {children}
    </section>
  );
}
