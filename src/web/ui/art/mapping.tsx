import { Art, type ArtProps } from './base.tsx';

const SLOTS = [0, 1, 2].flatMap((row) => [
  { x: 16, y: 18 + row * 14, i: row },
  { x: 58, y: 18 + row * 14, i: row + 3 },
]);

export function MappingArt(props: ArtProps) {
  return (
    <Art name="mapping" {...props}>
      {SLOTS.map((s) => (
        <rect
          key={s.i}
          data-part="s"
          data-i={s.i}
          className="s"
          x={s.x}
          y={s.y}
          width="22"
          height="8"
          rx="2"
        />
      ))}
      <path data-part="a" data-b="" className="a" d="M42 36h11m-3.5-3.5L53 36l-3.5 3.5" />
    </Art>
  );
}
