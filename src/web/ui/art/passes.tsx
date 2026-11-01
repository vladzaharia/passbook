import { Art, type ArtProps, bars, Edge, Foil, useFoilId } from './base.tsx';

const card = 'M38 18h20a3 3 0 0 1 3 3v30a3 3 0 0 1-3 3H38a3 3 0 0 1-3-3V21a3 3 0 0 1 3-3Z';

export function PassesArt(props: ArtProps) {
  const id = useFoilId();
  return (
    <Art name="passes" {...props}>
      <Foil id={id} x1={35} x2={61} />
      <path data-part="l" className="o" d={card} />
      <path data-part="r" className="o" d={card} />
      <g data-part="c" data-b="">
        <path className="o" d={card} />
        <rect className="a" x="39" y="22" width="10" height="5" rx="1.5" />
        <path d={`M40 34h16m-16 5h10${bars(41, 45)}`} />
        <Edge id={id} x={35} y={18} w={26} />
      </g>
    </Art>
  );
}
