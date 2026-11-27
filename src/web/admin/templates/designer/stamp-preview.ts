import { useEffect, useMemo, useRef, useState } from 'react';
import type { StampArt } from '@/passkit/stamps/compose.ts';
import type { Rgba } from '@/passkit/stamps/png.ts';
import { type DesignerHost, useDesignerHost } from './host.tsx';
import { previewAssetMap, toBase64 } from './images.ts';
import type { DesignDoc, DraftAsset } from './model.ts';
import { ART_SLOTS, readStamps, sampleCount } from './stamps.ts';

// The compositor and the PNG codec (with its inflate) load with the first strip, not with the designer.
const compositor = () => import('@/passkit/stamps/compose.ts');
const codec = () => import('@/passkit/stamps/png.ts');

const decoded = new Map<string, Promise<Rgba>>();

const fromBase64 = (text: string): Uint8Array => {
  const raw = atob(text);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

type Loader = DesignerHost['loadAsset'];
const noFiles: Loader = () => Promise.reject(new Error('No file loads here.'));

/** Decodes a file of the draft: new files from their upload, saved ones through the host. */
function load(asset: DraftAsset, assetBase: string, loadAsset: Loader): Promise<Rgba> {
  const id = `${asset.name}|${asset.sha1 ?? ''}|${asset.upload?.length ?? ''}|${asset.upload?.slice(-16) ?? ''}`;
  let hit = decoded.get(id);
  if (!hit) {
    hit = (async () => {
      const { decodePng } = await codec();
      if (asset.upload !== undefined) return decodePng(fromBase64(asset.upload));
      const url = previewAssetMap([asset], assetBase)[asset.name] ?? '';
      const blob = await loadAsset(url);
      return decodePng(new Uint8Array(await blob.arrayBuffer()));
    })();
    decoded.set(id, hit);
    hit.catch(() => decoded.delete(id));
  }
  return hit;
}

/** The strip the server will draw for `count`, from the same compositor, as a PNG data URL. */
export async function drawStrip(
  doc: DesignDoc,
  assetBase: string,
  count: number,
  loadAsset: Loader = noFiles,
): Promise<string | null> {
  const view = readStamps(doc);
  if (!view) return null;
  const file = (slot: (typeof ART_SLOTS)[number]) => {
    const name = view.art[slot.slot];
    return name ? doc.assets.find((a) => a.name === name) : undefined;
  };
  const [filled, empty, reward, rewardEarned] = await Promise.all(
    ART_SLOTS.map(async (slot) => {
      const asset = file(slot);
      return asset ? load(asset, assetBase, loadAsset) : undefined;
    }),
  );
  if (!filled || !empty) return null;
  const art: StampArt = {
    filled,
    empty,
    ...(reward ? { reward } : {}),
    ...(rewardEarned ? { rewardEarned } : {}),
  };
  const baseAsset = doc.assets.find((a) => a.name === 'strip@2x.png');
  let base: Rgba | undefined;
  try {
    base = baseAsset ? await load(baseAsset, assetBase, loadAsset) : undefined;
  } catch {
    base = undefined;
  }
  const [{ renderStrip }, { encodePng }] = await Promise.all([compositor(), codec()]);
  const strip = renderStrip({
    goal: view.goal,
    count,
    scale: 2,
    // A base of the wrong size is the server's error to report; the preview draws without it.
    base: base && base.width === 750 && base.height === 288 ? base : 'transparent',
    art,
    tilt: view.tilt,
  });
  return `data:image/png;base64,${toBase64(encodePng(strip))}`;
}

/** The live strip for the card: redrawn 200 ms after the last change. */
export function useStampStrip(doc: DesignDoc, assetBase: string, count: number) {
  const view = readStamps(doc);
  const key = view
    ? JSON.stringify([
        view.goal,
        view.tilt,
        count,
        ...doc.assets
          .filter((a) => a.name.startsWith('stamps/') || a.name === 'strip@2x.png')
          .filter((a) => !a.name.startsWith('stamps/strips/'))
          .map((a) => [a.name, a.sha1, a.upload?.length, a.upload?.slice(-16)]),
      ])
    : null;
  const [url, setUrl] = useState<string | null>(null);
  const { loadAsset } = useDesignerHost();
  // The effect runs when the key moves; it draws from whatever the latest render held.
  const latest = useRef({ doc, assetBase, count, loadAsset });
  latest.current = { doc, assetBase, count, loadAsset };
  useEffect(() => {
    if (key === null) return setUrl(null);
    let live = true;
    const t = setTimeout(() => {
      const now = latest.current;
      drawStrip(now.doc, now.assetBase, now.count, now.loadAsset).then(
        (next) => live && setUrl(next),
        () => live && setUrl(null),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return url;
}

/**
 * The Stamps preview: the slider's count (view state, from the sample until moved), the count the
 * live check builds, and the strip drawn for it.
 */
export function useStampsPreview(doc: DesignDoc, assetBase: string) {
  const [picked, setCount] = useState<number | null>(null);
  const view = readStamps(doc);
  const count = Math.min(picked ?? sampleCount(doc), view?.goal ?? 0);
  const stripUrl = useStampStrip(doc, assetBase, count);
  const slider = useMemo(() => ({ count, setCount }), [count]);
  return { slider, checkCount: view ? count : undefined, stripUrl };
}
