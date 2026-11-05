import { useEffect, useState } from 'react';

export interface Announcement {
  text: string;
  /** `status` for green, amber and ready; `alert` only for red, slate and blocking panels. */
  polite: boolean;
  /** Re-keyed per announcement, so the same sentence twice is read twice. */
  n: number;
}

/** Screen readers drop an unchanged region, so each message clears it, then sets it 50 ms later. */
export const ANNOUNCE_DELAY_MS = 50;

/**
 * Two persistent live regions (WCAG 4.1.3). They stay in the tree for the whole session; only
 * their text changes.
 */
export function LiveAnnouncer({ message }: { message: Announcement | null }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  useEffect(() => {
    if (!message) return;
    const set = message.polite ? setPolite : setAssertive;
    setPolite('');
    setAssertive('');
    const t = setTimeout(() => set(message.text), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [message]);
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="scan-sr">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="scan-sr">
        {assertive}
      </div>
    </>
  );
}
