import { Buddy } from '../../../ui/art/buddy.tsx';
import '../../../ui/art/scenes/common.css';
import '../../../ui/art/scenes/cheer.css';
import '../../../ui/art/scenes/sorry.css';
import type { Moment } from '../cheer.ts';

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The buddy on the response's top edge: it cheers a create and is sorry for a failed call. Still under reduced motion. */
export function Cheer({ kind }: Pick<Moment, 'kind'>) {
  const still = reduced();
  return (
    <div className="cr-cheer" data-kind={kind} data-still={still || undefined}>
      <Buddy
        mood={kind === 'cheer' ? 'happy' : 'sad'}
        size="sm"
        at="end"
        scene={kind === 'cheer' ? 'cheer' : 'sorry'}
        still={still}
      />
    </div>
  );
}
