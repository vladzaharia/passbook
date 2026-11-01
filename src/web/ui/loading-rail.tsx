import { useEffect, useState } from 'react';

/** True once `on` has held for `ms` (refetch rails and dims wait 150 ms). */
export function useDelayed(on: boolean, ms = 150): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return late;
}

/**
 * A 2 px accent bar along the top edge of its positioned parent while a refetch runs. It loops
 * only while pending and keeps running under reduced motion: it carries state.
 */
export function LoadingRail({ show }: { show: boolean }) {
  if (!show) return null;
  return <span aria-hidden className="wl-rail wl-essential" />;
}
