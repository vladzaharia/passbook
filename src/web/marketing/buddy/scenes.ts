import { DOOR_SCENES } from './scenes-door.ts';
import { JOB_SCENES } from './scenes-jobs.ts';
import { STOP_SCENES } from './scenes-stops.ts';
import type { Scenes } from './svg.ts';

export const SCENES: Scenes = { ...DOOR_SCENES, ...STOP_SCENES, ...JOB_SCENES };

export function scene(name: string): string {
  return Object.hasOwn(SCENES, name) ? (SCENES[name]?.() ?? '') : '';
}
