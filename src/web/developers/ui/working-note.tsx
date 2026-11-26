import type { ReactNode } from 'react';
import { BuddyFace } from '../../ui/art/face.tsx';
import '../../ui/art/scenes/face.css';
import './working-note.css';

/**
 * A long action under way: the buddy, what is happening, and a line on how long. `children` is the seam for
 * live steps (a StepList): until the server reports them, the note says only what is true, one call is running.
 */
export function WorkingNote({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="wnote" role="status" aria-live="polite">
      <BuddyFace className="wnote-face" size="sm" scene="wink" mood="curious" />
      <div className="wnote-body">
        <strong>{title}</strong>
        <span className="sm muted">{detail}</span>
        <span className="wnote-bar" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
