import { Art, type ArtProps, bars, Edge, Foil, useFoilId } from './base.tsx';

export function TemplateArt(props: ArtProps) {
  const id = useFoilId();
  return (
    <Art name="template" {...props}>
      <Foil id={id} x1={33} x2={63} />
      <rect data-part="o" className="dash" x="33" y="15" width="30" height="42" rx="3" />
      <rect
        data-part="p"
        data-i="0"
        data-b=""
        className="o"
        x="37"
        y="19"
        width="22"
        height="5"
        rx="1.5"
      />
      <rect
        data-part="p"
        data-i="1"
        data-b=""
        className="a"
        x="37"
        y="27"
        width="22"
        height="12"
        rx="2"
      />
      <path data-part="p" data-i="2" data-b="" d={bars(39, 46)} />
      <g data-part="e">
        <Edge id={id} x={33} y={15} w={30} />
      </g>
    </Art>
  );
}
