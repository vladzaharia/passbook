/** The tag: a rounded fob with a ring hole and two arcs. One drawing for the card, the chip and the prop. */
export function TagArt({
  size = 96,
  struck = false,
  className,
}: {
  size?: number;
  /** A lost or refused tag: grey, with one diagonal. */
  struck?: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={['scan-tag-art', className].filter(Boolean).join(' ')}
      data-struck={struck || undefined}
      width={size}
      height={(size * 3) / 4}
      viewBox="0 0 96 72"
      fill="none"
    >
      <rect className="scan-tag-body" x="8" y="14" width="56" height="44" rx="10" />
      <circle className="scan-tag-hole" cx="22" cy="28" r="4.5" />
      <path className="scan-tag-arc scan-tag-arc-1" d="M72 26a14 14 0 0 1 0 20" />
      <path className="scan-tag-arc scan-tag-arc-2" d="M80 20a24 24 0 0 1 0 32" />
      {struck ? <path className="scan-tag-strike" d="M12 62 80 8" /> : null}
    </svg>
  );
}
