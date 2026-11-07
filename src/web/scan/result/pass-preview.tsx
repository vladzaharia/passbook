import { useContext, useEffect, useState } from 'react';
import type { PassJson } from '../../../passkit/types.ts';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { normalize } from '../../../shared/pass-view/normalize.ts';
import { modeHeaders } from '../../lib/mode.ts';
import { PassCard, PassCardFlip } from '../../pass-card/PassCard.tsx';
import { ScanAssetScope } from '../platform/asset-scope.ts';

export function PassPreview({
  card,
  orgId,
  timeZone,
  still = false,
}: {
  card: ScanCard;
  orgId?: string;
  timeZone?: string;
  still?: boolean;
}) {
  const scope = useContext(ScanAssetScope);
  const setupId = scope?.setupId;
  orgId = scope?.orgId ?? orgId;
  timeZone = scope?.timeZone ?? timeZone;
  const p = card.passView;
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    setAssets({});
    setFailed(false);
    void Promise.all(
      p.assetNames.map(async (name) => {
        const q = new URLSearchParams({ g: p.assetGrant });
        if (orgId) {
          q.set('orgId', orgId);
          q.set('timeZone', timeZone ?? 'UTC');
          if (setupId) q.set('setupId', setupId);
        }
        const response = await fetch(`${p.assetBaseUrl}${encodeURIComponent(name)}?${q}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: orgId ? modeHeaders() : {},
        });
        if (!response.ok) throw new Error('Pass image unavailable.');
        const blob = await response.blob();
        if (controller.signal.aborted) return [name, ''];
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return [name, url];
      }),
    ).then(
      (entries) => {
        if (!controller.signal.aborted) setAssets(Object.fromEntries(entries));
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [p, orgId, timeZone, setupId]);
  // The server removes capabilities; older cards must not paint codes either.
  const { barcode: _barcode, barcodes: _barcodes, nfc: _nfc, ...pass } = p.passJson as PassJson;
  const view = normalize(pass as PassJson, { assets });
  return (
    <>
      <div aria-hidden={still || undefined} className={still ? 'scan-pass-preview' : undefined}>
        {still ? (
          <PassCard view={view} removed={card.status === 'removed'} />
        ) : (
          <PassCardFlip view={view} removed={card.status === 'removed'} />
        )}
      </div>
      {failed ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Some pass images could not load.
        </p>
      ) : null}
    </>
  );
}
