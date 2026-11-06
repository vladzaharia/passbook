import type { CodeFormat, RawRead } from '../input/types.ts';
import type { createDecoder } from './decoder.ts';
/** Confirm linear codes twice; a single partial stripe read must never check someone in. */
export function createReadFilter() {
  let candidate: { code: string; at: number } | null = null;
  let emitted: { code: string; at: number } | null = null;
  return (code: string, linear: boolean, now: number) => {
    const stable = !linear || (candidate?.code === code && now - candidate.at <= 600);
    candidate = { code, at: now };
    if (!stable || (emitted?.code === code && now - emitted.at < 1_500)) return false;
    emitted = { code, at: now };
    return true;
  };
}
/** Crop the aiming area; every fourth frame includes off-centre/long barcodes. */
export function frameRegion(width: number, height: number, full: boolean) {
  const side = Math.min(width, height) * 0.7;
  const w = full ? width : side;
  const h = full ? height : side;
  const scale = Math.min(1, (full ? 960 : 640) / Math.max(w, h));
  return {
    x: (width - w) / 2,
    y: (height - h) / 2,
    w,
    h,
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
export function createFrames(
  video: () => HTMLVideoElement | null,
  decoder: ReturnType<typeof createDecoder>,
  formats: () => CodeFormat[],
  emit: (read: RawRead) => void,
  failed: () => void,
  live: () => void,
) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const accept = createReadFilter();
  const openedAt = performance.now();
  let active = false;
  let epoch = 0;
  let frameNumber = 0;
  let interval = 125;
  let announced = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (!active) return;
    const token = epoch;
    const v = video();
    if (!ctx || (!announced && performance.now() - openedAt > 8_000)) {
      failed();
      return;
    }
    if (
      decoder.ready() &&
      v &&
      v.readyState >= 2 &&
      v.videoWidth > 0 &&
      v.videoHeight > 0 &&
      !announced
    ) {
      announced = true;
      live();
    }
    if (
      ctx &&
      v &&
      v.readyState >= 2 &&
      v.videoWidth > 0 &&
      v.videoHeight > 0 &&
      decoder.available()
    ) {
      const r = frameRegion(v.videoWidth, v.videoHeight, frameNumber++ % 4 === 3);
      canvas.width = r.width;
      canvas.height = r.height;
      try {
        ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, r.width, r.height);
        const image = ctx.getImageData(0, 0, r.width, r.height);
        const hit = await decoder.read(image, formats());
        if (active && epoch === token && hit && accept(hit.code, hit.linear, performance.now()))
          emit({ method: 'camera', code: hit.code });
      } catch (error) {
        // Empty frames during a camera switch are transient; other capture errors are actionable.
        if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
          failed();
          return;
        }
      }
    }
    if (active && epoch === token) timer = setTimeout(() => void tick(), interval);
  };
  const pause = () => {
    active = false;
    epoch++;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    pause,
    resume() {
      if (!active) {
        active = true;
        void tick();
      }
    },
    slow() {
      interval = 250;
    },
  };
}
