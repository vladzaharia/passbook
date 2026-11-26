import { Buddy } from '../../../ui/art/buddy.tsx';
import '../../../ui/art/scenes/common.css';
import '../../../ui/art/scenes/wave.css';

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The buddy waves from the response's top edge on the first 2xx of a session; still under reduced motion. */
export function Cheer() {
  const still = reduced();
  return (
    <div className="cr-cheer" data-still={still || undefined}>
      <Buddy mood="happy" size="sm" at="end" scene="wave" still={still} />
    </div>
  );
}
