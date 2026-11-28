import { PlanIcon } from '../plan-icon.tsx';
import { Art, type ArtProps, DIM } from './base.tsx';
import './wallet-states.css';

/** Paused: a sign on a post, two bars. The buddy holds it (state-art.tsx). */
export function SignArt(props: ArtProps) {
  return (
    <Art name="sign" {...props}>
      <path d="M48 36v24" />
      <rect className="o" x="30" y="10" width="36" height="28" rx="5" />
      <path className="a" d="M42 18v12M54 18v12" />
    </Art>
  );
}

/** Closed: a clock face, its hands at rest. */
export function ClockArt(props: ArtProps) {
  return (
    <Art name="clock" {...props}>
      <circle className="o" cx="48" cy="34" r="22" />
      <path d="M48 20v14l9 6" />
      <circle className="a" cx="48" cy="34" r="2" />
    </Art>
  );
}

/** Included from {Plan}: the plan's own ticket icon, rising once (a CSS animation, no script). */
export function PlanTicketArt({ plan, size = 'xl' }: { plan: string; size?: ArtProps['size'] }) {
  const [width, height] = DIM[size];
  return (
    <span
      data-art="plan-ticket"
      data-size={size}
      data-plan={plan}
      className="wl-plan-ticket"
      style={{ width, height }}
    >
      <PlanIcon id={plan} />
    </span>
  );
}
