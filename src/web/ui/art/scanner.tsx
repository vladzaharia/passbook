import { Art, type ArtProps } from './base.tsx';

export function ScannerArt(props: ArtProps) {
  return (
    <Art name="scanner" {...props}>
      <rect data-part="f" className="o" x="30" y="8" width="36" height="58" rx="5" />
      <path data-part="l" data-b="" className="a" d="M37 35h22" />
    </Art>
  );
}
