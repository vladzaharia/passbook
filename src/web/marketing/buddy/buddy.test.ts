import { describe, expect, it } from 'vitest';
import { draw, faces, poses, scene, scenes } from './index.ts';

/** Every name KIT.md lists under Poses and `data-scene`. */
const KIT_POSES = [
  'rest',
  'happy',
  'curious',
  'focus',
  'wave',
  'point',
  'clap',
  'cheer',
  'peek',
  'wink',
  'sleep',
  'shake',
  'sorry',
  'tuck',
  'offer',
  'clock',
];
const KIT_SCENES = [
  'door',
  'design',
  'send',
  'update',
  'scan',
  'kind-wallet',
  'kind-paper',
  'kind-mobile',
  'kind-tap',
  'ans-yes',
  'ans-already',
  'ans-no',
  'ans-sorry',
  'tap',
  'job-checkin',
  'job-tickets',
  'job-stamp',
  'job-visitors',
  'job-parking',
  'job-classes',
  'dev',
  'close',
  'verdict',
];
const KIT_FACES = [
  'rest',
  'happy',
  'delight',
  'focus',
  'curious',
  'sad',
  'no',
  'sleep',
  'sorry',
  'wink',
  'up',
];

describe('buddy kit', () => {
  it('lists every pose, scene and face the kit names', () => {
    expect(poses).toEqual(expect.arrayContaining(KIT_POSES));
    expect(scenes).toEqual(expect.arrayContaining(KIT_SCENES));
    expect(faces).toEqual(expect.arrayContaining(KIT_FACES));
  });

  it.each(poses)('draws the %s pose as an svg', (pose) => {
    expect(draw(pose).startsWith('<svg')).toBe(true);
    expect(draw(pose, { dir: 'right' }).startsWith('<svg')).toBe(true);
  });

  it.each(scenes)('draws the %s scene as an svg', (name) => {
    expect(scene(name).startsWith('<svg')).toBe(true);
  });

  it.each(faces)('draws a pose with the %s face', (face) => {
    expect(draw('rest', { face }).startsWith('<svg')).toBe(true);
  });

  it('falls back to rest for an unknown pose and draws nothing for an unknown scene', () => {
    expect(draw('nope')).toContain('b-pose-rest');
    expect(scene('constructor')).toBe('');
    expect(scene('nope')).toBe('');
  });
});
