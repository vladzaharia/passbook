import { useEffect, useMemo, useState } from 'react';
import type { PreviewSource } from './types.ts';
import type { WalletTargetOut } from './wallet-kit.ts';

type Kit = typeof import('./wallet-kit.ts');

/** The compilers are large: one chunk, fetched the first time a wallet preview opens. */
let loading: Promise<Kit> | undefined;
const loadKit = (): Promise<Kit> => {
  loading ??= import('./wallet-kit.ts');
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
};

export type WalletPreviews =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; out: WalletTargetOut };

/** Google and Samsung compiled in the browser, again whenever the pass or its template changes. */
export function useWalletPreviews(source: PreviewSource | null, enabled = true): WalletPreviews {
  const [kit, setKit] = useState<Kit | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || kit) return;
    let live = true;
    loadKit().then(
      (k) => live && setKit(k),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [enabled, kit]);
  const {
    passJson,
    assetBaseUrl,
    assetNames,
    assetUrls,
    manifest,
    assets,
    input,
    website,
    timeZone,
  } = source ?? {};
  return useMemo<WalletPreviews>(() => {
    if (failed) return { state: 'error' };
    if (!kit || !passJson || !assetBaseUrl || !assetNames || !manifest || !assets || !input)
      return { state: 'loading' };
    try {
      return {
        state: 'ready',
        out: kit.compileWallets(
          {
            passJson,
            assetBaseUrl,
            assetNames,
            assetUrls,
            manifest,
            assets,
            input,
          },
          { ...(website ? { website } : {}), ...(timeZone ? { timeZone } : {}) },
        ),
      };
    } catch {
      // A draft the compilers cannot read (a half-edited wallets block) shows the error line.
      return { state: 'error' };
    }
  }, [
    kit,
    failed,
    passJson,
    assetBaseUrl,
    assetNames,
    assetUrls,
    manifest,
    assets,
    input,
    website,
    timeZone,
  ]);
}
