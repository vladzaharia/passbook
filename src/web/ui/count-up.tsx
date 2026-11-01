import { useRef } from 'react';
import { useCountUp } from '../lib/motion.ts';

const plain = (n: number) => n.toLocaleString();

/** A number that counts to its value. Screen readers get the value only. */
export function CountUp({
  value,
  format = plain,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, format);
  return (
    <span className={className}>
      <span ref={ref} aria-hidden className="tabular-nums">
        {format(value)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
