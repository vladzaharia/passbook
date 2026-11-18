import { Check, Laptop, Nfc, Tablet } from 'lucide-react';
import './tags.css';

/** Console and scanner joined by a dashed line: one dot travels it, then the scanner's arcs ping. */
export function EnrollArt({ stage }: { stage: 'waiting' | 'done' | 'refused' }) {
  return (
    <div aria-hidden className="wl-enroll-art">
      <span className="wl-enroll-end">
        <Laptop className="size-6" />
      </span>
      <span className="wl-enroll-line">
        {stage === 'waiting' ? <span className="wl-enroll-dot" /> : null}
      </span>
      <span className="wl-enroll-end relative">
        <Tablet className="size-6" />
        {stage === 'waiting' ? (
          <>
            <span className="wl-enroll-arc" data-n="1" />
            <span className="wl-enroll-arc" data-n="2" />
          </>
        ) : null}
        {stage === 'done' ? (
          <Nfc className="wl-enroll-tag absolute -top-3 size-5 text-accent-fg" />
        ) : null}
        {stage === 'refused' ? (
          <svg viewBox="0 0 24 24" className="absolute -top-3 size-6 text-danger">
            <title>Refused</title>
            <path
              d="M4 20 20 4"
              className="wl-enroll-strike"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        ) : null}
      </span>
    </div>
  );
}

/** The green tile that says the tag is assigned. */
export function DoneTile() {
  return (
    <span className="wl-enroll-tile mx-auto grid size-12 place-items-center rounded-full border border-success-border bg-success-subtle text-success">
      <Check aria-hidden className="size-6" />
    </span>
  );
}
