import { Art, type ArtProps } from './base.tsx';

export function BadgeArt(props: ArtProps) {
  return (
    <Art name="badge" {...props}>
      <path d="M38 4l10 20 10-20" />
      <g data-part="b" data-b="">
        <rect className="o" x="32" y="24" width="32" height="42" rx="5" />
        <circle className="a" cx="48" cy="42" r="6" />
      </g>
    </Art>
  );
}
