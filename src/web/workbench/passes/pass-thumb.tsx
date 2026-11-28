import { cn } from '../../lib/cn.ts';

/**
 * A pass as a small card: the list has no pass.json to draw, so the thumbnail is the card's shape,
 * its three lines and a code. A voided pass goes grey.
 */
export function PassThumb({ voided }: { voided: boolean }) {
  return (
    <span aria-hidden className={cn('wb-pass-thumb', voided && 'wb-pass-thumb-off')}>
      <i />
      <i />
      <i />
      <b />
    </span>
  );
}
