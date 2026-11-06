import { Camera, ScanBarcode } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { CameraStatus } from '../machine/types.ts';
import './camera.css';

export function CameraLayer({
  videoRef,
  status,
  checking,
  result,
  reader,
}: {
  videoRef: { current: HTMLVideoElement | null };
  status: CameraStatus;
  checking: boolean;
  result: boolean;
  reader: boolean;
}) {
  const live = status === 'live';
  const frozen = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    const canvas = frozen.current;
    if (!checking || !video || !canvas || video.readyState < 2) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
  }, [checking, videoRef]);
  return (
    <>
      <video ref={videoRef} muted playsInline className="scan-video" aria-hidden />
      <canvas ref={frozen} className="scan-frozen-frame" hidden={!checking || !live} aria-hidden />
      <div className="scan-camera-scrim" />
      {live ? (
        <div
          className="scan-aim"
          aria-hidden={result || undefined}
          data-hidden={result || undefined}
          data-checking={checking || undefined}
        >
          <div className="scan-reticle" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </div>
          <p className="scan-live-pill">{checking ? 'Checking…' : 'Point at the barcode'}</p>
        </div>
      ) : (
        <div
          className="scan-reader-stage"
          aria-hidden={result || undefined}
          data-hidden={result || undefined}
        >
          {reader ? <ScanBarcode size={48} aria-hidden /> : <Camera size={48} aria-hidden />}
          <p>
            {status === 'starting'
              ? 'Opening camera…'
              : reader
                ? 'Ready for the reader'
                : 'Camera is off'}
          </p>
          <span>
            {status === 'blocked'
              ? 'Allow camera access in your browser settings, or type a code.'
              : status === 'decoder_failed'
                ? 'Camera reader unavailable. Type a code.'
                : status === 'unavailable'
                  ? 'No camera available. Use a reader or type a code.'
                  : reader
                    ? 'Scan a pass, or look someone up.'
                    : 'Start scanning to open the camera.'}
          </span>
        </div>
      )}
    </>
  );
}
