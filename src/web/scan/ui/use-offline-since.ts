import { useEffect, useState } from 'react';

/** When the connection went away, for "Offline since 7:38 PM"; null while online. A page opened offline counts from its open. */
export function useOfflineSince(online: boolean): number | null {
  const [since, setSince] = useState<number | null>(() => (online ? null : Date.now()));
  useEffect(() => {
    setSince((t) => (online ? null : (t ?? Date.now())));
  }, [online]);
  return since;
}
