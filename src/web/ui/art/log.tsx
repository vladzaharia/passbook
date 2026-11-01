import { Art, type ArtProps } from './base.tsx';

export function LogArt(props: ArtProps) {
  return (
    <Art name="log" {...props}>
      <g data-part="w">
        <rect className="o" x="24" y="13" width="48" height="46" rx="3" />
        <path d="M24 21h48" />
      </g>
      <g data-part="l" data-b="">
        <path d="M34 28h24m-24 6h18m-24 6h28m-28 6h20" />
        <path
          className="n"
          d="M29 26.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3Zm0 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3Zm0 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3Zm0 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3Z"
        />
      </g>
      <g data-part="n" data-b="">
        <path d="M34 52h16" />
        <circle className="a" cx="29" cy="52" r="2" />
      </g>
    </Art>
  );
}
