import { Art, type ArtProps } from './base.tsx';

export function UnpluggedArt(props: ArtProps) {
  return (
    <Art name="unplugged" {...props} beat={false}>
      <g data-part="s">
        <path d="M80 34h8" />
        <rect className="o" x="56" y="20" width="24" height="28" rx="5" />
        <path d="M64 30v7m8-7v7" />
      </g>
      <g data-part="p">
        <path d="M22 46c-8 0-10 9-18 9" />
        <rect className="o" x="22" y="38" width="18" height="16" rx="4" />
        <path d="M40 42.5h7m-7 7h7" />
      </g>
      <path data-part="k" className="x" d="M50 25l-3-3m5 0v-4m2 4l3-3" />
    </Art>
  );
}
