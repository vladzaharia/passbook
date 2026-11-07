import { Camera, ScanBarcode } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '../../ui/button.tsx';
import type { CameraStatus } from '../machine/types.ts';
import './camera.css';

export function CameraLayer({
  videoRef,
  status,
  checking,
  result,
  reader,
  onRetry,
}: {
  videoRef: { current: HTMLVideoElement | null };
  status: CameraStatus;
  checking: boolean;
  result: boolean;
  reader: boolean;
  onRetry?: () => void;
}) {
  const live = status === 'live';
  const frozen = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    const canvas = frozen.current;
    if (
      !checking ||
      !video ||
      !canvas ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    )
      return;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      // A camera switch can invalidate this optional still; fall back to the live video beneath it.
      canvas.width = 0;
      canvas.height = 0;
    }
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
          inert={result}
          aria-hidden={result || undefined}
          data-hidden={result || undefined}
        >
          {reader ? <ScanBarcode size={48} aria-hidden /> : <Camera size={48} aria-hidden />}
          <p>
            {status === 'starting'
              ? 'Opening camera…'
              : status === 'blocked'
                ? 'Camera access blocked'
                : status === 'unavailable' || status === 'decoder_failed'
                  ? 'Camera unavailable'
                  : reader
                    ? 'Ready for the reader'
                    : 'Camera is off'}
          </p>
          <span>
            {status === 'blocked'
              ? 'Allow camera access in your browser settings, or type a code.'
              : status === 'decoder_failed'
                ? 'Camera reader unavailable. Use Look up.'
                : status === 'unavailable'
                  ? 'Could not open the camera. Close other camera apps and try again.'
                  : reader
                    ? 'Scan a pass, or look someone up.'
                    : 'Start scanning to open the camera.'}
          </span>
          {onRetry &&
          ['blocked', 'unavailable', 'decoder_failed', 'off', 'disabled'].includes(status) ? (
            <Button variant="secondary" onClick={onRetry}>
              {status === 'off' || status === 'disabled' ? 'Use camera' : 'Retry camera'}
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}
