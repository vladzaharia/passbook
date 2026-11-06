import type { CodeFormat } from '../input/types.ts';
import type { CameraHit, CameraReply, CameraRequest } from './protocol.ts';
/** One frame in flight. A dead worker must never leave the camera looking ready. */
export function createDecoder(failed: () => void) {
  const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
  let closed = false;
  let ready = false;
  let id = 0;
  let pending: ((hit: CameraHit | null) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const close = () => {
    closed = true;
    clear();
    worker.terminate();
    pending?.(null);
    pending = null;
  };
  const fail = () => {
    if (!closed) {
      close();
      failed();
    }
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = ({ data }: MessageEvent<CameraReply>) => {
    if (closed) return;
    if (data.type === 'error') {
      fail();
      return;
    }
    if (data.type === 'ready') {
      clear();
      ready = true;
      return;
    }
    if (data.id !== id || !pending) return;
    clear();
    const done = pending;
    pending = null;
    done(data.hit);
  };
  const post = (message: CameraRequest, transfer: Transferable[] = []) => {
    try {
      worker.postMessage(message, transfer);
    } catch {
      fail();
    }
  };
  timer = setTimeout(fail, 8_000);
  post({ type: 'init' });
  return {
    close,
    available: () => ready && !closed && !pending,
    read(image: ImageData, formats: CodeFormat[]): Promise<CameraHit | null> {
      if (!ready || closed || pending) return Promise.resolve(null);
      return new Promise((resolve) => {
        pending = resolve;
        timer = setTimeout(fail, 1_500);
        post({ type: 'frame', id: ++id, image, formats }, [image.data.buffer]);
      });
    },
    ready: () => ready && !closed,
  };
}
