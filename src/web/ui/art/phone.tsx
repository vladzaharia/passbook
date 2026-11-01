import { Art, type ArtProps } from './base.tsx';

export function PhoneArt(props: ArtProps) {
  return (
    <Art name="phone" {...props}>
      <g data-part="f">
        <rect className="o" x="36" y="25" width="24" height="40" rx="4" />
        <rect className="s" x="39" y="30" width="18" height="28" rx="1.5" />
        <path d="M45 61.5h6" />
      </g>
      <g data-part="p" data-b="">
        <rect className="o" x="40" y="5" width="16" height="20" rx="2" />
        <path d="M43 10h6m-6 4h10m-10 4h8" />
      </g>
      <circle data-part="u" className="a" cx="60" cy="26" r="4" />
    </Art>
  );
}
