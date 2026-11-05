import { Art, type ArtProps } from './base.tsx';

/** A lock screen with a notification banner and its dot: a message, not a pass. */
export function BroadcastArt(props: ArtProps) {
  return (
    <Art name="broadcast" {...props}>
      <rect className="o" x="28" y="6" width="40" height="60" rx="6" />
      <path d="M41 17h14" />
      <path className="st" d="M33 53h30" />
      <g data-part="b" data-b="">
        <rect className="o" x="32" y="25" width="32" height="18" rx="3.5" />
        <path d="M37 32h12m-12 5h20" />
      </g>
      <circle data-part="d" className="a" cx="63" cy="25" r="4" />
    </Art>
  );
}
