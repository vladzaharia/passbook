import type { ReactNode } from 'react';
import { BUDDY_LABEL, type BuddyTone } from '../../../shared/copy/developers-buddy.ts';
import { BuddyFace } from '../../ui/art/face.tsx';
import '../../ui/art/scenes/face.css';
import './buddy-note.css';

/** tip: brows up. gotcha: one brow up, curious. done: happy, eyes shut. */
const FACE = {
  tip: { mood: 'neutral', brows: true },
  gotcha: { mood: 'curious', brows: false },
  done: { mood: 'happy', brows: false },
} as const;

/**
 * A guide callout from the buddy: its face at the start, a note with a short tail toward it, and
 * the words. The text says it all; the face is decoration (aria-hidden) and its eyes look at the
 * text. SSR-safe, so the note reads with no script. Matches `> [!buddy tip|gotcha|done]`; keep it
 * to one per screen height and three per guide, and write the text in developers-buddy.ts style.
 */
export function BuddyNote({
  tone,
  children,
  className,
}: {
  tone: BuddyTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="note" className={className ? `bnote ${className}` : 'bnote'} data-tone={tone}>
      <BuddyFace className="bnote-face" size="sm" scene="wink" {...FACE[tone]} />
      <div className="bnote-body">
        <strong className="bnote-label">{BUDDY_LABEL[tone]}</strong> {children}
      </div>
    </div>
  );
}
