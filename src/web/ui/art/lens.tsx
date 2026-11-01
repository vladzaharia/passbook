import { Art, type ArtProps } from './base.tsx';

const CELLS = [0, 1, 2].flatMap((col) => [22, 38].map((y) => ({ x: 24 + col * 17, y, i: col })));

export const Glass = () => (
  <g data-part="g" data-b="">
    <path className="h" d="M61 47l8 8" />
    <circle className="a" cx="54" cy="40" r="10" />
  </g>
);

export function LensArt(props: ArtProps) {
  return (
    <Art name="lens" {...props}>
      {CELLS.map((c) => (
        <rect
          key={`${c.x}-${c.y}`}
          data-part="c"
          data-i={c.i}
          className="s"
          x={c.x}
          y={c.y}
          width="14"
          height="12"
          rx="2"
        />
      ))}
      <Glass />
    </Art>
  );
}

export function LensOverlay(props: ArtProps) {
  return (
    <Art name="lens-overlay" {...props}>
      <Glass />
    </Art>
  );
}
