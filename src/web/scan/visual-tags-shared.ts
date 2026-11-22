/** Shared fixtures of the tag gallery: one preview, one tag read, the readers. */
import type { TagReader } from './assign/tag-reader.ts';
import type { BindResult, TagEnrollment } from './assign/types.ts';
import type { AssignState } from './machine/assign-state.ts';
import { fresh } from './machine/reduce-assign.ts';

export const NOW = 1_762_000_000_000;
export const ENROLL: TagEnrollment = {
  id: '01900000-0000-7000-8000-0000000000bb',
  holderName: 'Maya Okafor',
  passTitle: 'HQ access',
  scope: 'user',
  requestedByName: 'Ana R.',
  expiresAt: Date.now() + 102_000,
};
export const PREVIEW: BindResult = {
  status: 'preview',
  hint: '7F3A',
  assurance: 'basic',
  scope: 'pass',
  bindingId: null,
  card: {
    passId: '01900000-0000-7000-8000-0000000000aa',
    title: 'HQ access',
    subtitle: null,
    templateName: 'Staff · HQ access',
    holderName: 'Maya Okafor',
    photoUrl: null,
  },
  ownerAccount: true,
  skipped: [],
  warnings: [],
  lostAt: null,
  undoUntil: null,
};
/** A holder photo the gallery can load offline. */
export const PHOTO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#8a6bd1"/><circle cx="32" cy="25" r="11" fill="#f1e3d3"/><path d="M10 64c2-16 12-22 22-22s20 6 22 22Z" fill="#f1e3d3"/></svg>',
)}`;
export const READ = {
  read: { uid: '04a2b37f3a', tech: 'a' as const, source: 'native' as const },
  sig: 't:x',
};
export const base = (over: Partial<AssignState> = {}): AssignState => ({
  ...fresh('menu', NOW),
  ...over,
});

export const ANDROID: TagReader = { kind: 'continuous', needsStart: false };
export const IPHONE: TagReader = { kind: 'sheet', needsStart: false };
export const WEB: TagReader = { kind: 'webnfc', needsStart: true };
export const USB: TagReader = { kind: 'wedge', needsStart: false };

export interface Assign {
  a: AssignState;
  reader: TagReader;
  knownName?: string | null;
  manager?: boolean;
}
