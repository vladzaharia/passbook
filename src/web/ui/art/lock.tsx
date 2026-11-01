import { Art, type ArtProps, bars } from './base.tsx';

export function LockArt(props: ArtProps) {
  return (
    <Art name="lock" {...props}>
      <g data-part="p">
        <rect className="o" x="30" y="9" width="36" height="50" rx="3" />
        <rect className="s" x="35" y="14" width="12" height="5" rx="1.5" />
        <path d={`M35 25h20${bars(36, 50)}`} />
      </g>
      <g data-part="k">
        <path data-part="s" data-b="" d="M42 38v-5a6 6 0 0 1 12 0v5" />
        <g data-part="b">
          <rect className="a" x="37" y="37" width="22" height="17" rx="3" />
          <path d="M48 44v4" />
        </g>
      </g>
    </Art>
  );
}
