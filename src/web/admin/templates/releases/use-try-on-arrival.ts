import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

/** `?try=1` (from the Overview path) opens Try on my phone once on `version`, then clears itself. */
export function useTryOnArrival(
  on: boolean,
  version: string,
  tryVersion: (version: string) => void,
) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!on) return;
    if (version) tryVersion(version);
    void navigate({ to: '.', search: {}, replace: true });
  }, [on, version, tryVersion, navigate]);
}
