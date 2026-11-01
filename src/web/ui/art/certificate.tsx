import { Art, type ArtProps, Edge, Foil, useFoilId } from './base.tsx';

export function CertificateArt(props: ArtProps) {
  const id = useFoilId();
  return (
    <Art name="certificate" {...props}>
      <Foil id={id} x1={28} x2={62} />
      <g data-part="d">
        <rect className="o" x="28" y="12" width="34" height="46" rx="3" />
        <path d="M34 22h22M34 29h22M34 36h14" />
        <Edge id={id} x={28} y={12} w={34} />
      </g>
      <g data-part="s" data-b="" className="a">
        <path d="M54 55l-3 9 4-1.5 2 3.5 2.5-8m6.5-3 3 9-4-1.5-2 3.5-2.5-8" />
        <circle cx="60" cy="50" r="8" />
        <circle cx="60" cy="50" r="4" />
      </g>
    </Art>
  );
}
