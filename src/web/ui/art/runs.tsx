import { Art, type ArtProps } from './base.tsx';

export function RunsArt(props: ArtProps) {
  return (
    <Art name="runs" {...props}>
      <path d="M27.5 41.5 42.5 30.5m11 0 15 11" />
      <circle data-part="n" data-i="0" className="o" cx="22" cy="46" r="7" />
      <circle data-part="n" data-i="1" className="o" cx="48" cy="26" r="7" />
      <circle data-part="n" data-i="2" className="o" cx="74" cy="46" r="7" />
      <circle data-part="h" data-b="" className="a" cx="74" cy="46" r="3" />
    </Art>
  );
}
