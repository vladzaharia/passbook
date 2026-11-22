import type {
  ReleaseNext,
  TemplateReleaseState,
} from '@/shared/contracts/template-release-flow.ts';

export type NextKind = 'design' | 'try' | 'release' | 'request' | 'review' | 'wait' | 'pass';

/** The header's primary for the server's `next`; "New pass" once nothing is pending. */
export interface NextAction {
  kind: NextKind;
  label: string;
}
export const isPrimary = (a: NextAction): a is { kind: Exclude<NextKind, 'pass'>; label: string } =>
  a.kind !== 'pass';

export function nextAction(next: ReleaseNext | undefined, draft: string): NextAction {
  switch (next) {
    case 'design':
      return { kind: 'design', label: 'Design' };
    case 'try':
      return { kind: 'try', label: 'Try on my phone' };
    case 'release':
      return { kind: 'release', label: `Release ${draft}` };
    case 'request_review':
      return { kind: 'request', label: 'Request review' };
    case 'review':
      return { kind: 'review', label: `Review ${draft}` };
    case 'wait':
      return { kind: 'wait', label: 'In review' };
    default:
      return { kind: 'pass', label: 'New pass' };
  }
}

/** The strip's alternative to the header's primary: none while a review is open. */
export function stripAlt(state: TemplateReleaseState): 'try' | 'release' | null {
  if (state.review.state === 'open') return null;
  if (state.next === 'try') return 'release';
  return state.next === 'release' && state.test?.version !== state.draft?.version ? 'try' : null;
}
