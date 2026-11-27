import { useRouter } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';
import { bindBenchRouter } from '../bench/url.ts';

/** Bench selections write the address through the router, so Back and the shell keep in step. */
export function useBenchRouter(): void {
  const router = useRouter();
  useLayoutEffect(() => {
    bindBenchRouter((href) => router.history.replace(href));
    return () => bindBenchRouter(null);
  }, [router]);
}
