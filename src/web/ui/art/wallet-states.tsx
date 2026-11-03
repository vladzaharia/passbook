/**
 * Parts some wallet states add, drawn in the art's units (motion: wallet-states.css). The sign-in
 * scene and the SSR band draw the same ones; each means one thing. The expired state needs no
 * part: its gold pass greys and droops (WalletArt state="expired").
 */
import './wallet-states.css';

/** Confirm (onCard): a check on the top card. */
export const CHECK = <path data-part="ck" className="ck" d="M43.5 20l3 3 6-6.5" />;

/** Break-glass (front): a keyhole right of the clasp; the key slides in along its shaft, then turns. */
export const KEY = (
  <>
    <circle className="e" cx="67" cy="46.5" r="1.7" />
    <rect className="e" x="66.25" y="46.5" width="1.5" height="4" rx=".75" />
    <g data-part="key">
      <g data-part="kt">
        <path className="m" d="M68 48h8M70.5 48v2.6M73 48v1.8" />
        <circle className="o m" cx="79.8" cy="48" r="3.8" />
      </g>
    </g>
  </>
);

/**
 * Wait, a rate limit (aside): an hourglass stands on the surface at the wallet's left, the open
 * side of a band, and flips in. Key it by the attempt to flip it again.
 */
export const HOURGLASS = (
  <g data-part="hg">
    <path d="M4 52h8M4 65.5h8M5 52v2.5l3 4.25-3 4.25v2.5M11 52v2.5l-3 4.25 3 4.25v2.5" />
    <path className="n" d="M6.4 64.6h3.2L8 62.2Z" />
  </g>
);
