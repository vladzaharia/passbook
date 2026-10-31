/** bwip-js is large: the browser loads it on demand, the Worker registers it up front. */
export type ToSvg = (options: Record<string, unknown>) => string;

let engine: ToSvg | undefined;
let loading: Promise<ToSvg> | undefined;

export const getBarcodeEngine = (): ToSvg | undefined => engine;

export function setBarcodeEngine(toSvg: ToSvg): void {
  engine = toSvg;
}

export function loadBarcodeEngine(): Promise<ToSvg> {
  if (engine) return Promise.resolve(engine);
  loading ??= import('bwip-js/generic').then((mod) => {
    const lib = (mod.default ?? mod) as unknown as { toSVG: ToSvg };
    const toSvg: ToSvg = (options) => lib.toSVG(options);
    engine = toSvg;
    return toSvg;
  });
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
