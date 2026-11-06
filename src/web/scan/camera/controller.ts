import type { CodeFormat, RawRead } from '../input/types.ts';
import type { CameraStatus } from '../machine/types.ts';

export function createCamera(
  video: () => HTMLVideoElement | null,
  formats: () => CodeFormat[],
  emit: (read: RawRead) => void,
  status: (s: CameraStatus) => void,
) {
  let stream: MediaStream | null = null;
  let worker: Worker | null = null;
  let active = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let facing: 'environment' | 'user' = 'environment';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frame = () => {
    if (!active) return;
    const v = video();
    if (v && v.readyState >= 2 && ctx && !pending && worker) {
      canvas.width = Math.min(v.videoWidth, 960);
      canvas.height = Math.round((v.videoHeight * canvas.width) / Math.max(1, v.videoWidth));
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      pending = true;
      worker.postMessage({ image, formats: formats() }, [image.data.buffer]);
    }
    timer = setTimeout(frame, 140);
  };
  const pause = () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    generation++;
    pause();
    worker?.terminate();
    worker = null;
    pending = false;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    const v = video();
    if (v) v.srcObject = null;
  };
  const resume = () => {
    if (stream && !active) {
      active = true;
      frame();
    }
  };
  const start = async () => {
    stop();
    const token = generation;
    if (!navigator.mediaDevices?.getUserMedia) {
      status('unavailable');
      return;
    }
    status('starting');
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 } },
      });
      if (token !== generation) {
        for (const t of next.getTracks()) t.stop();
        return;
      }
      stream = next;
      const v = video();
      if (!v) {
        stop();
        return;
      }
      v.srcObject = stream;
      await v.play();
      if (token !== generation) return;
      worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<{ read?: RawRead; error?: boolean }>) => {
        pending = false;
        if (data.error) {
          stop();
          status('decoder_failed');
        } else if (active && data.read) emit(data.read);
      };
      worker.onerror = () => {
        stop();
        status('decoder_failed');
      };
      active = true;
      status('live');
      frame();
    } catch (error) {
      if (token !== generation) return;
      stop();
      status(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'blocked'
          : 'unavailable',
      );
    }
  };
  return {
    start: () => void start(),
    pause,
    resume,
    stop,
    slow: () => undefined,
    choose(choice: 'back' | 'back-wide' | 'front') {
      facing = choice === 'front' ? 'user' : 'environment';
      if (stream) void start();
    },
  };
}
