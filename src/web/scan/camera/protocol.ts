import type { CodeFormat } from '../input/types.ts';
export type CameraRequest =
  | { type: 'init' }
  | { type: 'frame'; id: number; image: ImageData; formats: CodeFormat[] };
export interface CameraHit {
  code: string;
  linear: boolean;
}
export type CameraReply =
  | { type: 'ready' }
  | { type: 'frame'; id: number; hit: CameraHit | null }
  | { type: 'error' };
