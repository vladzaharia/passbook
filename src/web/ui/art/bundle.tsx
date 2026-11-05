import { Art, type ArtProps } from './base.tsx';

/** Passes held together by one accent band: a bundle behind a single link. */
export function BundleArt(props: ArtProps) {
  return (
    <Art name="bundle" {...props}>
      <rect data-part="l" className="o" x="28" y="17" width="26" height="34" rx="3" />
      <rect data-part="r" className="o" x="42" y="17" width="26" height="34" rx="3" />
      <g data-part="c" data-b="">
        <rect className="o" x="35" y="13" width="26" height="38" rx="3" />
        <path d="M40 22h16m-16 5h10" />
      </g>
      <rect data-part="t" className="a" x="31" y="33" width="34" height="7" rx="3.5" />
    </Art>
  );
}
