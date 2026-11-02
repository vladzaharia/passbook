/**
 * The mascot's face on a 24-unit icon grid (art-wallet.css): the pocket, its fanned passes and a
 * smile. For icon slots: success toasts and the all-good status banner. It pops in with its host
 * and winks once; the pocket fills with --wl-face-bg, the host's surface.
 */
export function BuddyFace({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ? `wl-face ${className}` : 'wl-face'}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="c1"
        x="4.6"
        y="3.6"
        width="6.4"
        height="9"
        rx="1.4"
        transform="rotate(-18 7.8 12.6)"
      />
      <rect
        className="c3"
        x="13"
        y="3.6"
        width="6.4"
        height="9"
        rx="1.4"
        transform="rotate(18 16.2 12.6)"
      />
      <rect className="c2" x="8.8" y="2" width="6.4" height="9" rx="1.4" />
      <rect className="o" x="2.5" y="9" width="19" height="13" rx="4" />
      <circle data-eye="" cx="9" cy="14.7" r="1.4" />
      <circle data-eye="" data-wink="" cx="15" cy="14.7" r="1.4" />
      <path d="M10.1 17.7q1.9 1.5 3.8 0" />
    </svg>
  );
}
