import { Art, type ArtProps } from './base.tsx';

export function PulseArt(props: ArtProps) {
  return (
    <Art name="pulse" {...props}>
      <path d="M48 52v6m-10 0h20" />
      <rect className="o" x="18" y="14" width="60" height="38" rx="4" />
      <rect className="s" x="23" y="19" width="50" height="28" rx="2" />
      <path data-part="l" d="M26 34h12l4-8 5 16 5-20 4 12h14" />
      <circle data-part="p" data-b="" className="a" cx="70" cy="34" r="2.5" />
    </Art>
  );
}
