import { canonicalUid, readableUid, tagRef } from '../tag-ref.ts';
import type { TagSystem } from './types.ts';

/** Basic: the fixed UID is the proof. */
export const UID_SYSTEM: TagSystem = {
  id: 'uid',
  assurance: 'basic',
  ready: true,
  recognise(read) {
    const uid = readableUid(read);
    return uid ? { system: 'uid', uid } : null;
  },
  identify: (env, orgId, mode, uid) => tagRef(env, orgId, mode, canonicalUid(uid)),
};
