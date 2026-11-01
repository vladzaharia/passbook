import { Art, type ArtProps } from './base.tsx';

const bust = (x: number, y: number, r: number, w: number) => (
  <>
    <path className="o" d={`M${x - w} 56v-2a${w} ${w * 0.9} 0 0 1 ${w * 2} 0v2Z`} />
    <circle className="o" cx={x} cy={y} r={r} />
  </>
);

export function PeopleArt(props: ArtProps) {
  return (
    <Art name="people" {...props}>
      <g data-part="l" data-b="">
        {bust(28, 33, 5.5, 10)}
      </g>
      <g data-part="r" data-b="">
        {bust(68, 33, 5.5, 10)}
      </g>
      <g data-part="c" data-b="">
        {bust(48, 27, 7.5, 13)}
        <circle className="a" cx="55" cy="47" r="3" />
      </g>
    </Art>
  );
}
