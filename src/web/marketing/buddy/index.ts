/** The Buddy drawing kit. Pages import what they use. */
import { FACES, POSES } from './body.ts';
import { SCENES } from './scenes.ts';

export { draw } from './body.ts';
export { replay, startBuddy } from './mount.ts';
export { scene } from './scenes.ts';
export { star, svg } from './svg.ts';

export const poses: readonly string[] = POSES;
export const scenes: string[] = Object.keys(SCENES);
export const faces: string[] = Object.keys(FACES);
