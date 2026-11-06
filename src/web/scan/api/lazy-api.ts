import type { ScanApi, ScanApiDeps } from './scan-api.ts';

/** Pairing paints first; the typed client and its wire schemas load when the first call starts. */
export function createLazyScanApi(deps: ScanApiDeps): ScanApi {
  let loading: Promise<ScanApi> | null = null;
  const instance = () =>
    (loading ??= import('./scan-api.ts').then((module) => module.createScanApi(deps)));
  return new Proxy({} as ScanApi, {
    get:
      (_target, key) =>
      (...args: unknown[]) =>
        instance().then((client) => Reflect.apply(Reflect.get(client, key), client, args)),
  });
}
