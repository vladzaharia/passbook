import { Art, type ArtProps } from './base.tsx';

export function EnvelopeArt(props: ArtProps) {
  return (
    <Art name="envelope" {...props}>
      <g data-part="e">
        <rect className="o" x="22" y="28" width="52" height="34" rx="3" />
        <path data-part="u" className="o" d="M22 29.5 48 13l26 16.5Z" />
        <g data-part="p" data-b="">
          <rect className="o" x="32" y="16" width="32" height="30" rx="2" />
          <path className="a" d="M34.5 16h27" />
          <path d="M37 24h14m-14 5h20" />
        </g>
        <path className="o" d="M22 34l26 16 26-16v25a3 3 0 0 1-3 3H25a3 3 0 0 1-3-3Z" />
        <path data-part="c" className="o" d="M22 29.5 48 46l26-16.5Z" />
      </g>
    </Art>
  );
}
