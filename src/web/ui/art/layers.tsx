import { Art, type ArtProps } from './base.tsx';

export function LayersArt({ compare, ...props }: ArtProps & { compare?: boolean }) {
  return (
    <Art name="layers" pose={compare ? 'compare' : undefined} {...props}>
      <rect data-part="s" data-i="0" className="o" x="34" y="32" width="40" height="28" rx="3" />
      <rect data-part="s" data-i="1" className="o" x="29" y="26" width="40" height="28" rx="3" />
      <g data-part="s" data-i="2" data-b="">
        <rect className="o" x="24" y="20" width="40" height="28" rx="3" />
        <path className="a" d="M26.5 20h35" />
        <path d="M30 30h20m-20 6h14" />
      </g>
    </Art>
  );
}
