import { useEffect, useMemo, useRef, useState } from 'react';
import { useDesignerHost } from './host.tsx';

const INLINE = /^(data|blob):/;
/** A transparent pixel: a listed file before its bytes arrive, or when they cannot. */
const PENDING =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const canObjectUrl = () => typeof URL.createObjectURL === 'function';
const revoke = (url: string) => {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
};

/**
 * File name to a URL the page can show. Each path loads through the host (the session in admin,
 * the Workbench token, a blueprint's own bytes signed out) and shows as an object URL, revoked
 * once it is no longer listed. Data and blob URLs pass through. Until a file arrives (or if it
 * cannot) it is a transparent pixel, so the card's layout and the wallet reports, which go by the
 * files a version lists, never depend on load timing.
 */
export function useLoadedUrls(paths: Readonly<Record<string, string>>): Record<string, string> {
  const { loadAsset } = useDesignerHost();
  const signature = JSON.stringify(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the paths' content
  const wanted = useMemo(() => paths, [signature]);
  const cache = useRef(new Map<string, string>());
  const loader = useRef(loadAsset);
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    // Another host's bytes are not this one's: start over.
    if (loader.current !== loadAsset) {
      for (const url of cache.current.values()) revoke(url);
      cache.current.clear();
      loader.current = loadAsset;
    }
    const keep = new Set(Object.values(wanted));
    for (const [path, url] of cache.current)
      if (!keep.has(path)) {
        revoke(url);
        cache.current.delete(path);
      }
    if (!canObjectUrl()) return;
    const controller = new AbortController();
    for (const path of keep) {
      if (INLINE.test(path) || cache.current.has(path)) continue;
      loadAsset(path, controller.signal).then(
        (blob) => {
          if (controller.signal.aborted) return;
          cache.current.set(path, URL.createObjectURL(blob));
          setLoaded((n) => n + 1);
        },
        () => {
          // A missing or refused file stays the transparent pixel; the issues list names missing files.
        },
      );
    }
    return () => controller.abort();
  }, [wanted, loadAsset]);

  useEffect(() => {
    const urls = cache.current;
    return () => {
      for (const url of urls.values()) revoke(url);
      urls.clear();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` counts arrivals in the cache
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, path] of Object.entries(wanted)) {
      out[name] = INLINE.test(path) ? path : (cache.current.get(path) ?? PENDING);
    }
    return out;
  }, [wanted, loaded]);
}

/** One file, as `useLoadedUrls`. */
export function useLoadedUrl(path: string | null | undefined): string | undefined {
  const urls = useLoadedUrls(
    useMemo((): Record<string, string> => (path ? { file: path } : {}), [path]),
  );
  return urls.file;
}
