import './brand-mark.css';

/**
 * The PassBook mark: the buddy's face from the favicon, without its tile, redrawn on a 20-unit
 * grid with heavier lines for 20–24 px. The pocket is open (the surface shows through), so the
 * passes are cut at its top line instead of hidden behind a fill. SSR renders the same component
 * (worker/ssr/theme.ts). `hello`: the passes pop up and it winks (brand-mark.css).
 */
export function BrandMark({ className, hello }: { className?: string; hello?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={className ? `wl-mark ${className}` : 'wl-mark'}
      data-hello={hello || undefined}
      aria-hidden="true"
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: a clip viewport inside the hidden mark */}
      <svg y="-3" width="20" height="10" viewBox="0 -3 20 10" overflow="hidden">
        <g transform="rotate(-18 6 10)">
          <rect data-p="1" x="3" y="1" width="6" height="9" rx="1.25" />
        </g>
        <g transform="rotate(18 14 10)">
          <rect data-p="3" x="11" y="1" width="6" height="9" rx="1.25" />
        </g>
        <rect data-p="2" x="7" width="6" height="9" rx="1.25" />
      </svg>
      <rect x="1" y="7" width="18" height="12" rx="3.5" />
      <circle cx="7" cy="12.5" r="1.5" />
      <circle data-wink="" cx="13" cy="12.5" r="1.5" />
      <path d="M8 15.25q2 1.5 4 0" />
    </svg>
  );
}
