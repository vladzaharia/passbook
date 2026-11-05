import { Art, type ArtProps } from './base.tsx';

export function StubArt(props: ArtProps) {
  return (
    <Art name="stub" {...props}>
      <path data-part="t" className="o" d="M18 24h60v9a4 4 0 0 0 0 8v9H18v-9a4 4 0 0 0 0-8Z" />
      <circle data-part="h" data-b="" className="a" cx="62" cy="37" r="4" />
    </Art>
  );
}
