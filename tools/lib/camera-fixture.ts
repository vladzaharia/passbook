import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import bwipjs from 'bwip-js/node';

export const NATIVE_CAMERA_CODE = 'E2E-NATIVE-CAMERA';
/** Synthetic camera video: Chromium reads this through its native media capture implementation. */
export function writeCameraVideo(path: string) {
  const width = 640;
  const height = 480;
  const [qr] = bwipjs.raw({ bcid: 'qrcode', text: NATIVE_CAMERA_CODE });
  if (!qr || !('pixs' in qr)) throw new Error('QR fixture could not be generated');
  const scale = 12;
  const y = Buffer.alloc(width * height, 235);
  const left = Math.floor((width - qr.pixx * scale) / 2);
  const top = Math.floor((height - qr.pixy * scale) / 2);
  for (let row = 0; row < qr.pixy; row++)
    for (let col = 0; col < qr.pixx; col++) {
      if (!qr.pixs[row * qr.pixx + col]) continue;
      for (let dy = 0; dy < scale; dy++)
        y.fill(
          16,
          (top + row * scale + dy) * width + left + col * scale,
          (top + row * scale + dy) * width + left + (col + 1) * scale,
        );
    }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, Buffer.alloc((width * height) / 2, 128)]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`),
      frame,
      frame,
      frame,
    ]),
  );
}
