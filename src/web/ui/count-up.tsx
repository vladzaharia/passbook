import { cn } from '../lib/cn.ts';
import { useCountUp } from '../lib/motion.ts';

const plain = (n: number) => n.toLocaleString();

/** A number that counts to its value in 600 ms. */
export function CountUp({
  value,
  format = plain,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  return <span className={cn('tabular-nums', className)}>{format(useCountUp(value))}</span>;
}
