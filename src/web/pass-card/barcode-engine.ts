/** The encoders are large: the browser loads them on demand, the Worker registers them up front. */
export type ToSvg = (options: Record<string, unknown>) => string;

let engine: ToSvg | undefined;
let loading: Promise<ToSvg> | undefined;

export const getBarcodeEngine = (): ToSvg | undefined => engine;

export function setBarcodeEngine(toSvg: ToSvg): void {
  engine = toSvg;
}

/** The browser entry registers a dynamic import (barcode-loader.ts); the Worker never loads lazily. */
let loader: (() => Promise<ToSvg>) | undefined;

export function setBarcodeLoader(load: () => Promise<ToSvg>): void {
  loader = load;
}

export function loadBarcodeEngine(): Promise<ToSvg> {
  if (engine) return Promise.resolve(engine);
  if (!loader) return Promise.reject(new Error('No barcode engine registered.'));
  loading ??= loader().then((toSvg) => {
    engine = toSvg;
    return toSvg;
  });
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
