import type { Refusal } from '../../ssr/join-page.tsx';
import type { PublicLink } from './repo-issues.ts';

export type JoinOutcome =
  | { kind: 'card'; token: string; device: string }
  | { kind: 'check_email'; link: PublicLink; email: string }
  | {
      kind: 'form';
      link: PublicLink;
      /** Whether the form asks for a name: decided from the release, as the page is. */
      askName: boolean;
      error: string;
      values: { name: string; email: string };
      /** 403 for a failed Turnstile check; else 422. */
      status?: 403;
    }
  | { kind: 'refused'; reason: Refusal; link: PublicLink | null };
