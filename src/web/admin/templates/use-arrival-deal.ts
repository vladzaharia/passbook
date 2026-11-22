import { useEffect, useState } from 'react';

/**
 * A duplicate mints once on arrival (the value must change after mount); a hard load deals once,
 * then settles after 900 ms.
 */
export function useArrivalDeal(minted: boolean): { mint: number; deal: boolean } {
  const [mint, setMint] = useState(0);
  const [deal, setDeal] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setDeal(false), 900);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (minted) setMint(1);
  }, [minted]);
  return { mint, deal };
}
