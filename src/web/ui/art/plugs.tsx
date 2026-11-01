import { Art, type ArtProps } from './base.tsx';

export function PlugsArt(props: ArtProps) {
  return (
    <Art name="plugs" {...props}>
      <g data-part="p" data-b="">
        <path d="M26 36c-8 0-10 10-18 10" />
        <rect className="o" x="26" y="27" width="18" height="18" rx="4" />
        <path d="M44 31.5h10m-10 9h10" />
      </g>
      <g data-part="s" data-b="">
        <path d="M80 36h8" />
        <rect className="o" x="54" y="22" width="26" height="28" rx="5" />
        <circle data-part="l" className="a" cx="74" cy="28" r="2" />
      </g>
      <path data-part="k" d="M47 22l-2-4m6 3v-5m4 6l2-4" />
    </Art>
  );
}
