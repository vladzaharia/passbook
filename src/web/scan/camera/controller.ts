import type { CodeFormat, RawRead } from '../input/types.ts';
import type { CameraStatus } from '../machine/types.ts';
import { createDecoder } from './decoder.ts';
import { createFrames } from './frames.ts';

export function createCamera(
  video: () => HTMLVideoElement | null,
  formats: () => CodeFormat[],
  emit: (read: RawRead) => void,
  status: (s: CameraStatus) => void,
) {
  let stream: MediaStream | null = null;
  let decoder: ReturnType<typeof createDecoder> | null = null;
  let frames: ReturnType<typeof createFrames> | null = null;
  let generation = 0;
  let facing: 'environment' | 'user' = 'environment';
  let torch = false;
  let wideId: string | undefined;
  let useWide = false;
  const stop = () => {
    generation++;
    frames?.pause();
    frames = null;
    decoder?.close();
    decoder = null;
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    stream = null;
    torch = false;
    const v = video();
    if (v) v.srcObject = null;
  };
  const fail = (s: CameraStatus) => {
    stop();
    status(s);
  };
  const discover = async (token: number) => {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? [];
      if (token === generation)
        wideId = devices.find(
          (d) => d.kind === 'videoinput' && /ultra.?wide|back.?wide|0[.,]5/i.test(d.label),
        )?.deviceId;
    } catch {
      // Device labels are optional. A denied enumeration disables only the wide-camera option.
      if (token === generation) wideId = undefined;
    }
  };
  const request = async (token: number) => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(useWide && wideId
            ? { deviceId: { exact: wideId } }
            : { facingMode: { ideal: facing } }),
          width: { ideal: 1280 },
        },
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'OverconstrainedError')) throw error;
      if (token !== generation) return null;
      // A stale device id or an unsupported constraint must not exclude an otherwise usable camera.
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
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
      const next = await request(token);
      if (!next) return;
      if (token !== generation) {
        for (const t of next.getTracks()) t.stop();
        return;
      }
      stream = next;
      for (const track of next.getVideoTracks())
        track.onended = () => {
          if (token === generation) fail('unavailable');
        };
      void discover(token);
      const v = video();
      if (!v || next.getVideoTracks().length === 0) {
        fail('unavailable');
        return;
      }
      v.muted = true;
      v.playsInline = true;
      v.srcObject = next;
      await v.play();
      if (token !== generation) return;
      try {
        const nextDecoder = createDecoder(() => {
          if (token === generation) fail('decoder_failed');
        });
        if (token !== generation) {
          nextDecoder.close();
          return;
        }
        decoder = nextDecoder;
      } catch {
        fail('decoder_failed');
        return;
      }
      frames = createFrames(
        video,
        decoder,
        formats,
        emit,
        () => {
          if (token === generation) fail('unavailable');
        },
        () => {
          if (token === generation) status('live');
        },
      );
      frames.resume();
    } catch (error) {
      if (token !== generation) return;
      fail(
        error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
          ? 'blocked'
          : 'unavailable',
      );
    }
  };
  return {
    start: () => void start(),
    stop,
    pause: () => frames?.pause(),
    resume: () => {
      if (stream?.getVideoTracks().some((t) => t.readyState === 'live')) frames?.resume();
    },
    slow: () => frames?.slow(),
    hasTorch: () => {
      try {
        return Boolean(
          (stream?.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined)
            ?.torch,
        );
      } catch {
        return false;
      } // Unsupported capability probing disables only the torch control.
    },
    hasWide: () => Boolean(wideId),
    async toggleTorch() {
      const track = stream?.getVideoTracks()[0];
      if (!track) return false;
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      torch = !torch;
      return torch;
    },
    choose(choice: 'back' | 'back-wide' | 'front') {
      facing = choice === 'front' ? 'user' : 'environment';
      useWide = choice === 'back-wide';
      void start();
    },
  };
}
