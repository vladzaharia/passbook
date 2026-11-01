import { Art, type ArtProps } from './base.tsx';

export function KeyArt(props: ArtProps) {
  return (
    <Art name="key" {...props}>
      <path d="M24 32v-6a9 9 0 0 1 18 0v6" />
      <rect className="o" x="19" y="31" width="28" height="24" rx="4" />
      <circle className="s" cx="33" cy="43" r="3" />
      <g data-part="k">
        <g data-part="t" data-b="">
          <path d="M33 43h24m-6 0v4m-5-4v3" />
          <circle className="a" cx="64" cy="43" r="7" />
          <circle className="s" cx="66" cy="43" r="2" />
        </g>
      </g>
    </Art>
  );
}
