import type { ReactNode } from 'react';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { BuddyArt } from '../../ui/art/buddy-art.tsx';
import './gate.css';

/** `/login?next=` for a portal page. */
export const signInHref = (path: string) => `/login?next=${encodeURIComponent(path)}`;

/**
 * The signed-out card of every tool page: the buddy seated at its end, one line on what you get, `Sign in`
 * and, when a page has one, the docs. SSR-safe (no hooks), so the prerendered page and the islands that
 * replace it draw the same card. The buddy's eyes follow the button on hover or focus (gate.css).
 */
export function Gate({
  title,
  next,
  docs,
  heading: Heading = 'h2',
  inline = false,
  children,
}: {
  title: string;
  /** The page to come back to after sign-in. */
  next: string;
  /** The docs link for this tool. */
  docs?: string;
  heading?: 'h1' | 'h2' | 'p';
  /** Inside the Try it ticket: no card of its own. */
  inline?: boolean;
  /** Extra content under the line (the Try it ticket's sample). */
  children?: ReactNode;
}) {
  return (
    <section className={inline ? 'gate gate-inline' : 'card gate'} data-gate="" aria-label={title}>
      <BuddyArt size="sm" at="end" />
      <Heading className="h2 gate-t">{title}</Heading>
      {children}
      <div className="gate-a">
        <a className="btn" href={signInHref(next)}>
          {GATE_COPY.signIn}
        </a>
        {docs ? (
          <a className="btn outline" href={docs}>
            {GATE_COPY.docs}
          </a>
        ) : null}
      </div>
    </section>
  );
}
