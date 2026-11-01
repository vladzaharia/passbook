import { Art, type ArtProps, bars } from './base.tsx';

const TEAR = 'L54.5 17.5 56.5 16.5 58.5 20.5 60.5 19.5 62.5 23.5 64 23';

export function TornArt(props: ArtProps) {
  return (
    <Art name="torn" {...props}>
      <g data-part="b">
        <path
          className="o"
          d={`M35 14h17${TEAR}v34a3 3 0 0 1-3 3H35a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3Z`}
        />
        <path d={`M37 30h18m-18 5h12${bars(39, 49)}`} />
        <rect className="s" x="37" y="19" width="11" height="5" rx="1.5" />
      </g>
      <path
        data-part="c"
        data-b=""
        className="a"
        d="M52 14h9a3 3 0 0 1 3 3v6L62.5 23.5 60.5 19.5 58.5 20.5 56.5 16.5 54.5 17.5Z"
      />
    </Art>
  );
}
