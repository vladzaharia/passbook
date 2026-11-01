import { Art, type ArtProps } from './base.tsx';

export function ActivityArt(props: ArtProps) {
  return (
    <Art name="activity" {...props}>
      <path data-part="r" d="M36 18v38" />
      <path data-part="t" d="M46 18h22m-22 5h14m-14 12h18m-18 5h12m-12 12h20m-20 5h10" />
      <circle data-part="d" data-i="0" data-b="" className="a" cx="36" cy="20" r="4" />
      <circle data-part="d" data-i="1" className="o" cx="36" cy="37" r="4" />
      <circle data-part="d" data-i="2" className="o" cx="36" cy="54" r="4" />
    </Art>
  );
}
