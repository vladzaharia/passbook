import { useEffect, useRef, useState } from 'react';

/**
 * Stage motion from data: mint when the version goes up on an active pass (or once on arrival
 * from the wizard), settle and stamp when it turns void. Browsing versions never mints. Removal
 * stores the pass voided too, but it is not a void: no tear, no stamp.
 */
export function useStageMotion(
  version: number,
  status: string,
  mintedOnArrival: boolean,
  removed = false,
) {
  const last = useRef({ version, status });
  const [mint, setMint] = useState(0);
  const [settle, setSettle] = useState(0);
  const [stamp, setStamp] = useState(false);
  useEffect(() => {
    if (mintedOnArrival) setMint((n) => n + 1);
  }, [mintedOnArrival]);
  useEffect(() => {
    const prev = last.current;
    if (removed) {
      setStamp(false);
    } else if (status === 'voided' && prev.status !== 'voided') {
      setSettle((n) => n + 1);
      setStamp(true);
    } else if (status === 'active' && version > prev.version) {
      setMint((n) => n + 1);
      setStamp(false);
    }
    last.current = { version, status };
  }, [version, status, removed]);
  return { mint, settle, stamp };
}
