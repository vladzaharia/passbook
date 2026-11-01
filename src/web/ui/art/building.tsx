import { Art, type ArtProps } from './base.tsx';

const WINDOWS = [0, 1, 2].flatMap((row) =>
  [0, 1, 2].map((col) => ({ x: 35 + col * 10, y: 27 + row * 8, i: row + col })),
);

export function BuildingArt(props: ArtProps) {
  return (
    <Art name="building" {...props}>
      <path d="M20 58h56M48 22V11" />
      <path data-part="f" className="a" d="M48 11h10l-2.5 3.5 2.5 3.5H48Z" />
      <rect data-part="b" className="o" x="30" y="22" width="36" height="36" rx="2" />
      {WINDOWS.map((w) => (
        <rect
          key={`${w.x}-${w.y}`}
          data-part="w"
          data-i={w.i}
          data-b=""
          className="s"
          x={w.x}
          y={w.y}
          width="6"
          height="5"
          rx="1"
        />
      ))}
      <rect data-part="d" className="s" x="44" y="50" width="8" height="8" rx="1" />
    </Art>
  );
}
