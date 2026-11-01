import { Art, type ArtProps } from './base.tsx';

export function FramesArt(props: ArtProps) {
  return (
    <Art name="frames" {...props}>
      <g data-part="b">
        <rect className="o" x="20" y="16" width="38" height="30" rx="2" />
        <rect className="s" x="23" y="19" width="32" height="24" rx="1" />
      </g>
      <g data-part="f" data-b="">
        <rect className="o" x="38" y="26" width="38" height="30" rx="2" />
        <rect className="s" x="41" y="29" width="32" height="24" rx="1" />
        <path d="M41 50l9-9 6 6 5-5 12 11" />
        <circle data-part="s" className="a" cx="64" cy="35.5" r="3" />
      </g>
    </Art>
  );
}
